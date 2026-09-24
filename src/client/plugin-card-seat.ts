/**
 * Which seat the settings card occupies on the harness that is running.
 *
 * dsh 0.1.7 moved a bundle's own configuration out of Settings. The sidebar's
 * Plugins page owns it now, and `plugins.bundle.config` — keyed by the bundle's
 * package name — is the seat that page renders on the bundle's own page. The
 * Settings section still declares `settings.plugins.tab`, and it is the only
 * seat a deployment whose profile does not mount the plugin manager page has.
 *
 * Three facts about the slot registry shape this module:
 *
 * - The harness declares the official seats before an external plugin's
 *   `apply()` runs, so the first attempt normally succeeds. It is a plain
 *   `register`, never a declaration probe: `register` is the operation the
 *   registry validates, and a probe would answer for a different question —
 *   "is this key declared?" is true even in the deployment whose whole point is
 *   the other seat.
 * - `register` throws for an undeclared seat. That refusal is the fallback
 *   signal, so the seats are tried rather than predicted.
 * - `slots/changed` is emitted synchronously from inside both `register` and a
 *   disposer, so an unguarded reconcile re-enters itself mid-move and registers
 *   the card twice into the seat it is leaving ("already has an entry for key
 *   …"). The latch below is what prevents that.
 *
 * The card is therefore in exactly one seat at any time: the official one when
 * the harness renders it, the Settings tab otherwise, and the Settings entry is
 * disposed before the official one is taken. This module holds the policy and
 * no client-SDK import, so the moves are unit-tested with a fake registry.
 *
 * @module dsh-hypatia-auto-memory/client/plugin-card-seat
 */

/** The official keyed seat on the sidebar Plugins page, keyed by bundle package name. */
export const BUNDLE_CONFIG_SEAT = 'plugins.bundle.config'

/** The list seat inside Settings → Built-in plugins, declared by the Settings section. */
export const SETTINGS_TAB_SEAT = 'settings.plugins.tab'

/** The slice of the client slot registry this module uses. */
export interface SeatRegistry {
  /**
   * Contribute one entry, or throw when the seat is not declared.
   * @param key - declared slot key to inject a contribution into.
   * @param callback - runs while that declaration is live; returns its disposer.
   * @returns idempotent disposer for the wait and the active contribution.
   */
  inject(key: string, callback: () => () => void): () => void
}

/** The slice of the browser plugin context this module uses. */
export interface SeatHost {
  readonly slots: SeatRegistry
  /** Subscribe to the registry's change event; absent on a host that has no event bus. */
  on?(event: 'slots/changed', listener: (key: string) => void): (() => void) | undefined
}

/** How to install one card into each seat, each throwing when that seat is not declared. */
export interface PluginCardSeats {
  /** The official keyed seat; the caller keys it by bundle package name. */
  readonly official: () => (() => void) | undefined
  /** The Settings tab; the caller passes its list-seat id, label and locale. */
  readonly settingsTab: () => (() => void) | undefined
  /**
   * Called once per seat that a registration attempt refused, for a diagnostic.
   * The official seat is expected to refuse while it is not declared yet, so a
   * deployment that renders it never reports anything here.
   */
  readonly onRefused?: (seat: string, error: unknown) => void
}

/**
 * Install one card into the seat this harness renders, following the harness if
 * the seat becomes available later.
 *
 * @param host - the client context's slot registry and event bus.
 * @param seats - the two seat contributions and an optional refusal diagnostic.
 * @returns one disposer that removes the card and stops watching.
 */
export function installPluginCard(host: SeatHost, seats: PluginCardSeats): () => void {
  /** The live official registration, while the card occupies that seat. */
  let official: (() => void) | undefined
  /** The live Settings-tab registration, while the card occupies that seat instead. */
  let settingsTab: (() => void) | undefined
  /** Set by the returned disposer: every later reconcile is a no-op. */
  let stopped = false
  /** Re-entrancy latch: the registry emits `slots/changed` from inside register and dispose. */
  let reconciling = false
  const refused = new Set<string>()

  /** One registration attempt, reporting its refusal once instead of on every retry. */
  const attempt = (seat: string, register: () => (() => void) | undefined): (() => void) | undefined => {
    try {
      return register()
    } catch (error) {
      if (!refused.has(seat)) {
        refused.add(seat)
        seats.onRefused?.(seat, error)
      }
      return undefined
    }
  }

  /** Take the official seat when it is declared, retiring the Settings fallback first. */
  const reconcile = (): void => {
    if (stopped || reconciling || official !== undefined) return
    reconciling = true
    try {
      const dispose = attempt(BUNDLE_CONFIG_SEAT, seats.official)
      if (dispose === undefined) return
      official = dispose
      const previous = settingsTab
      settingsTab = undefined
      previous?.()
    } finally {
      reconciling = false
    }
  }

  reconcile()

  // The fallback claims the Settings tab only while the official seat is absent.
  // Its declaration arrives when the Settings section mounts, which is after the
  // shell has declared the official seats — so on a harness that renders the
  // Plugins page this callback finds `official` already live and contributes
  // nothing.
  const stopWaiting = host.slots.inject(SETTINGS_TAB_SEAT, () => {
    if (stopped || official !== undefined || settingsTab !== undefined) return () => {}
    const dispose = attempt(SETTINGS_TAB_SEAT, seats.settingsTab)
    if (dispose === undefined) return () => {}
    settingsTab = dispose
    // The registration above emits `slots/changed`, so a reconcile can have taken
    // the official seat before this assignment: the card would then sit in two
    // seats. Re-check instead of assuming which ran first.
    if (official !== undefined) {
      settingsTab = undefined
      dispose()
      return () => {}
    }
    return () => {
      const current = settingsTab
      settingsTab = undefined
      current?.()
    }
  })

  const stopWatching = host.on?.('slots/changed', () => { reconcile() })

  return () => {
    stopped = true
    stopWatching?.()
    stopWaiting()
    const officialDispose = official
    official = undefined
    officialDispose?.()
    const settingsDispose = settingsTab
    settingsTab = undefined
    settingsDispose?.()
  }
}
