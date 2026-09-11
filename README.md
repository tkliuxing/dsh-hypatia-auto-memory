# dsh-hypatia-auto-memory

Event-driven [Hypatia](https://github.com/tkliuxing/hypatia) memory for
[DSH](https://github.com/deepseek-ai/deepseek-harness): automatic conversation
logging and background consolidation — span summaries, a log₁₆(n) archive
cascade, and adjudicated work-unit extraction — all on a **dedicated model
route**, with zero model work in the main session.

Writing is automatic; **reading is the agent's job**, through the bundled
`hypatia-memory` skill. That split is deliberate — see *Recall* below.

Unlike `dsh-hypatia` (skills + auto-approval for bash-string hypatia calls),
this plugin drives the hypatia-memory protocol from **DSH native events** and
calls the `hypatia` CLI through the subprocess service with argv arrays — no
shell, no sandbox escalation, no approval prompts.

## Install

Prerequisite: `hypatia` CLI on PATH (or add its basename to `binaries`).

```bash
# from a local checkout (development)
dsh plugin --profile web add link:/path/to/hypatia/dsh-hypatia-auto-memory

# registry install once published
dsh plugin --profile web add dsh-hypatia-auto-memory
```

Repeat for other profiles (desktop, dsh-tui). Restart the profile after install.

The browser settings card is pre-built in `lib/client.js` and shipped with the
package. If you edit `src/client/*`, run `npm install && npm run build` in this
directory to regenerate it; while `pnpm run dev:web` is active in the DSH
checkout, client-plugin changes reload without a full page refresh.

**Coexistence with `dsh-hypatia`:** both can be installed — auto-approve and
auto-memory are independent. For the `hypatia-memory` skill, keep only one
provider: set `skills: false` on `dsh-hypatia` (this plugin's DSH-specific
variant assumes the auto layer is running and warns otherwise).

## How it works

```
session/event (emit)
  ├─ turn/end ──▶ durable queue (storageDomain tasks)
  │                 ├─ log-message  ──▶ hypatia msg-<sid>-<index>
  │                 ├─ consolidate  ──▶ ctx.llm.stream ──▶ sum-* (summary 1) + wu-*
  │                 └─ cascade      ──▶ $not-summaried ──▶ sum<N>-* (summary N)
  └─ session/title | compaction/summary ──▶ session-node ──▶ session-<sid> + belongTo
session/disposed ──▶ final flush + consolidation, thresholds waived
agent/session-start ──▶ rules/taboos inject()
```

- **Collector** records human `user/message` and `assistant/message` (with a
  collapsed tool ledger per turn), redacts secrets, absolutizes relative
  dates, caps assistant text, and enqueues idempotent log tasks. Plugin-sourced
  messages are skipped — no feedback loops.

  Spans are cut at `turn/end`, never on a timer. DSH appends `assistant/message`
  *before* running the tools it requested, so a mid-turn cut separates a message
  from its own tool results — and since a ledger is only emitted next to an
  assistant message, those results were then dropped rather than merely delayed.

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

- **Recall** preloads project/global rules and taboos at session start. Nothing
  else is pushed. Retrieval is the agent's job through the bundled skill, which
  is what `docs/memory-nolinear.md` prescribes for agents that hold context and
  can call tools; the previous per-turn injector also vetoed DSH's own runtime
  context section by returning from `agent/pre-step` without calling `next()`.

## Configuration

Settings namespace `hypatia-auto-memory` (edit `settings.yaml` or Web
settings; all fields optional, defaults shown):

```yaml
hypatia-auto-memory:
  enabled: true
  binaries: [hypatia]
  collector:
    enabled: true
    maxAssistantChars: 8000      # per-message cap before truncation marker
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
    # NOT a batching knob. Spans are cut at turn/end; this only bounds how much
    # a crash can lose from a turn that is still running.
    flushWindowMs: 120000
  recall:
    enabled: true
    preloadRulesTaboos: true
```

The cordis config block on the bundle row only carries skill packaging:

```yaml
- id: hypatia-auto-memory
  config:
    skills: true                 # register the bundled hypatia-memory skill
    skillsDir: /abs/path         # override the packaged skills/ directory
```

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
| Entries appear only after a turn finishes | By design: spans are cut at `turn/end` so a tool ledger stays with its assistant message |
| Logging works, no summaries | `consolidation.models` is empty or invalid — one warning at first trigger |
| Summaries but no `sum2-*` | Fewer than `cascade.batchSize` unarchived tier-1 summaries in that project yet |
| Work units have no relationships | No embedding model on the shelf (`similar` fails), or every candidate was beyond `dedupMaxDistance` |
| Task in `deferred` state | Its session is not loaded — DSH loads sessions lazily. Not an error: it spends no attempts and resumes by itself the next time that session is opened |
| Task in `failed` state | A CLI or model error persisted after `maxAttempts`. Failed `log-message` records are pruned at the next startup, since the watermark re-derives their range; other kinds are kept for inspection — delete one to let the next trigger re-create it |
| Watermark says logged, but the shelf has no entries | The shelf was reset or switched after logging. Watermarks live in `~/.dsh/storages/hypatia_auto_memory.json`, not in hypatia, so they survive the reset and those ranges are never re-logged. Stop DSH, delete the affected sessions' `progress` rows (or the whole file), then restart — backfill re-logs live sessions |
| Duplicate `msg-*` after weird manual edits | Delete the entry in hypatia and lower `lastLoggedSeq` for that session in the state domain — backfill recreates it once |
| Project scope looks wrong | Scope = git-root basename of the session cwd (falls back to basename); two same-named checkouts share a scope by design |

## Known limitations

Deliberate, and worth knowing before you rely on them:

- **No topic-shift detection.** `docs/memory-nolinear.md` ranks topic switches
  as the strongest session-splitting signal, above task boundaries and time
  gaps. Detecting one needs a model call every turn, which contradicts this
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
- **hypatia has no `knowledge-update`.** A second session title cannot replace
  the first, and a work unit is never edited in place. Changing an entry means
  delete + create, which loses `created_at` and its embedding, so the plugin
  does not do it.
- **Duplicate writes are detected by error text.** hypatia has no upsert and no
  `--if-not-exists`, so `hypatia-cli.js` recognises `UNIQUE constraint failed:` /
  `duplicate key` to make a replay idempotent. It is confined to one function;
  an upstream upsert would delete it. `test/integration` asserts the strings.
- **Adjudication and dedup need an embedding model.** On a shelf without one,
  `similar` fails outright and work units are stored with no relationship —
  never dropped.
- **Boot backfill reads live sessions.** A persisted-but-not-loaded session's
  gap is picked up when it next loads.
- **A cascade crash mid-batch shifts a grouping boundary.** Members already
  linked leave the tier's unarchived set, so the retry archives a different
  batch. Everything is still archived exactly once; the grouping is just not the
  one the first attempt intended.
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
│   ├── state.js          # storageDomain spec + progress helpers
│   ├── collector.js      # session/event filtering, ledger, backfill
│   ├── content-policy.js # redaction, dates, caps, slugs (pure)
│   ├── queue.js          # durable per-session queue with retry/dispose
│   ├── hypatia-cli.js    # argv-only subprocess wrapper
│   ├── writer.js         # idempotent get-before-create writes
│   ├── consolidator.js   # thresholds, prompt, llm.stream, validation
│   ├── cascade.js        # log₁₆(n) hierarchical summary archive
│   ├── recall.js         # rules/taboos preload at session start
│   ├── status.js         # counters + structured logging
│   └── client/           # browser settings card
│       ├── index.tsx     # client plugin entry + slot registration
│       ├── SettingsCard.tsx
│       └── slot-contract.ts
├── lib/
│   └── client.js         # built browser factory (commit this)
├── skills/hypatia-memory/SKILL.md   # DSH-specific skill (retrieval is the agent's)
├── scripts/it-shelf.sh   # throwaway shelf for manual CLI probing
├── test/                 # node:test units (npm test)
│   └── integration/      # contracts against a real hypatia (npm run test:integration)
└── README.md
```
