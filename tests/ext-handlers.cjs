// Runs the real extension manager (src/main/extensions.ts) with a stub for Electron: installing .vsix packages,
// theme conversion, snippets, the extension host process, and the registry client (against a fake registry).
// `npm run test:ext`: does not start the app.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const AdmZip = require('adm-zip')
const handlers = {}
const sent = []
let responder = null
const tmpRoot = path.join(os.tmpdir(), 'ext-test-' + process.pid)
fs.rmSync(tmpRoot, { recursive: true, force: true }); fs.mkdirSync(tmpRoot, { recursive: true })
const win = { webContents: { send: (ch, ...a) => { sent.push([ch, ...a]); if (ch === 'ext:request' && responder) setTimeout(() => responder(a[0]), 0) } } }
global.__electronStub = {
  ipcMain: { handle: (name, fn) => { handlers[name] = fn }, on: () => {} },
  shell: { openPath: async () => '' }, dialog: {}, BrowserWindow: class {}, safeStorage: {}, clipboard: { writeText: (t) => { global.__clip = t } },
  app: { getPath: () => path.join(tmpRoot, 'userData') }
}
const root = path.join(__dirname, '..')
const stubFile = path.join(root, 'node_modules', '.cache', 'ext-electron-stub.cjs')
const bundleFile = path.join(root, 'node_modules', '.cache', 'ext-bundle.cjs')
fs.mkdirSync(path.dirname(stubFile), { recursive: true })
fs.writeFileSync(stubFile, 'module.exports = global.__electronStub')
const buildBundle = () => require('esbuild').build({
  entryPoints: [path.join(root, 'src', 'main', 'extensions.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['adm-zip', '@anthropic-ai/sdk'], alias: { electron: stubFile }, outfile: bundleFile, logLevel: 'error',
  plugins: [{ name: 'raw', setup(b) { b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.replace(/\?raw$/, '')), namespace: 'raw' })); b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: 'export default ' + JSON.stringify(fs.readFileSync(a.path, 'utf8')), loader: 'js' })) } }]
})
delete process.env.ANTHROPIC_API_KEY
let mod
const call = (n, ...a) => handlers[n]({}, ...a)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 240) : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))


// A zip written by hand, so entry names are stored exactly as given (AdmZip tidies "../" away when adding files).
function rawZip(file, entries) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const parts = []; const central = []; let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameB = Buffer.from(name), data = Buffer.from(text), crc = crc32(data)
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26)
    parts.push(lh, nameB, data)
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42)
    central.push(ch, nameB)
    offset += lh.length + nameB.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  fs.writeFileSync(file, Buffer.concat([...parts, cd, end]))
  return file
}

function vsix(name, files) {
  const z = new AdmZip()
  z.addFile('[Content_Types].xml', Buffer.from('<Types/>'))
  for (const [p, text] of Object.entries(files)) z.addFile(p, Buffer.from(text))
  const f = path.join(tmpRoot, name)
  z.writeZip(f)
  return f
}

