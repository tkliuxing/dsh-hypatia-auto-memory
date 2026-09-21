# dsh-hypatia-auto-memory

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
works through the CLI instead, with one warning at the first call.

```bash
# from a local checkout (development)
dsh plugin --profile web add link:/path/to/dsh-hypatia-auto-memory

# registry install once published
dsh plugin --profile web add dsh-hypatia-auto-memory
```

Repeat for other profiles (desktop, dsh-tui). Restart the profile after install.

The browser settings card is pre-built in `lib/client.js` and shipped with the
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
                     closed while DSH keeps running; a restart is covered by the
                     startup consolidation backfill instead)
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

  Each assistant message carries a ledger of its own step's tool calls in the
  shape the hypatia-memory protocol asks for — what was called, how long it
  took, whether it worked, and one line of error on failure — **never the
  output** (`1. \`read\` ×5 — ✅ 1.2s total`). Tool outputs had been 84% of all
  stored message bytes, mostly file paths and contents, and made unrelated
  keyword searches match chat logs. Tool-call blocks leave no `[tool-call]`
  placeholder in the content; a step that only called tools says
  `(tool calls only)`. Plugin-sourced
  messages are skipped — no feedback loops.

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

- **Cascade** archives sixteen unarchived tier-N summaries into one tier-(N+1)
  entry, using hypatia's own `$not-summaried` (which anti-joins on
  `statement.tail` and orders `created_at ASC`, giving FIFO batching for free).
  This is the protocol's log₁₆(n) archive: each tier compresses only material a
  previous tier already distilled.

- **Work units** are adjudicated, not guessed. Candidates come from `similar`
  (the only search that reports a distance), filtered by a distance ceiling and
  by an exclusion list for the operational layer, then a small model call
  decides `duplicate | refines | extends | supersedes | contradicts | unrelated`.
  A contradiction keeps **both** entries and records `supersedes` — a memory
  system must not quietly forget what it once believed.

- **Housekeeping** runs once per startup over the progress table. It resets a
  row whose session has no `msg-*` entry left in the shelf — a wiped or
  replaced shelf would otherwise leave that session unlogged for good — and
  removes the row and tasks of a session DSH no longer has. Resetting costs a
  re-log and a re-consolidation, so both passes act only on positive evidence:
  a failed shelf query or an empty session listing changes nothing.

  A third pass consolidates what a restart interrupted. The session-end trigger
  does not survive one: DSH runs its close path at shutdown (it appends
  `session/end-seed`), but nothing queued there becomes durable before the
  process is gone — measured on a live restart, the storage file was not written
  and the session came back with `lastConsolidatedSeq: 0`. So a row whose logged
  tail was never consolidated is queued at the next startup, gated by the same
  `consolidation.minNewTokens` floor and read from the row rather than by
  loading the session. Without that gate every restart would spend one model
  call per session carrying any tail at all.

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

## Configuration

Settings namespace `hypatia-auto-memory` (edit `settings.yaml` or Web
settings; all fields optional, defaults shown):

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
    toolLedger: true             # collapse repeated tool calls
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
```

The cordis config block on the bundle row only carries skill packaging:

```yaml
- id: hypatia-auto-memory
  config:
    skills: true                 # register hypatia-memory + hypatia + hypatia-dream
    skillsDir: /abs/path         # override the packaged skills/ directory
