// Builds libgphoto2 (the open-source library for cameras that speak PTP over USB) into camera-helper/build/gphoto, together
// with the two libraries it needs: libusb, and libltdl from GNU libtool. All are LGPL, so they stay separate files:
//   include/gphoto2/     the headers
//   lib/                 libgphoto2, libgphoto2_port, libusb-1.0 and libltdl: universal, each known as @rpath/<file name>
//   camlibs/ptp2.so      the one camera driver built; libgphoto2 looks in the folder the CAMLIBS variable names
//   iolibs/usb1.so       the USB port; likewise IOLIBS
//   test-iolibs/vusb.so  libgphoto2's virtual camera, for tests (IOLIBS=…/test-iolibs). It must never ship: wherever it is
//                        loaded, a camera that doesn't exist shows up.
//   LICENSES/            the licence of each library
// The three source releases are downloaded once into camera-helper/build/gphoto-src and must match the sha256 sums below
// (the ones Homebrew pins). Each is built there for arm64 and for x86_64, and lipo joins the two. Xcode's command line
// tools are all it takes. What configure and make print goes to gphoto-src/build.log.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const build = path.join(import.meta.dirname, '..', 'camera-helper', 'build'), src = path.join(build, 'gphoto-src'), out = path.join(build, 'gphoto')
fs.mkdirSync(src, { recursive: true })
const logFile = path.join(src, 'build.log'), log = fs.openSync(logFile, 'w')
const run = (cmd, args, cwd) => {
  try { execFileSync(cmd, args, { cwd, stdio: ['ignore', log, log] }) } catch { throw new Error(`${cmd} failed${cwd ? ` in ${cwd}` : ''}: see ${logFile}`) }
}

const sources = {
  'https://ftpmirror.gnu.org/libtool/libtool-2.6.2.tar.xz': '2ef1067c16c97db930fd740cc9bc3d3ba9a583804ae5ac42cc3e8719e49e191e',
  'https://github.com/libusb/libusb/releases/download/v1.0.30/libusb-1.0.30.tar.bz2': 'fea36f34f9156400209595e300840767ab1a385ede1dc7ee893015aea9c6dbaf',
  'https://downloads.sourceforge.net/project/gphoto/libgphoto/2.5.34/libgphoto2-2.5.34.tar.bz2': '5df9e774eb4ab6087a193afff84dcafe9f666e3443fe29e73e6779f659ff7f28',
}
// The four libraries that ship, and the licence text of each.
const licences = { libgphoto2: 'libgphoto2-2.5.34/COPYING', libgphoto2_port: 'libgphoto2-2.5.34/libgphoto2_port/COPYING.LIB',
  'libusb-1.0': 'libusb-1.0.30/COPYING', libltdl: 'libtool-2.6.2/libltdl/COPYING.LIB' }

for (const [url, sha256] of Object.entries(sources)) {
  const file = path.join(src, path.basename(url))
  if (!fs.existsSync(file)) run('curl', ['-fsSL', '--retry', '3', '-o', file, url])
  const sum = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (sum !== sha256) throw new Error(`${file} has sha256 ${sum}, not ${sha256}`)
  fs.rmSync(file.replace(/\.tar\.\w+$/, ''), { recursive: true, force: true })
  run('tar', ['-xf', file, '-C', src])
}

// libgphoto2's configure stops if there is no pkg-config. This stand-in passes its version check and knows of no package,
// so the only libraries found are the ones named to configure below.
const pkgConfig = path.join(src, 'pkg-config')
fs.writeFileSync(pkgConfig, '#!/bin/sh\n[ "$1" = --atleast-pkgconfig-version ]\n', { mode: 0o755 })

// Nothing is ever installed in prefix: make install goes to gphoto-src/<architecture>/gphoto. It is there so that the
// folders the libraries remember (where to look for drivers when CAMLIBS and IOLIBS aren't set) aren't this computer's;
// -ffile-prefix-map does the same for the source file names in their log messages.
const prefix = '/gphoto', archs = ['arm64', 'x86_64'], root = arch => path.join(src, arch) + prefix
for (const arch of archs) {
  const stage = path.join(src, arch), at = root(arch)
  fs.rmSync(stage, { recursive: true, force: true })
  const make = (dir, ...args) => {
    const cwd = path.join(stage, path.basename(dir))
    console.log(`${path.basename(dir)} for ${arch}`)
    fs.mkdirSync(cwd, { recursive: true })
    run(path.join(src, dir, 'configure'), [`--host=${arch}-apple-darwin`, `--prefix=${prefix}`, '--disable-static', 'CC=clang',
      `CFLAGS=-O2 -arch ${arch} -mmacosx-version-min=12.1 -ffile-prefix-map=${src}/=`, ...args], cwd)
    run('make', [`-j${os.availableParallelism()}`], cwd)
    run('make', ['install', `DESTDIR=${stage}`], cwd)
  }
  make('libtool-2.6.2/libltdl', '--enable-ltdl-install')
  make('libusb-1.0.30')
  make('libgphoto2-2.5.34', '--disable-nls', '--without-libexif', '--without-libxml-2.0', '--without-gdlib', '--without-libcurl', '--without-jpeg',
    '--disable-serial', '--disable-disk', '--disable-ptpip', '--enable-vusb', '--with-camlibs=ptp2', `PKG_CONFIG=${pkgConfig}`,
    `camlibdir=${prefix}/camlibs`, `iolibdir=${prefix}/iolibs`, `LTDLINCL=-I${at}/include`, `LIBLTDL=-L${at}/lib -lltdl`,
    `LIBUSB1_CFLAGS=-I${at}/include/libusb-1.0`, `LIBUSB1_LIBS=-L${at}/lib -lusb-1.0`)
}

fs.rmSync(out, { recursive: true, force: true })
fs.cpSync(path.join(root(archs[0]), 'include', 'gphoto2'), path.join(out, 'include', 'gphoto2'), { recursive: true })
for (const [lib, file] of Object.entries(licences)) fs.cpSync(path.join(src, file), path.join(out, 'LICENSES', `${lib}.txt`))

// As built, each library knows itself and the others by a versioned path in prefix (/gphoto/lib/libusb-1.0.0.dylib):
// all of those become @rpath/<file name>, so the program that loads them says where they are.
const read = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const libs = Object.keys(licences).map(lib => `lib/${lib}.dylib`)
const renames = libs.flatMap(f => ['-change', read('otool', '-D', path.join(root(archs[0]), f)).split('\n').pop(), `@rpath/${path.basename(f)}`])
for (const f of [...libs, 'camlibs/ptp2.so', 'iolibs/usb1.so', 'iolibs/vusb.so']) {
  const to = path.join(out, f.replace('iolibs/vusb', 'test-iolibs/vusb'))
  fs.mkdirSync(path.dirname(to), { recursive: true })
  run('lipo', ['-create', ...archs.map(arch => path.join(root(arch), f)), '-output', to])
  run('install_name_tool', ['-id', `@rpath/${path.basename(f)}`, ...renames, to])
  // The linker's signature no longer fits the changed file, and arm64 loads nothing unsigned.
  run('codesign', ['-f', '-s', '-', to])
  if (read('otool', '-L', to).includes(`\t${prefix}/`)) throw new Error(`${to} still refers to a library in ${prefix}`)
}
console.log(`libgphoto2 built for ${archs.join(' and ')} in ${Math.round(performance.now() / 1000)} s: ${out} (camera driver ptp2, port usb1; vusb for tests only)`)
