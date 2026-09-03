import { describe, it, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import express from 'express'
import { forms } from '../index.js'
import { provideService, resetServices } from 'mikser-io'

// Boot a real Express app with the forms plugin attached. Returns the
// listening server URL plus the working folder paths and a function to
// drive the plugin's onLoaded by hand (simulating what the engine
// would do at lifecycle time).
async function bootForms(formsConfig, { extraRuntime = {}, provideServices = {} } = {}) {
    resetServices()
    for (const [name, api] of Object.entries(provideServices)) provideService(name, api)
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-forms-'))
    const documentsFolder = path.join(dir, 'documents')
    const filesFolder     = path.join(dir, 'files')
    await mkdir(documentsFolder, { recursive: true })
    await mkdir(filesFolder, { recursive: true })

    const app = express()
    const handlers = { loaded: [] }
    const runtime = {
        options: {
            app,
            workingFolder:  dir,
            documentsFolder,
            filesFolder,
            ...extraRuntime,
        },
    }
    const core = {
        runtime,
        onLoaded: (cb) => handlers.loaded.push(cb),
        useLogger: () => ({
            info:  () => {},
            warn:  () => {},
            error: () => {},
            debug: () => {},
            trace: () => {},
        }),
    }

    // v9 plugin invocation — factory(opts)(core) → register hooks.
    forms(formsConfig)(core)

    // Drive onLoaded once.
    for (const cb of handlers.loaded) await cb()

    const server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s))
    })
    const url = `http://127.0.0.1:${server.address().port}`

    return {
        url, dir, documentsFolder, filesFolder, runtime,
        close: () => new Promise((r) => server.close(r)),
    }
}

describe('forms — basic JSON submission', () => {
    let h
    before(async () => {
        h = await bootForms({
            endpoints: {
                contact: {
                    folder: 'contact',
                    name:   (data) => `submission-${data.id}`,
                    project: (data) => ({ meta: { email: data.email }, content: data.message }),
                },
            },
        })
    })
    after(() => h.close())

    it('writes a document file with frontmatter + content', async () => {
        const res = await fetch(`${h.url}/forms/contact`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 'a1', email: 'x@y.z', message: 'Hello.' }),
        })
        assert.equal(res.status, 201)
        const body = await res.json()
        assert.equal(body.id, '/documents/contact/submission-a1.md')
        assert.equal(body.status, 'queued')

        const written = await readFile(path.join(h.documentsFolder, 'contact', 'submission-a1.md'), 'utf8')
        assert.match(written, /^---\n.*email: x@y\.z.*\n---\n\nHello\./s)
    })

    it('defaults to { meta: data } when no project is given', async () => {
        const res = await fetch(`${h.url}/forms/contact`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 'a2', anything: 'whatever' }),
        })
        assert.equal(res.status, 201)
    })
})

describe('forms — auth', () => {
    it('token mismatch → 401', async () => {
        const h = await bootForms({
            endpoints: { x: { folder: 'x', name: 'one', token: 'secret' } },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
                body: JSON.stringify({ a: 1 }),
            })
            assert.equal(res.status, 401)
        } finally { await h.close() }
    })

    it('token match → accept', async () => {
        const h = await bootForms({
            endpoints: { x: { folder: 'x', name: 'one', token: 'secret' } },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
                body: JSON.stringify({ a: 1 }),
            })
            assert.equal(res.status, 201)
        } finally { await h.close() }
    })

    it('no token + loopback → accept (test runs on 127.0.0.1)', async () => {
        const h = await bootForms({
            endpoints: { x: { folder: 'x', name: 'one' } },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ a: 1 }),
            })
            assert.equal(res.status, 201)
        } finally { await h.close() }
    })

    it('token set + none presented + loopback → accept (BEHAVIOUR CHANGE)', async () => {
        // This used to 401. Forms hand-rolled the rule and required the
        // token even from localhost, while api and mcp let loopback through
        // — the "trusted local host" model. All three now share one
        // implementation (ADR-0012) and this is the shared answer.
        const h = await bootForms({
            endpoints: { x: { folder: 'x', name: 'one', token: 'secret' } },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ a: 1 }),
            })
            assert.equal(res.status, 201)
        } finally { await h.close() }
    })

    it('a wrong token is refused even from loopback, and challenges', async () => {
        // The bypass this guards: "presented but wrong" must never fall
        // through to the loopback allowance the way "not presented" does.
        const h = await bootForms({
            endpoints: { x: { folder: 'x', name: 'one', token: 'secret' } },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
                body: JSON.stringify({ a: 1 }),
            })
            assert.equal(res.status, 401)
            assert.equal(res.headers.get('www-authenticate'), 'Bearer')
        } finally { await h.close() }
    })

    it('accepts a verifier on `auth`, and gives it no loopback bypass', async () => {
        // A real verifier is not a shared secret keeping the internet out —
        // it gates every caller, localhost included.
        const verifier = {
            name: 'test',
            async verify(req) {
                const h = req.headers.authorization
                if (!h) return null
                return h === 'Bearer good' ? { subject: 'alice', capabilities: [] } : false
            },
        }
        const h = await bootForms({
            endpoints: { x: { folder: 'x', name: 'one', auth: verifier } },
        })
        try {
            const bare = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ a: 1 }),
            })
            assert.equal(bare.status, 401, 'loopback must not bypass a verifier')

            const ok = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
                body: JSON.stringify({ a: 1 }),
            })
            assert.equal(ok.status, 201)
        } finally { await h.close() }
    })

    it('accepts any of several tokens on one endpoint', async () => {
        const h = await bootForms({
            endpoints: { x: { folder: 'x', name: 'one', auth: ['tok-a', 'tok-b'] } },
        })
        try {
            for (const tok of ['tok-a', 'tok-b']) {
                const res = await fetch(`${h.url}/forms/x`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
                    body: JSON.stringify({ a: 1 }),
                })
                assert.equal(res.status, 201, `${tok} should be accepted`)
            }
            const bad = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer tok-c' },
                body: JSON.stringify({ a: 1 }),
            })
            assert.equal(bad.status, 401)
        } finally { await h.close() }
    })
})

