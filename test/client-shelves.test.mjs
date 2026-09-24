/**
 * The settings card's shelf dropdown: keeping the current choice selectable
 * when the Host's listing no longer carries it. Reading the listing itself is
 * covered by the memory-client tests (the `/shelves` route answer).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shelfChoices } from '../src/client/shelves.ts'

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
