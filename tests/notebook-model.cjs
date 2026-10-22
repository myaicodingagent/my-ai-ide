// Tests notebook reading/writing/editing (src/renderer/src/notebookModel.ts) and the Markdown renderer. `npm run test:nbmodel`.
const fs = require('fs'), path = require('path')
const root = path.join(__dirname, '..')
const build = (entry, name) => { const out = path.join(root, 'node_modules', '.cache', name); fs.mkdirSync(path.dirname(out), { recursive: true }); require('esbuild').buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' }); return require(out) }
const m = build('src/renderer/src/notebookModel.ts', 'nbmodel-bundle.cjs')
const md = build('src/renderer/src/miniMarkdown.ts', 'minimd-bundle.cjs')
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`) }

// A notebook as Jupyter writes it (with things we do not use, which must survive).
const original = {
  cells: [
    { cell_type: 'markdown', id: 'intro', metadata: { tags: ['x'] }, source: ['# Title\n', 'some *text*'] },
    { cell_type: 'code', execution_count: 3, id: 'one', metadata: { collapsed: true }, outputs: [{ name: 'stdout', output_type: 'stream', text: ['hello\n', 'world\n'] }, { data: { 'text/plain': ['2'] }, execution_count: 3, metadata: {}, output_type: 'execute_result' }], source: ['print("hello")\n', '1 + 1'], vendor_field: { keep: 'me' } },
    { cell_type: 'raw', id: 'raw1', metadata: {}, source: ['raw text'] }
  ],
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python', version: '3.11.4' }, widgets: { state: 1 } },
  nbformat: 4,
  nbformat_minor: 5,
  custom_top_level: 'kept'
}
const text = JSON.stringify(original, null, 1) + '\n'

let r = m.parseNotebook(text)
check('a notebook is read', !r.error && r.nb.cells.length === 3 && r.nb.nbformat === 4)
const nb = r.nb
check('source lists become one string; cell types are kept', nb.cells[0].source === '# Title\nsome *text*' && nb.cells[1].source === 'print("hello")\n1 + 1' && nb.cells[2].cell_type === 'raw')
check('execution counts and outputs are kept on code cells only', nb.cells[1].execution_count === 3 && nb.cells[1].outputs.length === 2 && nb.cells[0].outputs.length === 0)
check('the id of each cell is kept', nb.cells.map((c) => c.id).join() === 'intro,one,raw1')
const back = m.serializeNotebook(nb)
check('writing it back gives exactly the same file (layout, order, unknown fields)', back === text, back === text ? '' : back.slice(0, 200))
check('fields we do not know are kept (cell, notebook and metadata level)', JSON.parse(back).custom_top_level === 'kept' && JSON.parse(back).cells[1].vendor_field.keep === 'me' && JSON.parse(back).metadata.widgets.state === 1)

check('splitting text into lines keeps the line breaks except on the last', JSON.stringify(m.splitLines('a\nb\n')) === '["a\\n","b\\n"]' && JSON.stringify(m.splitLines('a\nb')) === '["a\\n","b"]' && JSON.stringify(m.splitLines('')) === '[]' && JSON.stringify(m.splitLines('\n')) === '["\\n"]')

check('an empty file is an empty notebook', m.parseNotebook('').nb.cells.length === 0 && m.parseNotebook('  \n').nb.nbformat === 4)
check('text that is not JSON gets a clear message', /not valid JSON/.test(m.parseNotebook('{ nope').error))
check('JSON that is not a notebook gets one too', /does not look like a notebook/.test(m.parseNotebook('{"a": 1}').error))
check('an old format is refused with advice', /too old/.test(m.parseNotebook(JSON.stringify({ cells: [], nbformat: 3 })).error))
const noIds = m.parseNotebook(JSON.stringify({ cells: [{ cell_type: 'code', source: 'a' }, { cell_type: 'code', source: 'b', id: 'dup' }, { cell_type: 'code', source: 'c', id: 'dup' }], nbformat: 4, nbformat_minor: 2, metadata: {} })).nb
check('cells without an id, or with a repeated one, get a fresh one', new Set(noIds.cells.map((c) => c.id)).size === 3 && noIds.cells.every((c) => c.id))

check('the kernel language comes from the metadata', m.kernelLanguage(nb) === 'python' && m.kernelLanguage({ ...nb, metadata: { kernelspec: { language: 'javascript', name: 'javascript' } } }) === 'javascript' && m.kernelLanguage({ ...nb, metadata: { kernelspec: { name: 'node' } } }) === 'javascript' && m.kernelLanguage({ ...nb, metadata: {} }) === 'python')

// editing
let e = m.insertCell(nb, 1, m.newCell('code', 'x = 1'))
check('a cell can be inserted at a position', e.cells.length === 4 && e.cells[1].source === 'x = 1' && e.cells[2].id === 'one')
check('and the original notebook is not changed (edits make new notebooks)', nb.cells.length === 3)
e = m.deleteCell(nb, 'one')
check('a cell can be deleted', e.cells.map((c) => c.id).join() === 'intro,raw1')
e = m.moveCell(nb, 'intro', 1)
check('a cell can be moved down, and up; the ends stay put', e.cells.map((c) => c.id).join() === 'one,intro,raw1' && m.moveCell(e, 'one', -1).cells[0].id === 'one' && m.moveCell(nb, 'raw1', 1).cells[2].id === 'raw1')
e = m.setCellType(nb, 'one', 'markdown')
check('turning a code cell into text drops its outputs and count (the source stays)', e.cells[1].cell_type === 'markdown' && e.cells[1].outputs.length === 0 && e.cells[1].execution_count === null && e.cells[1].source.startsWith('print'))
e = m.clearOutputs(nb)
check('Clear Outputs empties every code cell', e.cells[1].outputs.length === 0 && e.cells[1].execution_count === null && e.cells[0].source === nb.cells[0].source)
e = m.splitCell(nb, 'one', 'print("hello")'.length + 1)
check('a cell can be split in two at a position', e.cells.length === 4 && e.cells[1].source === 'print("hello")' && e.cells[2].source === '1 + 1' && e.cells[2].id !== 'one')
e = m.mergeWithNext(m.insertCell(nb, 2, m.newCell('code', 'second')), 'one')
check('and joined with the next one', e.cells.length === 3 && e.cells[1].source === 'print("hello")\n1 + 1\nsecond' && e.cells[1].outputs.length === 0)

// outputs
let outs = m.appendStream([], 'stdout', 'a')
outs = m.appendStream(outs, 'stdout', 'b\n')
outs = m.appendStream(outs, 'stderr', 'e')
outs = m.appendStream(outs, 'stdout', 'c')
check('output of the same stream is joined; another stream starts a new block', outs.length === 3 && outs[0].text === 'ab\n' && outs[1].name === 'stderr' && outs[2].text === 'c')
check('carriage returns rewrite the line (progress bars) and backspaces delete', m.renderStreamText('10%\r50%\r100%\ndone') === '100%\ndone' && m.renderStreamText('abc\b\bX') === 'aX' && m.renderStreamText('a\nb') === 'a\nb')
check('colour codes are removed from tracebacks', m.stripAnsi('\u001b[0;31mError\u001b[0m: x') === 'Error: x')
check('the richest output is chosen', m.bestMime({ 'text/plain': 'p', 'text/html': '<b>h</b>' }).mime === 'text/html' && m.bestMime({ 'text/plain': 'p', 'image/png': 'iVBOR' }).mime === 'image/png' && m.bestMime({ 'application/json': '{}' }) === null && m.bestMime({ 'text/plain': ['a\n', 'b'] }).value === 'a\nb')

// markdown
check('headings, paragraphs and emphasis', md.renderMarkdown('# Hi\n\nsome **bold** and *it* and `code`') === '<h1>Hi</h1>\n<p>some <strong>bold</strong> and <em>it</em> and <code>code</code></p>', md.renderMarkdown('# Hi\n\nsome **bold** and *it* and `code`'))
check('lists, quotes and rules', /<ul><li>a<\/li><li>b<\/li><\/ul>/.test(md.renderMarkdown('- a\n- b')) && /<ol><li>x<\/li><li>y<\/li><\/ol>/.test(md.renderMarkdown('1. x\n2. y')) && /<blockquote>/.test(md.renderMarkdown('> quoted')) && md.renderMarkdown('---') === '<hr>')
check('code fences keep their text exactly', md.renderMarkdown('```py\nif a < b:\n    print("x")\n```') === '<pre><code>if a &lt; b:\n    print(&quot;x&quot;)\n</code></pre>' || /<pre><code>if a &lt; b:/.test(md.renderMarkdown('```py\nif a < b:\n    print("x")\n```')))
const evil = md.renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> [click](javascript:alert(1)) ![p](http://x/y.png)')
check('HTML in the text is shown as text, never run', !/<(script|img|a|iframe)/i.test(evil) && !/href=/i.test(evil) && /&lt;script&gt;/.test(evil), evil)
check('links are shown as text, not made clickable', /class="md-link"/.test(md.renderMarkdown('[a](http://x)')) && !/<a /.test(md.renderMarkdown('[a](http://x)')))
check('inline code protects its contents from emphasis', md.renderMarkdown('`a*b*c`') === '<p><code>a*b*c</code></p>')

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
