/**
 * The settings card's shelf dropdown: reading the Host's listing out of a
 * settings descriptor, and keeping the current choice selectable when the
 * listing no longer carries it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INVENTORY_NAMESPACE, readShelfInventory, shelfChoices } from '../src/client/shelves.ts'

test('readShelfInventory picks the inventory namespace out of a descriptor', () => {
  const described = [
    { ns: 'hypatia-auto-memory', value: { shelf: 'default' } },
    {
      ns: INVENTORY_NAMESPACE,
      // A user-layer override the resolved value would carry; ignored.
      value: { shelves: [], error: '', listedAt: 0 },
      base: {
        shelves: [
          { name: 'default', path: '/a', connected: true },
          { name: 'work', path: '/b', connected: false },
          { path: '/nameless' },
        ],
        error: '',
        listedAt: 1,
      },
    },
  ]
  assert.deepEqual(readShelfInventory(described), {
    shelves: [
      { name: 'default', path: '/a', connected: true },
      { name: 'work', path: '/b', connected: false },
    ],
    error: '',
  })
})

test('readShelfInventory reports a Host that publishes no listing', () => {
  assert.equal(readShelfInventory([{ ns: 'hypatia-auto-memory', value: {} }]), undefined)
  assert.equal(readShelfInventory([{ ns: INVENTORY_NAMESPACE, value: { shelves: [] } }]), undefined)
})

test('shelfChoices keeps a stored shelf the listing no longer reports', () => {
  const listed = [{ name: 'default', path: '/a', connected: true }]
  assert.deepEqual(shelfChoices(listed, ['gone', 'default', '']), [
    { name: 'default', path: '/a', connected: true, listed: true },
    { name: 'gone', path: '', connected: false, listed: false },
  ])
})

test('shelfChoices still offers the current choice before the listing loads', () => {
  assert.deepEqual(shelfChoices([], ['default', 'default']).map((choice) => choice.name), ['default'])
})
