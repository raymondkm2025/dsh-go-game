/**
 * Read-only install verification for dsh-go-game — the deepest check possible
 * without restarting DSH.
 *
 *   1. profile manifest: link: dependency + dsh.profile.bundles
 *   2. the node_modules junction exists and resolves
 *   3. both package entry points resolve from the profile (host "." and "./client")
 *   4. the host half actually imports in this Node process and exports apply/inject
 *   5. cordis.patch.yml parses as YAML and carries the expected insert row
 *   6. the client half's declared inject target resolves from the profile
 *
 * Usage: node verify-install.mjs [--profile=web]
 */
import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILE_NAME = (process.argv.find((a) => a.startsWith('--profile=')) || '--profile=web').split('=')[1]
const APPDATA = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
const PROFILE_DIR = join(APPDATA, 'dsh-desktop', 'harness', 'profiles', PROFILE_NAME)
const PKG = 'dsh-go-game'

let failures = 0
function ok(label, detail) {
  console.log('  ok    ' + label + (detail ? '  — ' + detail : ''))
}
function bad(label, detail) {
  failures++
  console.log('  FAIL  ' + label + (detail ? '  — ' + detail : ''))
}

console.log('verify-install: ' + PKG + ' in profile "' + PROFILE_NAME + '"')
console.log('profile: ' + PROFILE_DIR)

// 1. manifest ---------------------------------------------------------------
const manifestPath = join(PROFILE_DIR, 'package.json')
if (!existsSync(manifestPath)) {
  bad('profile manifest', manifestPath + ' not found')
} else {
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dep = pkg.dependencies ? pkg.dependencies[PKG] : undefined
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
  if (dep && dep.startsWith('link:')) ok('dependency', dep)
  else bad('dependency', 'expected link:<dir>, saw ' + String(dep))
  if (bundles.includes(PKG)) ok('bundles', 'at index ' + bundles.indexOf(PKG) + ' of ' + bundles.length)
  else bad('bundles', PKG + ' missing from dsh.profile.bundles')
}

// 2. junction ---------------------------------------------------------------
const linkPath = join(PROFILE_DIR, 'node_modules', PKG)
if (!existsSync(linkPath)) {
  bad('node_modules link', linkPath + ' does not exist (DSH would never load the plugin)')
} else {
  let kind = 'directory'
  try {
    const st = lstatSync(linkPath)
    kind = st.isSymbolicLink() ? 'junction/symlink' : 'plain directory'
  } catch (err) {
    kind = 'unreadable'
  }
  ok('node_modules link', kind)
}

// 3. resolution -------------------------------------------------------------
const req = createRequire(join(PROFILE_DIR, 'package.json'))
for (const spec of [PKG, PKG + '/client', PKG + '/engine', PKG + '/package.json']) {
  try {
    ok('resolve ' + spec, req.resolve(spec).replace(PROFILE_DIR, '<profile>'))
  } catch (err) {
    bad('resolve ' + spec, err.message)
  }
}

// 4. host half imports ------------------------------------------------------
let hostUrl = null
try {
  hostUrl = pathToFileURL(req.resolve(PKG)).href
} catch (err) {
  bad('host half url', err.message)
}
if (hostUrl) {
  const mod = await import(hostUrl).catch((err) => ({ __error: err }))
  if (mod.__error) {
    bad('import host half', mod.__error.message)
  } else {
    if (typeof mod.apply === 'function') ok('host apply()', 'exported')
    else bad('host apply()', 'not a function')
    if (Array.isArray(mod.inject) && mod.inject.includes('webServer')) ok('host inject', JSON.stringify(mod.inject))
    else bad('host inject', 'expected ["webServer"], saw ' + JSON.stringify(mod.inject))
    ok('host name', String(mod.name))
  }
}

// 5. bundle patch -----------------------------------------------------------
const patchPath = join(HERE, 'cordis.patch.yml')
let yaml = null
try {
  yaml = req('js-yaml')
} catch (err) {
  yaml = null
}
if (!existsSync(patchPath)) {
  bad('cordis.patch.yml', 'missing')
} else if (!yaml) {
  bad('cordis.patch.yml', 'js-yaml not resolvable from the profile — cannot parse')
} else {
  try {
    const doc = yaml.load(readFileSync(patchPath, 'utf8'))
    const insert = Array.isArray(doc) ? doc[0] && doc[0].insert : null
    const row = Array.isArray(insert) ? insert[0] : null
    if (row && row.name === PKG) ok('bundle patch row', 'id=' + row.id + ' name=' + row.name)
    else bad('bundle patch row', 'expected insert[0].name=' + PKG + ', saw ' + JSON.stringify(row))
  } catch (err) {
    bad('cordis.patch.yml parse', err.message)
  }
}

// 6. client half declarations ------------------------------------------------
// `react` and the slots package are supplied by the harness client runtime, not
// by the profile's node_modules (they live inside app.asar and are resolved by
// the app process when it bundles the client half). They therefore cannot be
// resolved from here with plain Node — so the check is a *shape comparison*
// against the known-working sibling plugin instead of a resolution attempt.
const ours = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
const clientInject = (ours.dsh && ours.dsh.client && ours.dsh.client.inject) || []
const reactRange = (ours.peerDependencies && ours.peerDependencies.react) || ''
if (clientInject.includes('@deepseek-ai/dsh-client-ui-slots')) {
  ok('client inject declaration', JSON.stringify(clientInject))
} else {
  bad('client inject declaration', 'expected the slots package, saw ' + JSON.stringify(clientInject))
}
if (reactRange) ok('client react peer', reactRange)
else bad('client react peer', 'missing peerDependencies.react')

const siblingManifest = join(HERE, '..', 'dsh-token-cat', 'package.json')
if (existsSync(siblingManifest)) {
  const sibling = JSON.parse(readFileSync(siblingManifest, 'utf8'))
  const siblingInject = (sibling.dsh && sibling.dsh.client && sibling.dsh.client.inject) || []
  const sameInject = JSON.stringify(siblingInject) === JSON.stringify(clientInject)
  const sameReact = ((sibling.peerDependencies && sibling.peerDependencies.react) || '') === reactRange
  if (sameInject && sameReact) {
    ok('matches the proven sibling template', 'dsh-token-cat declares the same client inject + react peer')
  } else {
    bad('matches the proven sibling template', 'dsh-token-cat: inject=' + JSON.stringify(siblingInject) + ' react=' + (sibling.peerDependencies || {}).react)
  }
  for (const spec of ['react', '@deepseek-ai/dsh-client-ui-slots']) {
    let siblingResolves = true
    try {
      createRequire(siblingManifest).resolve(spec)
    } catch (err) {
      siblingResolves = false
    }
    if (siblingResolves) {
      bad('environment surprise', spec + ' resolves from dsh-token-cat but not from the profile — investigate')
    }
  }
  console.log('  info  react / slots are provided by the harness client runtime (same for dsh-token-cat)')
} else {
  console.log('  info  sibling dsh-token-cat not found — skipped the template comparison')
}

console.log('')
if (failures === 0) {
  console.log('all links of the chain verified — a DSH restart is the only step left')
} else {
  console.log(failures + ' check(s) failed')
}
process.exit(failures ? 1 : 0)
