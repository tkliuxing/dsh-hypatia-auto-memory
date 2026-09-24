# dsh-hypatia-auto-memory

> 中文：[README.zh-CN.md](./README.zh-CN.md)

Event-driven [Hypatia](https://github.com/tkliuxing/hypatia) memory for
[DSH](https://github.com/deepseek-ai/deepseek-harness): automatic conversation
logging and background consolidation — span summaries, a log₁₆(n) archive
cascade, and adjudicated work-unit extraction — all on a **dedicated model
route**, with zero model work in the main session.

Writing is automatic; **reading is the agent's job**, through the bundled
`hypatia-memory` skill. That split is deliberate — see *Recall* below.

**This plugin replaces `dsh-hypatia`.** That plugin left the writing to the
agent, which in practice did not happen: in the deployment this one was written
for, the model loaded the protocol and still issued a `hypatia` command in one
recorded session out of fifteen — the one where it was asked to directly. Here
the protocol is driven from **DSH native events**, and the plugin talks to
hypatia over its own `hypatia mcp` process on the subprocess service (the CLI,
with argv arrays, as fallback) — no shell, no tool call, no sandbox
escalation, no approval prompt. What is still worth having from `dsh-hypatia`
ships here: auto-approval for the agent's own bash `hypatia` calls, and its
`hypatia` / `hypatia-dream` skills. Install one or the other, not both.

## Install

Prerequisite: `hypatia` CLI on PATH (or add its basename to `binaries`). A
build with the `mcp` subcommand (hypatia #20) is used over MCP; an older one
works through the CLI instead, with one warning at the first call. Two later
additions are used when the binary has them and skipped when it does not:
`--no-embed` (hypatia #26) keeps the log layer out of the vector index, and
`similar --exclude-tags` (#35) keeps it out of the work-unit candidate search.
The first call logs which the binary offers
(`hypatia over mcp: no-embed yes, similar filters yes`).

The plugin also needs **dsh ≥ 0.1.7**, and dsh enforces that itself rather than
this README: the package declares
`peerDependencies["@deepseek-ai/dsh"]: ">=0.1.7-rc.1"` (the same range also
sits under `dsh.engines.dsh` for display), and dsh checks every
`@deepseek-ai/dsh*` peer against the running version when a bundle is installed
and again at startup — an older runtime refuses the install instead of loading a
plugin built for API it does not have, and `dsh plugin allow-version` grants an
exact-version exemption when the risk is accepted deliberately. The peer is
marked optional in `peerDependenciesMeta` so that neither npm nor a profile
installation pulls the runtime in as a dependency: the launcher supplies it.

```bash
# from a local checkout (development)
dsh plugin --profile web add link:/path/to/dsh-hypatia-auto-memory

# registry install once published
dsh plugin --profile web add dsh-hypatia-auto-memory
```

Repeat for other profiles (desktop, dsh-tui). Restart the profile after install.

The browser half — the settings card and the conversation's Memory tab — is
pre-built in `lib/client.js` and shipped with the
package. If you edit `src/client/*`, run `npm install && npm run build` in this
directory to regenerate it; while `pnpm run dev:web` is active in the DSH
checkout, client-plugin changes reload without a full page refresh.

**Replacing `dsh-hypatia`:** remove it from the profile and restart.

```bash
dsh plugin --profile web remove dsh-hypatia
```

Both register the same skill names and the registry keeps whichever plugin got
there first. This one refuses to shadow another provider (it warns instead), so
leaving `dsh-hypatia` installed hands the agent exactly the agent-driven
protocol whose failure this plugin exists to fix. If it has to stay for some
other reason, `skills: false` on its bundle row is the minimum.

A **skill on disk** of the same name — `~/.agents/skills`, `~/.dsh/skills`, a
custom directory, or a project's `.dsh/skills` / `.agents/skills` — also wins,
in every agent session. DSH's skill registry is layered per scope: the nearest
layer's same-name entry wins outright, and rank (project > plugin > user)
only breaks ties inside one layer. Agent presets (`st`, `standard`, …) mount
their own filesystem skill provider in the preset's layer, nearer to the agent
than this plugin's global registration. That includes the canonical
`hypatia-memory` which `hypatia skill install --agent codex` writes to
`~/.agents/skills`: it is the agent-driven protocol and needs host hooks DSH
does not have. Delete such a copy or move it out of the skills directory;
renaming its directory in place is not enough, because DSH names a skill by its
frontmatter `name`. The startup warning names the directory. The skill center shows the global view, so it can list this plugin
as a skill's provider while sessions load the disk copy.

## How it works

```
session/event (emit)
  ├─ turn/end ──▶ durable queue (storageDomain tasks)
  │                 ├─ log-message  ──▶ hypatia msg-<sid>-<index>
  │                 ├─ consolidate  ──▶ ctx.llm.stream ──▶ sum-* (summary 1) + wu-*
  │                 └─ cascade      ──▶ $not-summaried ──▶ sum<N>-* (summary N)
  └─ session/title | compaction/summary ──▶ session-node ──▶ session-<sid> + belongTo
session/disposed ──▶ final flush + consolidation, thresholds waived (a session
                     closed while DSH keeps running)
collect fiber dispose ──▶ the same flush for every session still open, persisted
                     before the queue stops; the model call finishes at the next start
                     (a restart, a config-change restart, or a crash: the startup
                     consolidation backfill)
agent/session-start ──▶ rules/taboos inject()
```

- **Transport** is a private `hypatia mcp` process: JSON-RPC over stdio on the
  subprocess service, one request at a time, which is how that server handles
  them anyway. It is not a `dsh-mcp-client` entry, so the model never sees
  these tools and the plugin's calls meet no tool policy, hook or approval.
  Over the CLI, every call was a process that opened the shelf; here a burst of
  writes shares one. Content travels as JSON rather than one argv element, so
  it is no longer cut at 96 KiB to fit a command line. Tags and scopes are
  split on commas as the CLI splits them, so an entry is stored the same over
  either transport.

  One process means one call at a time, where the CLI ran as many as
  `queue.concurrency` allowed. A call waits behind the one in flight — at
  worst a `similar` reloading the embedding model, or a write paying overdue
  embedding debt — and that includes the rules/taboos preload at session
  start.

  The process starts on the first call and is closed after 60 s without one.
  `hypatia mcp` keeps the embedding model's allocations after a semantic call
  (hundreds of MB), and reads the shelf registry once, at start. For the same
  reason a `shelf '<name>' is not connected` error restarts it, so a shelf
  connected meanwhile is found on the retry, and the shelf listing for the
  settings card always comes from `hypatia list`. A call that overruns its
  30 s deadline kills the process, as the CLI path kills a command; the next
  call starts another.

  `transport: cli` restores one CLI command per call. A binary that serves no
  usable MCP — no `mcp` subcommand, a tool this plugin calls missing, or an
  error in answer to the handshake — makes the plugin use the CLI until the
  profile reloads. Any other failure to start
  fails only that call, and the next one tries MCP again: a binary that cannot
  be started at all would fail the CLI too, and a start that timed out or
  crashed may not do so twice.

- **Collector** records human `user/message` and `assistant/message`, redacts
  secrets, rewrites relative dates against the time the message was sent, caps
  both user and assistant text, and enqueues idempotent log tasks.

  Tool-call, thinking and reasoning blocks are internal to the model and leave
  no placeholder in the content. Assistant turns whose only output is one of
  those (tool calls only, empty reasoning marker, etc.) produce no `msg-*`
  entry at all — there is nothing substantive to remember. Plugin-sourced
  messages are skipped — no feedback loops. By default no tool-call ledger is
  written at all; set `hypatia-auto-memory.collector.toolLedger: true` to record
  a compact ledger (`1. \`read\` ×5 — ✅ 1.2s total`) for assistant messages that
  do have text/image content. In either mode **tool outputs themselves are never
  stored** in the log layer.

- **The log layer is not embedded.** `msg-*` and `session-*` entries and the
  `belongTo` / `summary` edges are written `embed: false` (hypatia #26): stored,
  full-text indexed and reachable by JSE, but given no vector. The protocol has
  precise recall drill down from a summary along `summary` edges rather than
  hit raw messages by meaning, and embedded, a raw message outranks the
  knowledge distilled from it because it holds the very words. On the shelf
  this was measured on the layer was 85% of entries and 77% of statements, each
  costing a forward pass on the conversation's hot path. Summaries and work
  units are embedded as before. Statements have no tags, so a shelf's
  `embedding.skip_tags` could not have reached the edges; the plugin says so per
  write. On a binary without the flag the transport drops it and everything is
  embedded as it always was.

  Spans are cut at `turn/end`, and — for a turn that outlasts `flushWindowMs` —
  at `step/end`, never at an arbitrary moment. DSH appends `assistant/message`
  *before* running the tools it requested and `step/end` only after they have
  all run, so a span always holds whole steps and no entry is written without
  its own tool results. Tool results that DSH compaction re-appends after a
  `compaction/prune` are copies of old results and are not counted again.

  Entries are named by a **dense message ordinal**, not a session-log seq: DSH
  gives every streamed token delta its own seq, so seq numbering produced a
  sparse keyspace that broke `$not-summaried`'s FIFO batching. The ordinal is
  recounted from the immutable log prefix, so a replay reproduces the same names.

- **Queue** is durable before scheduling: per-session ordering, `queue.concurrency`
  cross-session limit, retry with backoff, and progress-watermark backfill on
  boot. A task that absorbs new work while running is re-scheduled rather than
  dropped. Writers are get-before-create AND re-assert their edges, so a crash
  between an entry and its statements is repaired by the replay.

- **Consolidator** runs at `turn/end` when the thresholds are met, and again
  unconditionally at `session/disposed` — a task shorter than `checkEveryTurns`
  turns would otherwise be logged and never turned into knowledge. `turn/end`
  carries a reason: a user interrupt is treated as a task boundary and lowers
  the token floor, while a blocked, failed or truncated turn is not a place to
  cut a memory at all. Its transcript is redacted and date-absolutized exactly
  like the log path, and an over-budget span consolidates its **oldest** entries
  and advances the watermark only that far, so the remainder is not silently
  marked done.

  The extraction call asks for **no reasoning** on a route that advertises it.
  Extraction is a mechanical transform into a fixed JSON shape, and on a
  thinking route the reasoning is charged to the SAME `maxOutputTokens` as the
  answer: measured live, a `deepseek-flash` route resolving to `high` spent
  ~800–1400 of a 2000-token cap thinking and hit `max-tokens` with the JSON half
  written (9.3 s, against 25 s for a completed run of the same kind on that
  route). Where a route cannot be asked — or a provider ignores the control —
  the budget carries a fixed thinking allowance instead, and a truncation is
  **retried** rather than declared permanent: the retry asks for one work unit
  instead of `maxWorkUnitsPerRun`, because the units are what make the reply
  long. Cascade is the exception: it keeps thinking (it is compressing sixteen
  summaries, not filling a shape) and pays for it in the same allowance.

- **Cascade** archives sixteen unarchived tier-N summaries into one tier-(N+1)
  entry, using hypatia's own `$not-summaried` (which anti-joins on
  `statement.tail` and orders `created_at ASC`, giving FIFO batching for free).
  This is the protocol's log₁₆(n) archive: each tier compresses only material a
  previous tier already distilled.

- **Work units** are adjudicated, not guessed. Candidates come from `similar`
  (the only search that reports a distance), with the operational layer left
  out — in the query, by `--exclude-tags`, on a binary that has it (hypatia
  #35); by fetching four times as many rows and dropping them on one that does
  not — and filtered by a distance ceiling, then a small model call
  decides `duplicate | refines | extends | supersedes | contradicts | unrelated`.
  A contradiction keeps **both** entries and records `supersedes` — a memory
  system must not quietly forget what it once believed.

- **Housekeeping** runs once per startup over the progress table. It resets a
  row whose session has no `msg-*` entry left in the shelf — a wiped or
  replaced shelf would otherwise leave that session unlogged for good — and
  removes the row and tasks of a session DSH no longer has. Resetting costs a
  re-log and a re-consolidation, so both passes act only on positive evidence:
  a failed shelf query or an empty session listing changes nothing.

  A third pass consolidates what a shutdown could only persist, and what a crash
  or `kill -9` left behind. Nothing a closing session owes survives on its own:
  `session/disposed` observers are fire-and-forget in DSH, the collect fiber is
  torn down before the session store releases its sessions, and the queue dies
  with the fiber — so an `enqueue` there was a silent no-op and a whole run's
  tails were dropped. Two things fix that. The collect fiber's disposer now
  **persists** both ranges for every session still open (registering the sweep
  after the queue's own disposer, because cordis disposes a fiber's effects in
  reverse order, so it runs while the queue can still write), and this pass
  finishes the work at the next start. Only the final log write is waited for at
  shutdown: a hypatia write is milliseconds, while the model call it may trigger
  is measured in tens of seconds and could never fit inside DSH's 5 s shutdown
  budget.

  This pass deliberately ignores the `consolidation.minNewTokens` floor that
  paces the live trigger. The floor is right while a conversation is running —
  there is always a later turn — but at boot there is no later turn, and a tail
  skipped here is skipped for good: measured on a live shelf, fifteen sessions
  carried 1–1950 pending tokens, not one of them was ever consolidated, and
  eight of nine sessions had messages with `lastConsolidatedSeq: 0`. Cost is
  bounded by `housekeeping.consolidationBackfillPerScope` instead — at most that
  many sessions **per project scope** per start, the largest tails first, so a
  backlog drains over several starts rather than in one unbounded burst of model
  calls. A range whose consolidate record is `failed` is taken first whatever its
  size: `resumeKind` never re-schedules a failed row, and re-enqueueing it is the
  only path back.

  Those tasks then read their events from **storage**, not only from the live
  store. `session/created` — the signal that wakes a deferred task — fires only
  where an agent actually runs, so a finished session may never emit it again,
  and a subagent session (which the sidebar does not even list) almost certainly
  will not: one sat `deferred` across a restart and stayed deferred while its
  transcript was open on screen. `sessionPersistence.load()` returns the same
  log without publishing anything, and the executors use only `snapshotEvents`,
  `inheritedEventCount`, `seq` and `header`, so a tail nothing will reopen still
  becomes knowledge. A composition without `sessionPersistence` behaves as
  before: the task waits.

- **Recall** preloads project/global rules and taboos at session start. Nothing
  else is pushed, except one line naming the shelf when it is not `default`, so
  the agent's own `hypatia` calls look where the plugin writes. Retrieval is the agent's job through the bundled skill, which
  is what [`memory-nolinear.md`](https://github.com/tkliuxing/hypatia/blob/main/docs/memory-nolinear.md)
  prescribes for agents that hold context and can call tools; the previous
  per-turn injector also vetoed DSH's own runtime context section by returning
  from `agent/pre-step` without calling `next()`.

- **Auto-approve** answers the approval request for the agent's own bash
  `hypatia` calls, and only those: the executable word must be a trusted
  basename (after `KEY=value` prefixes) and the command must carry no pipe,
  redirect, chain or command substitution *outside quotes* — a JSE argument full
  of `|` and `>` inside quotes still qualifies. Everything else goes to the
  human. The plugin's own writes never take this path.

  Scope, measured rather than assumed: in DSH a bash call raises an approval
  request **only** when the sandbox denies it and the model retries with
  `sandbox_permissions`. Retrieval (`query`, `search`, `list`, `knowledge-get`)
  runs inside a `workspace-write` sandbox and never asks, with or without this
  plugin. What this answers is the hypatia **write** — `~/.hypatia` is outside
  the workspace, so `knowledge-create` and friends are denied, escalated, and
  would otherwise stop on a prompt every time the user says "remember this".

- **Skills** are bundled: `hypatia-memory` in this plugin's variant (the
  automatic layer writes, the agent retrieves), plus vendored copies of
  hypatia's `hypatia` CLI reference (byte-identical) and `hypatia-dream`
  (patched, see *Known limitations*), carried because removing `dsh-hypatia`
  would otherwise take them with it. Another plugin's
  registration of the same name is left alone and reported, since DSH keeps the
  first runtime registration. A copy on disk is registered over but still wins
  in agent sessions — presets load disk skills in a nearer layer — so it is
  reported with its directory.

- **The conversation's Memory tab** is the read face of everything above. It sits
  beside the **Chat** and **Trajectory** tabs (a `conversation.view` entry with
  id `memory`, ordered after Trajectory) and shows, for the session it is bound
  to, three things. **Status**: the logging and consolidation watermarks, the
  pending token backlog, whether the `session-<id>` node exists, and any task
  that exhausted its attempts together with the error that stopped it.
  **Span summaries**: the `sum-<session>-<from>-<to>` entries consolidation
  produced, with their archive tier. **Work units**: the `wu-*` entries derived
  from those summaries, reached through the `derivedFrom` edges — their names are
  content-addressed, so the edge is the only way to find them. Bodies render
  through the shell's own `MarkdownText`, so a summary reads like assistant
  Markdown elsewhere in the GUI.

  Raw `msg-*` entries are deliberately **not** shown: they hold the conversation
  verbatim, the reader just wrote them, and the agent is the right reader for
  them.

  The data arrives over a session-scoped, read-only HTTP route this plugin
  registers on the DSH web server, `/api/dsh-hypatia-auto-memory/session`: status
  from the in-memory state tables on every poll, the shelf content only when it
  can have changed (on open, on a session switch, on a manual refresh, and when
  consolidation advances the session's watermark), cached for 15 s in between.
  The tab polls every five seconds while it is on screen, and a response is
  bounded: the newest 40 summaries and 40 work units, 4000 characters per body
  and 120 000 per response. JSE has no `ORDER BY`, so "newest" is decided only
  after reading every candidate; when a scan reaches its cap the counts become
  lower bounds, and the tab reports that response as truncated rather than
  leaving a short list unexplained.
  Two channels were rejected on the way here. A **session projection** would be
  the best shape, but the event that would drive it cannot be written from
  outside this repository: `Session.append` offers no way to set the envelope's
  `ignorable` marker, and the persistence read path refuses a session log
  carrying an unknown event type without it — so a custom event would break
  session reload. A **settings namespace** was root-scoped even when it existed:
  the Host cannot know which session the browser is showing, so it would have
  to ship every session's data. (dsh 0.1.7 removed the Host-side settings
  registration API entirely; the route family below is now the only channel.)

  The route is not one of the composed app's authenticated routes — a route a
  plugin registers never is — so it authenticates itself the way
  `dsh-hypatia-ui`'s does: the socket must be loopback, the `Host` must be a
  loopback name (`localhost`, `127.x`, `[::1]`), and the request same-origin. A
  browser tab on this page passes all three; a page on another origin fails the
  last even from the same machine, and a DNS-rebound page fails the `Host` check.
  `~/.dsh/storages/hypatia_auto_memory.json` and
  `hypatia_auto_memory_diag.json` remain the durable record; the tab is a view of
  the same facts, not a replacement for them.

## Configuration

The plugin's cordis `Config` is its configuration form. dsh ≥ 0.1.7 projects a
plugin's Config schema onto the sidebar's **Plugins** page, and the card renders
on this bundle's own page there; a deployment whose profile renders no Plugins
page gets the same card as a tab under **Settings → Built-in plugins**. The card
takes whichever seat exists and moves between them without ever appearing twice
(`src/client/plugin-card-seat.ts`). Every field below applies on
save, without a profile reload. Stored as the plugin entry's `config:` in the
profile patch; a pre-0.1.7 `settings.yaml` section is imported once on first
launch. All fields optional, defaults shown. A blank consolidation route is
refused on save; a duplicate one is dropped at runtime with a warning:

```yaml
hypatia-auto-memory:
  enabled: true
  binaries: [hypatia]
  transport: mcp                 # or cli; a binary without `mcp` falls back to cli
  shelf: default                 # where every entry goes; read at startup (see below)
  autoApprove: true              # approve the AGENT's plain `hypatia …` bash calls
  collector:
    enabled: true
    maxAssistantChars: 8000      # per-message cap before truncation marker
    maxUserChars: 32000          # same, for what the user typed or pasted
    toolLedger: false            # off by default; true records a compact tool-call ledger
  consolidation:
    enabled: true
    # Each attempt, including a retry, rotates to the next selected route.
    models: []                   # select one or more { provider, model } routes
    maxInputTokens: 16000        # transcript cap (chars/4 estimate)
    maxOutputTokens: 2000
    timeoutMs: 120000
    checkEveryTurns: 5           # minimum turns between accepted tasks
    minNewTokens: 3000           # unconsolidated tokens required to trigger
    maxWorkUnitsPerRun: 3
    adjudicate: true             # judge how a new work unit relates to nearby ones
    dedupMaxDistance: 0.45       # cosine ceiling on candidates worth judging
    dedupCandidates: 5
    cascade:
      enabled: true
      batchSize: 16              # entries per tier before archiving one tier up
  queue:
    concurrency: 1               # parallel sessions
    maxAttempts: 3
    retryDelayMs: 5000
    # NOT a batching knob. Spans are cut at turn/end; for a turn still running
    # this long, the next step/end flushes what is complete so far.
    flushWindowMs: 120000
  recall:
    enabled: true
    preloadRulesTaboos: true
  housekeeping:
    reconcileOnStartup: true     # reset rows whose session has no msg-* left in the shelf
    pruneVanishedSessions: true  # drop rows and tasks of sessions DSH no longer has
    backfillConsolidation: true  # consolidate a logged tail the in-session trigger never reached
    consolidationBackfillPerScope: 4  # sessions that pass may queue per scope, per start
```

The cordis config block on the bundle row only carries skill packaging:

```yaml
- id: hypatia-auto-memory
  config:
    skills: true                 # register hypatia-memory + hypatia + hypatia-dream
    skillsDir: /abs/path         # override the packaged skills/ directory
```

`enabled`, `shelf` and `autoApprove` are read when the collector starts, so
saving a change to any of them restarts the collector (queue drained, state
re-opened); every other switch applies in place. The same restart is what
applies an imported pre-0.1.7 `settings.yaml`: dsh imports it only after every
plugin has started, and the collector itself waits for that point before it
starts, so it rarely runs on the defaults at all.

### Choosing the shelf

`shelf` names the hypatia shelf every entry is written to and every lookup
reads — logging, consolidation, the cascade, the rules/taboos preload, and the
startup housekeeping. The settings card offers it as a dropdown of what
`hypatia list` reports — read on demand when the tab opens; a successful
listing is cached for 60 s on the Host, a failed one never is — marking
shelves that are registered but not connected.

- **Takes effect on save**, like `enabled`: the collector restarts on the new
  shelf, and the log says so.
- **Progress is kept per shelf.** Watermarks and queued tasks are stored per
  shelf, so a newly chosen shelf starts every session from zero, and switching
  back resumes exactly where that shelf left off — nothing is re-logged or
  re-consolidated into a shelf that already has it. The cost is on the new
  shelf: every live session is logged from its start there — and every other
  session the next time it is active — and consolidated again, one model call
  per span. Work queued for the other shelf waits, untouched, until it is
  chosen again, and housekeeping (pruning vanished sessions, failed tasks) only
  touches the current shelf's rows. `default` keeps the rows
  written before this setting existed.
- **The agent follows.** When the shelf is not `default`, the session seed tells
  the agent to pass `--shelf <name>` to its own `hypatia` commands; the bundled
  `hypatia-memory` skill says the same, and `hypatia-dream` consolidates that
  shelf when the request names none.
- **A missing shelf is logged at startup**, not refused: writes to it fail and
  retry like any other hypatia failure until it is connected
  (`hypatia connect <dir> --name <name>`). Over MCP, that failure restarts the
  server, so the retry after a `connect` reaches the shelf.

The listing reaches the browser over the same route family as the Memory tab —
`GET /api/dsh-hypatia-auto-memory/shelves`, mounted before the startup
reconcile and backfill (and even while `enabled: false`), so the list is there
when a broken shelf needs replacing. (It rode a read-only settings namespace until dsh 0.1.7 removed that
Host-side API; a shelf listing is not configuration, and the settings domain
now only projects plugin Config forms.)

## Operations checklist

1. After a turn ends, entries appear within seconds:
   `hypatia knowledge-get msg-<sessionId>-<n>` (`n` counts messages, from 0).
   The conversation's **Memory** tab answers the same question without a CLI,
   and adds what the CLI cannot show: the watermarks themselves.
2. Watermarks live in the state domain; failed tasks stay in the `tasks`
   table with their last error for inspection. Both are what the Memory tab
   reads; refresh it after changing the shelf, since the tab's snapshot is
   keyed to the shelf this run is writing to.
3. Restart mid-write is safe: messages already stored are skipped
   (get-before-create); uncovered ranges are re-enqueued from watermarks.
4. To check the route warning: consolidation with no selected `models`
   logs a one-time warning and otherwise stays silent.
5. Which model a background call actually ran on is recorded per attempt in
   `~/.dsh/storages/hypatia_auto_memory_diag.json` (`tables.model_calls`,
   newest first by `seq`, bounded to 100). The settings list is not the answer:
   one process-local cursor rotates through `consolidation.models` across every
   span summary, adjudication and cascade call, so consecutive attempts
   alternate. `outcome` is `pending` (in flight, or the process died mid-call),
   `ok` (a usable result was produced), `incomplete` (the call settled without
   one — output cap, abort, unparseable reply) or `error` (the call threw); in
   the last two the cursor was consumed and nothing was stored. `detail` is a
   finish kind, a fixed label, or the provider's message, capped at 200
   characters — never message content and never model output.
6. `hypatia backfill --status` reports the shelf's embedding debt. With a
   current hypatia, logging a turn adds nothing to it; only summaries and work
   units are pending until the next flush. `hypatia scope list --count` shows
   the scopes in use — the one this project's `msg-*` entries carry is the one
   the session seed reads.
7. Uninstall: `dsh plugin --profile web remove dsh-hypatia-auto-memory` —
   hypatia entries themselves are left in `~/.hypatia/`.

## Failure modes

| Symptom | Cause / handling |
|---|---|
| No entries after chatting | `enabled: false`, missing `hypatia` binary, or the collect fiber PENDING (needs `sessions`, `storageDomain`, `subprocess` from the base composition) — check profile logs |
| Nothing logged for a whole run after a restart | The storage domain refused to open because a stored record failed its schema. The storage service validates on read, not on write, so a bad write only surfaces at the next startup — and one bad row fails the whole domain. Look for `startup failed` / `does not match its schema` in the profile log. Task rows missing `error` are now defaulted; for any other bad row, stop DSH, remove it from `~/.dsh/storages/hypatia_auto_memory.json`, and restart |
| Memory tab never shows data, or shows a read failure | The page is not reached over a **loopback origin**. The route authenticates itself — loopback socket, loopback `Host`, same-origin — so reading DSH from another device (a LAN address, or a `0.0.0.0` binding) is refused by design, and so is a tunnel presenting a public `Host`. Both halves of the payload are refused together, so the tab reports a load failure rather than partial data. Open the GUI at `127.0.0.1` or `localhost` |
| Entries appear only after a turn finishes | By design: spans are cut at `turn/end`, or at the first `step/end` once a turn has run longer than `flushWindowMs`, so an entry never lacks its own tool results |
| Logging works, no summaries | `consolidation.models` is empty or invalid — one warning at first trigger |
| Summaries but no `sum2-*` | Fewer than `cascade.batchSize` unarchived tier-1 summaries in that project yet |
| Work units have no relationships | No embedding model on the shelf (`similar` fails), every candidate was beyond `dedupMaxDistance`, or the adjudication call itself produced no verdict — `model_calls` shows that as `incomplete` / `max-tokens`, which is what a thinking-enabled route does when it spends the whole output budget on reasoning before answering. The call now asks a route for `reasoningEffort: 'off'` once the adapter advertises it, and carries a 1024-token cap for routes that cannot honour it. Since hypatia #19 the local model is looked up in `~/.hypatia/models/<org>/<name>` (or the Hugging Face cache), no longer beside the shelf: a shelf that used to answer `similar` and now says `is not installed` needs `hypatia model install <model>`, or `hypatia model register <model> <dir>` pointing at the files it already has |
| `similar` still returns `msg-*` rows | They were written before this plugin opted the log layer out of embedding, or by a hypatia without `--no-embed`. Retract the knowledge vectors once with `embedding.skip_tags = ["message"]` in the shelf's `shelf.toml` followed by `hypatia backfill` (a binary older than the key refuses to open the shelf, so upgrade every binary sharing it first). Do not add `session` to that list: `skip_tags` matches any entry carrying the tag, and knowledge people write about sessions carries it too — one such entry lost its vector on the shelf this was tried on. The plugin's own `session-*` nodes are few and now opt out per write. Statements have no tags and no update command, so `belongTo` / `summary` edges written before keep their vectors |
| Task in `deferred` state | Neither the live store nor persistence could supply its session. Not an error: it spends no attempts and runs as soon as one of them can. Normally storage answers immediately — the state persists only when `sessionPersistence` is absent from the composition, or its read failed (look for `could not be read` in the log) |
| Task in `failed` state | A hypatia or model error persisted after `maxAttempts`. Failed `log-message` records are pruned at the next startup, since the watermark re-derives their range; other kinds are kept for inspection — delete one to let the next trigger re-create it |
| Watermark says logged, but the shelf has no entries | The shelf was reset or switched after logging. Handled at startup: `housekeeping.reconcileOnStartup` resets any row whose session has no `msg-*` left, and that session is re-logged — and re-consolidated — from the start on its next activity. A shelf query that fails leaves the row untouched. A session whose messages were all deleted on purpose is indistinguishable and is logged again; turn the switch off if that matters |
| Warning `hypatia mcp unavailable: …; using the hypatia CLI until the profile reloads` | The binary predates `hypatia mcp` (the message quotes its `unrecognized subcommand`), lacks a tool the plugin calls, or answered the handshake with an error. Everything keeps working over the CLI; upgrade hypatia and reload the profile to use MCP |
| Every call fails with `hypatia mcp exited …` or `timed out` | The binary starts but its MCP server does not come up — a wrapper script in `binaries` that changes clap's exit code or wording is not recognised as an old binary. Set `transport: cli` |
| Every write fails right after changing `shelf` | The shelf is not registered or not connected — startup logs `shelf "<name>" is not registered`. Connect it (`hypatia connect <dir> --name <name>`) and save the setting again (or reload the profile), or pick another |
| The agent searches `default` while the plugin writes elsewhere | A disk copy of `hypatia-memory` (see below) replaced the bundled skill, or recall is disabled, so nothing told the agent which shelf to use |
| Duplicate `msg-*` after weird manual edits | Delete the entry in hypatia and lower `lastLoggedSeq` for that session in the state domain — backfill recreates it once |
| The agent's own `hypatia` write still asks for approval | `autoApprove: false`, the command pipes/redirects/chains outside quotes, or its first word is not one of `binaries` — only plain calls are answered, by design. Reads never reach approval at all, so nothing to fix there |
| The agent got a memory protocol that tells it to log messages by hand | Another plugin registered `hypatia-memory` first (`dsh-hypatia` still in the profile), or a `hypatia-memory` exists on disk — typically `~/.agents/skills/hypatia-memory`, written by `hypatia skill install --agent codex`. Agent presets load disk skills in a layer nearer than plugins, so it wins in sessions even though the skill center may list this plugin. Remove the copy the startup warning names |
| Can't tell which model actually ran | By design the choice rotates: one process-local cursor is shared by span summaries, adjudication and cascade, so consecutive calls alternate through `consolidation.models`. Each attempt lands in `~/.dsh/storages/hypatia_auto_memory_diag.json` (`model_calls`) with purpose, provider/model, outcome and duration. The usage ledger cannot answer this — it folds agent turns (`assistant/message`) and never sees a plugin's direct `llm.stream`. A `pending` row means the call is still in flight, or the process died mid-call: the row is written before the call and settled after it |
| Startup warnings never appear in the terminal | `dsh web` mounts no log exporter, so plugin log lines of any level go nowhere; the console exporter's default threshold would also drop warnings (warn is level 2, above info's 1). Mount a logger such as `dsh-logbook` or `dsh-boot-doctor` temporarily to read them |
| Project scope looks wrong | Scope = basename of the session cwd's git top level (`git rev-parse --show-toplevel`), or of the cwd itself when git finds no work tree or cannot answer (not installed, a repo it refuses as unsafe). A `rev-parse` slower than 3 s leaves that one session on the cwd's own name. Two same-named checkouts share a scope by design; a linked worktree is scoped by its own directory, not the main checkout's; git resolves symlinks, so a checkout opened through a link named differently from its target gets the target's name. A name hypatia would rewrite is normalized first: a session at `/` is scoped `/`, commas become `_`, surrounding whitespace goes. Entries written before these fixes stay where they were stored: a subdirectory session's under that directory's name (`repo/src` wrote under `src` — the git root was never read), a session at `/` with no scope, `a,b` under both `a` and `b`, `foo,` under `foo` and global. Padded names were stored trimmed, which is what the query now asks for. Nothing migrates them; `knowledge-update --scopes` moves one entry and keeps its `created_at`. `hypatia scope list --count` (hypatia #30) shows every spelling in use and how many entries each holds |

## Known limitations

Deliberate, and worth knowing before you rely on them:

- **No topic-shift detection.**
  [`memory-nolinear.md`](https://github.com/tkliuxing/hypatia/blob/main/docs/memory-nolinear.md)
  ranks topic switches as the strongest session-splitting signal, above task
  boundaries and time gaps. Detecting one needs a model call every turn, which contradicts this
  plugin's central trade-off (zero model work in the main session), so it is not
  implemented. Task boundaries (`turn/end` reasons) and session close are
  honoured; a session covering three unrelated topics is summarised as one.
- **Summary names are mechanical.** The protocol asks for descriptive names
  extracted from content. A model-authored title cannot be the key — a retry may
  word it differently and silently fork the entry — so keys stay derivable
  (`sum-<session>-<from>-<to>`, `sum<N>-<digest>`) and the descriptive title is
  the first heading in the body.
- **No `session-<id>` node without a host summary.** The protocol forbids
  inventing one, and DSH emits no session-summary event of its own; the node is
  built from a `session/title` or `compaction/summary` when one appears.
- **The plugin does not use `knowledge-update` yet.** hypatia gained it in #20
  (it keeps `created_at`, discards the old vector and re-embeds on the next
  flush), but older binaries lack it, so the plugin still never edits an entry
  in place: a second session title does not replace the first, and a work unit
  is never rewritten.
- **Duplicate `knowledge-create` is detected by error text.** hypatia has no
  upsert for knowledge entries, so `hypatia-cli.js` recognises
  `UNIQUE constraint failed:` / `duplicate key` to make a replay idempotent.
  `statement-create` has been idempotent on its own since hypatia #20 (a repeat
  exits 0 with `Statement already exists`); on an older binary the same
  error-text path covers it. The matching is confined to one function, and
  `test/integration` accepts either statement behaviour.
- **What was embedded stays embedded.** The log layer opts out of the vector
  index at write time, so entries and edges written before this version, or by
  a hypatia without `--no-embed`, keep their vectors and keep surfacing in
  `similar`. `skip_tags` + `backfill` retracts the knowledge entries' (see
  *Failure modes*); the edges have no retraction path short of deleting and
  recreating them, which the plugin does not do.
- **Adjudication and dedup need an embedding model.** On a shelf without one,
  `similar` fails outright and work units are stored with no relationship —
  never dropped.
- **Boot backfill reads live sessions.** A persisted-but-not-loaded session's
  gap is picked up when it next loads.
- **A cascade crash mid-batch shifts a grouping boundary.** Members already
  linked leave the tier's unarchived set, so the retry archives a different
  batch. Everything is still archived exactly once; the grouping is just not the
  one the first attempt intended.
- **Two of the three bundled skills are vendored copies.** `hypatia` and
  `hypatia-dream` are copied from the [hypatia
  repository](https://github.com/tkliuxing/hypatia)'s `skills/`, because a
  published package cannot reach outside itself. Nothing refreshes them: when
  the originals change upstream, copy them in by hand. `hypatia` is
  byte-identical. `hypatia-dream` carries two local patches, which a refresh
  must re-apply:
  - **Shelf.** With no shelf in the request, it uses the one the session seed
    names, and `default` only when the seed names none. Upstream always
    falls back to `default`, which reviews a shelf this plugin may not write to
    (see *Choosing the shelf*).
  - **Operational relations left out of the graph read.** Both statement
    queries exclude `summary` and `belongTo`, which the skill already treats as
    protected and never uses as evidence. This plugin writes them for every
    logged message, span summary and archive tier, so they were 971 of 1258
    statements on the measured shelf. Counted against the read's 10000-row
    limit, they would make the skill stop on its truncation check long before
    the triples it actually reviews reach that limit.

  Its `evals/evals.json` gains cases 9 and 10 for these two patches.
- **`enabled: false` at the top level is read when the collector starts**;
  saving a change restarts the collector, while the per-feature switches apply
  in place.

## Directory structure

```
dsh-hypatia-auto-memory/
├── package.json          # bundle + client manifest, deps
├── cordis.patch.yml      # bundle layer inserting id=hypatia-auto-memory
├── tsconfig.json         # browser TS/TSX type-check config
├── tsconfig.build.json   # declaration emit for client bundle
├── tsdown.config.ts      # browser CJS factory build
├── src/
│   ├── index.js          # fiber composition (collect + optional children)
│   ├── config.js         # cordis Config schema (volatile), defaults, live updates
│   ├── shelf.js          # per-shelf table views, `hypatia list` parsing
│   ├── state.js          # storageDomain spec + progress helpers
│   ├── collector.js      # session/event filtering, ledger, backfill
│   ├── content-policy.js # redaction, dates, caps, slugs (pure)
│   ├── queue.js          # durable per-session queue with retry/dispose
│   ├── hypatia-client.js # transport switch: MCP, CLI fallback
│   ├── hypatia-mcp.js    # private `hypatia mcp` connection + result mapping
│   ├── hypatia-cli.js    # argv-only subprocess wrapper
│   ├── writer.js         # idempotent get-before-create writes
│   ├── consolidator.js   # thresholds, prompt, llm.stream, validation
│   ├── cascade.js        # log₁₆(n) hierarchical summary archive
│   ├── model-log.js      # bounded record of which model each attempt ran on
│   ├── memory-status.js  # per-session fold of the two state tables (pure)
│   ├── memory-api.js     # Memory tab + shelf listing: read-only route family
│   ├── recall.js         # rules/taboos preload at session start
│   ├── auto-approve.js   # approves the agent's own plain bash hypatia calls
│   ├── skills.js         # bundled skill registration (never shadows another provider)
│   ├── status.js         # counters + structured logging
│   └── client/           # settings card + Memory tab
│       ├── index.tsx     # client plugin entry + slot registration
│       ├── SettingsCard.tsx
│       ├── MemoryView.tsx     # the Memory tab body
│       ├── memory-client.ts   # its fetch + merge rules (pure)
│       ├── plugin-card-seat.ts # card seat: official Plugins page, else Settings tab
│       ├── shelves.ts    # shelf dropdown choices (listing from the /shelves route)
│       └── slot-contract.ts
├── lib/
│   └── client.js         # built browser factory (commit this)
├── skills/
│   ├── hypatia-memory/   # this plugin's variant (retrieval is the agent's)
│   ├── hypatia/          # vendored from hypatia's skills/
│   └── hypatia-dream/    # vendored from hypatia's skills/, with local patches
├── scripts/
│   └── it-shelf.sh       # throwaway shelf for manual CLI probing
├── test/                 # node:test units (npm test)
│   └── integration/      # contracts against a real hypatia (npm run test:integration)
└── README.md
```
