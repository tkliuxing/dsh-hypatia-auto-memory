/**
 * Configuration card for the `hypatia-auto-memory` namespace, rendered on
 * whichever seat the harness offers (see `plugin-card-seat.ts`).
 *
 * The card is a disclosure over the harness's own settings form: the header
 * folds it (collapsed by default where the page already names the plugin), and
 * the frame inside — read-only notice, controls, save, failure line — is
 * `SettingsForm` with the shared `Switch`, so only the fields this plugin
 * invents are drawn here. Edits are staged until Save, as the form expects.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutlineRegular, Input, SettingsForm, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  consolidationModelCandidates,
  consolidationModelKey,
  moveConsolidationModel,
  orderedConsolidationModels,
  reasoningEffortChoices,
  type ConsolidationModelCandidate,
  type ConsolidationModelRoute,
  type LoadConsolidationModelCatalog,
  type ReasoningEffortChoice,
} from './consolidation-models'
import { DEFAULT_SHELF, shelfChoices, type LoadShelfInventory, type ShelfInfo } from './shelves'
import css from './SettingsCard.module.css'
import { NS } from './locales'
import './slot-contract'

const DEFAULT_CONSOLIDATION = {
  models: [] as ConsolidationModelRoute[],
  maxInputTokens: 16000,
  maxOutputTokens: 2000,
  timeoutMs: 120000,
  checkEveryTurns: 5,
  minNewTokens: 3000,
  maxWorkUnitsPerRun: 3,
  adjudicate: true,
  dedupMaxDistance: 0.45,
  cascade: { enabled: true, batchSize: 16 },
}

export interface ConfigShape {
  enabled?: boolean
  autoApprove?: boolean
  shelf?: string
  consolidation?: typeof DEFAULT_CONSOLIDATION
  recall?: { preloadRulesTaboos?: boolean }
}

/** JSON value one `set` operation carries; the draft's fields are JSON-shaped. */
type FieldValue = Extract<SettingsPathOpView, { op: 'set' }>['value']

function getSnapshotValue<T>(form: ConfigForm<T>): ConfigFormSnapshot<T> {
  return form.getSnapshot()
}

function subscribe(form: ConfigForm<unknown>, cb: () => void) {
  return form.subscribe(cb)
}

function sectionValue<T>(snap: ConfigFormSnapshot<T>): T | undefined {
  return snap.value ?? (snap.base as T | undefined) ?? undefined
}

