/**
 * The conversation's Memory tab: what this session has been remembered as, what
 * it was remembered into, and what is stuck.
 *
 * Three sections, in the order a reader wants them: the pipeline's status
 * (watermarks, backlog, failures), then the span summaries consolidation
 * produced, then the work units derived from them. Bodies render through the
 * shell's own `MarkdownText`, so a summary reads exactly like assistant Markdown
 * elsewhere in the GUI and costs no bundle weight.
 *
 * Raw `msg-*` entries are deliberately absent: they hold the conversation
 * verbatim, the reader just wrote them, and the agent is the right reader for
 * them (see `src/memory-api.js` for the same rule on the Host side).
 *
 * Status is polled; content is fetched only when it can have changed — on mount,
 * on a session switch, on a manual refresh, and whenever consolidation advances
 * the session's watermark. Reading the shelf costs hypatia round trips, and
 * consolidation is the only thing that changes it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  consolidationGap,
  mergeMemory,
  type FetchMemory,
  type MemoryEntry,
  type MemoryPayload,
} from './memory-client'
import { NS } from './locales'
import css from './MemoryView.module.css'
import './slot-contract'

/** How often the tab re-reads the status half while it is on screen. */
const POLL_MS = 5000

export type MemoryViewProps = {
  /** The session this tab is bound to; supplied by the session-scoped slot. */
  sessionId: string
  fetch: FetchMemory
} & PropsLocale<typeof NS>

/** Local wall-clock stamp for the freshness line. */
function formatTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '—'
  return new Date(epochMs).toLocaleTimeString()
}

/**
 * hypatia stamps `created_at` as `YYYY-MM-DD HH:MM:SS.ffffff`; the microseconds
 * are noise in a row that is 11px tall, so the tab shows down to the minute.
 * Slice rather than `new Date`: the space-separated form is not the ISO shape
 * every engine is required to parse.
 */
function formatEntryTime(stamp: string): string {
  return stamp.length >= 16 ? stamp.slice(0, 16).replace('T', ' ') : stamp
}

