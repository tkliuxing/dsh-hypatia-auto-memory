/**
 * Shelf choices for the settings card.
 *
 * The Host publishes `hypatia list` as the read-only `hypatia-auto-memory-shelves`
 * settings namespace (see `src/config.js`); the card reads it through the
 * settings descriptor. Zero runtime imports, so it is unit-tested under
 * `node:test` like `card-form.ts`.
 */

/** Namespace the Host publishes the shelf listing under. */
export const INVENTORY_NAMESPACE = 'hypatia-auto-memory-shelves'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pick the inventory namespace out of a settings descriptor.
 *
 * Reads the composition layer (`base`), which only the Host sets, rather than
 * the resolved value: a stray user-layer section for this namespace would
 * otherwise freeze the list.
 * @param described - the `namespaces` array a settings `describe()` returns.
 * @returns the listing, or undefined when the Host does not serve one.
 */
export function readShelfInventory(described: readonly unknown[]): ShelfInventory | undefined {
  const view = described.find(entry => isRecord(entry) && entry.ns === INVENTORY_NAMESPACE)
  if (!isRecord(view) || !isRecord(view.base)) return undefined
  const { shelves, error } = view.base
  return {
    shelves: Array.isArray(shelves)
      ? shelves.flatMap((shelf): ShelfInfo[] => isRecord(shelf) && typeof shelf.name === 'string'
        ? [{
            name: shelf.name,
            path: typeof shelf.path === 'string' ? shelf.path : '',
            connected: shelf.connected === true,
          }]
        : [])
      : [],
    error: typeof error === 'string' ? error : '',
  }
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
