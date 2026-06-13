# mikser-io-forms

Public form-submission endpoints for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). Receives JSON or `multipart/form-data` over HTTP, runs validation + captcha, writes the submission as a document file plus any uploaded files to disk. The `documents` and `files` plugins pick the new files up via their normal watch loop — same shape as a content author saving a file by hand.

## Why a separate write-side plugin

The `api` plugin already accepts authenticated catalog mutations (`PUT /entities`, `DELETE /entities`). That's the admin surface — token-gated, full-update semantics, intended for tooling.

Forms is the *public* surface. Contact forms, newsletter signups, job applications. Different audience, different shape:

- Submissions are append-only, not arbitrary mutations.
- Validation is the plugin's job, not the caller's.
- Captcha matters here; on `api` it doesn't.
- The plugin shouldn't trust the form to declare its own entity id, path, or schema — the endpoint config does.

Forms writes files. The documents / files plugins do their normal work. No bypass of the catalog, no race against the watcher.

## Install

```bash
npm install mikser-io-forms
```

Peer dependency: `mikser-io ^9.0.0`. Optional integration with `mikser-io-schemas` when an endpoint declares `schema:`. Multer is bundled as a runtime dependency.

## Configure

```js
// mikser.config.js
import { documents, files, layouts } from 'mikser-io'
import { forms } from 'mikser-io-forms'
import { schemas } from 'mikser-io-schemas'   // optional — for schema-by-name validation

export default {
    plugins: [
        documents(),
        files(),
        layouts(),
        schemas(/* ... */),
        forms({
            base: '/forms',                    // default '/forms'
            endpoints: {
                // POST /forms/contact
                contact: {
                    // Where the document file lands inside documentsFolder.
                    // String or (data) => string. Falsy → defaults to the endpoint name.
                    folder: 'contact',
                    // File name (no extension). String or (data) => string. Default = timestamp.
                    name: (data) => `${Date.now()}-${slugify(data.email)}`,
                    // 'md' (default) → YAML frontmatter + body. 'yml' → pure YAML.
                    format: 'md',

                    // Validation: route through mikser-io-schemas (preferred),
                    // a custom function (escape hatch), or both. Schema runs first.
                    schema:   'contactSubmission',
                    // validate: (data) => contactSchema.parse(data),

                    // Project the form data into the file shape. Default = { meta: data }.
                    // The second arg carries upload metadata so you can embed file paths.
                    project: (data, { uploads }) => ({
                        meta: { ...data, attachments: uploads.map(u => u.path), layout: 'submission' },
                        content: data.message,
                    }),

                    // Captcha. Omit → no verification.
                    captcha: {
                        provider:  'google-v3',                          // 'google-v2' | 'google-v3' | 'hcaptcha' | 'turnstile'
                        secret:    process.env.RECAPTCHA_SECRET,
                        minScore:  0.5,                                  // v3 only
                        timeoutMs: 5000,
                        failOpen:  true,                                 // accept on network error (default true)
                        // field:  'g-recaptcha-response',               // override; provider preset sets a sensible default
                        // verify: async (data, { req }) => boolean,     // escape hatch — ignores provider/secret
                    },

                    // Uploads. Omit → uploads disabled for this endpoint (multipart
                    // still parses but file fields are dropped).
                    uploads: {
                        // Where uploads land inside filesFolder. (data) only — per-submission, not per-file.
                        folder: (data) => `contact/${data.year}/${data.month}`,
                        // Per-file name. (data, { field, originalName, mimeType, size }) => string.
                        name: (data, { field, originalName }) =>
                            `${slugify(data.email)}-${field}-${originalName}`,
                        maxFileSize:     5 * 1024 * 1024,
                        maxFiles:     3,
                        allowedMimes: ['image/jpeg', 'image/png', 'application/pdf'],
                    },

                    // Auth. Mirror of the api plugin's uniform rule:
                    //   - token set → require `Authorization: Bearer <token>` on every request
                    //   - no token → loopback only (set allowRemote: true to relax)
                    token: process.env.CONTACT_FORM_TOKEN,
                    // allowRemote: false,
                },

                // Internal webhook — loopback-only, no captcha needed.
                webhook: {
                    folder:  'webhooks',
                    name:    () => crypto.randomUUID(),
                    project: (data) => ({ meta: { source: 'webhook', ...data } }),
                },
            },
        }),
    ],
}
```

## How it works

Per request:

1. **Auth check.** Token mismatch → `401`. No token + non-loopback → `401`.
2. **Multipart parse.** `multer` parses the body; uploaded files held in memory until validation passes.
3. **Captcha verify.** If `captcha` is set, the configured provider (or `verify` function) is called. Failure → `403`. Network failure honors `failOpen`.
4. **Schema validation.** If `schema:` is set, runs through `mikser-io-schemas`. Failure → `400`.
5. **Validate function.** If `validate:` is set, runs after schema. Failure → `400`.
6. **Resolve folder + name.** `string | (data) => string`. The result is path-sanitized — `..` segments are rejected.
7. **Write uploads.** Per-file: `mkdir -p` the upload folder, write the buffer.
8. **Project + write document.** Default projection: `{ meta: data }`. Format `'md'` → YAML frontmatter + content body. Format `'yml'` → pure YAML.
9. **Respond `201 { id, status: 'queued', uploads }`.** The `id` is the eventual entity id the documents plugin will assign once its watcher picks the file up.

The documents plugin's watch loop picks the new file up on the next cycle (or immediately, in watch mode) and registers the entity in the catalog. The files plugin does the same for uploads.

## Captcha providers

Built-in:

| Provider | Form field | Verify URL |
|---|---|---|
| `google-v2` | `g-recaptcha-response` | `https://www.google.com/recaptcha/api/siteverify` |
| `google-v3` | `g-recaptcha-response` | `https://www.google.com/recaptcha/api/siteverify` |
| `hcaptcha` | `h-captcha-response` | `https://hcaptcha.com/siteverify` |
| `turnstile` | `cf-turnstile-response` | `https://challenges.cloudflare.com/turnstile/v0/siteverify` |

Each accepts a `secret`. `google-v3` accepts `minScore` (default `0.5`). Override the form-field name with `field`. For anything else (private corporate captcha, no-network test mock), pass a `verify(data, { req }) => boolean` function — provider / secret are ignored when `verify` is set.

`failOpen` defaults to `true` — a provider outage doesn't take your form down. Flip to `false` if you'd rather reject than risk a brief unverified window.

## Composing with schemas

`mikser-io-forms` looks for `runtime.options.schemas.validate(name, data)`. If `mikser-io-schemas` exposes that surface, endpoints can declare `schema: 'name'` and the plugin routes validation through it — including the typed-output value that the schema returns. If `schema:` is set but the schemas plugin isn't loaded, you get a clear mount-time error instead of a silent skip.

## What it does NOT do

- **Does not call `createEntity`.** Writes files; the documents / files plugins do the catalog work.
- **Does not implement update / delete.** Submissions are append-only. For arbitrary CRUD on the catalog, use the `api` plugin.
- **Does not render or preview.** A submission becomes an entity on the next cycle; the SSE channel from `api` is how a frontend learns about it.

## License

MIT
