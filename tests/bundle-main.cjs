// Bundles a main-process module (src/main/*.ts) for a test that runs it without Electron. Some modules import files as text
// ("./JavaDap.java?raw", as the real build does), which needs an esbuild plugin; plugins need the async API, so the build runs
// in a child process and bundleSync() waits for it.
//   const { bundleSync } = require('./bundle-main.cjs'); bundleSync({ entry, out, stub, external: ['ws'] })
const path = require('path'), fs = require('fs'), cp = require('child_process')

function bundleSync(o) {
  const r = cp.spawnSync(process.execPath, [__filename, JSON.stringify(o)], { cwd: path.join(__dirname, '..'), encoding: 'utf-8' })
  if (r.status !== 0) throw new Error('Build failed: ' + (r.stderr || r.stdout))
}
module.exports = { bundleSync }

if (require.main === module) {
  const o = JSON.parse(process.argv[2])
  require('esbuild').build({
    entryPoints: [o.entry], bundle: true, platform: 'node', format: 'cjs', external: o.external ?? [], alias: o.stub ? { electron: o.stub } : {}, outfile: o.out, logLevel: 'error',
    plugins: [{ name: 'raw', setup(b) { b.onResolve({ filter: /[?]raw$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.replace(/[?]raw$/, '')), namespace: 'raw' })); b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: fs.readFileSync(a.path, 'utf-8'), loader: 'text' })) } }]
  }).catch((e) => { console.error(e.message); process.exit(1) })
}
