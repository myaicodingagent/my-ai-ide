// Bundles the cloud runner (src/runner/cloud-runner.ts) with the editor's agent code into one file for Node 18+ on a server:
// out/runner/cloud-runner.cjs. `npm run build` does this; the editor copies the file to the server when a cloud task starts.
const path = require('path'), fs = require('fs')
const root = path.join(__dirname, '..')
const outfile = path.join(root, 'out', 'runner', 'cloud-runner.cjs')
const sshStub = path.join(root, 'src', 'runner', 'sshfs-stub.ts')

require('esbuild').build({
  entryPoints: [path.join(root, 'src', 'runner', 'cloud-runner.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile,
  alias: { electron: path.join(root, 'src', 'runner', 'electron-stub.ts') },
  // The search model's runtime and image libraries are not needed here (search by meaning is off); folders are local to the server.
  external: ['@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web', 'sharp'],
  logLevel: 'error',
  plugins: [{
    name: 'runner',
    setup(b) {
      b.onResolve({ filter: /[?]raw$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.replace(/[?]raw$/, '')), namespace: 'raw' }))
      b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: fs.readFileSync(a.path, 'utf-8'), loader: 'text' }))
      b.onResolve({ filter: /(^|\/)sshfs$/ }, () => ({ path: sshStub }))
    }
  }]
}).then(() => console.log('built', path.relative(root, outfile), (fs.statSync(outfile).size / 1024).toFixed(0) + ' KB')).catch(() => process.exit(1))
