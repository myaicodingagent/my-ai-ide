// Tests the WSL / SSH helpers (src/main/shellspec.ts). `npm run test:shells`: does not start the app.
const fs = require('fs'), path = require('path')
const root = path.join(__dirname, '..')
const out = path.join(root, 'node_modules', '.cache', 'shellspec-bundle.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src', 'main', 'shellspec.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' })
const m = require(out)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 200) : ''}`) }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

check('a \\\\wsl$ path becomes a distribution and a Linux path', eq(m.wslLocation('\\\\wsl$\\Ubuntu\\home\\me\\proj'), { distro: 'Ubuntu', path: '/home/me/proj' }), JSON.stringify(m.wslLocation('\\\\wsl$\\Ubuntu\\home\\me\\proj')))
check('so does \\\\wsl.localhost', eq(m.wslLocation('\\\\wsl.localhost\\Debian\\srv'), { distro: 'Debian', path: '/srv' }))
check('the root of a distribution is /', eq(m.wslLocation('\\\\wsl$\\Ubuntu'), { distro: 'Ubuntu', path: '/' }) && eq(m.wslLocation('\\\\wsl$\\Ubuntu\\'), { distro: 'Ubuntu', path: '/' }))
check('distribution names with spaces and dots are accepted', eq(m.wslLocation('\\\\wsl.localhost\\Ubuntu-22.04\\x'), { distro: 'Ubuntu-22.04', path: '/x' }) && m.wslLocation('\\\\wsl$\\My Distro\\a').distro === 'My Distro')
check('ordinary Windows paths and other servers are not WSL', m.wslLocation('C:\\Users\\me') === null && m.wslLocation('\\\\server\\share\\x') === null && m.wslLocation('/home/me') === null && m.wslLocation(null) === null && m.wslLocation('') === null)
check('a distribution name that could carry options is refused', m.wslLocation('\\\\wsl$\\--exec\\x') === null && eq(m.parseWslList(Buffer.from('--exec\r\nUbuntu\r\n', 'utf16le')), ['Ubuntu']))
check('and one with shell characters', m.wslLocation('\\\\wsl$\\a;b\\x') === null && m.wslLocation('\\\\wsl$\\a&b\\x') === null)
check('the Windows path of a place in a distribution', m.wslUnc('Ubuntu', '/home/me') === '\\\\wsl.localhost\\Ubuntu\\home\\me')
check('the Windows path round-trips', eq(m.wslLocation(m.wslUnc('Ubuntu', '/home/me/a b')), { distro: 'Ubuntu', path: '/home/me/a b' }))

const utf16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])
check('the list of distributions is read from wsl.exe\'s UTF-16 output', eq(m.parseWslList(utf16('Ubuntu\r\nDebian\r\n')), ['Ubuntu', 'Debian']), JSON.stringify(m.parseWslList(utf16('Ubuntu\r\nDebian\r\n'))))
check('an empty list, blank lines and noise give nothing / only valid names', eq(m.parseWslList(utf16('')), []) && eq(m.parseWslList(utf16('\r\n\r\nUbuntu\r\n')), ['Ubuntu']) && eq(m.parseWslList('Ubuntu; rm -rf /\nDebian'), ['Debian']))

check('plain host names, addresses and user@host are valid SSH targets', ['example.com', 'me@example.com', '192.168.0.5', 'me@192.168.0.5', 'my-alias', 'host_1', 'user.name@host:22', '[::1]'.replace(/[\[\]]/g, '')].every(m.validSshTarget))
check('options, spaces, quotes and shell characters are not', ['-oProxyCommand=calc', '-p', 'me@-bad', 'a b', 'a;b', 'a|b', 'a&b', '"x"', '$(x)', '`x`', 'a\nb', '', 'x'.repeat(300)].every((t) => !m.validSshTarget(t)))
check('ssh gets "--" before the target', eq(m.sshArgs('me@host'), ['--', 'me@host']))
check('a WSL command runs bash -lc in the folder, as a single argument', eq(m.wslCommandArgs({ distro: 'Ubuntu', path: '/home/me' }, 'ls -la; echo "x y"'), ['-d', 'Ubuntu', '--cd', '/home/me', '--', 'bash', '-lc', 'ls -la; echo "x y"']))
check('an interactive WSL shell starts in the folder', eq(m.wslShellArgs({ distro: 'Ubuntu', path: '/home/me' }), ['-d', 'Ubuntu', '--cd', '/home/me']))

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