function useScopeValue<T>(form: ConfigForm<T>) {
  const [snap, setSnap] = useState(() => getSnapshotValue(form))
  useEffect(() => {
    setSnap(getSnapshotValue(form))
    return subscribe(form as ConfigForm<unknown>, () => setSnap(getSnapshotValue(form)))
  }, [form])
  const value = useMemo(() => sectionValue(snap), [snap])
  return { snap, value }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Which seat renders the card: the bundle's own page on the Plugins page, or the Settings fallback tab. */
export type SettingsCardSeat = 'official' | 'settings-tab'

export type SettingsCardProps = {
  scope: ConfigForm<ConfigShape>
  loadModelCatalog: LoadConsolidationModelCatalog
  loadShelfInventory: LoadShelfInventory
  /**
   * The seat this instance occupies. The Plugins page draws the bundle's title
   * and one-liner above the card, so the card heads itself with the section's
   * own name there; the Settings tab has no such page, so the card carries the
   * plugin's name instead and starts expanded.
   */
  seat: SettingsCardSeat
} & PropsLocale<typeof NS>

export function SettingsCard({ scope, loadModelCatalog, loadShelfInventory, seat, t }: SettingsCardProps) {
  const bodyId = useId()
  // Collapsed by default where the page already names the plugin; the Settings
  // tab is the plugin's whole page, so its card opens.
  const [open, setOpen] = useState(seat === 'settings-tab')
  const { snap, value } = useScopeValue(scope)
  const disabled = !snap.writable
  const base = useMemo(() => (snap.base ?? {}) as ConfigShape, [snap.base])

  const resolved: ConfigShape = useMemo(() => (value ?? base ?? {
    enabled: true,
    autoApprove: true,
    shelf: DEFAULT_SHELF,
    consolidation: DEFAULT_CONSOLIDATION,
    recall: { preloadRulesTaboos: true },
  }), [value, base])

  const [draft, setDraft] = useState(resolved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [catalogStatus, setCatalogStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [catalogGroups, setCatalogGroups] = useState<Parameters<typeof consolidationModelCandidates>[0]>([])
  const [catalogPartial, setCatalogPartial] = useState(false)
  const catalogGeneration = useRef(0)
  const [shelfStatus, setShelfStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [shelves, setShelves] = useState<ShelfInfo[]>([])
  const [shelfListingError, setShelfListingError] = useState('')
  const shelfGeneration = useRef(0)

  useEffect(() => {
    setDraft(resolved)
  }, [resolved])

  const dirty = useMemo(() => !same(draft, resolved), [draft, resolved])
  const consolidation = draft.consolidation ?? DEFAULT_CONSOLIDATION
  const recall = draft.recall ?? { preloadRulesTaboos: true }
  const saveBlocked = disabled || !dirty || saving

  const updateConsolidation = useCallback((patch: Partial<typeof DEFAULT_CONSOLIDATION>) => {
    setDraft((prev) => ({
      ...prev,
      consolidation: { ...(prev.consolidation ?? DEFAULT_CONSOLIDATION), ...patch },
    }))
  }, [])

  const loadCatalog = useCallback(async () => {
    const generation = ++catalogGeneration.current
    setCatalogStatus('loading')
    setCatalogPartial(false)
    try {
      const catalog = await loadModelCatalog()
      if (generation !== catalogGeneration.current) return
      setCatalogGroups(catalog.groups)
      setCatalogPartial(catalog.partial)
      setCatalogStatus('ready')
    } catch {
      if (generation !== catalogGeneration.current) return
      setCatalogStatus('error')
    }
  }, [loadModelCatalog])

  // The tab panel mounts the card when the tab is first shown, so "on mount"
  // is "when the user opens this plugin's settings".
  useEffect(() => {
    void loadCatalog()
    return () => { catalogGeneration.current += 1 }
  }, [loadCatalog])

  const loadShelves = useCallback(async () => {
    const generation = ++shelfGeneration.current
    setShelfStatus('loading')
    try {
      const inventory = await loadShelfInventory()
      if (generation !== shelfGeneration.current) return
      setShelves(inventory.shelves)
      setShelfListingError(inventory.error)
      setShelfStatus('ready')
    } catch {
      if (generation !== shelfGeneration.current) return
      setShelfStatus('error')
    }
  }, [loadShelfInventory])

  useEffect(() => {
    void loadShelves()
    return () => { shelfGeneration.current += 1 }
  }, [loadShelves])

  const draftShelf = draft.shelf ?? DEFAULT_SHELF
  const baseShelf = base.shelf ?? DEFAULT_SHELF
  const choices = useMemo(
    () => shelfChoices(shelves, [draftShelf, resolved.shelf ?? DEFAULT_SHELF, baseShelf]),
    [shelves, draftShelf, resolved.shelf, baseShelf],
  )
  const chosen = choices.find(choice => choice.name === draftShelf)

  const candidates = useMemo(() => {
    const models = consolidation.models ?? []
    return consolidationModelCandidates(
      catalogGroups,
      models,
      new Set(models.map(consolidationModelKey)),
    )
  }, [catalogGroups, consolidation.models])

  // The draft's own order, NOT the catalog's: this list is what the Host reads
  // as the priority order, so it has to show the stored array verbatim.
  const selectedModels = useMemo(
    () => orderedConsolidationModels(consolidation.models ?? [], candidates),
    [consolidation.models, candidates],
  )

  const toggleModel = useCallback((candidate: ConsolidationModelCandidate) => {
    if (disabled || saving) return
    setDraft((current) => {
      const currentConsolidation = current.consolidation ?? DEFAULT_CONSOLIDATION
      const currentModels = currentConsolidation.models ?? []
      const key = consolidationModelKey(candidate)
      const selected = currentModels.some(route => consolidationModelKey(route) === key)
      const models = selected
        ? currentModels.filter(route => consolidationModelKey(route) !== key)
        : [...currentModels, { provider: candidate.provider, model: candidate.model }]
      return {
        ...current,
        consolidation: { ...currentConsolidation, models },
      }
    })
  }, [disabled, saving])

  /**
   * Reorder one entry of the priority list. A no-op move leaves the draft
   * untouched (the mover returns the original array), so the "unsaved" badge
   * does not light up for a click that changed nothing.
   */
  const moveModel = useCallback((from: number, to: number) => {
    if (disabled || saving) return
    setDraft((current) => {
      const currentConsolidation = current.consolidation ?? DEFAULT_CONSOLIDATION
      const currentModels = currentConsolidation.models ?? []
      const models = moveConsolidationModel(currentModels, from, to)
      if (models === currentModels) return current
      return {
        ...current,
        consolidation: { ...currentConsolidation, models },
      }
    })
  }, [disabled, saving])

  /**
   * Set or clear one route's thinking level. Clearing REMOVES the key rather
   * than storing `undefined`, so the saved patch carries only what the user
   * chose and nothing reading the profile can confuse "not configured" with
   * "configured as nothing".
   */
  const setModelEffort = useCallback((index: number, effort: string | undefined) => {
    if (disabled || saving) return
    setDraft((current) => {
      const currentConsolidation = current.consolidation ?? DEFAULT_CONSOLIDATION
      const currentModels = currentConsolidation.models ?? []
      if (index < 0 || index >= currentModels.length) return current
      const models = currentModels.map((route, at) => {
        if (at !== index) return route
        if (effort === undefined) {
          const cleared = { ...route }
          delete cleared.reasoningEffort
          return cleared
        }
        return { ...route, reasoningEffort: effort }
      })
      return {
        ...current,
        consolidation: { ...currentConsolidation, models },
      }
    })
  }, [disabled, saving])

  /** Display label for one thinking-level option, in the card's own words. */
  const effortChoiceLabel = useCallback((choice: ReasoningEffortChoice): string => {
    if (choice.effort === undefined) return t('reasoningFollowPurpose')
    const name = choice.name ?? choice.effort
    // A value the route no longer declares is shown, not hidden: rewriting the
    // user's configuration behind their back is worse than showing a stale one.
    return choice.stale === true ? `${name} · ${t('reasoningStale')}` : name
  }, [t])

  /**
   * What the adapter does when no effort is sent. Only a hint: this plugin
   * cannot pin it, because omitting the field is what lets its own per-purpose
   * policy apply.
   */
  const routeDefaultLabel = useCallback((candidate: ConsolidationModelCandidate): string | undefined => {
    const reasoning = candidate.reasoning
    const fallback = reasoning?.defaultEffort
    if (reasoning === undefined || fallback === undefined) return undefined
    const named = reasoning.efforts.find(effort => effort.id === fallback)
    return t('reasoningDefault', { effort: named?.name ?? fallback })
  }, [t])

  const discard = useCallback(() => {
    setDraft(resolved)
    setError(null)
  }, [resolved])

  const save = useCallback(async () => {
    if (saveBlocked) return
    setSaving(true)
    setError(null)
    try {
      const ops: SettingsPathOpView[] = []
      const setField = (field: keyof ConfigShape, value: unknown) => {
        ops.push({ op: 'set', path: [field], value: value as FieldValue })
      }
      if (!same(draft.enabled, resolved.enabled)) setField('enabled', draft.enabled)
      if (!same(draft.autoApprove, resolved.autoApprove)) setField('autoApprove', draft.autoApprove)
      if (!same(draft.shelf, resolved.shelf)) setField('shelf', draft.shelf)
      if (!same(draft.consolidation, resolved.consolidation)) setField('consolidation', draft.consolidation)
      if (!same(draft.recall, resolved.recall)) setField('recall', draft.recall)
      // One atomic mutation: the Host validates and commits every changed
      // field together, so a refusal (a concurrent edit, a value the schema
      // rejects) saves nothing rather than half the form. ConfigForm resolves
      // false on refusal instead of rejecting, and reloads the saved values.
      if (ops.length > 0 && !await scope.mutate(ops)) {
        throw new Error('the Host refused the change; nothing was saved')
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[${NS}] save failed:`, err)
      setError(message)
    } finally {
      setSaving(false)
    }
  }, [draft, resolved, saveBlocked, scope])

  if (snap.status === 'loading') {
    return <p className={css.status}>{t('loading', { ns: NS })}</p>
  }
  if (snap.status === 'unavailable') {
    return <p className={css.status}>{t('unavailable', { ns: NS })}</p>
  }

  const availableGroups = new Map<string, {
    providerName: string
    candidates: ConsolidationModelCandidate[]
  }>()
  const unavailable: ConsolidationModelCandidate[] = []
  for (const candidate of candidates) {
    if (!candidate.available) {
      unavailable.push(candidate)
      continue
    }
    const group = availableGroups.get(candidate.provider)
    if (group === undefined) {
      availableGroups.set(candidate.provider, {
        providerName: candidate.providerName,
        candidates: [candidate],
      })
    } else {
      group.candidates.push(candidate)
    }
  }

  const renderCandidate = (candidate: ConsolidationModelCandidate) => (
    <label key={candidate.key} className={css.model}>
      <input
        type="checkbox"
        checked={candidate.selected}
        disabled={disabled || saving}
        onChange={() => toggleModel(candidate)}
      />
      <span>
        <span className={css.modelName}>{candidate.modelName}</span>
        <span className={css.route}>{`${candidate.providerName} · ${candidate.provider}/${candidate.model}`}</span>
      </span>
      {!candidate.available ? <span className={css.unavailable}>{t('modelUnavailable')}</span> : null}
    </label>
  )

  return (
    <section className={css.card} aria-label={t('title')}>
      <div className={css.header}>
        <button
          type="button"
          className={css.toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconChevronDownOutlineRegular className={css.chevron} size={12} aria-hidden="true" />
          {seat === 'settings-tab'
            ? (
              <span className={css.headText}>
                <span className={css.name}>{t('title')}</span>
                <span className={css.description}>{t('description')}</span>
              </span>
            )
            : <span className={css.sectionName}>{t('configSection')}</span>}
        </button>
        {error !== null
          ? <span className={css.failedPill}>{t('saveFailedShort')}</span>
          : dirty ? <span className={css.pending}>{t('unsaved')}</span> : null}
      </div>

      {/* Kept mounted while collapsed: a disclosure is not a page change, and a
          staged edit must survive folding the card. */}
      <div className={css.body} id={bodyId} hidden={!open}>
        <SettingsForm
          labels={{
            unavailable: t('unavailable', { ns: NS }),
            readOnly: t('readOnly'),
            saveFailed: t('saveFailed', { message: error ?? '' }),
            save: t('save'),
            saving: t('saving'),
          }}
          // The loading and unavailable documents return above, so the frame
          // this renders is always an available one.
          state={{ available: true, writable: snap.writable, dirty, invalid: false, saving, failed: error !== null }}
          onSave={() => { void save() }}
          onDiscard={discard}
        >
          <div className={css.field}>
            <div className={css.fieldHead}>
              <span className={css.label}>{t('enable')}</span>
              {draft.enabled !== (base.enabled ?? true) ? (
                <button
                  type="button"
                  className={css.reset}
                  disabled={disabled}
                  onClick={() => setDraft((current) => ({ ...current, enabled: base.enabled ?? true }))}
                >
                  {t('reset')}
                </button>
              ) : null}
            </div>
            <Switch
              checked={draft.enabled ?? true}
              label={t('enable')}
              disabled={disabled}
              onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </div>

          <div className={css.field}>
            <div className={css.fieldHead}>
              <span className={css.label}>{t('autoApprove')}</span>
              {(draft.autoApprove ?? true) !== (base.autoApprove ?? true) ? (
                <button
                  type="button"
                  className={css.reset}
                  disabled={disabled}
                  onClick={() => setDraft((current) => ({ ...current, autoApprove: base.autoApprove ?? true }))}
                >
                  {t('reset')}
                </button>
              ) : null}
            </div>
            <Switch
              checked={draft.autoApprove ?? true}
              label={t('autoApprove')}
              disabled={disabled}
              onChange={(autoApprove) => setDraft((current) => ({ ...current, autoApprove }))}
            />
            <p className={css.hint}>{t('autoApproveHint')}</p>
          </div>

          <div className={css.field}>
            <div className={css.fieldHead}>
              <label className={css.label} htmlFor="ham-shelf">{t('shelf')}</label>
              {draftShelf !== baseShelf ? (
                <button
                  type="button"
                  className={css.reset}
                  disabled={disabled}
                  onClick={() => setDraft((current) => ({ ...current, shelf: baseShelf }))}
                >
                  {t('reset')}
                </button>
              ) : null}
            </div>
            <select
              id="ham-shelf"
              className={css.select}
              value={draftShelf}
              disabled={disabled || saving}
              onChange={(event) => {
                const shelf = event.target.value
                setDraft((current) => ({ ...current, shelf }))
              }}
            >
              {choices.map(choice => (
                <option key={choice.name} value={choice.name}>
                  {choice.name}
                  {choice.path !== '' ? ` — ${choice.path}` : ''}
                  {!choice.listed
                    ? t('shelfOptionStatus', { status: t('shelfNotListed') })
                    : !choice.connected ? t('shelfOptionStatus', { status: t('shelfDisconnected') }) : ''}
                </option>
              ))}
            </select>
            {shelfStatus === 'loading' ? <p className={css.notice} role="status">{t('shelfLoading')}</p> : null}
            {shelfStatus === 'error' ? (
              <div className={css.catalogError} role="alert">
                <span>{t('shelfLoadFailed')}</span>
                <button type="button" disabled={saving} onClick={() => { void loadShelves() }}>{t('retry')}</button>
              </div>
            ) : null}
            {shelfStatus === 'ready' && shelfListingError !== '' ? (
              <p className={css.notice} role="status">{t('shelfListingFailed', { message: shelfListingError })}</p>
            ) : null}
            {shelfStatus === 'ready' && shelfListingError === '' && chosen !== undefined && (!chosen.listed || !chosen.connected) ? (
              <p className={css.warning} role="status">{t(chosen.listed ? 'shelfDisconnectedWarning' : 'shelfNotListedWarning', { shelf: chosen.name })}</p>
            ) : null}
            <p className={css.hint}>{t('shelfHint')}</p>
          </div>

          <section className={css.group} aria-labelledby="ham-consolidation-title">
            <h3 id="ham-consolidation-title" className={css.groupTitle}>{t('consolidationTitle')}</h3>
            <p className={css.hint}>{t('modelSelectionHint')}</p>

            <div className={css.modelSelection}>
              {catalogStatus === 'loading' ? <p className={css.notice} role="status">{t('modelCatalogLoading')}</p> : null}
              {catalogStatus === 'error' ? (
                <div className={css.catalogError} role="alert">
                  <span>{t('modelCatalogFailed')}</span>
                  <button type="button" disabled={saving} onClick={() => { void loadCatalog() }}>{t('retry')}</button>
                </div>
              ) : null}
              {catalogPartial ? <p className={css.notice}>{t('modelCatalogPartial')}</p> : null}
              {candidates.length > 0 ? (
                <>
                  <fieldset className={css.models}>
                    <legend>{t('selectedModels')}</legend>
                    {selectedModels.length === 0 ? (
                      <p className={css.notice}>{t('selectedModelsEmpty')}</p>
                    ) : selectedModels.map((candidate, index) => (
                      <div key={candidate.key} className={css.selectedRow}>
                        <span className={css.order}>{index + 1}</span>
                        <span className={css.selectedText}>
                          <span className={css.modelName}>{candidate.modelName}</span>
                          <span className={css.route}>{`${candidate.providerName} · ${candidate.provider}/${candidate.model}`}</span>
                        </span>
                        <select
                          className={css.effort}
                          aria-label={`${t('reasoningEffort')}: ${candidate.modelName}`}
                          title={candidate.reasoning === undefined
                            ? t('reasoningUnavailable')
                            : routeDefaultLabel(candidate) ?? t('reasoningFollowPurpose')}
                          value={candidate.reasoningEffort ?? ''}
                          disabled={disabled || saving || candidate.reasoning === undefined}
                          onChange={(event) => setModelEffort(index, event.target.value === '' ? undefined : event.target.value)}
                        >
                          {reasoningEffortChoices(candidate.reasoning, candidate.reasoningEffort).map(choice => (
                            <option key={choice.key} value={choice.effort ?? ''}>{effortChoiceLabel(choice)}</option>
                          ))}
                        </select>
                        {!candidate.available ? <span className={css.unavailable}>{t('modelUnavailable')}</span> : null}
                        <span className={css.rowActions}>
                          <button
                            type="button"
                            className={css.move}
                            title={t('moveUp')}
                            aria-label={`${t('moveUp')}: ${candidate.modelName}`}
                            disabled={disabled || saving || index === 0}
                            onClick={() => moveModel(index, index - 1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className={css.move}
                            title={t('moveDown')}
                            aria-label={`${t('moveDown')}: ${candidate.modelName}`}
                            disabled={disabled || saving || index === selectedModels.length - 1}
                            onClick={() => moveModel(index, index + 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className={css.move}
                            title={t('remove')}
                            aria-label={`${t('remove')}: ${candidate.modelName}`}
                            disabled={disabled || saving}
                            onClick={() => toggleModel(candidate)}
                          >
                            ×
                          </button>
                        </span>
                      </div>
                    ))}
                  </fieldset>

                  <fieldset className={css.models}>
                    <legend>{t('availableModels')}</legend>
                    {[...availableGroups].map(([provider, group]) => (
                      <div key={provider} className={css.modelGroup}>
                        <div className={css.providerName}>{group.providerName}</div>
                        {group.candidates.map(renderCandidate)}
                      </div>
                    ))}
                    {unavailable.length > 0 ? (
                      <div className={css.modelGroup}>
                        <div className={css.providerName}>{t('unavailableModels')}</div>
                        {unavailable.map(renderCandidate)}
                      </div>
                    ) : null}
                  </fieldset>
                </>
              ) : catalogStatus === 'ready' ? <p className={css.notice}>{t('modelCatalogEmpty')}</p> : null}
              <p className={css.hint}>{t('reasoningBudgetHint')}</p>
            </div>

            <div className={css.pairedFields}>
              <div className={css.field}>
                <div className={css.fieldHead}>
                  <label className={css.label} htmlFor="ham-checkEveryTurns">{t('checkEveryTurns')}</label>
                  {consolidation.checkEveryTurns !== (base.consolidation?.checkEveryTurns ?? DEFAULT_CONSOLIDATION.checkEveryTurns) ? (
                    <button
                      type="button"
                      className={css.reset}
                      disabled={disabled}
                      onClick={() => updateConsolidation({ checkEveryTurns: base.consolidation?.checkEveryTurns ?? DEFAULT_CONSOLIDATION.checkEveryTurns })}
                    >
                      {t('reset')}
                    </button>
                  ) : null}
                </div>
                <Input
                  id="ham-checkEveryTurns"
                  className={css.input}
                  type="number"
                  min={1}
                  value={consolidation.checkEveryTurns}
                  disabled={disabled}
                  onChange={(event) => updateConsolidation({ checkEveryTurns: Number(event.target.value) })}
                />
              </div>
              <div className={css.field}>
                <div className={css.fieldHead}>
                  <label className={css.label} htmlFor="ham-minNewTokens">{t('minNewTokens')}</label>
                  {consolidation.minNewTokens !== (base.consolidation?.minNewTokens ?? DEFAULT_CONSOLIDATION.minNewTokens) ? (
                    <button
                      type="button"
                      className={css.reset}
                      disabled={disabled}
                      onClick={() => updateConsolidation({ minNewTokens: base.consolidation?.minNewTokens ?? DEFAULT_CONSOLIDATION.minNewTokens })}
                    >
                      {t('reset')}
                    </button>
                  ) : null}
                </div>
                <Input
                  id="ham-minNewTokens"
                  className={css.input}
                  type="number"
                  min={0}
                  value={consolidation.minNewTokens}
                  disabled={disabled}
                  onChange={(event) => updateConsolidation({ minNewTokens: Number(event.target.value) })}
                />
              </div>
            </div>

            <div className={css.pairedFields}>
              <div className={css.field}>
                <div className={css.fieldHead}>
                  <label className={css.label} htmlFor="ham-cascadeBatchSize">{t('cascadeBatchSize')}</label>
                  {(consolidation.cascade?.batchSize ?? DEFAULT_CONSOLIDATION.cascade.batchSize)
                    !== (base.consolidation?.cascade?.batchSize ?? DEFAULT_CONSOLIDATION.cascade.batchSize) ? (
                      <button
                        type="button"
                        className={css.reset}
                        disabled={disabled}
                        onClick={() => updateConsolidation({
                          cascade: {
                            ...(consolidation.cascade ?? DEFAULT_CONSOLIDATION.cascade),
                            batchSize: base.consolidation?.cascade?.batchSize ?? DEFAULT_CONSOLIDATION.cascade.batchSize,
                          },
                        })}
                      >
                        {t('reset')}
                      </button>
                    ) : null}
                </div>
                <Input
                  id="ham-cascadeBatchSize"
                  className={css.input}
                  type="number"
                  min={2}
                  value={consolidation.cascade?.batchSize ?? DEFAULT_CONSOLIDATION.cascade.batchSize}
                  disabled={disabled}
                  onChange={(event) => updateConsolidation({
                    cascade: {
                      ...(consolidation.cascade ?? DEFAULT_CONSOLIDATION.cascade),
                      batchSize: Number(event.target.value),
                    },
                  })}
                />
              </div>
              <div className={css.field}>
                <div className={css.fieldHead}>
                  <label className={css.label} htmlFor="ham-dedupMaxDistance">{t('dedupMaxDistance')}</label>
                  {(consolidation.dedupMaxDistance ?? DEFAULT_CONSOLIDATION.dedupMaxDistance)
                    !== (base.consolidation?.dedupMaxDistance ?? DEFAULT_CONSOLIDATION.dedupMaxDistance) ? (
                      <button
                        type="button"
                        className={css.reset}
                        disabled={disabled}
                        onClick={() => updateConsolidation({
                          dedupMaxDistance: base.consolidation?.dedupMaxDistance ?? DEFAULT_CONSOLIDATION.dedupMaxDistance,
                        })}
                      >
                        {t('reset')}
                      </button>
                    ) : null}
                </div>
                <Input
                  id="ham-dedupMaxDistance"
                  className={css.input}
                  type="number"
                  min={0}
                  step={0.05}
                  value={consolidation.dedupMaxDistance ?? DEFAULT_CONSOLIDATION.dedupMaxDistance}
                  disabled={disabled}
                  onChange={(event) => updateConsolidation({ dedupMaxDistance: Number(event.target.value) })}
                />
              </div>
            </div>
            <p className={css.hint}>{t('cascadeHint')}</p>

            <h4 className={css.limitsTitle}>{t('limitsTitle')}</h4>
            <p className={css.hint}>{t('limitsHint')}</p>
            <div className={css.pairedFields}>
              <div className={css.field}>
                <div className={css.fieldHead}>
                  <label className={css.label} htmlFor="ham-maxInputTokens">{t('maxInputTokens')}</label>
                  {consolidation.maxInputTokens !== (base.consolidation?.maxInputTokens ?? DEFAULT_CONSOLIDATION.maxInputTokens) ? (
                    <button
                      type="button"
                      className={css.reset}
                      disabled={disabled}
                      onClick={() => updateConsolidation({ maxInputTokens: base.consolidation?.maxInputTokens ?? DEFAULT_CONSOLIDATION.maxInputTokens })}
                    >
                      {t('reset')}
                    </button>
                  ) : null}
                </div>
                <Input
                  id="ham-maxInputTokens"
                  className={css.input}
                  type="number"
                  min={1000}
                  step={1000}
                  value={consolidation.maxInputTokens}
                  disabled={disabled}
                  onChange={(event) => updateConsolidation({ maxInputTokens: Number(event.target.value) })}
                />
              </div>
              <div className={css.field}>
                <div className={css.fieldHead}>
                  <label className={css.label} htmlFor="ham-maxOutputTokens">{t('maxOutputTokens')}</label>
                  {consolidation.maxOutputTokens !== (base.consolidation?.maxOutputTokens ?? DEFAULT_CONSOLIDATION.maxOutputTokens) ? (
                    <button
                      type="button"
                      className={css.reset}
                      disabled={disabled}
                      onClick={() => updateConsolidation({ maxOutputTokens: base.consolidation?.maxOutputTokens ?? DEFAULT_CONSOLIDATION.maxOutputTokens })}
                    >
                      {t('reset')}
                    </button>
                  ) : null}
                </div>
                <Input
                  id="ham-maxOutputTokens"
                  className={css.input}
                  type="number"
                  min={200}
                  step={200}
                  value={consolidation.maxOutputTokens}
                  disabled={disabled}
                  onChange={(event) => updateConsolidation({ maxOutputTokens: Number(event.target.value) })}
                />
              </div>
              <div className={css.field}>
                <div className={css.fieldHead}>
                  <label className={css.label} htmlFor="ham-maxWorkUnitsPerRun">{t('maxWorkUnitsPerRun')}</label>
                  {consolidation.maxWorkUnitsPerRun !== (base.consolidation?.maxWorkUnitsPerRun ?? DEFAULT_CONSOLIDATION.maxWorkUnitsPerRun) ? (
                    <button
                      type="button"
                      className={css.reset}
                      disabled={disabled}
                      onClick={() => updateConsolidation({ maxWorkUnitsPerRun: base.consolidation?.maxWorkUnitsPerRun ?? DEFAULT_CONSOLIDATION.maxWorkUnitsPerRun })}
                    >
                      {t('reset')}
                    </button>
                  ) : null}
                </div>
                <Input
                  id="ham-maxWorkUnitsPerRun"
                  className={css.input}
                  type="number"
                  min={1}
                  max={10}
                  value={consolidation.maxWorkUnitsPerRun}
                  disabled={disabled}
                  onChange={(event) => updateConsolidation({ maxWorkUnitsPerRun: Number(event.target.value) })}
                />
              </div>
            </div>
          </section>

          <div className={css.field}>
            <div className={css.fieldHead}>
              <span className={css.label}>{t('recallPreload')}</span>
              {(recall.preloadRulesTaboos ?? true) !== (base.recall?.preloadRulesTaboos ?? true) ? (
                <button
                  type="button"
                  className={css.reset}
                  disabled={disabled}
                  onClick={() => setDraft((current) => ({
                    ...current,
                    recall: {
                      ...(current.recall ?? { preloadRulesTaboos: true }),
                      preloadRulesTaboos: base.recall?.preloadRulesTaboos ?? true,
                    },
                  }))}
                >
                  {t('reset')}
                </button>
              ) : null}
            </div>
            <Switch
              checked={recall.preloadRulesTaboos ?? true}
              label={t('recallPreload')}
              disabled={disabled}
              onChange={(preloadRulesTaboos) => setDraft((current) => ({
                ...current,
                recall: { ...(current.recall ?? { preloadRulesTaboos: true }), preloadRulesTaboos },
              }))}
            />
          </div>

          <p className={css.advancedHint}>{t('advancedHint', { ns: NS })}</p>
        </SettingsForm>
      </div>
    </section>
  )
}