describe('forms — captcha', () => {
    const originalFetch = globalThis.fetch
    beforeEach(() => {
        globalThis.fetch = originalFetch  // reset
    })
    after(() => {
        globalThis.fetch = originalFetch
    })

    it('rejects when provider returns success: false', async () => {
        const h = await bootForms({
            endpoints: {
                x: {
                    folder: 'x', name: 'one',
                    captcha: { provider: 'google-v3', secret: 's' },
                },
            },
        })
        try {
            // Stub the upstream captcha verify endpoint
            const realFetch = globalThis.fetch
            globalThis.fetch = async (u, opts) => {
                if (String(u).includes('recaptcha')) {
                    return new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input'] }), { status: 200 })
                }
                return realFetch(u, opts)
            }
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ a: 1, 'g-recaptcha-response': 'token' }),
            })
            assert.equal(res.status, 403)
            const body = await res.json()
            assert.match(body.reason, /captcha provider rejected/)
        } finally { await h.close() }
    })

    it('strips the token field before projection', async () => {
        const h = await bootForms({
            endpoints: {
                x: {
                    folder: 'x',
                    name:   'capture',
                    project: (data) => ({ meta: data }),
                    captcha: { provider: 'google-v3', secret: 's' },
                },
            },
        })
        try {
            const realFetch = globalThis.fetch
            globalThis.fetch = async (u, opts) => {
                if (String(u).includes('recaptcha')) {
                    return new Response(JSON.stringify({ success: true, score: 0.9 }), { status: 200 })
                }
                return realFetch(u, opts)
            }
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'X', 'g-recaptcha-response': 'token' }),
            })
            assert.equal(res.status, 201)
            const written = await readFile(path.join(h.documentsFolder, 'x', 'capture.md'), 'utf8')
            assert.doesNotMatch(written, /g-recaptcha-response/)
            assert.match(written, /name: X/)
        } finally { await h.close() }
    })

    it('failOpen=true accepts on network failure', async () => {
        const h = await bootForms({
            endpoints: {
                x: {
                    folder: 'x', name: 'one',
                    captcha: { provider: 'google-v3', secret: 's', failOpen: true },
                },
            },
        })
        try {
            const realFetch = globalThis.fetch
            globalThis.fetch = async (u, opts) => {
                if (String(u).includes('recaptcha')) throw new Error('network down')
                return realFetch(u, opts)
            }
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ a: 1, 'g-recaptcha-response': 'token' }),
            })
            assert.equal(res.status, 201)
        } finally { await h.close() }
    })

    it('failOpen=false rejects on network failure', async () => {
        const h = await bootForms({
            endpoints: {
                x: {
                    folder: 'x', name: 'one',
                    captcha: { provider: 'google-v3', secret: 's', failOpen: false },
                },
            },
        })
        try {
            const realFetch = globalThis.fetch
            globalThis.fetch = async (u, opts) => {
                if (String(u).includes('recaptcha')) throw new Error('network down')
                return realFetch(u, opts)
            }
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ a: 1, 'g-recaptcha-response': 'token' }),
            })
            assert.equal(res.status, 403)
        } finally { await h.close() }
    })

    it('custom verify function — pass', async () => {
        const h = await bootForms({
            endpoints: {
                x: {
                    folder: 'x', name: 'one',
                    captcha: { verify: async (data) => data.allow === true },
                },
            },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ allow: true }),
            })
            assert.equal(res.status, 201)
        } finally { await h.close() }
    })

    it('v3 minScore gate rejects low scores', async () => {
        const h = await bootForms({
            endpoints: {
                x: {
                    folder: 'x', name: 'one',
                    captcha: { provider: 'google-v3', secret: 's', minScore: 0.7 },
                },
            },
        })
        try {
            const realFetch = globalThis.fetch
            globalThis.fetch = async (u, opts) => {
                if (String(u).includes('recaptcha')) {
                    return new Response(JSON.stringify({ success: true, score: 0.4 }), { status: 200 })
                }
                return realFetch(u, opts)
            }
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ 'g-recaptcha-response': 'token' }),
            })
            assert.equal(res.status, 403)
        } finally { await h.close() }
    })
})

