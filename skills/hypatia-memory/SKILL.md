---
name: hypatia-memory
description: Long-term memory for DSH via hypatia. Conversation logging and background consolidation run automatically; retrieval is yours to drive. Use when the task touches past decisions, project conventions, prior bugs, or anything the user expects you to already know — and whenever the user says "read hypatia", "查一下 hypatia", "记住", "忘记".
user-invocable: false
allowed-tools: Bash, Read, Grep, Glob
---

# Hypatia Memory (DSH auto-memory variant)

The `dsh-hypatia-auto-memory` plugin is active. It handles the **write** side of
memory in the background. The **read** side is yours.

## What runs without you

Do not do these by hand — you would only create duplicates:

- **Conversation logging.** Every human message and every assistant message
  becomes a `msg-<sessionId>-<N>` entry (`N` is a dense per-session message
  ordinal), redacted, with relative dates rewritten to absolute ones and a tool
  ledger attached. Spans are cut at turn boundaries.
- **Span summaries.** `sum-*` entries tagged `summary`, linked to the messages
  they cover with `summary` statements.
- **Work units.** `wu-*` entries tagged `memory,work-unit` for lessons worth
  keeping, with `is_a` / `derivedFrom` statements.
- **Session seed.** Project and global entries tagged `rule` or `taboo` are
  injected into your context at session start. Nothing else is pushed to you.

## What you own: retrieval

Rules and taboos are pushed because you cannot know to ask for them. Everything
else you must **pull**, when you judge you need it — including part-way through
a task, once you discover what the task is actually about.

Search when the task touches prior decisions, project conventions, a bug that
smells familiar, an unfamiliar internal name, or when the user implies you
should already know something. Searching costs one subprocess; not searching
costs a wrong answer that contradicts a decision already made.

### Semantic search — the default

```bash
hypatia similar "<what you actually want to know>" -t knowledge --limit 5
```

Write the query as the *idea* you are looking for, not the user's words verbatim.
Rows come back as `{"name", "content" (object), "distance"}`; lower `distance` is
closer. If it exits non-zero with `model unavailable` / `no embedding provider`,
this shelf has no embedding model — fall back to `search` and carry on.

### Keyword search — for exact identifiers

```bash
hypatia search "<exact symbol, error code, file name>" -c knowledge --limit 5
```

Rows come back as `{"id", "catalog", "key", "content" (**JSON-encoded string**),
"rank"}`. Note the shape differs from `similar`: the name is `key`, not `name`,
and `content` must be parsed before use.

### Structured queries

```bash
# This project's rules (and global ones)
hypatia query '["$knowledge", ["$contains","tags","rule"],
  ["$or", ["$contains","scopes","<PROJECT>"], ["$contains","scopes",""]]]'

# Everything derived from one work unit, two hops out
hypatia query '["$statement", ["$k-hop", "<entry-name>", "$*", 2]]'
```

`<PROJECT>` is the git-root basename of the workspace.

### Always exclude the operational layer

Raw logs and bookkeeping entries are indexed for full-text and vector search,
so they *will* come back in results. They are not knowledge — skip rows whose
name starts with `msg-`, `sum`, `session-`, or `hypatia-dream-run-`, and rows
tagged `message`, `session`, `summary`, or `hypatia-dream-run`. Read `wu-*`,
`rule`, `taboo`, and ordinary named entries.

Reach into `msg-*` only when the user asks what was literally said, and prefer
reaching it by walking `summary` statements down from a `sum-*` entry.

## Explicit writes

### Remember

When the user states a durable rule, taboo, or correction — "以后都记住：……",
"always use tabs", "never commit to main" — write it immediately. The background
extractor only produces work units; it never invents rules or taboos, so an
unwritten rule is a lost rule.

```bash
hypatia knowledge-create "<short-kebab-name>" \
  --data="<the fact, as an imperative>" \
  --tags "rule" \
  --scopes "<PROJECT>"
```

- `--tags rule` for conventions to follow, `taboo` for never-do items,
  `memory` for durable facts.
- **Scope syntax matters.** `--scopes "<PROJECT>"` is project-only.
  `--scopes "<PROJECT>,"` — with a *trailing comma* — also marks it global.
  `--scopes ""` writes no scope at all, which is not the same as global and will
  not be found by the session seed.
- There is **no `knowledge-update`**. Check with `knowledge-get <name>` first,
  then create or leave it alone. Changing an entry means delete + create, which
  loses its creation time and embedding, so avoid it unless the user asks.
- Creating a name that already exists exits 1 with `UNIQUE constraint failed`.
  That is a collision, not a crash.

Relate it to what is already there when the relationship is clear:

```bash
hypatia statement-create "<new>" "supersedes" "<old>" --scopes "<PROJECT>"
```

Use `refines`, `extends`, `supersedes`, `derivedFrom`, `is_a`. When new
knowledge **contradicts** old, record `supersedes` and leave the old entry in
place — the memory system must never quietly forget what it once believed. Do
not invent a vague `related_to` edge just because two entries share a topic.

### Forget

```bash
hypatia search "<keywords>" -c knowledge --limit 10
hypatia knowledge-delete "<exact-name>"
```

Deleting a missing entry exits 1. Statements referencing the entry are not
cascade-deleted; remove them with `hypatia statement-delete <head> <relation>
<tail>` when they would otherwise dangle. Deleted memories stay deleted — the
collector's watermark has already moved past them.

## Known gaps in the automatic layer

Say so plainly if a user's expectation depends on one of these:

- **No topic-shift detection.** Spans are cut on turn boundaries and token
  thresholds, not on the conversation changing subject. A session covering three
  unrelated topics summarises them together.
- **No `session-<id>` node** unless the host produced a session title or a
  compaction summary to build it from.
- **Summary names are mechanical** (`sum-<session>-<from>-<to>`), not descriptive.
  The descriptive title is the first heading inside the entry.
- **Work-unit dedup is best-effort** and degrades to "no relationship" whenever
  the shelf has no embedding model.
