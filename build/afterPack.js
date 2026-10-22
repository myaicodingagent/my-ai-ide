// Sets the icon and version info on the packaged exe. electron-builder normally does this with its
// own signing toolkit, which needs symlink rights on Windows, so signAndEditExecutable is off and
// rcedit is run here instead.
const path = require('path')
const rcedit = require('rcedit')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  await rcedit(exe, {
    icon: path.join(__dirname, 'icon.ico'),
    'version-string': {
      ProductName: 'My AI IDE',
      FileDescription: 'My AI IDE',
      CompanyName: 'Abdul Basith',
      LegalCopyright: 'Copyright (c) Abdul Basith',
      OriginalFilename: 'My AI IDE.exe'
    },
    'file-version': context.packager.appInfo.version,
    'product-version': context.packager.appInfo.version
  })
}
