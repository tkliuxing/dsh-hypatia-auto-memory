/**
 * Settings card for the `hypatia-auto-memory` namespace.
 *
 * The card owns its disclosure state and stages edits until Save. Its visual
 * treatment mirrors the DSH plugin-settings cards while remaining bundle-local.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconChevronDownOutline14, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  consolidationModelCandidates,
  consolidationModelKey,
  type ConsolidationModelCandidate,
  type ConsolidationModelRoute,
  type LoadConsolidationModelCatalog,
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

function getSnapshotValue<T>(scope: SettingsScope<T>): SettingsScopeSnapshot<T> {
  return scope.getSnapshot()
}

function subscribe(scope: SettingsScope<unknown>, cb: () => void) {
  return scope.subscribe(cb)
}

function sectionValue<T>(snap: SettingsScopeSnapshot<T>): T | undefined {
  return snap.value ?? (snap.base as T | undefined) ?? undefined
}

function useScopeValue<T>(scope: SettingsScope<T>) {
  const [snap, setSnap] = useState(() => getSnapshotValue(scope))
  useEffect(() => {
    setSnap(getSnapshotValue(scope))
    return subscribe(scope as SettingsScope<unknown>, () => setSnap(getSnapshotValue(scope)))
  }, [scope])
  const value = useMemo(() => sectionValue(snap), [snap])
  return { snap, value }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export type SettingsCardProps = {
  scope: SettingsScope<ConfigShape>
  loadModelCatalog: LoadConsolidationModelCatalog
  loadShelfInventory: LoadShelfInventory
} & PropsLocale<typeof NS>

export function SettingsCard({ scope, loadModelCatalog, loadShelfInventory, t }: SettingsCardProps) {
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
  const [open, setOpen] = useState(false)
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

  useEffect(() => {
    if (!open) return
    void loadCatalog()
    return () => { catalogGeneration.current += 1 }
  }, [open, loadCatalog])

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
    if (!open) return
    void loadShelves()
    return () => { shelfGeneration.current += 1 }
  }, [open, loadShelves])

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

  const discard = useCallback(() => {
    setDraft(resolved)
    setError(null)
  }, [resolved])

  const save = useCallback(async () => {
    if (saveBlocked) return
    setSaving(true)
    setError(null)
    try {
      const tasks: Promise<void>[] = []
      if (!same(draft.enabled, resolved.enabled)) {
        tasks.push(scope.set('enabled', draft.enabled))
      }
      if (!same(draft.autoApprove, resolved.autoApprove)) {
        tasks.push(scope.set('autoApprove', draft.autoApprove))
      }
      if (!same(draft.shelf, resolved.shelf)) {
        tasks.push(scope.set('shelf', draft.shelf))
      }
      if (!same(draft.consolidation, resolved.consolidation)) {
        tasks.push(scope.set('consolidation', draft.consolidation))
      }
      if (!same(draft.recall, resolved.recall)) {
        tasks.push(scope.set('recall', draft.recall))
      }
      await Promise.all(tasks)
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
    return <li className={css.status}>{t('loading', { ns: NS })}</li>
  }
  if (snap.status === 'unavailable') {
    return <li className={css.status}>{t('unavailable', { ns: NS })}</li>
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
    <li className={`${css.card} ${open ? css.cardOpen : ''}`}>
      <button
        type="button"
        className={css.header}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('title')}</span>
          <span className={css.description}>{t('description')}</span>
        </span>
        {dirty ? <span className={css.pending}>{t('unsaved')}</span> : null}
        <IconChevronDownOutline14 className={`${css.chevron} ${open ? css.chevronOpen : ''}`} />
      </button>

      {open ? (
        <div className={css.body}>
          {!snap.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}

          <div className={css.field}>
            <div className={css.fieldHead}>
              <label className={css.label} htmlFor="ham-enabled">{t('enable')}</label>
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
            <button
              id="ham-enabled"
              type="button"
              role="switch"
              aria-checked={draft.enabled ?? true}
              aria-label={t('enable')}
              className={`${css.switch} ${draft.enabled ?? true ? css.switchOn : ''}`}
              disabled={disabled}
              onClick={() => setDraft((current) => ({ ...current, enabled: !(current.enabled ?? true) }))}
            >
              <span className={css.switchThumb} />
            </button>
          </div>

          <div className={css.field}>
            <div className={css.fieldHead}>
              <label className={css.label} htmlFor="ham-autoApprove">{t('autoApprove')}</label>
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
            <button
              id="ham-autoApprove"
              type="button"
              role="switch"
              aria-checked={draft.autoApprove ?? true}
              aria-label={t('autoApprove')}
              className={`${css.switch} ${draft.autoApprove ?? true ? css.switchOn : ''}`}
              disabled={disabled}
              onClick={() => setDraft((current) => ({ ...current, autoApprove: !(current.autoApprove ?? true) }))}
            >
              <span className={css.switchThumb} />
            </button>
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
                <fieldset className={css.models}>
                  <legend>{t('selectedModels')}</legend>
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
              ) : catalogStatus === 'ready' ? <p className={css.notice}>{t('modelCatalogEmpty')}</p> : null}
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
              <label className={css.label} htmlFor="ham-preloadRulesTaboos">{t('recallPreload')}</label>
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
            <button
              id="ham-preloadRulesTaboos"
              type="button"
              role="switch"
              aria-checked={recall.preloadRulesTaboos ?? true}
              aria-label={t('recallPreload')}
              className={`${css.switch} ${recall.preloadRulesTaboos ?? true ? css.switchOn : ''}`}
              disabled={disabled}
              onClick={() => setDraft((current) => ({
                ...current,
                recall: {
                  ...(current.recall ?? { preloadRulesTaboos: true }),
                  preloadRulesTaboos: !(current.recall?.preloadRulesTaboos ?? true),
                },
              }))}
            >
              <span className={css.switchThumb} />
            </button>
          </div>

          <p className={css.advancedHint}>{t('advancedHint', { ns: NS })}</p>
          {error ? <p className={css.error} role="status">{t('saveFailed', { message: error })}</p> : null}

          <div className={css.footer}>
            <Button
              variant="outline"
              size="sm"
              disabled={!dirty || saving}
              onClick={discard}
            >
              {t('discard')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={saveBlocked}
              onClick={save}
            >
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
