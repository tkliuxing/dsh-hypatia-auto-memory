/**
 * Compile-time guard for the dsh event surface this plugin subscribes to.
 *
 * `ctx.on` takes any string, so a subscription to an event dsh no longer emits
 * fails silently: the plugin loads, nothing warns, and the work behind that
 * listener simply never runs. That is exactly how the recall seed went dead —
 * `agent/session-start` was renamed to `agent/created` upstream (dsh v0.1.6),
 * and the plugin kept a listener on the retired name for every version it
 * declares support for (>=0.1.7).
 *
 * `npm run typecheck` (and so `prepublishOnly`) compiles this file against the
 * installed dsh's cordis `Events` interface. A name that does not exist — or one
 * this dsh version does not ship — stops the build:
 *
 *     Type '"agent/session-start"' is not assignable to type
 *     '"internal/plugin" | … | "agent/created" | …'.
 *
 * When dsh renames an event, this fails here instead of in the user's `~/.dsh/logs`
 * with no symptom at all. Runtime tests cannot make that claim: a listener double
 * will accept any event name it is handed.
 *
 * Each event belongs to the package that declares it, so the type-only imports
 * below load those augmentations into the `Context` type. They emit nothing, and
 * the file is never bundled — it exists for the compiler alone.
 *
 * @module dsh-hypatia-auto-memory/test/events.type-check
 */

import type { Context } from '@deepseek-ai/cordis'
// Each import supplies the cordis `Events` augmentation for the events the
// plugin subscribes to: agent lifecycle, session lifecycle, tool interception,
// approval, and loader updates.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** The event map cordis exposes, with every imported package's augmentation applied. */
type EventsOf<C> = C extends { on(event: infer E, listener: infer _L): unknown } ? E & string : never
type KnownEvents = EventsOf<Context>

/**
 * Every event name this plugin passes to `ctx.on`, by module — the assertion
 * below fails to compile if any of them is not a real dsh event. Keep in sync
 * with the `ctx.on('…')` call sites; the list is the whole point of the file.
 */
type SubscribedEvents =
  // src/recall.js
  | 'agent/created'
  // src/collector.js
  | 'session/created'
  | 'session/disposed'
  | 'session/event'
  // src/auto-approve.js
  | 'tools/pre-execute'
  | 'tools/result'
  | 'approval/request'
  // src/config.js
  | 'loader/volatile-update'

/**
 * Each name must be assignable to a real event. A retired or misspelled name is
 * not a member of `KnownEvents`, so its initializer is rejected by name.
 */
const subscribedEvents: readonly KnownEvents[] = [
  'agent/created',
  'session/created',
  'session/disposed',
  'session/event',
  'tools/pre-execute',
  'tools/result',
  'approval/request',
  'loader/volatile-update',
] satisfies readonly SubscribedEvents[]

// Keep the binding live without emitting anything.
void subscribedEvents

export type { KnownEvents, SubscribedEvents }
