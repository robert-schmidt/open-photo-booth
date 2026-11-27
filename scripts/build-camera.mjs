// Builds camera-helper (camera-helper/*.cpp) for this computer into camera-helper/build/mac or build/win: a universal binary on macOS
// (Xcode's command line tools), camera-helper.exe on Windows (Visual Studio's C++ tools, found with vswhere). Elsewhere
// there's nothing to build: the booth runs with webcams only.
//
// The makers' SDKs are not in git (their licences don't allow it). Download them yourself and unpack them into
// drivers/ (or the folder BOOTH_DRIVERS names):
//   drivers/sony/mac/RemoteCli/, drivers/sony/win/RemoteCli/   Sony's Camera Remote SDK: RemoteCli.zip from it, unpacked
//   drivers/nikon/z/Module/                                    Nikon's Remote SDK for Z cameras
// Each one found is compiled in, and its runtime files go next to the program:
//   build/bin/         camera-helper, Sony's libraries, Nikon's module and its settings files
//   build/Frameworks/  Nikon's driver on macOS (its module looks for it there)
// libgphoto2 (open source: Canon EOS, Nikon DSLRs, older Sony and more) needs no download of yours: on macOS,
// `npm run build:gphoto` builds it into camera-helper/build/gphoto/, and from there it is compiled in too:
//   build/bin/gphoto/  libgphoto2 and the libraries it needs, its camera and port drivers, their licences
// With neither, camera-helper has only the simulated camera, and the booth works with webcams as before.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const mac = process.platform === 'darwin', win = process.platform === 'win32'
// One folder per system (build/mac, build/win), so an installer built here for the other system doesn't carry this one's files.
const root = path.join(import.meta.dirname, '..'), dir = path.join(root, 'camera-helper'), out = path.join(dir, 'build', mac ? 'mac' : 'win')
const bin = path.join(out, 'bin'), drivers = process.env.BOOTH_DRIVERS || path.join(root, 'drivers')
if (!mac && !win) {
  console.log('camera-helper: nothing to build on this platform (webcams only)')
  process.exit(0)
}
fs.rmSync(bin, { recursive: true, force: true })
fs.rmSync(path.join(out, 'Frameworks'), { recursive: true, force: true })
fs.mkdirSync(bin, { recursive: true })

const copy = (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true })
const sources = ['main.cpp'], defines = [], includes = [], libs = []

// Sony ships RemoteCli zipped inside its download: unpack it once if that hasn't been done by hand (tar reads zips).
const sony = path.join(drivers, 'sony', mac ? 'mac' : 'win', 'RemoteCli')
if (!fs.existsSync(sony) && fs.existsSync(`${sony}.zip`)) { fs.mkdirSync(sony); execFileSync('tar', ['-xf', `${sony}.zip`, '-C', sony]) }
if (fs.existsSync(path.join(sony, 'external', 'crsdk'))) {
  const lib = path.join(sony, 'external', 'crsdk')
  // Cr_Core and its adapters (USB and network); the monitoring libraries are left out: the booth doesn't use them.
  for (const f of fs.readdirSync(lib)) if (!/^(lib)?monitor_protocol|^\.DS_Store$/.test(f) && !f.endsWith('.lib')) copy(path.join(lib, f), path.join(bin, f))
  sources.push('sony.cpp'), defines.push('HAVE_SONY'), includes.push(path.join(sony, 'app', 'CRSDK'))
  libs.push(...(mac ? [`-L${lib}`, '-lCr_Core'] : [path.join(lib, 'Cr_Core.lib')]))
}

const nikon = path.join(drivers, 'nikon', 'z', 'Module', mac ? 'Mac' : 'Win')
if (fs.existsSync(path.join(nikon, 'HeaderFile'))) {
  // On macOS Nikon's files sit inside its sample program, TestApp (unzip BinaryFile/TestApp.zip next to itself).
  const app = path.join(nikon, 'BinaryFile', 'TestApp', 'TestApp'), files = mac ? path.join(app, 'TestApp') : path.join(nikon, 'BinaryFile')
  for (const f of fs.readdirSync(files)) if (!/^(TestApp(\.exe)?|\.DS_Store)$/.test(f)) copy(path.join(files, f), path.join(bin, f))
  if (mac) copy(path.join(app, 'Frameworks'), path.join(out, 'Frameworks'))
  sources.push('nikon.cpp'), defines.push('HAVE_NIKON'), includes.push(path.join(nikon, 'HeaderFile'))
}

