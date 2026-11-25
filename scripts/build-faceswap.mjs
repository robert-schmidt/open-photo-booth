// Bundles browser-inswapper (on-device face swap, by Chronic Qual SRL) for the renderer, which has no bundler:
// vendor/faceswap/faceswap.js and its two workers, plus the ONNX Runtime and MediaPipe files they load at run time.
// Runs before start, e2e and dist. The InsightFace models are not bundled: operators keep them in a folder (see main.js).
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..'), out = path.join(root, 'vendor/faceswap')
const lib = await fs.realpath(path.join(root, 'node_modules/browser-inswapper'))
// The library's own (pinned) ONNX Runtime and MediaPipe: nested under it if the app has another version, else hoisted.
async function dir(name) {
  for (const base of [lib, root]) {
    const d = path.join(base, 'node_modules', name)
    if (await fs.stat(d).then(() => true, () => false)) return d
  }
  throw new Error(`${name} not found; run npm install`)
}

await fs.rm(out, { recursive: true, force: true })
const common = { bundle: true, format: 'esm', target: 'es2022', platform: 'browser', outdir: out, logLevel: 'warning', legalComments: 'none' }
// The library's video-file features use mediabunny (MPL-2.0), loaded only when they're called. The booth doesn't
// use them, so a stub stands in and no MPL code ships.
const noVideo = { name: 'no-video', setup(b) {
  b.onResolve({ filter: /^mediabunny$/ }, () => ({ path: 'mediabunny', namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'throw new Error("Face swap in video files is not part of the booth")' }))
} }
await build({ ...common, entryPoints: { faceswap: path.join(lib, 'src/index.ts') }, plugins: [noVideo] })
await build({ ...common, entryPoints: { worker: path.join(lib, 'src/worker.ts'), 'segment-worker': path.join(lib, 'src/segment-worker.ts') } })
await fs.mkdir(path.join(out, 'ort'), { recursive: true })
const ort = path.join(await dir('onnxruntime-web'), 'dist')
for (const f of (await fs.readdir(ort)).filter(f => /^ort-wasm-simd-threaded\.jsep\.(mjs|wasm)$/.test(f))) await fs.copyFile(path.join(ort, f), path.join(out, 'ort', f))
await fs.cp(path.join(await dir('@mediapipe/tasks-vision'), 'wasm'), path.join(out, 'mediapipe'), { recursive: true, filter: f => !/module_internal/.test(f) })
await fs.copyFile(path.join(lib, 'LICENSE.md'), path.join(out, 'LICENSE.md'))
console.log('faceswap bundled:', (await fs.readdir(out)).join(', '))
