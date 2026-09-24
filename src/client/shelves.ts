/**
 * Shelf choices for the settings card.
 *
 * The Host serves `hypatia list` from the Memory tab's route family
 * (`GET /api/dsh-hypatia-auto-memory/shelves`, see `src/memory-api.js`); the
 * fetch itself lives in `memory-client.ts`. Until dsh 0.1.7 this listing rode
 * a read-only settings namespace, which the settings overhaul removed.
 *
 * Zero runtime imports, so the parsing half is unit-tested under `node:test`.
 */

/** Shelf hypatia uses when none is named. */
export const DEFAULT_SHELF = 'default'

/** One shelf as `hypatia list` reports it. */
export interface ShelfInfo {
  name: string
  path: string
  connected: boolean
}

/** The Host's latest listing; `error` is non-empty when it could not list. */
export interface ShelfInventory {
  shelves: ShelfInfo[]
  error: string
}

/** Load the Host's latest listing for the settings card. */
export type LoadShelfInventory = () => Promise<ShelfInventory>

/** One dropdown option. */
export interface ShelfChoice {
  name: string
  path: string
  /** False for a shelf that is registered but not connected. */
  connected: boolean
  /** False for a stored value the listing no longer reports. */
  listed: boolean
}

/**
 * Every shelf the dropdown offers: the listing, plus the stored and composed
 * values when the listing does not carry them, so the current choice always
 * renders and never silently changes to the first option.
 * @param shelves - the Host's listing.
 * @param keep - values that must stay selectable (current draft, stored, composed).
 * @returns options, listed shelves first in listing order.
 */
export function shelfChoices(shelves: readonly ShelfInfo[], keep: readonly string[]): ShelfChoice[] {
  const choices: ShelfChoice[] = shelves.map(shelf => ({ ...shelf, listed: true }))
  for (const name of keep) {
    if (name === '' || choices.some(choice => choice.name === name)) continue
    choices.push({ name, path: '', connected: false, listed: false })
  }
  return choices
}
