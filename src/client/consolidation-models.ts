/**
 * Model-directory projection shared by the consolidation settings card.
 *
 * Two projections of the same data, deliberately kept apart: the CATALOG one
 * (every advertised route, in directory order, with a `selected` flag) is the
 * pool a user picks from, and the ORDERED one (the stored array as-is) is the
 * priority list consolidation actually reads. Directory order must never leak
 * into the latter — it did, and the card then showed a rotation order the
 * configuration did not have.
 */

import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'

/** One exact provider/model route used for a consolidation attempt. */
export interface ConsolidationModelRoute {
  provider: string
  model: string
}

/** One catalog route, including stored routes no longer advertised by an adapter. */
export interface ConsolidationModelCandidate extends ConsolidationModelRoute {
  key: string
  providerName: string
  modelName: string
  available: boolean
  selected: boolean
}

/** One catalog response retained by the settings card. */
export interface ConsolidationModelCatalog {
  groups: readonly ModelProviderGroup[]
  partial: boolean
}

/** Load the current Host model directory for the settings card. */
export type LoadConsolidationModelCatalog = () => Promise<ConsolidationModelCatalog>

/** Stable opaque key for one exact route. */
export function consolidationModelKey(route: ConsolidationModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Move one entry of the priority list, returning a new array.
 *
 * The stored `consolidation.models` array IS the priority order, so this is the
 * only thing a reorder has to do: reorder the array. `to` is clamped instead of
 * rejected, so a click that cannot move anything (the first row's "up") is a
 * no-op rather than an error. A no-op returns the ORIGINAL reference, which lets
 * a caller use identity to skip the state update.
 *
 * @param models - Priority-ordered routes; not mutated.
 * @param from - Index to move.
 * @param to - Target index, clamped into `models`.
 */
export function moveConsolidationModel(
  models: ConsolidationModelRoute[],
  from: number,
  to: number,
): ConsolidationModelRoute[] {
  if (!Number.isInteger(from) || from < 0 || from >= models.length) return models
  if (!Number.isFinite(to)) return models
  const target = Math.min(Math.max(0, Math.trunc(to)), models.length - 1)
  if (target === from) return models
  const next = [...models]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}

/**
 * The stored routes in their configured (priority) order, each resolved to its
 * catalog entry for a display name and an availability flag.
 *
 * `consolidationModelCandidates` already guarantees every stored route appears —
 * taken from the catalog, or appended as unavailable — so the candidate list is
 * a lookup table for this. A route that somehow is not in it is still shown,
 * named by its raw ids and marked unavailable, because dropping it from the
 * priority list would hide a configured route from the only UI that can remove
 * it.
 */
export function orderedConsolidationModels(
  stored: readonly ConsolidationModelRoute[],
  candidates: readonly ConsolidationModelCandidate[],
): ConsolidationModelCandidate[] {
  const byKey = new Map(candidates.map(candidate => [candidate.key, candidate]))
  return stored.map((route) => {
    const key = consolidationModelKey(route)
    return byKey.get(key) ?? {
      ...route,
      key,
      providerName: route.provider,
      modelName: route.model,
      available: false,
      selected: true,
    }
  })
}

/**
 * Join the live model directory with selected routes that disappeared from it.
 * Disappeared routes remain visible so users can remove them deliberately.
 */
export function consolidationModelCandidates(
  groups: readonly ModelProviderGroup[],
  stored: readonly ConsolidationModelRoute[],
  selected: ReadonlySet<string>,
): ConsolidationModelCandidate[] {
  const storedByKey = new Map(stored.map(route => [consolidationModelKey(route), route]))
  const candidates = groups.flatMap(group => group.models.map((model): ConsolidationModelCandidate => {
    const route = { provider: group.id, model: model.id }
    const key = consolidationModelKey(route)
    storedByKey.delete(key)
    return {
      ...route,
      key,
      providerName: group.name,
      modelName: model.name,
      available: true,
      selected: selected.has(key),
    }
  }))
  for (const route of storedByKey.values()) {
    const key = consolidationModelKey(route)
    candidates.push({
      ...route,
      key,
      providerName: route.provider,
      modelName: route.model,
      available: false,
      selected: selected.has(key),
    })
  }
  return candidates
}
