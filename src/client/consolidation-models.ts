/** Model-directory projection shared by the consolidation settings card. */

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