```

`enabled` and `autoApprove` are read when the plugin starts, so changing either
needs a profile reload; every other switch applies immediately.

### Choosing the shelf

`shelf` names the hypatia shelf every entry is written to and every lookup
reads — logging, consolidation, the cascade, the rules/taboos preload, and the
startup housekeeping. The settings card offers it as a dropdown of what
`hypatia list` reports (refreshed about once a minute, and after every settings
change), marking shelves that are registered but not connected.

- **Takes effect after a profile reload**, like `enabled`. A running queue keeps
  writing where it started; the log says so when the setting changes.
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

The listing reaches the browser as a second, read-only settings namespace,
`hypatia-auto-memory-shelves`, which the Host re-registers whenever the listing
changes. No card claims it, so it renders nowhere; nothing ever writes to it.

## Operations checklist

1. After a turn ends, entries appear within seconds:
   `hypatia knowledge-get msg-<sessionId>-<n>` (`n` counts messages, from 0)
2. Watermarks live in the state domain; failed tasks stay in the `tasks`
   table with their last error for inspection.
3. Restart mid-write is safe: messages already stored are skipped
   (get-before-create); uncovered ranges are re-enqueued from watermarks.
4. To check the route warning: consolidation with no selected `models`
   logs a one-time warning and otherwise stays silent.
5. Uninstall: `dsh plugin --profile web remove dsh-hypatia-auto-memory` —
   hypatia entries themselves are left in `~/.hypatia/`.

## Failure modes

| Symptom | Cause / handling |
|---|---|
| No entries after chatting | `enabled: false`, missing `hypatia` binary, or the collect fiber PENDING (needs `sessions`, `storageDomain`, `subprocess`, `settings` from the base composition) — check profile logs |
| Nothing logged for a whole run after a restart | The storage domain refused to open because a stored record failed its schema. The storage service validates on read, not on write, so a bad write only surfaces at the next startup — and one bad row fails the whole domain. Look for `startup failed` / `does not match its schema` in the profile log. Task rows missing `error` are now defaulted; for any other bad row, stop DSH, remove it from `~/.dsh/storages/hypatia_auto_memory.json`, and restart |
| Entries appear only after a turn finishes | By design: spans are cut at `turn/end`, or at the first `step/end` once a turn has run longer than `flushWindowMs`, so an entry never lacks its own tool results |
| Logging works, no summaries | `consolidation.models` is empty or invalid — one warning at first trigger |
| Summaries but no `sum2-*` | Fewer than `cascade.batchSize` unarchived tier-1 summaries in that project yet |
| Work units have no relationships | No embedding model on the shelf (`similar` fails), or every candidate was beyond `dedupMaxDistance` |
| Task in `deferred` state | Neither the live store nor persistence could supply its session. Not an error: it spends no attempts and runs as soon as one of them can. Normally storage answers immediately — the state persists only when `sessionPersistence` is absent from the composition, or its read failed (look for `could not be read` in the log) |
| Task in `failed` state | A hypatia or model error persisted after `maxAttempts`. Failed `log-message` records are pruned at the next startup, since the watermark re-derives their range; other kinds are kept for inspection — delete one to let the next trigger re-create it |
| Watermark says logged, but the shelf has no entries | The shelf was reset or switched after logging. Handled at startup: `housekeeping.reconcileOnStartup` resets any row whose session has no `msg-*` left, and that session is re-logged — and re-consolidated — from the start on its next activity. A shelf query that fails leaves the row untouched. A session whose messages were all deleted on purpose is indistinguishable and is logged again; turn the switch off if that matters |
| Warning `hypatia mcp unavailable: …; using the hypatia CLI until the profile reloads` | The binary predates `hypatia mcp` (the message quotes its `unrecognized subcommand`), lacks a tool the plugin calls, or answered the handshake with an error. Everything keeps working over the CLI; upgrade hypatia and reload the profile to use MCP |
| Every call fails with `hypatia mcp exited …` or `timed out` | The binary starts but its MCP server does not come up — a wrapper script in `binaries` that changes clap's exit code or wording is not recognised as an old binary. Set `transport: cli` |
| Every write fails right after changing `shelf` | The shelf is not registered or not connected — startup logs `shelf "<name>" is not registered`. Connect it (`hypatia connect <dir> --name <name>`) and reload the profile, or pick another |
| The agent searches `default` while the plugin writes elsewhere | A disk copy of `hypatia-memory` (see below) replaced the bundled skill, or recall is disabled, so nothing told the agent which shelf to use |
| Duplicate `msg-*` after weird manual edits | Delete the entry in hypatia and lower `lastLoggedSeq` for that session in the state domain — backfill recreates it once |
| The agent's own `hypatia` write still asks for approval | `autoApprove: false` (needs a profile reload to change), the command pipes/redirects/chains outside quotes, or its first word is not one of `binaries` — only plain calls are answered, by design. Reads never reach approval at all, so nothing to fix there |
| The agent got a memory protocol that tells it to log messages by hand | Another plugin registered `hypatia-memory` first (`dsh-hypatia` still in the profile), or a `hypatia-memory` exists on disk — typically `~/.agents/skills/hypatia-memory`, written by `hypatia skill install --agent codex`. Agent presets load disk skills in a layer nearer than plugins, so it wins in sessions even though the skill center may list this plugin. Remove the copy the startup warning names |
| Startup warnings never appear in the terminal | `dsh web` mounts no log exporter, so plugin log lines of any level go nowhere; the console exporter's default threshold would also drop warnings (warn is level 2, above info's 1). Mount a logger such as `dsh-logbook` or `dsh-boot-doctor` temporarily to read them |
| Project scope looks wrong | Scope = basename of the session cwd's git top level (`git rev-parse --show-toplevel`), or of the cwd itself when git finds no work tree or cannot answer (not installed, a repo it refuses as unsafe). A `rev-parse` slower than 3 s leaves that one session on the cwd's own name. Two same-named checkouts share a scope by design; a linked worktree is scoped by its own directory, not the main checkout's; git resolves symlinks, so a checkout opened through a link named differently from its target gets the target's name. A name hypatia would rewrite is normalized first: a session at `/` is scoped `/`, commas become `_`, surrounding whitespace goes. Entries written before these fixes stay where they were stored: a subdirectory session's under that directory's name (`repo/src` wrote under `src` — the git root was never read), a session at `/` with no scope, `a,b` under both `a` and `b`, `foo,` under `foo` and global. Padded names were stored trimmed, which is what the query now asks for. Nothing migrates them; `knowledge-update --scopes` moves one entry and keeps its `created_at` |

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
- **`enabled: false` at the top level is read at plugin startup**; toggling it
  live requires a profile reload, while the per-feature switches apply
  immediately.

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
│   ├── config.js         # settings namespace, defaults, live updates
│   ├── shelf.js          # per-shelf table views, `hypatia list`, shelf inventory
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
│   ├── recall.js         # rules/taboos preload at session start
│   ├── auto-approve.js   # approves the agent's own plain bash hypatia calls
│   ├── skills.js         # bundled skill registration (never shadows another provider)
│   ├── status.js         # counters + structured logging
│   └── client/           # browser settings card
│       ├── index.tsx     # client plugin entry + slot registration
│       ├── SettingsCard.tsx
│       ├── shelves.ts    # shelf dropdown choices from the inventory namespace
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
