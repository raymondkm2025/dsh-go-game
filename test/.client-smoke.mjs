// TEMPORARY smoke harness — executes lib/client.js (top level + one render of
// the panel) under a hand-rolled React/DOM stub, to catch undefined identifiers
// and typos that `node --check` cannot see. Not part of the permanent suite.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

let registration = null
let injectedSlot = null
let renderFn = null

const win = {
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: {
    store: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null },
    setItem(k, v) { this.store[k] = String(v) },
  },
  addEventListener() {},
  removeEventListener() {},
  open() {},
  __ModuleLoader__: {
    load(spec) { registration = spec },
  },
}

const doc = {
  createElement() { return { setAttribute() {}, style: {} } },
  head: { appendChild() {} },
}

let firstState = true
const React = {
  createElement: (type, props, ...kids) => {
    if (typeof type === 'function') return type({ ...(props || {}), children: kids })
    return { type, props: props || {}, kids }
  },
  useState: (init) => {
    const value = typeof init === 'function' ? init() : init
    if (firstState) {
      firstState = false
      return [true, () => {}] // force the panel open so the panel branch renders
    }
    return [value, () => {}]
  },
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useEffect: () => undefined,
}

const fn = new Function('window', 'document', 'fetch', 'console', src)
fn(win, doc, () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }), console)

if (!registration || registration.id !== 'dsh-go-game') throw new Error('module did not register as dsh-go-game')

const exports_ = registration.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

const slots = {
  inject(name, cb) { injectedSlot = name; return cb() },
  register(spec, render) { renderFn = render; return () => {} },
}

exports_.apply({ get: (name) => (name === 'slots' ? slots : undefined), effect: (cb) => cb() })

if (injectedSlot !== 'shell.overlay') throw new Error('expected shell.overlay, saw ' + injectedSlot)
if (typeof renderFn !== 'function') throw new Error('no render function captured')

const tree = renderFn()
if (!tree || typeof tree !== 'object') throw new Error('render returned nothing')

console.log('client smoke: module registered, apply() injected into shell.overlay, panel branch rendered OK')
console.log('client smoke: injected state count =', win.localStorage.store['dsh-go-game:panel'] === undefined ? 'none (no drag yet)' : 'saved')
