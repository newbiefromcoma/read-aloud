/**
 * Build a loadable extension directory per browser.
 *
 *   node tools/build.mjs            -> build/chrome and build/firefox
 *   node tools/build.mjs firefox    -> build/firefox only
 *
 * Why separate directories rather than swapping manifest.json in place: the two
 * browsers need different manifests, so one directory can only ever satisfy one of
 * them. If both browsers have the same folder loaded, whichever flavour is on disk
 * the other one warns about every Chrome-only key it does not recognise. Loading
 * each browser from its own output directory is the only way both are clean at the
 * same time.
 */
import { cpSync, mkdirSync, rmSync, readdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { writeManifest, TARGETS } from './build-manifest.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

//Directories copied wholesale into every build.
const DIRS = ['_locales', 'css', 'img', 'js', 'sound']

//Root files. background.js is Chrome-only: it calls importScripts, which does not
//exist in Firefox's event page, and the Firefox manifest lists its scripts
//directly instead. Shipping it there would only invite confusion.
const FILES = { all: ['houdini.js'], chrome: ['background.js'], firefox: [] }

function build(target) {
  const out = join(ROOT, 'build', target)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  for (const dir of DIRS) {
    const from = join(ROOT, dir)
    if (existsSync(from)) cpSync(from, join(out, dir), { recursive: true })
  }

  for (const name of readdirSync(ROOT)) {
    if (name.endsWith('.html')) cpSync(join(ROOT, name), join(out, name))
  }

  for (const name of FILES.all.concat(FILES[target])) {
    if (existsSync(join(ROOT, name))) cpSync(join(ROOT, name), join(out, name))
  }

  writeManifest(target, join(out, 'manifest.json'))
  console.log('built ' + out)
}

const requested = process.argv[2] ? [process.argv[2]] : TARGETS
for (const target of requested) {
  if (!TARGETS.includes(target)) {
    console.error('unknown target "' + target + '"; expected one of ' + TARGETS.join(', '))
    process.exit(2)
  }
  build(target)
}
