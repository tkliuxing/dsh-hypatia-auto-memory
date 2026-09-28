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

/**
 * Adapter-owned reasoning metadata for one catalog model. Derived from the
 * catalog type rather than re-declared, so a change upstream cannot drift from
 * what the card renders: `efforts` is the vocabulary the adapter accepts, in its
 * own preferred display order, and `defaultEffort` (optional) is what the
 * adapter materializes when a caller omits an effort.
 */
export type ConsolidationModelReasoning = NonNullable<ModelProviderGroup['models'][number]['reasoning']>

/** One exact provider/model route used for a consolidation attempt. */
export interface ConsolidationModelRoute {
  provider: string
  model: string
  /**
   * Optional thinking level for this route. Absent means "follow the purpose
   * policy", which is what every call did before the field existed: extraction
   * and adjudication ask for no reasoning where the route allows it, and the
   * archive call leaves the adapter's own default in place.
   *
   * The vocabulary is adapter-owned and opaque, so the card only ever offers
   * what this model's catalog entry declares.
   */
  reasoningEffort?: string
}

/** One catalog route, including stored routes no longer advertised by an adapter. */
export interface ConsolidationModelCandidate extends ConsolidationModelRoute {
  key: string
  providerName: string
  modelName: string
  available: boolean
  selected: boolean
  /** Absent for a route the catalog no longer advertises. */
  reasoning?: ConsolidationModelReasoning
}

/** One row of the thinking-level picker. */
export interface ReasoningEffortChoice {
  /** Stable key for React and for tests. */
  key: string
  /** Value to store; `undefined` means "follow the purpose policy". */
  effort: string | undefined
  /** Adapter-provided display name; the card supplies its own label when absent. */
  name?: string
  /** The stored value is no longer declared by this route. */
  stale?: boolean
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
 * catalog entry for a display name, an availability flag and the reasoning
 * levels the route declares.
 *
 * `consolidationModelCandidates` already guarantees every stored route appears —
 * taken from the catalog, or appended as unavailable — so the candidate list is
 * a lookup table for this. A route that somehow is not in it is still shown,
 * named by its raw ids and marked unavailable, because dropping it from the
 * priority list would hide a configured route from the only UI that can remove
 * it.
 *
 * `reasoningEffort` is taken from the STORED route, never from the catalog: the
 * catalog describes what a model can do, the stored route is what the user chose.
 */
export function orderedConsolidationModels(
  stored: readonly ConsolidationModelRoute[],
  candidates: readonly ConsolidationModelCandidate[],
): ConsolidationModelCandidate[] {
  const byKey = new Map(candidates.map(candidate => [candidate.key, candidate]))
  return stored.map((route) => {
    const key = consolidationModelKey(route)
    const base = byKey.get(key) ?? {
      ...route,
      key,
      providerName: route.provider,
      modelName: route.model,
      available: false,
      selected: true,
    }
    return { ...base, reasoningEffort: route.reasoningEffort }
  })
}

/**
 * The thinking-level options for one route, in the order they are offered.
 *
 * Two rules, both about not inventing a vocabulary this plugin does not own:
 *
 * - The list comes from the route's own declared `efforts`, in the adapter's
 *   preferred order, labelled with the adapter's own names. Nothing is
 *   hard-coded — the ids are opaque, and a level one adapter accepts is not one
 *   another does.
 * - "Follow the purpose policy" (`undefined`) is always first and is what an
 *   absent field stores. It is NOT the same as the adapter's `defaultEffort`:
 *   omitting the field lets the plugin's own per-purpose policy apply, which for
 *   extraction and adjudication means asking for no reasoning at all.
 *
 * A stored value the route no longer declares is appended and flagged rather
 * than dropped, so the card can show what is actually configured instead of
 * silently rewriting it — and so a route whose catalog entry disappeared still
 * displays its setting.
 *
 * @param reasoning - The route's catalog metadata; absent when the catalog does
 * not advertise the route, or the model declares no reasoning control.
 * @param stored - The configured value, if any.
 */
export function reasoningEffortChoices(
  reasoning: ConsolidationModelReasoning | undefined,
  stored: string | undefined,
): ReasoningEffortChoice[] {
  const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
  const choices: ReasoningEffortChoice[] = [{ key: 'purpose', effort: undefined }]
  for (const effort of efforts) {
    const id = typeof effort?.id === 'string' ? effort.id : ''
    if (id === '') continue
    const name = typeof effort.name === 'string' && effort.name !== '' ? effort.name : id
    choices.push({ key: `effort:${id}`, effort: id, name })
  }
  const value = typeof stored === 'string' ? stored.trim() : ''
  if (value !== '' && !efforts.some(effort => effort?.id === value)) {
    choices.push({ key: `stale:${value}`, effort: value, stale: true })
  }
  return choices
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
      // The adapter-owned vocabulary this route accepts, straight from the
      // catalog the card already loaded — no extra request, and no client-side
      // guess at what "low" or "high" mean.
      ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
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