describe('forms — schema integration with mikser-io-schemas', () => {
    it('routes through the schemas service validate', async () => {
        let called
        const h = await bootForms({
            endpoints: {
                x: {
                    folder: 'x', name: 'one',
                    schema: 'mySchema',
                },
            },
        }, {
            // Provided as a service now, the way mikser-io-schemas offers it.
            provideServices: {
                schemas: {
                    validate: async (name, data) => {
                        called = { name, data }
                        return { ...data, typed: true }
                    },
                },
            },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ a: 1 }),
            })
            assert.equal(res.status, 201)
            assert.equal(called.name, 'mySchema')
            const written = await readFile(path.join(h.documentsFolder, 'x', 'one.md'), 'utf8')
            assert.match(written, /typed: true/)
        } finally { await h.close() }
    })

    it('throws at mount time when schema is declared but schemas plugin is missing', async () => {
        await assert.rejects(
            () => bootForms({
                endpoints: { x: { folder: 'x', name: 'one', schema: 'unknown' } },
            }),
            /mikser-io-schemas is not loaded/,
        )
    })

    it('validate function failure returns 400', async () => {
        const h = await bootForms({
            endpoints: {
                x: {
                    folder: 'x', name: 'one',
                    validate: (data) => {
                        if (!data.email) throw new Error('email required')
                    },
                },
            },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            })
            assert.equal(res.status, 400)
            const body = await res.json()
            assert.match(body.detail, /email required/)
        } finally { await h.close() }
    })
})

describe('forms — folder + name as function or string', () => {
    it('function returning falsy falls back to endpoint name', async () => {
        const h = await bootForms({
            endpoints: {
                x: {
                    folder: () => null,        // → defaults to 'x'
                    name:   () => undefined,   // → defaults to timestamp-random
                },
            },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            })
            assert.equal(res.status, 201)
            const body = await res.json()
            assert.match(body.id, /^\/documents\/x\/\d+-/)
        } finally { await h.close() }
    })

    it('rejects path-traversal in folder', async () => {
        const h = await bootForms({
            endpoints: {
                x: { folder: () => '../../../etc', name: 'one' },
            },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            })
            assert.equal(res.status, 500)
            const body = await res.json()
            assert.match(body.error, /path-traversal/)
        } finally { await h.close() }
    })

    it('rejects path-traversal in name', async () => {
        const h = await bootForms({
            endpoints: {
                x: { folder: 'x', name: () => '../etc/passwd' },
            },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            })
            assert.equal(res.status, 500)
        } finally { await h.close() }
    })
})

