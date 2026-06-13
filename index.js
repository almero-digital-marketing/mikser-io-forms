import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import YAML from 'yaml'
import { isLoopback } from 'mikser-io'

// mikser-io-forms — public form-submission endpoints. POST → validation
// + captcha → write a document file + per-submission uploaded files.
// The plugin never calls createEntity; it writes to disk and lets the
// documents / files plugins' watch loops pick the new files up. That's
// the files-as-source-of-truth invariant (ADR-0002) — same shape decap
// uses.
//
// Composition:
//   - documentsFolder / filesFolder are read from runtime.options
//     (set by the documents / files plugins). Forms can't run without
//     those plugins also loaded.
//   - validation can route through mikser-io-schemas if its plugin is
//     loaded and exposes runtime.options.schemas.validate(name, data).
//
// Per-request order: auth → multipart parse → captcha → schema/validate
// → resolve folder & name → write uploads → write document → 201.

// Resolve a string-or-function configuration value.
const resolve = (value, ...args) =>
    typeof value === 'function' ? value(...args) : value

// Path-traversal sanitization. A user-supplied folder/name may end up
// in `path.join(workingFolder, ...)` — reject anything that escapes.
function sanitizeRelative(p) {
    if (p == null) return null
    const s = String(p).replace(/\\/g, '/')
    // path.normalize collapses '..' segments. Then we check whether the
    // result still contains a leading '..' — which would mean the input
    // escaped the join root.
    const normalized = path.posix.normalize(s.replace(/^\/+/, ''))
    if (normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`forms: rejected path-traversal in folder/name: ${p}`)
    }
    return normalized
}

// Built-in captcha provider presets. Each returns the (field name in the
// form, verify-url). Verification posts form-encoded `secret` + `response`
// to the URL and reads JSON { success, score? }.
const CAPTCHA_PROVIDERS = {
    'google-v2':  { field: 'g-recaptcha-response',  url: 'https://www.google.com/recaptcha/api/siteverify' },
    'google-v3':  { field: 'g-recaptcha-response',  url: 'https://www.google.com/recaptcha/api/siteverify' },
    'hcaptcha':   { field: 'h-captcha-response',    url: 'https://hcaptcha.com/siteverify' },
    'turnstile':  { field: 'cf-turnstile-response', url: 'https://challenges.cloudflare.com/turnstile/v0/siteverify' },
}

// Verify a captcha token against the configured provider (or via a
// user-supplied `verify` function). Returns { ok: boolean, score?, reason? }.
// Honors `failOpen` on network failure.
async function verifyCaptcha(captcha, data, req, logger) {
    // Custom verify function — escape hatch. If set, ignore provider /
    // secret / etc. and just call it.
    if (typeof captcha.verify === 'function') {
        try {
            const result = await captcha.verify(data, { req })
            return result
                ? { ok: true }
                : { ok: false, reason: 'custom verifier rejected' }
        } catch (err) {
            logger.warn('forms captcha custom verify threw: %s', err.message)
            return captcha.failOpen !== false
                ? { ok: true, reason: 'failOpen on verify error' }
                : { ok: false, reason: err.message }
        }
    }

    const preset = CAPTCHA_PROVIDERS[captcha.provider]
    if (!preset) {
        throw new Error(`forms: unknown captcha provider "${captcha.provider}" (use one of ${Object.keys(CAPTCHA_PROVIDERS).join(', ')} or pass captcha.verify)`)
    }
    if (!captcha.secret) {
        throw new Error(`forms: captcha provider "${captcha.provider}" requires captcha.secret`)
    }

    const field = captcha.field ?? preset.field
    const token = data[field]
    if (!token) {
        return { ok: false, reason: `missing captcha field "${field}"` }
    }

    const body = new URLSearchParams({
        secret: captcha.secret,
        response: token,
    })
    // Forward client IP when the engine sits behind a trusted proxy. The
    // server plugin sets trust-proxy + req.ip walks X-Forwarded-For.
    if (req.ip) body.append('remoteip', req.ip)

    const timeoutMs = captcha.timeoutMs ?? 5000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let upstream
    try {
        const res = await fetch(preset.url, {
            method: 'POST',
            body,
            signal: controller.signal,
        })
        upstream = await res.json()
    } catch (err) {
        // Network / timeout / parse failure. Honor failOpen — defaults
        // true so a provider outage doesn't take the form down.
        const failOpen = captcha.failOpen ?? true
        logger.warn('forms captcha verify network failure (%s): failOpen=%s', err.message, failOpen)
        return failOpen
            ? { ok: true, reason: 'failOpen on network error' }
            : { ok: false, reason: `captcha verify network failure: ${err.message}` }
    } finally {
        clearTimeout(timer)
    }

    if (!upstream.success) {
        return { ok: false, reason: `captcha provider rejected: ${(upstream['error-codes'] ?? []).join(', ')}` }
    }
    // v3 score gate. score >= minScore (default 0.5) → accept.
    if (captcha.provider === 'google-v3' && typeof upstream.score === 'number') {
        const minScore = captcha.minScore ?? 0.5
        if (upstream.score < minScore) {
            return { ok: false, score: upstream.score, reason: `score ${upstream.score} below threshold ${minScore}` }
        }
        return { ok: true, score: upstream.score }
    }
    return { ok: true }
}

