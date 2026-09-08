// A submission POSTed to a running server is processed without a restart.
//
// This is an integration test on purpose: the defect was not in any one
// function but in the gap between two of them. The plugin wrote the file
// correctly, the documents plugin imported files correctly, and nothing
// connected the two unless a chokidar watcher happened to be running. Every
// unit test passed throughout.
//
// So the shape of the run matters more than the assertions: real mikser, real
// HTTP, `--server` and NO `--watch` — the ordinary production shape, and the
// one where this failed. On gpoint-cms eleven submissions accumulated over 81
// minutes with no notification, through 585 render cycles, because an
// API-triggered cycle does not import from disk. Every restart flushed the
// backlog at once, which is what made it look intermittent.
//
// Enabling `--watch` in the consuming site is NOT the fix and is not tested as
// one: on gpoint-cms it had mikser rebuilding continuously, and a
// boot-blocking call from the web app landed in a gap and stopped online
// payment for three days. Watch is a development flag.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const rootOf = (name) => path.dirname(require.resolve(`${name}/package.json`))
const MIKSER_ROOT = rootOf('mikser-io')
const MIKSER_APP = path.join(MIKSER_ROOT, 'app.js')

// Everything the generated config imports by name, plus what those need in
// turn. Resolved from THIS package's own dependency tree, so the test runs
// against the checkouts beside it rather than whatever is published.
const NEEDED = {
    'mikser-io': MIKSER_ROOT,
    'mikser-io-layouts': rootOf('mikser-io-layouts'),
    'mikser-io-forms': path.resolve(import.meta.dirname, '..'),
}

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { forms } from 'mikser-io-forms'

export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({ layoutsFolder: 'layouts' }), renderHbs(),
        forms({
            endpoints: {
                contact: {
                    folder: 'contact',
                    name: ({ email }) => String(email).replace(/[^a-z0-9]+/gi, '-'),
                    project: (data) => ({ meta: { layout: 'notice', ...data } }),
                },
            },
        }),
    ],
}
`

async function startServer({ watch = false } = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-forms-live-'))
    await mkdir(path.join(dir, 'layouts'), { recursive: true })
    await mkdir(path.join(dir, 'documents'), { recursive: true })
    await writeFile(path.join(dir, 'mikser.config.js'), CONFIG)

    // The config lives outside any node_modules tree and imports the packages
    // by name, and NODE_PATH does nothing for ESM — resolution walks up from
    // the importing FILE. So the packages are symlinked in, the same way the
    // engine's own scenario harness does it.
    const modules = path.join(dir, 'node_modules')
    await mkdir(modules, { recursive: true })
    for (const [name, target] of Object.entries(NEEDED)) {
        await symlink(target, path.join(modules, name), 'dir')
    }
    await writeFile(path.join(dir, 'layouts', 'notice.hbs'),
        '<p>{{entity.meta.email}}</p>')

    const port = 30000 + Math.floor(Math.random() * 20000)
    const args = ['--no-warnings', MIKSER_APP, '--working-folder', dir, '--server', String(port)]
    if (watch) args.push('--watch')
    const proc = spawn('node', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
    })
    let log = ''
    proc.stdout.on('data', (d) => { log += d.toString() })
    proc.stderr.on('data', (d) => { log += d.toString() })

    // Wait for the first cycle to finish — `started` gates createdHook, so a
    // submission before it is legitimately answered "written".
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !/Mikser completed|Listening|server/i.test(log)) {
        await new Promise(r => setTimeout(r, 100))
    }
    return {
        dir, port, proc,
        get log() { return log },
        stop: () => new Promise((resolve) => {
            proc.once('exit', resolve)
            proc.kill('SIGTERM')
            setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 5000)
        }),
    }
}

// Poll rather than sleep once: scheduleProcess is a 1s trailing debounce, so
// the cycle lands somewhere after the response, not at a fixed offset.
async function waitFor(predicate, { timeout = 20_000 } = {}) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (await predicate()) return true
        await new Promise(r => setTimeout(r, 200))
    }
    return false
}

describe('a live server with no watcher', () => {
    let server
    after(async () => {
        if (server) { await server.stop(); await rm(server.dir, { recursive: true, force: true }) }
    })

    it('imports and renders a submission without a restart', async () => {
        server = await startServer({ watch: false })
        assert.doesNotMatch(server.log, /--watch|Watching/i,
            'precondition: no watcher, or this tests the path that always worked')

        const res = await fetch(`http://127.0.0.1:${server.port}/forms/contact`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'live@example.com' }),
        })
        const raw = await res.text()
        assert.equal(res.status, 201, raw)
        const body = JSON.parse(raw)
        assert.equal(body.status, 'queued',
            `the endpoint claims it is queued, so something must be about to read it\n${server.log}`)

        const output = path.join(server.dir, 'out', 'contact', 'live-example-com', 'index.html')
        const rendered = await waitFor(() => existsSync(output))
        assert.ok(rendered,
            'the submission was never processed — this is the defect, and no restart happened\n'
            + `looked for ${output}\n${server.log}`)
    })
})

describe('a live server WITH a watcher', () => {
    let server
    after(async () => {
        if (server) { await server.stop(); await rm(server.dir, { recursive: true, force: true }) }
    })

    it('renders the submission once, not twice', async () => {
        // Both paths now announce the same file: the explicit hook plus
        // chokidar's `add`. Nothing here adds its own dedupe, and it does not
        // need to — scheduleProcess clears and re-arms one trailing timer, so
        // two announcements milliseconds apart collapse into a single
        // runtime.process(); and identical content means an identical
        // checksum, so the manifest gates the second render.
        //
        // Worth asserting rather than assuming, because the layer that does
        // NOT dedupe is runtime.sync — it returns true unless a hook says
        // otherwise — so the file may well be re-imported. That is harmless
        // only as long as the two layers below it hold.
        server = await startServer({ watch: true })

        const res = await fetch(`http://127.0.0.1:${server.port}/forms/contact`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'watched@example.com' }),
        })
        assert.equal(res.status, 201, await res.text())

        const output = path.join(server.dir, 'out', 'contact', 'watched-example-com', 'index.html')
        assert.ok(await waitFor(() => existsSync(output)),
            `never rendered under --watch\n${server.log}`)

        // Let any second announcement arrive and be acted on before counting.
        await new Promise(r => setTimeout(r, 4000))
        const renders = [...server.log.matchAll(/Rendered: (\d+)/g)]
            .map(m => Number(m[1]))
            .reduce((a, b) => a + b, 0)
        assert.equal(renders, 1,
            `the submission must be rendered exactly once, not once per announcement\n${server.log}`)
    })
})
