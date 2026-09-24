/**
 * Seat selection for the settings card: the official keyed seat on the sidebar
 * Plugins page when the harness renders it, the Settings tab when it does not,
 * and never both at once.
 *
 * The registry is faked at the seam the module actually uses — `register`
 * throws for an undeclared seat and emits `slots/changed` synchronously from
 * inside both register and dispose, which is what makes the move re-entrant.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  BUNDLE_CONFIG_SEAT,
  SETTINGS_TAB_SEAT,
  installPluginCard,
} from '../src/client/plugin-card-seat.ts'

const BUNDLE = 'dsh-hypatia-auto-memory'
const ID = 'hypatia-auto-memory'

test('the official seat key is the bundle package name the manifest declares', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const declared = /BUNDLE_NAME\s*=\s*['"]([^'"]+)['"]/.exec(source)
  assert.equal(declared?.[1], manifest.name, 'the keyed seat must name the bundle as npm installs it')
})

/**
 * A slot registry with the two behaviours the module depends on.
 * @param declaredSeats - seats declared before the card is installed.
 * @param beforeRegister - optional hook that may declare further seats, standing
 *   in for a harness whose seats appear while another registration is running.
 */
function fakeHost(declaredSeats = [], beforeRegister) {
  const declared = new Set(declaredSeats)
  const entries = new Map()
  const listeners = new Set()
  const injections = new Map()
  const emit = (key) => { for (const listener of [...listeners]) listener(key) }
  const idOf = (options) => `${options.name}\u0000${options.key ?? options.id ?? ''}`

  const slots = {
    register(options, component) {
      beforeRegister?.(options, declared)
      if (!declared.has(options.name)) throw new Error(`slot "${options.name}" is not declared`)
      const id = idOf(options)
      if (entries.has(id)) throw new Error(`slot "${options.name}" already has an entry for key "${options.key}"`)
      let live = true
      const dispose = () => {
        if (!live) return
        live = false
        entries.delete(id)
        emit(options.name)
      }
      entries.set(id, { options, component, dispose })
      emit(options.name)
      return dispose
    },
    inject(seat, callback) {
      injections.set(seat, callback)
      return () => injections.delete(seat)
    },
  }

  return {
    slots,
    host: {
      slots,
      on(event, listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    /** Declare a seat and run the injection waiting on it, as a mounting section does. */
    mount(seat) {
      declared.add(seat)
      const callback = injections.get(seat)
      const dispose = callback === undefined ? undefined : callback()
      emit(seat)
      return dispose
    },
    liveSeats: () => [...entries.values()].map((entry) => entry.options.name),
    liveKeys: () => [...entries.values()].map((entry) => entry.options.key ?? entry.options.id),
    listenerCount: () => listeners.size,
  }
}

/** The two contributions the browser half hands the installer. */
function makeSeats(registry, refused) {
  return {
    official: () => registry.register({ name: BUNDLE_CONFIG_SEAT, key: BUNDLE, locale: ID }, 'card'),
    settingsTab: () => registry.register({ name: SETTINGS_TAB_SEAT, id: ID, locale: ID }, 'card'),
    ...refused === undefined ? {} : { onRefused: (seat) => refused.push(seat) },
  }
}

test('the official seat wins when the harness declares it', () => {
  const fake = fakeHost([BUNDLE_CONFIG_SEAT, SETTINGS_TAB_SEAT])
  const stop = installPluginCard(fake.host, makeSeats(fake.slots))

  assert.deepEqual(fake.liveSeats(), [BUNDLE_CONFIG_SEAT], 'the card took the bundle page seat')
  assert.deepEqual(fake.liveKeys(), [BUNDLE], 'keyed by the bundle package name')

  fake.mount(SETTINGS_TAB_SEAT)
  assert.deepEqual(fake.liveSeats(), [BUNDLE_CONFIG_SEAT], 'the Settings tab stays empty')
  stop()
})

test('a harness without the Plugins page seats the card in Settings instead', () => {
  const fake = fakeHost([SETTINGS_TAB_SEAT])
  const refused = []
  const stop = installPluginCard(fake.host, makeSeats(fake.slots, refused))

  assert.deepEqual(fake.liveSeats(), [], 'nothing is registered before the tab is declared')
  fake.mount(SETTINGS_TAB_SEAT)
  assert.deepEqual(fake.liveSeats(), [SETTINGS_TAB_SEAT])
  assert.deepEqual(fake.liveKeys(), [ID])
  assert.deepEqual(refused, [BUNDLE_CONFIG_SEAT], 'the refusal is reported once')
  stop()
})

test('the card moves to the official seat, disposed from Settings first', () => {
  const fake = fakeHost([SETTINGS_TAB_SEAT])
  const stop = installPluginCard(fake.host, makeSeats(fake.slots))
  fake.mount(SETTINGS_TAB_SEAT)
  assert.deepEqual(fake.liveSeats(), [SETTINGS_TAB_SEAT])

  // The plugin manager mounts late: the seat is declared and the registry emits.
  fake.mount(BUNDLE_CONFIG_SEAT)

  assert.deepEqual(fake.liveSeats(), [BUNDLE_CONFIG_SEAT], 'the card never sits in two seats')
  stop()
})

test('the fallback is never attempted while the official seat is live', () => {
  const fake = fakeHost([BUNDLE_CONFIG_SEAT])
  const refused = []
  const stop = installPluginCard(fake.host, makeSeats(fake.slots, refused))

  assert.deepEqual(refused, [])
  assert.deepEqual(fake.liveSeats(), [BUNDLE_CONFIG_SEAT])
  stop()
})

test('a seat declared while the fallback registers leaves exactly one card', () => {
  // The Settings registration emits `slots/changed`, and this harness declares
  // the official seat at that moment: the reconcile it triggers takes the
  // official seat while the Settings entry is still being installed.
  const fake = fakeHost([SETTINGS_TAB_SEAT], (options, declared) => {
    if (options.name === SETTINGS_TAB_SEAT) declared.add(BUNDLE_CONFIG_SEAT)
  })
  const stop = installPluginCard(fake.host, makeSeats(fake.slots))

  fake.mount(SETTINGS_TAB_SEAT)

  assert.deepEqual(fake.liveSeats(), [BUNDLE_CONFIG_SEAT], 'the Settings entry was retired, not kept')
  stop()
})

test('disposing removes the card, the wait and the watch', () => {
  const fake = fakeHost([BUNDLE_CONFIG_SEAT, SETTINGS_TAB_SEAT])
  const stop = installPluginCard(fake.host, makeSeats(fake.slots))
  assert.equal(fake.listenerCount(), 1)

  stop()

  assert.deepEqual(fake.liveSeats(), [])
  assert.equal(fake.listenerCount(), 0, 'the change listener is gone')
  // A late declaration must not resurrect the card.
  fake.mount(SETTINGS_TAB_SEAT)
  fake.mount(BUNDLE_CONFIG_SEAT)
  assert.deepEqual(fake.liveSeats(), [])
})

test('a host without a change event still seats the card once', () => {
  const fake = fakeHost([BUNDLE_CONFIG_SEAT])
  const stop = installPluginCard({ slots: fake.slots }, makeSeats(fake.slots))
  assert.deepEqual(fake.liveSeats(), [BUNDLE_CONFIG_SEAT])
  stop()
  assert.deepEqual(fake.liveSeats(), [])
})