// Serialize the projected entity into the file body. Markdown gets
// YAML frontmatter + body; plain YAML formats just dump the projected
// object as YAML.
function buildFileBody(format, projected) {
    if (format === 'yml' || format === 'yaml') {
        return YAML.stringify(projected.meta ?? projected)
    }
    // Default: markdown with frontmatter.
    const meta = projected.meta ?? {}
    const content = projected.content ?? ''
    return `---\n${YAML.stringify(meta)}---\n\n${content}`
}

export function forms(options = {}) {
    return ({ runtime, onLoaded, useLogger }) => {
        const endpoints = options.endpoints
        if (!endpoints || !Object.keys(endpoints).length) {
            // No endpoints → nothing to mount. Same posture as the api
            // plugin: warn instead of throw, so a project that turns
            // forms off via config-driven flags doesn't crash.
            return
        }

        onLoaded(async () => {
            const logger = useLogger()

            const app = runtime.options.app
            if (!app) {
                throw new Error(
                    'forms plugin requires runtime.options.app — run mikser with --server, ' +
                    'or pass { app: yourExpressInstance } to setup() before loading the forms plugin'
                )
            }

            // Hard prereq: documents + files plugins must have set their
            // folders. We don't reach into them; we just read what they
            // exposed on runtime.options.
            const documentsFolder = runtime.options.documentsFolder
            const filesFolder     = runtime.options.filesFolder
            if (!documentsFolder) {
                throw new Error(
                    'forms plugin requires the documents plugin to be loaded before it ' +
                    '(documentsFolder not set on runtime.options).'
                )
            }
            if (!filesFolder) {
                // Files plugin is only required if any endpoint declares uploads.
                const anyUploads = Object.values(endpoints).some(ep => ep.uploads)
                if (anyUploads) {
                    throw new Error(
                        'forms plugin has endpoints with uploads but the files plugin ' +
                        'is not loaded (filesFolder not set on runtime.options).'
                    )
                }
            }

            // Optional integration with mikser-io-schemas — used only when
            // an endpoint declares schema: 'X'. If the surface isn't
            // present we throw a clear error at mount time so the
            // misconfiguration is loud, not silent at request time.
            const schemaValidate = runtime.options.schemas?.validate
            for (const [name, ep] of Object.entries(endpoints)) {
                if (ep.schema && !schemaValidate) {
                    throw new Error(
                        `forms endpoint "${name}" declares schema "${ep.schema}" but ` +
                        'mikser-io-schemas is not loaded (or did not expose ' +
                        'runtime.options.schemas.validate).'
                    )
                }
            }

            const { default: express } = await import('express').catch(() => {
                throw new Error('forms plugin: express is required — npm install express')
            })
            const { default: multer } = await import('multer').catch(() => {
                throw new Error('forms plugin: multer is required — npm install multer')
            })

            const base = options.base ?? '/forms'
            const router = express.Router()
            router.use(express.json())
            router.use(express.urlencoded({ extended: true }))

            for (const [name, ep] of Object.entries(endpoints)) {
                router.post(`/${name}`, makeEndpointHandler({
                    name, ep, multer, schemaValidate,
                    documentsFolder, filesFolder,
                    useLogger,
                }))
            }

            app.use(base, router)
            const location = runtime.options.port
                ? `http://localhost:${runtime.options.port}${base}/<name>`
                : `${base}/<name>`
            logger.info('Forms mounted: %s (endpoints: %s)',
                location, Object.keys(endpoints).join(', '))
        })
    }
}