describe('forms — multipart uploads', () => {
    it('writes uploaded files alongside the document; project receives upload paths', async () => {
        const h = await bootForms({
            endpoints: {
                contact: {
                    folder: 'contact',
                    name:   (data) => `submission-${data.id}`,
                    project: (data, { uploads }) => ({
                        meta: { ...data, attachments: uploads.map(u => u.path) },
                    }),
                    uploads: {
                        folder: (data) => `contact/${data.id}`,
                        name:   (data, { originalName }) => originalName,
                        maxFileSize: 1024 * 1024,
                        maxFiles: 2,
                    },
                },
            },
        })
        try {
            const fd = new FormData()
            fd.append('id', 'abc')
            fd.append('email', 'x@y.z')
            fd.append('attachment', new Blob([Buffer.from('photo bytes')], { type: 'image/png' }), 'photo.png')

            const res = await fetch(`${h.url}/forms/contact`, {
                method: 'POST',
                body: fd,
            })
            assert.equal(res.status, 201)
            const body = await res.json()
            assert.equal(body.id, '/documents/contact/submission-abc.md')
            assert.equal(body.uploads.length, 1)
            assert.equal(body.uploads[0].field, 'attachment')
            assert.equal(body.uploads[0].path, '/files/contact/abc/photo.png')

            // Doc on disk references the upload
            const doc = await readFile(path.join(h.documentsFolder, 'contact', 'submission-abc.md'), 'utf8')
            assert.match(doc, /attachments:.*?\/files\/contact\/abc\/photo\.png/s)
            // Upload bytes on disk
            const file = await readFile(path.join(h.filesFolder, 'contact/abc/photo.png'))
            assert.equal(file.toString(), 'photo bytes')
        } finally { await h.close() }
    })

    it('files larger than maxFileSize are rejected', async () => {
        const h = await bootForms({
            endpoints: {
                contact: {
                    folder: 'contact',
                    name:   'sub',
                    uploads: {
                        folder: 'contact',
                        name: (d, { originalName }) => originalName,
                        maxFileSize: 100,   // 100 bytes — easy to exceed
                    },
                },
            },
        })
        try {
            const fd = new FormData()
            fd.append('attachment', new Blob([Buffer.alloc(500, 'x')], { type: 'image/png' }), 'big.png')
            const res = await fetch(`${h.url}/forms/contact`, {
                method: 'POST',
                body: fd,
            })
            assert.notEqual(res.status, 201)
        } finally { await h.close() }
    })

    it('mime not in allowedMimes is rejected', async () => {
        const h = await bootForms({
            endpoints: {
                contact: {
                    folder: 'contact',
                    name:   'sub',
                    uploads: {
                        folder: 'contact',
                        name: (d, { originalName }) => originalName,
                        allowedMimes: ['image/jpeg'],
                    },
                },
            },
        })
        try {
            const fd = new FormData()
            fd.append('attachment', new Blob([Buffer.from('x')], { type: 'image/png' }), 'x.png')
            const res = await fetch(`${h.url}/forms/contact`, {
                method: 'POST',
                body: fd,
            })
            // multer surfaces the fileFilter error before the handler runs
            assert.notEqual(res.status, 201)
        } finally { await h.close() }
    })
})

describe('forms — format', () => {
    it('format: yml writes pure YAML', async () => {
        const h = await bootForms({
            endpoints: {
                x: {
                    folder: 'x', name: 'one', format: 'yml',
                    project: (data) => ({ name: data.name, when: data.when }),
                },
            },
        })
        try {
            const res = await fetch(`${h.url}/forms/x`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'X', when: '2026' }),
            })
            assert.equal(res.status, 201)
            assert.equal(res.headers.get('content-type')?.includes('json'), true)
            const body = await res.json()
            assert.equal(body.id, '/documents/x/one.yml')
            const written = await readFile(path.join(h.documentsFolder, 'x', 'one.yml'), 'utf8')
            assert.doesNotMatch(written, /^---/)
            assert.match(written, /name: X/)
        } finally { await h.close() }
    })
})

describe('forms — mount-time errors', () => {
    it('throws when documents plugin is not loaded', async () => {
        const app = express()
        const runtime = { options: { app, workingFolder: '/tmp' } }   // no documentsFolder
        const handlers = []
        const core = {
            runtime,
            onLoaded: (cb) => handlers.push(cb),
            useLogger: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {} }),
        }
        forms({ endpoints: { x: { folder: 'x', name: 'a' } } })(core)
        await assert.rejects(
            () => handlers[0](),
            /documents plugin to be loaded/,
        )
    })

    it('throws when uploads is set but files plugin is not loaded', async () => {
        const app = express()
        const runtime = { options: { app, workingFolder: '/tmp', documentsFolder: '/tmp/d' } }
        const handlers = []
        const core = {
            runtime,
            onLoaded: (cb) => handlers.push(cb),
            useLogger: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {} }),
        }
        forms({
            endpoints: { x: { folder: 'x', name: 'a', uploads: { folder: 'u', name: 'f' } } },
        })(core)
        await assert.rejects(
            () => handlers[0](),
            /files plugin is not loaded/,
        )
    })
})