// libgphoto2 and what it needs stay separate, replaceable files next to the program, as the LGPL asks.
const gphoto = path.join(dir, 'build', 'gphoto')
if (mac && fs.existsSync(path.join(gphoto, 'lib', 'libgphoto2.dylib'))) {
  for (const f of fs.readdirSync(path.join(gphoto, 'lib'))) copy(path.join(gphoto, 'lib', f), path.join(bin, 'gphoto', f))
  for (const d of ['camlibs', 'iolibs', 'LICENSES']) copy(path.join(gphoto, d), path.join(bin, 'gphoto', d))
  sources.push('gphoto.cpp'), defines.push('HAVE_GPHOTO'), includes.push(path.join(gphoto, 'include'))
  libs.push(`-L${path.join(gphoto, 'lib')}`, '-lgphoto2', '-lgphoto2_port', '-Wl,-rpath,@executable_path/gphoto')
}

if (mac) {
  execFileSync('clang++', ['-std=c++17', '-O2', '-Wall', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=12.1',
    ...defines.map(d => `-D${d}`), ...includes.flatMap(i => [`-isystem`, i]), ...sources, '-framework', 'CoreFoundation', ...libs,
    '-Wl,-rpath,@executable_path', '-Wl,-rpath,@executable_path/../Frameworks', '-o', path.join(bin, 'camera-helper')], { cwd: dir, stdio: 'inherit' })
} else {
  const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim()
  if (!vs) throw new Error("Visual Studio's C++ tools weren't found")
  // Sony's and Nikon's libraries need Visual C++'s runtime: it goes next to them (Microsoft allows this), as a booth
  // computer may not have it installed.
  const redist = path.join(vs, 'VC', 'Redist', 'MSVC'), crt = []
  for (const v of fs.existsSync(redist) ? fs.readdirSync(redist) : []) {
    const x64 = path.join(redist, v, 'x64')
    if (fs.existsSync(x64)) crt.push(...fs.readdirSync(x64).filter(n => /^Microsoft\.VC\d+\.CRT$/.test(n)).map(n => path.join(x64, n)))
  }
  if (defines.length) {
    if (!crt.length) throw new Error("Visual C++'s runtime (VC\\Redist) wasn't found")
    for (const f of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) copy(path.join(crt.sort().at(-1), f), path.join(bin, f))
  }
  const vcvars = path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'), q = s => `"${s}"`
  const cl = ['cl /nologo /std:c++17 /O2 /EHsc /W3 /utf-8', ...defines.map(d => `/D${d}`), `/external:W0`, ...includes.map(i => `/external:I${q(i)}`), ...sources,
    `/Fe:${q(path.join(bin, 'camera-helper.exe'))}`, `/Fo:${q(out + path.sep)}`, ...libs.map(q), 'user32.lib shell32.lib'].join(' ')
  // ponytail: written for Windows but never compiled there yet. Until it has been, a failed compile doesn't stop the
  // build: the booth then runs with webcams only. Make it fatal again once a Windows build has passed.
  try {
    execFileSync('cmd', ['/d', '/s', '/c', `"call ${q(vcvars)} >nul && ${cl}"`], { cwd: dir, stdio: 'inherit', windowsVerbatimArguments: true })
  } catch (e) {
    console.warn(`camera-helper did not compile (${e.message}): this build has webcams only`)
    process.exit(0)
  }
}
console.log(`camera-helper built${defines.length ? ` with ${defines.map(d => d.slice(5).toLowerCase()).join(' and ')}` : ' (simulated camera only: no SDKs in drivers/)'}`)
