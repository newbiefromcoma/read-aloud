/**
 * Generate manifest.json for a target browser.
 *
 *   node tools/build-manifest.mjs chrome
 *   node tools/build-manifest.mjs firefox
 *
 * One manifest cannot serve both without warnings, because the two disagree on
 * things that are not optional:
 *
 *   - Chrome MV3 requires `background.service_worker` and rejects
 *     `background.scripts`; Firefox MV3 is the other way round -- it runs an event
 *     page and has no service worker.
 *   - `offscreen`, `tts` and `ttsEngine` are Chrome-only permissions. Firefox
 *     reports each as an error while processing permissions.
 *   - `key`, `oauth2`, `use_dynamic_url` and the two cross-origin isolation keys
 *     are Chrome-only manifest properties.
 *   - Firefox wants `browser_specific_settings` for a stable add-on id.
 *
 * So manifest.base.json holds everything common and this script adds the rest.
 * The generated manifest.json is committed, so `git clone` + "Load unpacked" in
 * Chrome still works with no build step.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Publisher identity, kept out of the repository.
 *
 * `key` pins a Chrome extension to one specific id, and `browser_specific_settings.gecko.id`
 * does the same on AMO. They belong to whoever publishes the build, so a fork must
 * not inherit them from upstream: doing so would claim the original extension's id,
 * and any auth redirect derived from that id would point somewhere you do not
 * control. Absent -- the default -- the browser generates a development id, which
 * is the right behaviour for a fork that is not being published.
 *
 * Copy build.config.example.json to build.config.json and fill in your own values
 * when you are ready to publish. build.config.json is gitignored.
 */
function publisherConfig() {
  const path = join(ROOT, 'build.config.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch (err) {
    console.error('build.config.json is not valid JSON: ' + err.message)
    process.exit(1)
  }
}

/**
 * The scripts background.js loads via importScripts(), in order.
 *
 * Firefox's background is a document, where importScripts does not exist -- the
 * call throws, background.js swallows it in its try/catch, and the extension
 * silently comes up with no background at all. Listing them directly is the only
 * way the event page ever initialises.
 */
const BACKGROUND_SCRIPTS = [
  'js/rxjs.umd.min.js',
  'js/defaults.js',
  'js/messaging.js',
  'js/content-handlers.js',
  'js/events.js'
]

const targets = {
  chrome(manifest, config) {
    manifest.minimum_chrome_version = '99'
    //Only when this build has an identity of its own -- see publisherConfig.
    if (config.chromeKey) manifest.key = config.chromeKey
    if (config.oauth2) manifest.oauth2 = config.oauth2

    //chrome.tts / chrome.ttsEngine, and the offscreen document used for audio
    manifest.permissions.push('offscreen', 'tts', 'ttsEngine')
    manifest.permissions.sort()

    //Cross-origin isolation, which is what lets the Piper and Supertonic iframes
    //allocate a SharedArrayBuffer for their ONNX runtimes.
    manifest.cross_origin_opener_policy = { value: 'same-origin' }
    manifest.cross_origin_embedder_policy = { value: 'require-corp' }

    manifest.background = { service_worker: 'background.js' }
    manifest.web_accessible_resources[0].use_dynamic_url = true
    return manifest
  },

  firefox(manifest, config) {
    manifest.browser_specific_settings = {
      gecko: {
        //this fork's own id, on a domain the author controls
        id: config.geckoId || 'read-aloud-fork@crossbowsec.com',
        //MV3 with event-page backgrounds and scripting.executeScript
        strict_min_version: '115.0'
      }
    }
    manifest.background = { scripts: BACKGROUND_SCRIPTS }
    return manifest
  }
}

export const TARGETS = Object.keys(targets)

/** The manifest for a target, as an object. */
export function buildManifest(target) {
  if (!targets[target]) throw new Error('unknown target: ' + target)
  //re-read each time so callers building both targets don't share one mutated object
  const base = JSON.parse(readFileSync(join(ROOT, 'manifest.base.json'), 'utf8'))
  return targets[target](base, publisherConfig())
}

export function writeManifest(target, outPath) {
  const json = JSON.stringify(buildManifest(target), null, 2) + '\n'
  writeFileSync(outPath, json)
  return outPath
}

//CLI: node tools/build-manifest.mjs <target> [outfile]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2]
  if (!targets[target]) {
    console.error('usage: node tools/build-manifest.mjs <' + TARGETS.join('|') + '> [outfile]')
    process.exit(2)
  }
  const out = writeManifest(target, join(ROOT, process.argv[3] || 'manifest.json'))
  console.log('wrote ' + out + ' for ' + target)
}