/** The first non-empty line of a body, for a collapsed row's preview. */
function firstLine(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const trimmed = line.replace(/^[#>\-*\s]+/, '').trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** One collapsible distilled entry. */
function Entry({ entry, badge, open, onToggle, labels, t }: {
  entry: MemoryEntry
  badge: string
  open: boolean
  onToggle: () => void
  labels: { code: { copyLabel: string; copiedLabel: string }; footnotes: string }
  t: MemoryViewProps['t']
}) {
  return (
    <li className={css.entry}>
      <button type="button" className={css.entryHead} aria-expanded={open} onClick={onToggle}>
        <span className={css.entryName}>{entry.name}</span>
        <span className={css.entryMeta}>
          <span className={css.badge}>{badge}</span>
          {entry.createdAt !== '' ? <span className={css.entryTime}>{formatEntryTime(entry.createdAt)}</span> : null}
          <span className={css.entryToggle}>{open ? t('memoryEntryCollapse') : t('memoryEntryExpand')}</span>
        </span>
      </button>
      {open
        ? (
          <div className={css.entryBody}>
            {entry.markdown === ''
              ? <p className={css.status}>{t('memoryEntryEmpty')}</p>
              : <MarkdownText text={entry.markdown} labels={labels} />}
          </div>
        )
        : <p className={css.entryPreview}>{firstLine(entry.markdown)}</p>}
    </li>
  )
}

export function MemoryView({ sessionId, fetch, t }: MemoryViewProps) {
  const [payload, setPayload] = useState<MemoryPayload | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /**
   * The entries the reader opened, by name. Absent means closed, which is the
   * default: a toggle survives the poll that replaces the payload, and an entry
   * a later poll adds starts closed rather than inheriting a neighbour's state.
   */
  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({})
  /** The watermark whose content is already in hand, so a poll never re-reads it. */
  const [contentAt, setContentAt] = useState<number | undefined>(undefined)

  const copyLabel = t('memoryCopyCode')
  const copiedLabel = t('memoryCopiedCode')
  const footnotes = t('memoryFootnotes')
  // MarkdownText caches its render against the labels identity, so this must be
  // one object per locale, not a fresh one per render.
  const labels = useMemo(
    () => ({ code: { copyLabel, copiedLabel }, footnotes }),
    [copyLabel, copiedLabel, footnotes],
  )

  /**
   * The session the tab is showing now. A request outlives the session it was
   * made for — a slow shelf read, or a poll already in flight at a switch — and
   * its answer must be dropped rather than folded into the next session's view.
   */
  const activeSession = useRef(sessionId)

  const load = useCallback(async (content: boolean) => {
    const current = () => activeSession.current === sessionId
    try {
      const next = await fetch(sessionId, { content })
      if (!current()) return
      // Folded, not assigned: a status-only poll must not erase the shelf
      // content it did not ask for (see `mergeMemory`).
      setPayload((previous) => mergeMemory(previous, next))
      setError('')
      if (content) setContentAt(next.session.consolidatedSeq)
    } catch (failure) {
      if (!current()) return
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (current()) setLoading(false)
    }
  }, [fetch, sessionId])

  // A session switch starts over: the previous session's content and the
  // previous session's collapsed rows must not leak into this one.
  useEffect(() => {
    activeSession.current = sessionId
    setPayload(undefined)
    setOverrides({})
    setContentAt(undefined)
    setLoading(true)
    void load(true)
  }, [load, sessionId])

  useEffect(() => {
    const timer = setInterval(() => {
      // A hidden tab has nobody reading it; the panel is a snapshot, not a stream.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load(false)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  // Consolidation is the only thing that changes the shelf, so a watermark that
  // moved is the signal to read it again.
  useEffect(() => {
    const at = payload?.session.consolidatedSeq
    if (at === undefined || contentAt === undefined) return
    if (at !== contentAt) void load(true)
  }, [payload?.session.consolidatedSeq, contentAt, load])

  const toggle = useCallback((name: string, open: boolean) => {
    setOverrides((current) => ({ ...current, [name]: !open }))
  }, [])

  const session = payload?.session
  const content = payload?.content
  const summaries = content?.summaries ?? []
  const workUnits = content?.workUnits ?? []

  // Every entry starts closed and previews its first line: the list stays
  // scannable at any length, and the bodies are one click away. `overrides`
  // holds what the reader opened, so a poll that replaces the payload does not
  // close it again.
  const renderEntries = (entries: MemoryEntry[], kind: 'summary' | 'workUnit') => (
    <ul className={css.entries}>
      {entries.map((entry) => {
        const open = overrides[entry.name] === true
        return (
          <Entry
            key={entry.name}
            entry={entry}
            badge={kind === 'summary' ? t('memoryTier', { level: String(entry.level) }) : t('memoryWorkUnit')}
            open={open}
            onToggle={() => toggle(entry.name, open)}
            labels={labels}
            t={t}
          />
        )
      })}
    </ul>
  )

  return (
    // Opts into the composer overlay the way the trajectory ledger does: the
    // view owns its scroller and gets the full height, with the composer
    // floating over it. Without the marker the Conversation shell seats the
    // composer below a short panel instead.
    <div className={css.panel} data-conversation-composer-overlay="">
      <div className={css.column}>
        <header className={css.head}>
          <h2 className={css.title}>{t('memoryTitle')}</h2>
          <div className={css.headMeta}>
            <span className={css.updated}>{t('memoryUpdatedAt', { time: formatTime(payload?.updatedAt ?? 0) })}</span>
            <button type="button" className={css.refresh} onClick={() => { void load(true) }}>
              {t('memoryRefresh')}
            </button>
          </div>
        </header>

        {error !== '' ? <p className={css.error} role="status">{t('memoryLoadFailed', { message: error })}</p> : null}

        {loading && payload === undefined
          ? <p className={css.status}>{t('memoryLoading')}</p>
          : session === undefined
            ? <p className={css.status}>{t('memoryNoSnapshot')}</p>
            : !session.known
              ? <p className={css.status}>{t('memoryUnknown')}</p>
              : (
                <section className={css.group} aria-label={t('memoryTitle')}>
                  <dl className={css.rows}>
                    <div className={css.row}>
                      <dt className={css.label}>{t('memoryLogged')}</dt>
                      <dd className={css.value}>{t('memorySeqValue', { seq: String(session.loggedSeq) })}</dd>
                    </div>
                    <div className={css.row}>
                      <dt className={css.label}>{t('memoryConsolidated')}</dt>
                      <dd className={css.value}>
                        {t('memorySeqValue', { seq: String(session.consolidatedSeq) })}
                        {/* Quantified, not a bare "pending": a reader has to know HOW
                            far behind to judge whether to wait. */}
                        <span className={session.caughtUp ? css.calm : css.busy}>
                          {session.caughtUp
                            ? t('memoryCaughtUp')
                            : t('memoryBehind', { behind: String(consolidationGap(session)) })}
                        </span>
                      </dd>
                    </div>
                    <div className={css.row}>
                      <dt className={css.label}>{t('memoryPending')}</dt>
                      <dd className={css.value}>{t('memoryPendingValue', { tokens: String(session.pendingTokens) })}</dd>
                    </div>
                    <div className={css.row}>
                      <dt className={css.label}>{t('memorySessionNode')}</dt>
                      <dd className={css.value}>
                        {session.sessionNode ? t('memorySessionNodeYes') : t('memorySessionNodeNo')}
                      </dd>
                    </div>
                    <div className={css.row}>
                      <dt className={css.label}>{t('memoryBelongTo')}</dt>
                      <dd className={css.value}>{t('memoryBelongToValue', { count: String(session.belongTo) })}</dd>
                    </div>
                    {session.deferred > 0 ? (
                      <div className={css.row}>
                        <dt className={css.label}>{t('memoryDeferred')}</dt>
                        <dd className={css.value}>{String(session.deferred)}</dd>
                      </div>
                    ) : null}
                  </dl>
                </section>
              )}

        {session !== undefined && (session.failed > 0 || session.failedTasks.length > 0) ? (
          <section className={css.group} aria-label={t('memoryFailedTitle')}>
            <h3 className={css.groupTitle}>{t('memoryFailedTitle')}</h3>
            <ul className={css.failures}>
              {session.failedTasks.map((task, index) => (
                <li key={`${task.kind}-${String(index)}`} className={css.failure}>
                  <span className={css.failureKind}>
                    {t('memoryFailedItem', { kind: task.kind, attempts: String(task.attempts) })}
                  </span>
                  {task.error !== '' ? <span className={css.failureError}>{task.error}</span> : null}
                </li>
              ))}
              {session.failedTasks.length === 0 ? <li className={css.failure}>{session.error}</li> : null}
            </ul>
          </section>
        ) : null}

        {content !== undefined && content.error !== '' ? (
          <section className={css.group} aria-label={t('memoryContentTitle')}>
            <h3 className={css.groupTitle}>{t('memoryContentTitle')}</h3>
            <p className={css.error} role="status">{t('memoryContentFailed', { message: content.error })}</p>
          </section>
        ) : null}

        {content !== undefined ? (
          <>
            <section className={css.group} aria-label={t('memorySummariesTitle')}>
              <h3 className={css.groupTitle}>
                {t('memorySummariesTitle')}
                <span className={css.count}>
                  {t('memoryCount', { shown: String(summaries.length), total: String(content.summaryCount) })}
                </span>
              </h3>
              {summaries.length === 0
                ? <p className={css.status}>{t('memoryNoSummaries')}</p>
                : renderEntries(summaries, 'summary')}
            </section>

            <section className={css.group} aria-label={t('memoryWorkUnitsTitle')}>
              <h3 className={css.groupTitle}>
                {t('memoryWorkUnitsTitle')}
                <span className={css.count}>
                  {t('memoryCount', { shown: String(workUnits.length), total: String(content.workUnitCount) })}
                </span>
              </h3>
              {workUnits.length === 0
                ? <p className={css.status}>{t('memoryNoWorkUnits')}</p>
                : renderEntries(workUnits, 'workUnit')}
            </section>

            {content.truncated ? <p className={css.hint}>{t('memoryTruncated')}</p> : null}
            <p className={css.hint}>{t('memoryHint')}</p>
          </>
        ) : null}
      </div>
    </div>
  )
}