// Build the per-endpoint POST handler. Returns an Express middleware
// chain (multer parses first, then the body handler runs).
function makeEndpointHandler({
    name, ep, multer, schemaValidate, documentsFolder, filesFolder, useLogger,
}) {
    // Multer config — memory storage so we control where files land
    // after validation. Per-endpoint limits + MIME allowlist.
    const uploadsCfg = ep.uploads
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize:    uploadsCfg?.maxFileSize ?? 100 * 1024 * 1024,
            files:       uploadsCfg?.maxFiles ?? 0,
        },
        fileFilter(req, file, cb) {
            if (!uploadsCfg) return cb(null, false) // uploads disabled
            const allowed = uploadsCfg.allowedMimes
            if (allowed && !allowed.includes(file.mimetype)) {
                return cb(new Error(`mime not allowed: ${file.mimetype}`))
            }
            cb(null, true)
        },
    })

    const parseMultipart = uploadsCfg
        ? upload.any()
        : (req, res, next) => next()   // no multer; json/urlencoded already on the router

    return [
        parseMultipart,
        async (req, res) => {
            const logger = useLogger()
            try {
                // 1. Auth — match api plugin's uniform rule. Token wins
                //    over loopback. No token → loopback only.
                if (ep.token) {
                    const auth = req.get('authorization') ?? ''
                    const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : null
                    if (supplied !== ep.token) {
                        return res.status(401).json({ error: 'Invalid or missing token' })
                    }
                } else if (ep.allowRemote !== true && !isLoopback(req.ip)) {
                    return res.status(401).json({ error: 'Loopback only (set token or allowRemote on this endpoint to accept remote)' })
                }

                // Form data is whatever multer parsed + whatever
                // express.json() / urlencoded() left on req.body.
                let data = { ...(req.body ?? {}) }

                // 2. Captcha verify (if configured). Strips the token
                //    field from data afterwards so it doesn't end up
                //    in the entity's frontmatter.
                if (ep.captcha) {
                    const result = await verifyCaptcha(ep.captcha, data, req, logger)
                    const tokenField = ep.captcha.field
                        ?? CAPTCHA_PROVIDERS[ep.captcha.provider]?.field
                    if (tokenField) delete data[tokenField]
                    if (!result.ok) {
                        logger.warn('forms %s: captcha rejected (%s)', name, result.reason)
                        return res.status(403).json({ error: 'Captcha verification failed', reason: result.reason })
                    }
                }

                // 3. Schema (mikser-io-schemas) THEN validate function.
                //    schema runs first; validate gets the already-typed
                //    output if both are set.
                if (ep.schema) {
                    try {
                        data = (await schemaValidate(ep.schema, data)) ?? data
                    } catch (err) {
                        return res.status(400).json({ error: 'Schema validation failed', detail: err.message })
                    }
                }
                if (typeof ep.validate === 'function') {
                    try {
                        const out = await ep.validate(data)
                        if (out !== undefined) data = out
                    } catch (err) {
                        return res.status(400).json({ error: 'Validation failed', detail: err.message })
                    }
                }

                // 4. Resolve folder + name (string | (data) => string).
                //    Falsy returned by a function → use endpoint name as
                //    the default folder.
                const folderResolved = sanitizeRelative(
                    resolve(ep.folder, data) ?? name
                )
                const nameResolved = sanitizeRelative(
                    resolve(ep.name, data) ?? defaultName()
                )

                // 5. Write uploads (multer holds them in memory).
                const filesWritten = []
                if (uploadsCfg && Array.isArray(req.files) && req.files.length) {
                    const uploadFolderResolved = sanitizeRelative(
                        resolve(uploadsCfg.folder, data) ?? name
                    )
                    const uploadFolderAbs = path.join(filesFolder, uploadFolderResolved)
                    await mkdir(uploadFolderAbs, { recursive: true })
                    for (const f of req.files) {
                        const ctx = {
                            field: f.fieldname,
                            originalName: f.originalname,
                            mimeType: f.mimetype,
                            size: f.size,
                        }
                        const uploadFileName = sanitizeRelative(
                            resolve(uploadsCfg.name, data, ctx) ?? f.originalname
                        )
                        const dest = path.join(uploadFolderAbs, uploadFileName)
                        await mkdir(path.dirname(dest), { recursive: true })
                        await writeFile(dest, f.buffer)
                        filesWritten.push({
                            field: f.fieldname,
                            path: path.join('/files', uploadFolderResolved, uploadFileName),
                        })
                    }
                }

                // 6. Project + write the document file.
                const project = ep.project ?? ((d) => ({ meta: d }))
                const projected = await project(data, { uploads: filesWritten })
                const format = ep.format ?? 'md'

                const docFolderAbs = path.join(documentsFolder, folderResolved)
                await mkdir(docFolderAbs, { recursive: true })
                const docPath = path.join(docFolderAbs, `${nameResolved}.${format}`)
                await writeFile(docPath, buildFileBody(format, projected), 'utf8')

                // 7. Respond. Entity id is what the documents plugin will
                //    assign once its watcher picks the file up — it's
                //    derived from the path the same way the documents
                //    plugin's useSource does it.
                const entityId = path.join('/documents', folderResolved, `${nameResolved}.${format}`)
                logger.debug('forms %s: queued %s', name, entityId)
                res.status(201).json({
                    id: entityId,
                    status: 'queued',
                    uploads: filesWritten.length ? filesWritten : undefined,
                })
            } catch (err) {
                logger.error('forms %s: handler error: %s', name, err.message)
                res.status(500).json({ error: err.message })
            }
        },
    ]
}

// Fallback file name when neither a function nor a string was provided.
// Best-effort uniqueness via timestamp + random tail.
function defaultName() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
