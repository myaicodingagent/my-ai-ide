// Tests the conflict-marker parser behind the merge editor (src/renderer/src/mergeParse.ts). `npm run test:merge`.
const fs = require('fs'), path = require('path')
const root = path.join(__dirname, '..')
const out = path.join(root, 'node_modules', '.cache', 'mergeparse-bundle.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/renderer/src/mergeParse.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' })
const m = require(out)
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 220) : ''}`) }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const T = ['top', '<<<<<<< HEAD', 'ours 1', 'ours 2', '=======', 'theirs 1', '>>>>>>> feature', 'middle', '<<<<<<< HEAD', 'o', '=======', '>>>>>>> feature', 'bottom'].join('\n')
const p = m.parseMerge(T)
check('two conflicts are found with their lines and labels', p.conflicts.length === 2 && p.conflicts[0].start === 1 && p.conflicts[0].end === 6 && p.conflicts[0].oursLabel === 'HEAD' && p.conflicts[0].theirsLabel === 'feature' && eq(p.conflicts[0].ours, ['ours 1', 'ours 2']) && eq(p.conflicts[0].theirs, ['theirs 1']), JSON.stringify(p.conflicts[0]))
check('an empty side is empty', eq(p.conflicts[1].theirs, []) && eq(p.conflicts[1].ours, ['o']))
check('a file without conflicts has none', m.parseMerge('a\nb\n').conflicts.length === 0 && m.countConflicts('a\n=======\nb') === 0)

check('taking our side everywhere', m.resolveText(T, 'ours') === 'top\nours 1\nours 2\nmiddle\no\nbottom')
check('taking their side everywhere', m.resolveText(T, 'theirs') === 'top\ntheirs 1\nmiddle\nbottom')
check('both sides, ours first, or theirs first', m.resolveText(T, 'both') === 'top\nours 1\nours 2\ntheirs 1\nmiddle\no\nbottom' && m.resolveText(T, 'both-reverse') === 'top\ntheirs 1\nours 1\nours 2\nmiddle\no\nbottom')
check('a different side for each conflict, or left as it is (null)', m.resolveText(T, (c) => (c.index === 0 ? 'theirs' : null)) === ['top', 'theirs 1', 'middle', '<<<<<<< HEAD', 'o', '=======', '>>>>>>> feature', 'bottom'].join('\n'))

const D = ['<<<<<<< ours', 'mine', '||||||| base', 'orig', '=======', 'yours', '>>>>>>> theirs'].join('\n')
const pd = m.parseMerge(D)
check('diff3-style markers: the original text is kept separately', pd.conflicts.length === 1 && eq(pd.conflicts[0].base, ['orig']) && eq(pd.conflicts[0].ours, ['mine']) && eq(pd.conflicts[0].theirs, ['yours']), JSON.stringify(pd.conflicts[0]))
check('and can be chosen', m.resolveText(D, 'base') === 'orig' && m.resolveText(D, 'ours') === 'mine')

const C = T.replace(/\n/g, '\r\n')
check('Windows line endings are kept', m.parseMerge(C).eol === '\r\n' && m.resolveText(C, 'ours') === 'top\r\nours 1\r\nours 2\r\nmiddle\r\no\r\nbottom')
check('an unfinished conflict (no closing marker) is left alone', m.parseMerge('a\n<<<<<<< HEAD\nb\n=======\nc\n').conflicts.length === 0 && m.resolveText('a\n<<<<<<< HEAD\nb\n=======\nc\n', 'ours') === 'a\n<<<<<<< HEAD\nb\n=======\nc\n')
check('text that only looks like a marker is not one', m.parseMerge('x <<<<<<< y\n=======\n>>>>>>> z').conflicts.length === 0 && m.parseMerge('<<<<<<<<\n=======\n>>>>>>>').conflicts.length === 0)
check('a trailing newline is kept', m.resolveText(T + '\n', 'ours').endsWith('bottom\n'))

const spans = m.conflictSpans(T, 'ours')
check('where each conflict lands in the "ours" text', eq(spans, [{ start: 1, count: 2 }, { start: 4, count: 1 }]), JSON.stringify(spans))
const spansT = m.conflictSpans(T, 'theirs')
check('and in the "theirs" text (an empty side takes no lines)', eq(spansT, [{ start: 1, count: 1 }, { start: 3, count: 0 }]), JSON.stringify(spansT))
const lines = m.resolveText(T, 'theirs').split('\n')
check('those spans point at the right lines', lines[spansT[0].start] === 'theirs 1' && m.resolveText(T, 'ours').split('\n')[spans[1].start] === 'o')

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
