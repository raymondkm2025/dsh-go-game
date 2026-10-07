/**
 * Register dsh-go-game in the DSH `web` profile.
 *
 * Writes outside the workspace, so it is deliberately explicit:
 *   node install-web-profile.mjs          -> dry run, prints the plan
 *   node install-web-profile.mjs --apply  -> backs up, edits, links
 *
 * What it changes in <profile>/package.json:
 *   dependencies         + "dsh-go-game": "link:<this package>"
 *   dsh.profile.bundles  + "dsh-go-game"
 * and it creates <profile>/node_modules/dsh-go-game as a junction to this
 * directory (DSH does not run pnpm install on boot; a missing link fails
 * silently). The previous manifest is copied into ./install-backup/ first.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APPLY = process.argv.includes('--apply')
const PROFILE_NAME = (process.argv.find((a) => a.startsWith('--profile=')) || '--profile=web').split('=')[1]

const APPDATA = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
const PROFILE_DIR = join(APPDATA, 'dsh-desktop', 'harness', 'profiles', PROFILE_NAME)
const MANIFEST = join(PROFILE_DIR, 'package.json')
const NM_LINK = join(PROFILE_DIR, 'node_modules', 'dsh-go-game')
const LINK_SPEC = 'link:' + HERE.replace(/\\/g, '/')
const BACKUP_DIR = join(HERE, 'install-backup')

function fail(msg) {
  console.error('! ' + msg)
  process.exit(1)
}

if (!existsSync(MANIFEST)) fail('profile manifest not found: ' + MANIFEST)

const original = readFileSync(MANIFEST, 'utf8')
let pkg
try {
  pkg = JSON.parse(original)
} catch (err) {
  fail('profile package.json is not valid JSON — refusing to touch it: ' + err.message)
}

pkg.dependencies = pkg.dependencies || {}
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []

const depBefore = pkg.dependencies['dsh-go-game']
const bundleBefore = pkg.dsh.profile.bundles.includes('dsh-go-game')
const linkExists = existsSync(NM_LINK)

pkg.dependencies['dsh-go-game'] = LINK_SPEC
if (!bundleBefore) pkg.dsh.profile.bundles.push('dsh-go-game')
const next = JSON.stringify(pkg, null, 2) + '\n'

console.log('profile     : ' + PROFILE_DIR)
console.log('package     : ' + HERE)
console.log('dependency  : ' + (depBefore === LINK_SPEC ? 'already set' : depBefore ? 'replacing ' + depBefore : 'adding'))
console.log('bundles     : ' + (bundleBefore ? 'already listed' : 'appending "dsh-go-game"'))
console.log('node_modules: ' + (linkExists ? 'link already present' : 'creating junction'))

if (!APPLY) {
  console.log('\ndry run — pass --apply to write the manifest and create the junction')
  process.exit(0)
}

mkdirSync(BACKUP_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
copyFileSync(MANIFEST, join(BACKUP_DIR, 'web-package.json.bak'))
copyFileSync(MANIFEST, join(BACKUP_DIR, 'web-package.json.' + stamp + '.bak'))
console.log('backup      : ' + join(BACKUP_DIR, 'web-package.json.bak'))

writeFileSync(MANIFEST, next, 'utf8')
// re-parse to prove we did not corrupt it
JSON.parse(readFileSync(MANIFEST, 'utf8'))
console.log('manifest    : written and re-parsed ok')

if (!linkExists) {
  mkdirSync(dirname(NM_LINK), { recursive: true })
  symlinkSync(HERE, NM_LINK, 'junction')
}
let target = ''
try {
  target = lstatSync(NM_LINK).isSymbolicLink() ? 'junction ok' : 'exists (not a link)'
} catch (err) {
  target = 'unreadable: ' + err.message
}
console.log('node_modules: ' + target)

console.log('\nnext: restart DSH, then open the Go panel or http://127.0.0.1:43129/dsh-go-game/')
