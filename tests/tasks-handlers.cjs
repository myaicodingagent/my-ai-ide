// Tests tasks.json / launch.json reading (src/main/tasks.ts) and the variable / dependency helpers (src/renderer/src/tasksRun.ts).
// `npm run test:tasks`: does not start the app.
const fs = require('fs'), os = require('os'), path = require('path')
const handlers = {}
global.__electronStub = { ipcMain: { handle: (n, f) => { handlers[n] = f } }, shell: {}, app: { getPath: () => os.tmpdir() }, safeStorage: {}, BrowserWindow: class {} }
const root = path.join(__dirname, '..')
const stub = path.join(root, 'node_modules', '.cache', 'tasks-stub.cjs')
fs.mkdirSync(path.dirname(stub), { recursive: true })
fs.writeFileSync(stub, 'module.exports = global.__electronStub')
const bundle = (entry, name) => { const out = path.join(root, 'node_modules', '.cache', name); require('esbuild').buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', alias: { electron: stub }, outfile: out, logLevel: 'error' }); return require(out) }
const tasks = bundle('src/main/tasks.ts', 'tasks-bundle.cjs')
const run = bundle('src/renderer/src/tasksRun.ts', 'tasksrun-bundle.cjs')
tasks.registerTaskHandlers()
const call = (n, ...a) => handlers[n]({}, ...a)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`) }
const mk = (n) => { const d = path.join(os.tmpdir(), 'tasks-test-' + n + '-' + process.pid); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d }
const w = (d, rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text) }

;(async () => {
  check('arguments with spaces or quotes are quoted, plain ones are not', tasks.quoteArg('plain-1.0/x') === 'plain-1.0/x' && tasks.quoteArg('a b') === "'a b'" && tasks.quoteArg("it's") === "'it''s'" && tasks.quoteArg('') === "''")

  const p = mk('proj')
  check('a folder without any files has no tasks and no problems', JSON.stringify(await call('tasks:load', p)) === JSON.stringify({ tasks: [], launch: [], tasksFile: null, launchFile: null, errors: [] }))

  w(p, '.vscode/tasks.json', `// VS Code style, with comments
{
  "version": "2.0.0",
  "tasks": [
    { "label": "build", "type": "shell", "command": "npm", "args": ["run", "build", "--", "--flag value"], "group": { "kind": "build", "isDefault": true }, "options": { "cwd": "\${workspaceFolder}/app" } },
    { "label": "lint", "command": "eslint ." , "group": "test", "detail": "Lint everything" },
    { "label": "all", "dependsOn": ["build", "lint"] },
    { "label": "single-dep", "dependsOn": "lint" },
    { "command": "no label" },
    { "label": "nothing" },
  ]
}`)
  w(p, 'package.json', JSON.stringify({ name: 'x', scripts: { start: 'node .', test: 'jest', 'build:prod': 'webpack -p', 'build': 'duplicate of a file task' } }))
  let info = await call('tasks:load', p)
  check('tasks come from .vscode/tasks.json (comments and trailing commas are fine)', info.tasksFile.endsWith(path.join('.vscode', 'tasks.json')) && info.tasks.filter((t) => t.source === 'file').map((t) => t.label).join() === 'build,lint,all,single-dep', JSON.stringify(info.tasks.map((t) => t.label)))
  const build = info.tasks.find((t) => t.label === 'build')
  check('command and arguments make one command line; an argument with a space is quoted', build.command === "npm run build -- '--flag value'" && build.group === 'build' && build.cwd === '${workspaceFolder}/app', build.command)
  check('a group may be a word or an object', info.tasks.find((t) => t.label === 'lint').group === 'test' && info.tasks.find((t) => t.label === 'lint').detail === 'Lint everything')
  check('dependsOn may be a list or a single name', JSON.stringify(info.tasks.find((t) => t.label === 'all').dependsOn) === '["build","lint"]' && JSON.stringify(info.tasks.find((t) => t.label === 'single-dep').dependsOn) === '["lint"]')
  check('mistakes are reported, not thrown (a task with no label, one with nothing to run)', info.errors.some((e) => /no "label"/.test(e)) && info.errors.some((e) => /"nothing" has no "command"/.test(e)), JSON.stringify(info.errors))
  const npm = info.tasks.filter((t) => t.source === 'npm')
  check('npm scripts are tasks too (a file task of the same name wins)', npm.map((t) => t.label).sort().join() === 'npm: build,npm: build:prod,npm: start,npm: test' || npm.map((t) => t.label).sort().join() === 'npm: build:prod,npm: start,npm: test', JSON.stringify(npm.map((t) => t.label)))
  check('npm start / test use the short form, others npm run, and build/test scripts get a group', npm.find((t) => t.label === 'npm: start').command === 'npm start' && npm.find((t) => t.label === 'npm: test').command === 'npm test' && npm.find((t) => t.label === 'npm: build:prod').command === 'npm run build:prod' && npm.find((t) => t.label === 'npm: build:prod').group === 'build' && npm.find((t) => t.label === 'npm: test').group === 'test')

  // .ai-ide wins over .vscode
  w(p, '.ai-ide/tasks.json', JSON.stringify({ tasks: [{ label: 'ours', command: 'echo ours' }] }))
  info = await call('tasks:load', p)
  check('.ai-ide/tasks.json is used in preference to .vscode/tasks.json', info.tasks.some((t) => t.label === 'ours') && !info.tasks.some((t) => t.label === 'build' && t.source === 'file') && info.tasksFile.includes('.ai-ide'))

  w(p, '.ai-ide/tasks.json', '{ "tasks": [ { oops')
  info = await call('tasks:load', p)
  check('a tasks file that is not valid JSON is reported with its name', info.errors.some((e) => /\.ai-ide\/tasks\.json: not valid JSON/.test(e)) && info.tasks.every((t) => t.source === 'npm'), JSON.stringify(info.errors))

  // launch
  w(p, '.vscode/launch.json', `{
  "version": "0.2.0",
  "configurations": [
    { "name": "Run app", "type": "node", "request": "launch", "program": "\${workspaceFolder}/src/app.js", "args": ["--port", "3000"], "cwd": "\${workspaceFolder}/src", "stopOnEntry": true, "env": { "MODE": "dev", "N": 5, "BAD": {} } },
    { "name": "Short", "program": "run.js" },
    { "name": "Chrome", "type": "chrome", "request": "launch", "program": "x" },
    { "name": "Attach", "type": "node", "request": "attach", "port": 9229 },
    { "name": "No program", "type": "node", "request": "launch" },
    { "type": "node", "program": "nameless.js" }
  ]
}`)
  info = await call('tasks:load', p)
  check('launch configurations are read from launch.json', info.launch.map((l) => l.name).join() === 'Run app,Short', JSON.stringify(info.launch.map((l) => l.name)))
  const app = info.launch[0]
  check('with arguments, folder, stop-on-entry and environment (numbers become text, objects are dropped)', JSON.stringify(app.args) === '["--port","3000"]' && app.cwd === '${workspaceFolder}/src' && app.stopOnEntry === true && JSON.stringify(app.env) === '{"MODE":"dev","N":"5"}', JSON.stringify(app))
  check('type and request may be left out', info.launch[1].program === 'run.js' && info.launch[1].stopOnEntry === false && info.launch[1].args.length === 0)
  check('configurations that cannot be run say why', info.errors.some((e) => /"Chrome".*only "node"/.test(e)) && info.errors.some((e) => /"Attach".*only "launch"/.test(e)) && info.errors.some((e) => /"No program" has no "program"/.test(e)) && info.errors.some((e) => /configurations\[5\] has no "name"/.test(e)), JSON.stringify(info.errors))

  // starter files
  const q = mk('empty')
  const tf = await call('tasks:ensure', q, 'tasks')
  const lf = await call('tasks:ensure', q, 'launch')
  check('a starter tasks.json and launch.json are created in .ai-ide', tf.endsWith(path.join('.ai-ide', 'tasks.json')) && lf.endsWith(path.join('.ai-ide', 'launch.json')) && fs.existsSync(tf) && fs.existsSync(lf))
  const info2 = await call('tasks:load', q)
  check('and the starter files are valid and listed', info2.errors.length === 0 && info2.tasks.length === 1 && info2.tasks[0].label === 'Say hello' && info2.launch.length === 1 && info2.launch[0].name === 'Run index.js', JSON.stringify(info2.errors))
  fs.writeFileSync(tf, '{ "tasks": [] }')
  check('an existing file is returned, not overwritten', (await call('tasks:ensure', q, 'tasks')) === tf && fs.readFileSync(tf, 'utf8') === '{ "tasks": [] }')
  w(q, '.vscode/tasks.json', '{}'); fs.rmSync(path.join(q, '.ai-ide'), { recursive: true })
  check('an existing .vscode file is used instead of creating a new one', (await call('tasks:ensure', q, 'tasks')).endsWith(path.join('.vscode', 'tasks.json')) && !fs.existsSync(path.join(q, '.ai-ide')))

  // variables and chains
  const ctx = { root: 'C:\\proj\\app', file: 'C:\\proj\\app\\src\\main.test.js' }
  check('variables like VS Code\'s are expanded', run.expandVars('${workspaceFolder}|${workspaceFolderBasename}|${file}|${fileBasename}|${fileBasenameNoExtension}|${fileExtname}|${fileDirname}|${relativeFile}', ctx) === 'C:\\proj\\app|app|C:\\proj\\app\\src\\main.test.js|main.test.js|main.test|.js|C:\\proj\\app\\src|src\\main.test.js', run.expandVars('${workspaceFolder}|${relativeFile}', ctx))
  check('unknown variables, and file ones with no file open, stay as written', run.expandVars('${env:HOME} ${file} ${fileBasename}', { root: 'r', file: null }) === '${env:HOME} ${file} ${fileBasename}')
  const t = [
    { label: 'a', command: 'echo a', dependsOn: [] }, { label: 'b', command: 'echo b', dependsOn: ['a'] },
    { label: 'c', command: '', dependsOn: ['a', 'b'] }, { label: 'loop1', command: 'x', dependsOn: ['loop2'] }, { label: 'loop2', command: 'y', dependsOn: ['loop1'] },
    { label: 'lost', command: 'z', dependsOn: ['nope'] }
  ]
  check('a task runs what it depends on first, each once, in order', JSON.stringify(run.taskChain(t, 'c').commands) === '["echo a","echo b"]' && JSON.stringify(run.taskChain(t, 'b').commands) === '["echo a","echo b"]')
  check('circular dependencies end instead of looping', run.taskChain(t, 'loop1').commands.length === 2)
  check('a missing dependency is reported', JSON.stringify(run.taskChain(t, 'lost').missing) === '["nope"]' && run.taskChain(t, 'lost').commands.join() === 'z')

  for (const d of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tasks-test-'))) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true })
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + (e && e.stack || e)); process.exit(1) })