;(async () => {
  await buildBundle()
  mod = require(bundleFile)
  mod.registerExtensionHandlers(() => win)
  // ---- a theme extension (JSONC, include, transparency)
  const themeVsix = vsix('night.vsix', {
    'extension/package.json': JSON.stringify({
      name: 'night', publisher: 'acme', version: '1.0.0', displayName: 'Night Owl Test', description: 'A dark theme',
      contributes: { themes: [{ label: 'Night Test', uiTheme: 'vs-dark', path: './themes/night.json' }], grammars: [{ language: 'x', scopeName: 'source.x', path: './g.json' }] }
    }),
    'extension/themes/base.json': '{ "tokenColors": [ { "scope": ["comment"], "settings": { "foreground": "#637777" } } ] }',
    'extension/themes/night.json': `// a theme with comments
{
  "include": "./base.json",
  /* block comment */
  "name": "Night",
  "colors": {
    "editor.background": "#011627",
    "editor.foreground": "#d6deeb",
    "sideBar.background": "#010e1a",
    "button.background": "#7e57c2",
    "editor.selectionBackground": "#1d3b53cc",
    "errorForeground": "#ef5350",
  },
  "tokenColors": [
    { "scope": "keyword", "settings": { "foreground": "#c792ea" } },
    { "scope": ["string", "string.quoted"], "settings": { "foreground": "#ecc48d" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#f78c6c" } },
    { "scope": "entity.name.function", "settings": { "foreground": "#82aaff" } },
    { "scope": "entity.name.type", "settings": { "foreground": "#ffcb8b" } },
    { "scope": "variable", "settings": { "foreground": "#d6deeb" } },
    { "scope": "keyword.control", "settings": { "foreground": "#ff0000" } },
  ]
}`,
    'extension/g.json': '{}'
  })
  let r = await call('ext:installVsix', themeVsix)
  check('a theme package installs', r.ok === true && r.ext.id === 'acme.night' && r.ext.themes === 1 && r.ext.displayName === 'Night Owl Test', JSON.stringify(r).slice(0, 200))
  check('contributions that are not supported are listed, and it runs no code', r.ext.unsupported.includes('grammars') && r.ext.native === false && r.ext.codeIgnored === false)
  const themes = await mod.extensionThemes()
  check('its theme is offered to the theme list under an ext- file name', themes.length === 1 && /^ext-acme\.night-Night_Test\.json$/.test(themes[0].file), JSON.stringify(themes.map((t) => t.file)))
  const t = JSON.parse(themes[0].text)
  check('the converted theme has the name, type and base', t.name === 'Night Test' && t.type === 'dark' && t.base === 'dark-modern')
  check('editor and sidebar colours come from the VS Code colours', t.ui.bg === '#011627' && t.ui.side === '#010e1a' && t.ui.fg === '#d6deeb' && t.ui.accent === '#7e57c2' && t.ui.danger === '#ef5350', JSON.stringify(t.ui))
  check('a transparent colour is blended with the background', /^#[0-9a-f]{6}$/.test(t.ui.sel) && t.ui.sel !== '#1d3b53', t.ui.sel)
  check('syntax colours are picked from the matching scopes (and the most specific rule wins)', t.syntax.keyword === '#c792ea' && t.syntax.string === '#ecc48d' && t.syntax.number === '#f78c6c' && t.syntax.func === '#82aaff' && t.syntax.type === '#ffcb8b', JSON.stringify(t.syntax))
  check('rules from an included file are used', t.syntax.comment === '#637777')
  check('the other themes\' colours that the theme does not define are left to the base theme', !('hover' in t.ui) || /^#[0-9a-f]{6}$/.test(t.ui.hover))

  // ---- snippets
  const snipVsix = vsix('snips.vsix', {
    'extension/package.json': JSON.stringify({ name: 'snips', publisher: 'acme', version: '0.2.0', contributes: { snippets: [{ language: 'javascript', path: './s.json' }, { language: 'python', path: './missing.json' }] } }),
    'extension/s.json': `{
  // comment
  "Log": { "prefix": ["log", "cl"], "body": ["console.log($1)", "$0"], "description": "Print" },
  "Fn": { "prefix": "fn", "body": "function \${1:name}() {}" },
}`
  })
  r = await call('ext:installVsix', snipVsix)
  check('a snippet package installs', r.ok && r.ext.snippets === 2)
  const sn = await call('ext:snippets')
  const js = sn.find((s) => s.language === 'javascript')
  check('snippets are returned per language, one entry per prefix, bodies joined', !!js && js.snippets.map((x) => x.prefix).sort().join() === 'cl,fn,log' && js.snippets.find((x) => x.prefix === 'log').body === 'console.log($1)\n$0' && js.snippets.find((x) => x.prefix === 'fn').description === 'Fn', JSON.stringify(js))
  check('a missing snippet file is skipped without breaking the others', !sn.some((s) => s.language === 'python'))

  // ---- bad packages
  const slip = rawZip(path.join(tmpRoot, 'slip.vsix'), { 'extension/package.json': JSON.stringify({ name: 'slip', publisher: 'x', version: '1.0.0' }), 'extension/../../../evil.txt': 'owned' })
  r = await call('ext:installVsix', slip)
  check('a package with a path that escapes its folder is refused', r.ok === false && !fs.existsSync(path.join(tmpRoot, 'evil.txt')) && !fs.existsSync(path.join(tmpRoot, 'userData', 'evil.txt')), JSON.stringify(r))
  r = await call('ext:installVsix', vsix('plain.zip', { 'readme.txt': 'hello' }))
  check('a zip that is not an extension is refused with a clear message', r.ok === false && /not an extension/.test(r.error), JSON.stringify(r))
  r = await call('ext:installVsix', vsix('noversion.vsix', { 'extension/package.json': JSON.stringify({ name: 'nv', publisher: 'x' }) }))
  check('a package without a version is refused', r.ok === false && /version/.test(r.error))
  r = await call('ext:installVsix', vsix('vscode-code.vsix', { 'extension/package.json': JSON.stringify({ name: 'vscodey', publisher: 'ms', version: '1.0.0', main: './out/ext.js', contributes: { commands: [{ command: 'x.y', title: 'X' }], languages: [] } }), 'extension/out/ext.js': 'require("vscode")' }))
  check('a VS Code extension with code is installed as one that runs against the vscode module, with its commands listed', r.ok && r.ext.vscode === true && r.ext.native === false && r.ext.commands.length === 1 && r.ext.commands[0].id === 'x.y' && r.ext.unsupported.includes('languages'), JSON.stringify(r.ext))
  r = await call('ext:installVsix', path.join(tmpRoot, 'nope.vsix'))
  check('a file that does not exist is reported', r.ok === false)

  // ---- a native extension running in the extension host
  const project = path.join(tmpRoot, 'project'); fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(project, 'a.txt'), 'file contents')
  fs.writeFileSync(path.join(tmpRoot, 'outside.txt'), 'secret')
  const nativeVsix = vsix('hello.vsix', {
    'extension/package.json': JSON.stringify({ name: 'hello', publisher: 'me', version: '1.0.0', engines: { 'my-ai-ide': '*' }, main: 'main.js', contributes: { commands: [{ command: 'hello.upper', title: 'Upper Case Selection' }, { command: 'hello.fail', title: 'Fail' }, { command: 'hello.escape', title: 'Escape' }] } }),
    'extension/main.js': `exports.activate = (ide) => {
  ide.commands.register('hello.upper', async () => {
    const ed = await ide.editor.getActive()
    await ide.editor.replaceSelection(ed.selection.toUpperCase())
    await ide.window.showMessage('upper-case done in ' + ed.path, 'info')
    const answer = await ide.window.showInput({ prompt: 'Name?', value: 'x' })
    await ide.window.showMessage('input was ' + answer)
    await ide.window.showMessage('file: ' + await ide.workspace.readFile('a.txt'))
    await ide.workspace.writeFile('out/written.txt', 'from the extension')
  })
  ide.commands.register('hello.fail', async () => { throw new Error('this command failed on purpose') })
  ide.commands.register('hello.escape', async () => { await ide.workspace.readFile('../outside.txt') })
}`
  })
  r = await call('ext:installVsix', nativeVsix)
  check('a native extension installs and lists its commands', r.ok && r.ext.native === true && r.ext.commands.map((c) => c.id).join() === 'hello.upper,hello.fail,hello.escape', JSON.stringify(r.ext.commands))
  await call('ext:setRoot', project)
  const seen = []
  responder = (req) => {
    seen.push(req)
    const answer = (result) => call('ext:respond', req.reqId, { result })
    if (req.method === 'getEditor') answer({ path: 'x.js', language: 'javascript', text: 'abc def', selection: 'abc' })
    else if (req.method === 'input') answer('Ada')
    else answer(null)
  }
  let run = await call('ext:run', 'me.hello', 'hello.upper')
  check('running a command works', run.ok === true, JSON.stringify(run))
  const methods = seen.map((s) => s.method)
  check('the extension asked the editor for the selection and replaced it with the upper-cased text', methods.includes('getEditor') && seen.find((s) => s.method === 'replaceSelection').params.text === 'ABC', methods.join())
  const messages = seen.filter((s) => s.method === 'message').map((s) => s.params.text)
  check('it showed messages, got the input answer and read a file of the project through the host', messages[0] === 'upper-case done in x.js' && messages[1] === 'input was Ada' && messages[2] === 'file: file contents', JSON.stringify(messages))
  check('and wrote a file inside the project folder', fs.readFileSync(path.join(project, 'out', 'written.txt'), 'utf8') === 'from the extension')
  check('the editor is told that a file changed', sent.some((s) => s[0] === 'ext:request' && s[1].method === 'fileChanged'))
  run = await call('ext:run', 'me.hello', 'hello.fail')
  check('a command that throws reports its error', run.ok === false && /failed on purpose/.test(run.error), JSON.stringify(run))
  run = await call('ext:run', 'me.hello', 'hello.escape')
  check('an extension cannot read outside the project folder through the API', run.ok === false && /outside the project/.test(run.error), JSON.stringify(run))
  run = await call('ext:run', 'me.hello', 'hello.unknown')
  check('an unknown command is reported', run.ok === false && /did not register/.test(run.error))

  // ---- an extension written for VS Code, running against the partial `vscode` module ----
  const runC = async (e, c) => { const r = await call('ext:run', e, c); await sleep(250); return r } // messages are answered a moment after the command ends
  fs.writeFileSync(path.join(project, 'notes.txt'), 'x'); fs.mkdirSync(path.join(project, 'sub'), { recursive: true }); fs.writeFileSync(path.join(project, 'sub', 'more.txt'), 'y'); fs.writeFileSync(path.join(project, 'skip.md'), 'z')
  const vscVsix = vsix('vsc.vsix', {
    'extension/package.json': JSON.stringify({
      name: 'vsc', publisher: 'dev', version: '1.0.0', displayName: 'VSC Test', main: './extension.js', activationEvents: ['*'], engines: { vscode: '^1.80.0' },
      contributes: {
        commands: [{ command: 'vsc.upper', title: 'Upper', category: 'VSC' }, { command: 'vsc.pick', title: 'Pick' }, { command: 'vsc.diag', title: 'Diag' }, { command: 'vsc.cfg', title: 'Cfg' }, { command: 'vsc.count', title: 'Count' }, { command: 'vsc.web', title: 'Web' }, { command: 'vsc.find', title: 'Find' }, { command: 'vsc.uri', title: 'Uri' }, { command: 'vsc.pos', title: 'Pos' }, { command: 'vsc.clip', title: 'Clip' }, { command: 'vsc.exec', title: 'Exec' }],
        configuration: { title: 'VSC', properties: { 'vsc.greeting': { type: 'string', default: 'hi there' }, 'vsc.size': { type: 'number', default: 7 } } },
        languages: [{ id: 'x' }], grammars: [{ language: 'x', scopeName: 'source.x', path: './g.json' }]
      }
    }),
    'extension/extension.js': `const vscode = require('vscode')
exports.activate = (context) => {
  context.subscriptions.push(vscode.commands.registerCommand('vsc.upper', async () => {
    const ed = vscode.window.activeTextEditor
    if (!ed) { vscode.window.showErrorMessage('no editor'); return }
    const sel = ed.selection
    const text = ed.document.getText(sel)
    await ed.edit((b) => b.replace(sel, text.toUpperCase()))
    vscode.window.showInformationMessage('upper: ' + ed.document.languageId + ' ' + ed.document.lineCount + ' ' + sel.isEmpty + ' ' + ed.document.lineAt(1).text)
  }))
  vscode.commands.registerCommand('vsc.pick', async () => {
    const choice = await vscode.window.showQuickPick(['one', 'two', 'three'], { placeHolder: 'pick' })
    const name = await vscode.window.showInputBox({ prompt: 'Name?' })
    const answer = await vscode.window.showWarningMessage('Sure?', 'Yes', 'No')
    vscode.window.showInformationMessage(choice + '/' + name + '/' + answer)
  })
  const diag = vscode.languages.createDiagnosticCollection('t')
  vscode.commands.registerCommand('vsc.diag', () => {
    const ed = vscode.window.activeTextEditor
    diag.set(ed.document.uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 3), 'bad word', vscode.DiagnosticSeverity.Warning)])
  })
  vscode.languages.registerCompletionItemProvider('plaintext', { provideCompletionItems(doc, pos) {
    const word = doc.getText(doc.getWordRangeAtPosition(pos) || new vscode.Range(pos, pos))
    return [new vscode.CompletionItem('hello-' + word, vscode.CompletionItemKind.Snippet), { label: 'snip', insertText: new vscode.SnippetString('a\${1:b}'), detail: 'd' }]
  } }, '.')
  vscode.languages.registerHoverProvider('plaintext', { provideHover(doc, pos) { return new vscode.Hover(new vscode.MarkdownString('**hover** at ' + pos.line + ':' + pos.character)) } })
  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
  sb.text = 'VSC ready'; sb.command = 'vsc.upper'; sb.tooltip = 'tip'; sb.show()
  const cfg = vscode.workspace.getConfiguration('vsc')
  vscode.commands.registerCommand('vsc.cfg', () => vscode.window.showInformationMessage('cfg ' + cfg.get('greeting') + ' ' + cfg.get('size') + ' ' + cfg.get('missing', 'dflt') + ' ' + cfg.has('size')))
  context.globalState.update('count', context.globalState.get('count', 0) + 1)
  vscode.commands.registerCommand('vsc.count', () => vscode.window.showInformationMessage('count ' + context.globalState.get('count')))
  vscode.commands.registerCommand('vsc.web', () => vscode.window.createTerminal('x'))
  vscode.commands.registerCommand('vsc.find', async () => { const files = await vscode.workspace.findFiles('**/*.txt'); vscode.window.showInformationMessage('found ' + files.map((f) => vscode.workspace.asRelativePath(f)).sort().join(',') + ' in ' + vscode.workspace.workspaceFolders[0].name) })
  vscode.commands.registerCommand('vsc.uri', () => { const u = vscode.Uri.file('/a/b c.txt'); vscode.window.showInformationMessage(u.scheme + '|' + u.path + '|' + vscode.Uri.joinPath(u, '..', 'd.txt').path + '|' + vscode.Uri.parse('https://x.org/p?q=1#f').query) })
  vscode.commands.registerCommand('vsc.pos', () => {
    const doc = vscode.window.activeTextEditor.document
    const p = doc.positionAt(14)
    vscode.window.showInformationMessage(p.line + ':' + p.character + ' ' + doc.offsetAt(new vscode.Position(1, 3)) + ' ' + new vscode.Range(2, 5, 1, 1).start.line + ' ' + doc.getText(new vscode.Range(0, 6, 0, 11)))
  })
  vscode.commands.registerCommand('vsc.clip', async () => { await vscode.env.clipboard.writeText('copied text') })
  vscode.commands.registerCommand('vsc.exec', async () => { await vscode.commands.executeCommand('vsc.cfg'); await vscode.commands.executeCommand('no.such.command') })
  vscode.workspace.onDidChangeTextDocument((e) => vscode.window.setStatusBarMessage('doc changed ' + e.document.lineCount))
  vscode.window.onDidChangeActiveTextEditor((ed) => { if (ed) vscode.window.setStatusBarMessage('editor ' + require('path').basename(ed.document.fileName)) })
}
exports.deactivate = () => {}
`,
    'extension/g.json': '{}'
  })
  r = await call('ext:installVsix', vscVsix)
  check('a VS Code extension installs with its commands (category first) and settings noted, grammars unused', r.ok && r.ext.vscode === true && r.ext.native === false && r.ext.commands[0].title === 'VSC: Upper' && r.ext.commands.length === 11 && r.ext.unsupported.includes('languages') && r.ext.unsupported.includes('grammars'), JSON.stringify(r.ext))
  await sleep(500)
  seen.length = 0
  const edState = { path: path.join(project, 'doc.txt'), language: 'plaintext', text: 'hello world\nsecond line', selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 5 } }] }
  await call('ext:editorState', edState)
  await call('ext:setRoot', project) // restarts the host with the editor state still to come
  await sleep(300)
  await call('ext:editorState', edState)
  responder = (req) => {
    seen.push(req)
    const answer = (result) => call('ext:respond', req.reqId, { result })
    if (req.method === 'quickPick') answer(1)
    else if (req.method === 'input') answer('Ada')
    else if (req.method === 'message') answer(req.params.items && req.params.items.length ? req.params.items[0] : null)
    else answer(null)
  }
  const msgs = () => seen.filter((x) => x.method === 'message').map((x) => x.params.text)
  run = await runC('dev.vsc', 'vsc.upper')
  check('a command reads the open file through vscode.window.activeTextEditor and edits it', run.ok === true && JSON.stringify(seen.find((x) => x.method === 'applyEdits')?.params.edits) === JSON.stringify([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, text: 'HELLO' }]), JSON.stringify(run) + JSON.stringify(seen.map((x) => x.method)))
  check('the document, selection and line access work (language, line count, selection, lineAt)', msgs().includes('upper: plaintext 2 false second line'), JSON.stringify(msgs()))
  seen.length = 0
  run = await runC('dev.vsc', 'vsc.pick')
  check('quick pick, input box and message buttons reach the editor and bring answers back', run.ok && msgs().includes('two/Ada/Yes') && seen.find((x) => x.method === 'quickPick').params.items.map((i) => i.label).join() === 'one,two,three' && seen.find((x) => x.method === 'message' && x.params.items?.length).params.items.join() === 'Yes,No', JSON.stringify(msgs()))
  seen.length = 0
  run = await runC('dev.vsc', 'vsc.diag')
  const dg = sent.filter((x) => x[0] === 'ext:request' && x[1].method === 'setDiagnostics').pop()
  check('diagnostics are sent for the file, with range, message and severity', run.ok && !!dg && dg[1].params.path === edState.path && dg[1].params.items[0].message === 'bad word' && dg[1].params.items[0].severity === 1 && dg[1].params.items[0].range.end.character === 3, JSON.stringify(dg && dg[1].params))
  const sbs = sent.filter((x) => x[0] === 'ext:request' && x[1].method === 'statusBar' && x[1].params.text === 'VSC ready').pop()
  check('a status bar item is shown with its text, tooltip and command', !!sbs && sbs[1].params.visible === true && sbs[1].params.command === 'vsc.upper' && sbs[1].params.tooltip === 'tip', JSON.stringify(sbs && sbs[1].params))
  const reg = sent.filter((x) => x[0] === 'ext:request' && x[1].method === 'registerProvider').map((x) => x[1].params)
  const comp = reg.find((p) => p.kind === 'completion'), hov = reg.find((p) => p.kind === 'hover')
  check('providers are registered for their language, completion with trigger characters', !!comp && comp.languages.join() === 'plaintext' && comp.triggerCharacters.join() === '.' && !!hov, JSON.stringify(reg))
  const items = await call('ext:provide', comp.id, 'completion', { path: edState.path, language: 'plaintext', text: edState.text, position: { line: 0, character: 3 } })
  check('the editor can ask a completion provider and gets items (labels, kinds, snippets)', Array.isArray(items) && items[0].label === 'hello-hello' && items[0].kind === 14 && items[1].isSnippet === true && items[1].insertText === 'a${1:b}' && items[1].detail === 'd', JSON.stringify(items))
  const hv = await call('ext:provide', hov.id, 'hover', { path: edState.path, language: 'plaintext', text: edState.text, position: { line: 1, character: 2 } })
  check('and a hover provider', hv && hv.contents[0] === '**hover** at 1:2', JSON.stringify(hv))
  seen.length = 0
  await runC('dev.vsc', 'vsc.cfg')
  check('settings the extension declares answer getConfiguration().get() with their defaults', msgs().includes('cfg hi there 7 dflt true'), JSON.stringify(msgs()))
  seen.length = 0
  await runC('dev.vsc', 'vsc.count')
  const c1 = msgs()[0]
  await call('ext:setRoot', project + '2'); await call('ext:setRoot', project); await sleep(300) // restarts the host
  seen.length = 0
  await runC('dev.vsc', 'vsc.count')
  check('globalState is kept between runs of the host', c1 === 'count 1' && msgs()[0] === 'count 2', c1 + ' / ' + msgs()[0])
  seen.length = 0
  await call('ext:editorState', edState)
  await runC('dev.vsc', 'vsc.find')
  check('workspace.findFiles and workspaceFolders work', msgs()[0] === 'found a.txt,notes.txt,out/written.txt,sub/more.txt in project', JSON.stringify(msgs()))
  seen.length = 0
  await runC('dev.vsc', 'vsc.uri')
  check('Uri.file, joinPath and parse behave like VS Code\'s', msgs()[0] === 'file|/a/b c.txt|/a/d.txt|q=1', JSON.stringify(msgs()))
  seen.length = 0
  await runC('dev.vsc', 'vsc.pos')
  check('Position, Range and the document\'s offset conversions work', msgs()[0] === '1:2 15 1 world', JSON.stringify(msgs()))
  global.__clip = ''
  await runC('dev.vsc', 'vsc.clip')
  await sleep(100)
  check('env.clipboard.writeText puts text on the clipboard', global.__clip === 'copied text')
  seen.length = 0
  run = await runC('dev.vsc', 'vsc.exec')
  check('executeCommand runs other extension commands, and an unknown one is an error', run.ok === false && /no\.such\.command/.test(run.error) && msgs().some((m) => /^cfg /.test(m)), JSON.stringify([run, msgs()]))
  run = await runC('dev.vsc', 'vsc.web')
  check('something that cannot be provided says so by name instead of failing silently', run.ok === false && /createTerminal is not supported/.test(run.error), JSON.stringify(run))
  const logs = await call('ext:log')
  check('nothing went wrong while the extension started', !logs.some((l) => /failed to start/.test(l)), JSON.stringify(logs.slice(-3)))
  await call('ext:uninstall', 'dev.vsc')

  // ---- enable / disable / uninstall
  await call('ext:setEnabled', 'acme.night', false)
  check('a disabled extension\'s theme is no longer offered', (await mod.extensionThemes()).length === 0)
  check('and the list shows it as disabled', (await call('ext:list')).find((e) => e.id === 'acme.night').enabled === false)
  await call('ext:setEnabled', 'me.hello', false)
  run = await call('ext:run', 'me.hello', 'hello.upper')
  check('commands of a disabled extension do not run', run.ok === false, JSON.stringify(run))
  await call('ext:setEnabled', 'me.hello', true); await call('ext:setEnabled', 'acme.night', true)
  const state = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'userData', 'extensions', 'state.json'), 'utf8'))
  check('the list of extensions and whether they are enabled is saved', state.length === 4 && state.every((s) => s.enabled), JSON.stringify(state.map((s) => s.id)))
  const dir = (await call('ext:list')).find((e) => e.id === 'acme.night').dir
  await call('ext:uninstall', 'acme.night')
  check('uninstalling removes the extension and its files', !(await call('ext:list')).some((e) => e.id === 'acme.night') && !fs.existsSync(dir))
  r = await call('ext:installVsix', themeVsix)
  const again = await call('ext:installVsix', themeVsix)
  check('installing the same extension again replaces it instead of duplicating it', again.ok && (await call('ext:list')).filter((e) => e.id === 'acme.night').length === 1)

  // ---- the registry
  const zipBytes = fs.readFileSync(snipVsix)
  let mode = 'ok'
  const server = http.createServer((req, res) => {
    if (mode === 'down') { res.writeHead(500); return res.end('boom') }
    if (req.url.startsWith('/api/-/search')) {
      const q = new URL(req.url, 'http://x').searchParams.get('query')
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ extensions: [{ namespace: 'acme', name: 'snips', version: '0.2.0', displayName: 'Snips (' + q + ')', description: 'Snippets', downloadCount: 1234, files: { download: `http://127.0.0.1:${server.address().port}/dl/acme.snips-0.2.0.vsix` } }, { namespace: 'bad', name: 'nolink', version: '1', files: {} }] }))
    }
    if (req.url.startsWith('/dl/')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(mode === 'corrupt' ? Buffer.from('not a zip') : zipBytes) }
    res.writeHead(404); res.end()
  })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  process.env.MY_AI_IDE_REGISTRY_URL = `http://127.0.0.1:${server.address().port}`
  await call('ext:uninstall', 'acme.snips')
  const found = await call('ext:search', 'snip')
  check('searching the registry lists extensions with name, version and downloads', found.ok && found.results.length === 2 && found.results[0].id === 'acme.snips' && found.results[0].displayName === 'Snips (snip)' && found.results[0].downloads === 1234, JSON.stringify(found).slice(0, 200))
  const inst = await call('ext:installRegistry', found.results[0])
  check('an extension can be installed from the registry', inst.ok && inst.ext.source === 'registry' && inst.ext.snippets === 2, JSON.stringify(inst).slice(0, 200))
  check('an entry without a download link is refused', (await call('ext:installRegistry', found.results[1])).ok === false)
  mode = 'corrupt'
  const bad = await call('ext:installRegistry', found.results[0])
  check('a download that is not a valid package is refused and nothing is left behind', bad.ok === false && fs.readdirSync(path.join(tmpRoot, 'userData', 'extensions')).filter((f) => f.startsWith('.dl-') || f.startsWith('.tmp-')).length === 0, JSON.stringify(bad))
  mode = 'down'
  const down = await call('ext:search', 'x')
  check('a registry that is down gives a readable error, not a crash', down.ok === false && /500/.test(down.error), JSON.stringify(down))
  server.close()

  await call('ext:setRoot', null)
  mod.stopExtensions()
  await sleep(600)
  try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch { /* the host may still be closing */ }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.log('FAIL  test run completed without exception  -> ' + (e && e.stack || e)); process.exit(1) })
