# 对话回退与记忆真实性：问题、终案与实施方案

> **给谁看**：本插件的维护者。动手改 `collector`、`index`、`writer`、`consolidator` 之前，先读 §0（结论速览）、§2.2（判定白名单，**硬条件**）和 §6（验收清单）。
>
> **事实基线**：2026-10-14，本仓库工作树 `c75e133`；文中每个本仓库行号都在这个提交上逐条核对过。回退一侧读的是已安装的 `dsh-rewind-plugin` 包（`~/.dsh/profiles/web/node_modules/dsh-rewind-plugin`，`/rewind` 实际行为与其 README 一致）；宿主契约读的是 `deepseek-harness` 检出（`packages/...`，行号指向该检出的 `src`）；hypatia 能力在同一台机器上实测（`hypatia 4.0.0`）。
>
> **相关代码**：[`src/collector.js`](../src/collector.js)（判定与采集）、[`src/index.js`](../src/index.js)（`log-message` 执行器）、[`src/writer.js`](../src/writer.js)（条目与图边）、[`src/consolidator.js`](../src/consolidator.js)（摘要输入与水位）、[`src/queue.js`](../src/queue.js)（flush 时机）、[`src/housekeeping.js`](../src/housekeeping.js)（重启对账）、[`src/hypatia-cli.js`](../src/hypatia-cli.js) / [`src/hypatia-mcp.js`](../src/hypatia-mcp.js) / [`src/hypatia-client.js`](../src/hypatia-client.js)（delete 通道）。
>
> **本文的来历**：调研与复核见记忆条目 `wu-rewind-memory-contamination-rootcause-fd988b2f`（根因与取证）与 `wu-skip-write-instead-of-tombstone-802f31dd`（三轮收敛后的终案）。本文把终案写成可开工的文档，并纳入复核提出的硬条件；写文档时又补到两处新证据（§2.2 的 compaction-checkpoint、§4.5 的 `items` 契约），已在文中标出。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 缺陷成立吗 | **成立**。回退把"哪些消息被撤回"写进了会话日志，记忆侧从来不读它 |
| 是回退插件的错吗 | **不是**。它只追加一条标记、从不删改日志；它把撤回**记录**下来了，缺的是消费方 |
| 修正形态 | **一处判定、两种处置**：撤回区间内的消息，未落库 → 不写；已落库 → 删除。摘要输入一起跳过 |
| 判定依据 | `event.surfaceOp.op === 'replace'` **且** `event.type === 'user/message'` **且** `event.data.source.kind` 在白名单里（`dsh-rewind`、`plugin:rollback`，§2.2，不能放宽） |
| 覆盖范围 | **两个包**：`dsh-rewind-plugin` 与 `plugin:rollback`（`@domitor-syh/dsh-rollback`、`@nianchu/dsh-rollback` 同源）。口径是「只兼容使用量大的少数几个」（§2.4）：用量最高的一批同类插件全部走 fork、无需兼容 |
| 要改哪里 | `collector.js` 一个纯函数；`index.js` 执行器两处分支；`writer.js` 跳过集 + delete 通道；`consolidator.js` 两处跳过；客户端两个 transport 各加 delete |
| 刻意不做 | 不改回退插件、不建撤回账本、不加新任务 kind、不写撤回条目、不做历史回扫、不动召回侧 |
| 被撤回的内容能还原吗 | 对话层**不能**（宿主无 un-rewind，`/undo` 就是 `/rewind`）；原文只留在会话日志与 `/export` |
| 残留 | 回退前已写出的摘要可能仍含被撤回内容（摘要不可重写）；这是"只向前生效"的代价，见 §7 |

## 1. 问题

### 1.1 回退做了什么

`dsh-rewind-plugin` 的设计只有一步：往日志**末尾追加一条「空消息」标记**，把目标消息之后的全部内容从模型可见面（surface）"遮蔽 + 替换"掉。

- 标记的来源与内容：`REWIND_MARKER_SOURCE = { kind: 'dsh-rewind' }`、正文固定为 `"(empty message)"`（`lib/index.js:132-133`、`:2481-2487`）；
- 追加动作：`session.append('user/message', marker, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs })`（`lib/index.js:2614-2618`）；
- 遮蔽范围：`shadowedSeqs = surface.slice(targetIndex)`——目标消息**及其之后**的全部 surface 节点（`lib/index.js:225-233`）；
- 它对自己的承诺是明确的：日志"仅追加回退标记，从不删改"（README:15）、回退本身"**无法撤销**，但被撤回的内容仍保留在会话日志中"（README:64）、"采用与官方 `/compact` 相同的「隐藏 + 替换」"（README:111）、"被撤回的内容完整留在日志里，可审计、可追溯"（README:113）。

**所以这不是回退插件的缺陷。** 它把"这里发生过撤回、撤回了哪几条"完整写进了日志；缺陷在记忆侧：我们从日志里读消息，却从不读这个字段。

### 1.2 记忆侧现在怎么读日志

| # | 环节 | 现在的行为 | 后果 |
|---|---|---|---|
| 1 | 采集 [`src/collector.js:364`](../src/collector.js#L364) | 只按 `seq` 监听 `session/event`；`isLoggableMessage` 只看事件类型与 `data.source.kind`（[:106-112](../src/collector.js#L106-L112)） | 完全不知道 surface 语义；还会把插件写的**替换副本**当成人类消息记一条（§2.3 末） |
| 2 | 条目序号 [`src/collector.js:131`](../src/collector.js#L131) | `countLoggableMessages` 按**日志前缀**数稠密序号 | 撤回不改变序号；事后删条目会留下永久空位（这是可接受的，见 §3） |
| 3 | 写入 [`src/writer.js:133`](../src/writer.js#L133) | `writeMessage` 先 `knowledgeGet`，已存在就跳过（按名幂等），**从不重写** | 一旦写出，没有任何机制收回 |
| 4 | 摘要水位 [`src/consolidator.js:570`](../src/consolidator.js#L570) | `toSeq = min(session.seq, lastLoggedSeq)`，只看 seq | 旧分支与新分支混进同一个摘要 |
| 5 | 摘要输入 [`src/consolidator.js:274-281`](../src/consolidator.js#L274-L281) | `buildTranscript` **逐条读 `event.data.content`** | 被撤回的原句照样送进模型 |
| 6 | 召回 | 排除名单只有 `msg-`/`sum`/`session-`/`hypatia-dream-run-` 前缀（[`src/writer.js:28`](../src/writer.js#L28)） | 被撤回内容照常可检索 |

另外：标记自己 `source.kind === 'dsh-rewind'`（不是 `'user'`），被 `isHumanMessage`（[`src/collector.js:231`](../src/collector.js#L231)）过滤，**不占序号、不进记忆**——也就是说记忆里连"这里发生过回退"这个事实都不存在。

### 1.3 取证（本机可复现）

会话 `session-007cef11-c4ac-45aa-976e-4e77db44e72e`（`deepseek-harness` 工作区，2026-10-13）。

日志（`~/.dsh/sessions/--Users-baihaoran-Code-github.com-tkliuxing-deepseek-harness--/session-007cef11-.../session.v4.jsonl.zstd`）：

| seq | 时间（UTC） | 内容 |
|---|---|---|
| 365 | — | `user/message`，`surfaceOp: "append"`，`source.kind = user`：「插件 dsh-web-search-enhanced 有没有提供新工具？」**（被撤回的那条）** |
| 389 | 01:09:31.605 | `user/message`，正文 `(empty message)`，`source.kind = dsh-rewind`，`sourceEventSeqs: [365, 367]`，`surfaceOp: { op: "replace", startSeq: 365, endSeq: 367 }` |
| 397 | 01:09:33 | `user/message`，`surfaceOp: "append"`，`source.kind = user`：同一句话**（用户改完重发）** |

记忆库（scope `deepseek-harness`，`embed: false`、`tags: ["message"]`）：

| 条目 | 正文开头 | `created_at` |
|---|---|---|
| `msg-session-007cef11-…-3` | 「插件 dsh-web-search-enhanced 有没有提供新工具？」 | 2026-10-13 01:12:28.555 |
| `msg-session-007cef11-…-4` | 同一句话 | 2026-10-13 01:12:28.566 |

两条都在**回退之后**（01:09:31）写入——正是"回退发生了，但这个会话的 flush 当时还没跑，采集器随后按原始日志把 365 原样落库"。记忆里从此有同一句话的两份副本，而没有任何一条记录说"这份已被用户当场丢弃"。

顺带确认的两个边界（都在上表里）：标记不占序号（`source.kind` 不是 `user`）；被遮蔽的 367 是 `developer/message`，本来就不是可记消息。

## 2. 修正信号：宿主已经给了，不需要改回退插件

### 2.1 标记的三个字段

`SurfaceOp` 是宿主类型，不是插件私有格式（`packages/core/session/src/types.ts:449-465`）：

```ts
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```

`surfaceOp` 与 `sourceEventSeqs` 是**事件信封上的顶层字段**（不在 `data` 里），因此它们随 `session.snapshotEvents()` 一起到手，无论会话是活的还是从持久层只读打开的（[`src/persisted-session.js:47-60`](../src/persisted-session.js#L47-L60) 原样返回事件）。宿主还导出了现成的判据与折叠函数（`isReplacementSurfaceEvent`，`packages/core/session/src/surface.ts:102-108`；`foldSurface`，`:600`），我们不需要它们——只需要两个字段。

三条契约要点：

1. **区间语义**：`[startSeq, endSeq]` 表示"当前 surface 上从 `startSeq` 到 `endSeq`（含两端）的节点，被这条事件整体替换"。回退插件给的 `sourceEventSeqs` 与这个区间是同一批节点（它自己就是按 `surface.slice(targetIndex)` 算的，`lib/index.js:225-233`）。
2. **顺序保证**：`startSeq`/`endSeq` 必须指向**更早**的事件（`validateSurfaceMetadata` 强校验，`packages/core/session/src/surface.ts:410-419`）。§3 的扫描边界就建立在这条上。
3. **所有权**：这是宿主契约，不是回退插件的私产。任何 surface 生产者都能用它。

### 2.2 【硬条件】判定必须认 `source.kind`，不能只认事件类型

**这是复核提出的验收硬条件，写文档时又补到了更强的证据：连"只认类型 + replace"都不够。**

`surfaceOp: { op: 'replace' }` 在本机运行的 DSH 里有四个生产者：

| 生产者 | 事件类型 | `data.source.kind` | 被遮蔽的是 | 该算"撤回"吗 |
|---|---|---|---|---|
| `dsh-rewind-plugin` | `user/message` | `dsh-rewind` | 用户当场丢弃的分支 | **算** |
| `compaction-basic`（自动/手动压缩） | **`user/message`** | `compact-checkpoint` | **真实历史**（压缩成摘要，对模型折叠，对人类仍是历史） | **不算** |
| `compaction-tool-result-pruner` | `tool/result` | 原 tool result 来源 | 一条工具输出被裁剪后的副本 | 不算 |
| `agent-loop` runtime-context | `system/message` | `system-prompt`（实测） | 上一版运行时上下文快照 | 不算 |

出处：`packages/compaction/compaction-basic/src/region.ts:506-509`（checkpoint 就是用 `user/message` + `replace` 追加的，来源由 `compactCheckpointSource` 构造，`packages/compaction/compaction/src/checkpoint.ts:22-41`，kind 固定为 `'compact-checkpoint'`）；`packages/compaction/compaction-tool-result-pruner/src/index.ts:169`；`packages/core/agent-loop/src/runtime-context.ts:108`。同一份会话日志里两种事件并存，可直接对照——`session-007cef11` 的 seq 389 是 `dsh-rewind`，紧邻的 seq 395/396 是 `system/message` 的 `replace`（这两条靠**事件类型**就被排除了，kind 的具体拼写不影响判定）。

为什么这是硬条件：**compaction 折叠掉的历史是真实历史**。若判定只看"`replace` + 被遮蔽内容在水位之前"，压缩一旦发生，大段真实对话会被当成撤回，在删除语义下就是**删错数据**——而且删的是刚刚续写过的那段。

所以判定收窄成一条，没有余地（`src/collector.js` 里的实际形态）：

```js
export const WITHDRAWAL_SOURCE_KINDS = Object.freeze(['dsh-rewind', 'plugin:rollback'])

export function withdrawnRanges(events) {
  const ranges = []
  for (const event of events ?? []) {
    const op = event?.surfaceOp
    if (op?.op !== 'replace') continue              // 'append' 与无 surface 的事件都不是
    if (event.type !== 'user/message') continue     // 排除 runtime-context 的 system/message、pruner 的 tool/result
    const kind = event.data?.source?.kind
    if (WITHDRAWAL_SOURCE_KINDS.includes(kind) === false) continue  // 排除 compact-checkpoint 等——它们不是撤回
    const seqs = new Set((event.sourceEventSeqs ?? []).filter(Number.isInteger))
    if (seqs.size === 0) continue                   // 宿主禁止空列表；读不出来就不猜
    ranges.push({ from: op.startSeq, to: op.endSeq, at: event.seq, kind, seqs })
  }
  return ranges
}
```

**第二个硬条件：所列 seq 必须刚好等于被遮蔽集。** 宿主只要求 `sourceEventSeqs` **包含**全部被遮蔽节点——多列更早的 seq 是合法的（`assertSourceEventReferences` 查的是 `missing`，不是相等）。而我们把所列的每一个 seq 都当作撤回、直接删。所以"列出的集合"是每个成员各自的性质，读代码确认过才算数：`dsh-rewind-plugin` 传 `[...plan.shadowedSeqs]`（它自己的 `surface.slice(targetIndex)`），两个 rollback 包传 `seqsForStorage(shadowed)`——同一个集合，三个以上时把末尾提到最前，为的是绕开存储层对连续区间的压缩（所以读的是**集合**，不是顺序）。加新成员时这项必须一并在 §2.4 第 5 条里核对：一个顺带列举了"回退到的锚点"的生产者，会让那条被保留的消息在这里被删掉。

**第三个硬条件：不读 `[startSeq, endSeq]` 兜底。** 那两个数字表示的是 **surface 顺序**，不是 seq 大小——一个跨过 compaction checkpoint 的回退，切片里可能出现 `startSeq > endSeq`。按数字从 `startSeq` 遍历到 `endSeq` 既可能取不到东西，也可能把不该动的 seq 包进来；因此没有 citation 的标记一律不认（宿主本来就禁止 replace 带空列表）。

测试里必须有一条"compaction 的 replace 不触发跳过/删除"，见 §6.3。

### 2.3 生态实况：同类插件的 replace 生产者（2026-10-14 审计）

§2.2 列的是**宿主侧**的生产者。插件侧还有更多，而且**来源字符串毫无统一约定**。下表是 npm 上 13 个"对话回退 / 撤回 / 编辑重发"类插件解包后的代码审计结果（判定只看代码原文，不看 README；关键四条已逐条复核）：

| 包（版本） | 机制 | 写 `replace`？ | `source.kind` | 语义上算撤回吗 | 本方案覆盖？ |
|---|---|---|---|---|---|
| `dsh-rewind-plugin` 0.15.0 | surface-replace（原地） | 是 | `dsh-rewind` | **算** | **是** |
| `dsh-retrace` 0.4.32 | surface-replace（`compaction/prune` 审计段 + 载体段） | 是 | `model` | 算 | 否 |
| `@kyle123740/dsh-message-recall` 0.2.1 | surface-replace（原地墓碑） | 是 | `user` + `producer: "message-recall"` | 算 | 否（且现在会被当人类消息记一次） |
| `@domitor-syh/dsh-rollback` 0.5.0、`@nianchu/dsh-rollback` 0.4.3 | surface-replace（`withReplaceSurfaceOpFallback`，拿不到区间时降级 `append`） | 是 | `plugin:rollback` | 算 | **是**（2026-10-14 纳入） |
| `dsh-clear-mind` 0.1.5 | surface-replace（双路径：自塌陷墓碑 / compaction 包装器） | 是 | `dsh-clear-mind`；另一路是 `compact-checkpoint` | **不算**（模型自压缩，人类侧历史仍是真历史） | 否 = 正确 |
| `@anionex/dsh-turn-rewind` 0.3.9、`dsh-recall-plugin` 2.4.10、`dsh-recover-context` 1.0.6、`dsh-checkpoint-rewind` 0.6.24、`dsh-message-edit` 0.2.3、`dsh-plugin-message-edit` 1.2.1、`dsh-undo-plugin`（实现在依赖 `@dsh-undo/rollback-*`） | **fork / 新建会话**（`sessions.fork` / `agents.create({seed})`），全包 0 处 `surfaceOp` | 否 | — | 不是本次缺陷的形态 | 无事可做 |
| `dsh-tauri-turnrewind` 0.3.1 | 只回滚工作区文件，会话日志零改写（提示只注入 `agent/pre-step` 的请求面） | 否 | — | 不属于对话回退 | 不适用 |

三条结论：

1. **多数同类插件走 fork，不产生任何标记。** 它们不改写日志，旧内容留在**旧会话**里——那是一条真实存在、随时可打开的会话，不是"被就地遮蔽的分支"。要不要把废弃会话排除出记忆是另一个问题（本方案不涉及）；本次缺陷只发生在"就地改写、模型再也看不到"的那一类插件上。
2. **白名单只能逐包验证后追加，不能反向排除。** 写撤回语义 replace 的一共 4 个包，kind 分别是 `model`、`user`+`producer`、`plugin:rollback`（×2）。已按用量口径纳入 `plugin:rollback` 这一档（一个判据覆盖两个同源包），`model` 与 `user`+`producer` 不收；而"排除已知的非撤回来源"（denylist）是 **fail-open** 的——只要有新插件用 replace 做编辑或压缩，就会被当成撤回删掉。`dsh-message-recall` 的 `kind: 'user'` 尤其说明问题：它必须靠 `producer` 字段才能标识自己。
3. **`dsh-clear-mind` 复用官方 compaction 的 `kind = 'compact-checkpoint'`。** 那一路是"模型自己把一段历史压成检查点"，人类侧历史仍是真历史——**不算撤回**。白名单把它排除在外是正确行为，这条恰好证明"宁窄勿宽"的取向是对的。

**顺带发现一个今天就存在的 bug（与撤回处理无关）**：`dsh-message-recall` 的墓碑是 `user/message` 且 `source.kind === 'user'`（它必须在 `source.producer` 里带上自己的身份，因为 v4 持久化格式拒收 `kind: 'plugin'`），于是 [`isLoggableMessage`](../src/collector.js#L106-L112) 会把它当成人类消息，记一条正文为 `[已撤回]` 的 `msg-*`。宿主对此有现成判据——**只有 append-origin 的 surface 事件才属于人类转写**（`isAppendSurfaceEvent`，`packages/core/session/src/surface.ts:89-102`，原文：*replacement copies stay model-only*）。采集侧的判据应当从"`kind === 'user'`"升级为"append-origin"（`surfaceOp` 缺省视为 append，以兼容老日志），这样所有替换副本——包括我们还没审计过的插件——都不会被误记。

### 2.4 兼容口径：只覆盖使用量大的少数几个（2026-10-14 定）

生态现状让口径可以很窄：**同类插件里用量最高的一批全部走 fork，不需要任何兼容**；真正需要兼容的只有"就地改写"的那几个，而它们当中用量够大的极少。所以本方案不做广谱适配，只按用量取头部有限几个（口径已落库为规则 `rewind-plugin-compat-scope`）。

| 包 | 近 30 天 ⤓ | ★ | 机制 | 需要兼容？ |
|---|---|---|---|---|
| `dsh-rewind-plugin` | **25992** | 127 | replace，kind `dsh-rewind` | **是（已实现）** |
| `dsh-recall-plugin` | 5890 | 40 | fork | 不需要 |
| `@anionex/dsh-turn-rewind` | 5274 | 133 | fork | 不需要 |
| `dsh-checkpoint-rewind` | 5147 | 23 | fork | 不需要 |
| `dsh-easyrewrite`（DSH-EasyRewrite） | 4596 | 126 | fork（`ctxSessions.fork`；全包 0 处 `surfaceOp`） | 不需要 |
| `dsh-retrace` | 3453 | 4 | replace，kind `model` | **否**：kind 过于通用，误判即删错数据 |
| `@domitor-syh/dsh-rollback` | 2443 | 2 | replace，kind `plugin:rollback` | **是（已实现，一条判据同时覆盖下一行）** |
| `dsh-message-edit` | 2376 | 50 | fork | 不需要 |
| `dsh-plugin-message-edit` | 2191 | 18 | fork | 不需要 |
| `dsh-recover-context` | 1377 | 4 | fork | 不需要 |
| `dsh-undo-plugin` | 959 | 3 | fork（实现在依赖 `@dsh-undo/rollback-*`） | 不需要 |
| `@nianchu/dsh-rollback` | 529 | 1 | replace，kind `plugin:rollback` | **是（与 `@domitor-syh` 同源）** |
| `@kyle123740/dsh-message-recall` | 354 | 2 | replace，kind `user` + `producer` | **否**：用量低 |

五条口径：

1. **先按机制筛。** 只走 fork / 新建会话的插件一律不做兼容——它们不产生标记，旧内容留在真实存在的旧会话里。
2. **再按用量筛。** 以市场目录的近 30 天下载量（配星数）为准，只取头部有限几个。这一筛把候选从"4 个写 replace 的包"压到两个：`dsh-rewind` 与 `plugin:rollback` 这一档（后者一条判据覆盖两个同源包）。
3. **识别字段不可靠的不予兼容。** `dsh-retrace` 的 `source.kind = 'model'` 是个通用字符串，拿它当判据等于开一个口子；`@kyle123740/dsh-message-recall` 的 `'user'` 同理（它必须靠 `producer` 才能标识自己）。
4. **不做反向规则。** denylist（"排除已知的非撤回来源"）是 fail-open 的：新插件拿 replace 做编辑或压缩就会被当成撤回删掉。白名单只做加法。
5. **新成员加入流程（两步都要，缺一不可）。** 解包 tarball → ①确认它写 replace 的**语义确实是"用户丢弃分支"**（不是编辑/压缩/合并）；②确认它列出的 `sourceEventSeqs` **刚好等于被遮蔽集**——宿主只要求"包含"，多列更早的 seq 合法，而多列的每一条都会被我们删掉（§2.2 第二个硬条件）→ 记入白名单 → 用它的真实 kind 与真实 cite 形状构造一条测试。
   - 已按此核对：`dsh-rewind-plugin` 传 `[...plan.shadowedSeqs]`（恰好）；两个 rollback 包传 `seqsForStorage(shadowed)`（同一集合，三个以上时重排顺序）。
   - 名字通用性是个已知取舍：`plugin:rollback` 落进的是 `plugin:<插件名>` 这个通用格式，将来任何自称 `rollback` 的插件都会命中。接受它，因为改名会以测试失败的形式暴露，而写死更窄的字符串会让它**悄悄**停止匹配原本支持的那个插件。

## 3. 决定方案形态的五个事实

1. **对话层不可还原。** 宿主没有 un-rewind / redo；`/undo` 是 `/rewind` 的别名；回退插件里所有 `restore` 都指工作区文件还原，不指对话。原文只留在日志与 `/export` 里供审计。结论：那条记忆**没有任何恢复路径会用到**，没有"留着将来可能引用"的价值。
2. **序号是数出来的，不是存出来的。** `msg-<session>-<N>` 的 `N` 由 `countLoggableMessages` 按 append-only 日志前缀现算（[`src/collector.js:114-137`](../src/collector.js#L114-L137)）。所以**跳过或删除都不破坏后续序号**，只是序号空间出现空位。反过来：若为了"连续"改成只数未撤回的消息，会让所有已写出的幸存条目与后续序号**整体错位**，那才是真正的破坏。
3. **名字即身份，删除不释放语义。** 同一份 append-only 日志前缀永远算出同一个序号，所以 `msg-3` 永远指 seq 365 那条消息；删除后重建同名也不会指向别的消息。这消掉了"delete 会静默错指"的担心。
   - 附带：`knowledge-delete` **不会**级联删除引用该名字的 statements，悬挂边是既有语义、被明确接受为"可审计、风险较低"（记忆条目 `wu-knowledge-delete-retains-statements-7487bf50`）。所以我们**不去删边**，也不为它加清理逻辑。
4. **写入不可撤回，但"不会再被写回来"必须靠区间锚定。** 已落库的只能删；而"删了又复活"的防线不是"条目当前是否存在"（崩溃重放、跨批次续写都会绕过它），而是**判定锚定在日志区间上**：只要重放时扫到的日志里还有那条标记，它就不会被重写。
5. **扫描必须扫到 `session.seq`，不能只看任务自己的区间。** 标记的 seq 恒**大于**它遮蔽的所有内容 seq（事实 2.2 的顺序保证），所以标记完全可能落在任务区间**之外**：`turn/end` 触发的 flush 是 `immediate: true`（[`src/collector.js:330`](../src/collector.js#L330) → [`src/queue.js:311-332`](../src/queue.js#L311-L332)，跳过合并窗口），用户看到回合结束后才按回退，标记的 seq 就落在 `[fromSeq, toSeq)` 之外。因此判定读的是 `[fromSeq, session.seq)`——一次几十个事件的**尾部切片**，不是全量扫描；而且这样做同时覆盖了两种处置（新消息还没写、旧条目已写）。
   - 反过来"任务区间整体位于标记之后"的情形不需要论证：那时区间内每条消息的 seq 都大于标记 seq，也就都大于一切被遮蔽的 seq，不可能属于撤回范围。**真正的风险只有一种：标记落在 `[toSeq, session.seq)` 之间。**

## 4. 终案：一处判定，两种处置

已定的三条取向：**记忆侧自解析**（不依赖回退插件的任何导出，不要求它发新版）、**只向前生效**（不回扫历史）、**允许删除**（所以不需要墓碑，也不需要标签通道）。

### 4.1 判定（一次读日志的纯函数）

判定是 `src/collector.js` 里三个**纯函数**，输入日志切片、输出集合与序号——不落库、不进 schema、不产生新任务类型。这正是它比"撤回账本"简单的地方：**没有第二处真值要存，判定可以随时从日志重算，重放天然幂等**。

| 函数 | 输入 → 输出 |
|---|---|
| `withdrawnRanges(events)` | 日志切片 → 每个标记的 `{from, to, at, kind, seqs}` |
| `withdrawnSeqs(events)` | 日志切片 → 全部被遮蔽 seq 的集合（`consolidator` 用这个） |
| `withdrawalWork({ log, prefix, fromSeq, inherited })` | 两段日志 → `{ seqs, retract }`：本 span 要跳过哪些、哪些已经落库要按序号删（`log-message` 用这个） |
| `withdrawnOrdinals(events, seqs, inherited)` | 日志 + seq 集合 → seq → 条目序号（`session-node` 与 `withdrawalWork` 共用） |

调用点三处，读法相同：标记窗口一律是 `[fromSeq, session.seq)`，从不切到任务自己的上界——`log-message` 执行器（[`src/index.js:362`](../src/index.js#L362)，标记窗口在 `:382`）、`session-node` 执行器（[`src/index.js:449`](../src/index.js#L449)）与 `consolidate` 执行器（[`src/consolidator.js:712`](../src/consolidator.js#L712)）面对的是**同一个**可见性问题（§3 事实 5），所以共用这几个函数，不要各自实现。判定与序号的算术都在 `collector.js` 里，因此可以脱离 session 单测（`test/collector-withdrawn.test.mjs`）。

### 4.2 处置一：还没落库 → 不写

执行器在写之前把 `formatted`（[`src/collector.js:648`](../src/collector.js#L648) 产出的 `{seq, index, role, markdown, tokens}`）里 `seq` 落在撤回区间内的条目**直接跳过**：不创建条目、不留正文、不产生知识。

**实现要点（决定 §4.5 是否还成立）**：判定与跳过放在**写入侧**，`formatted` 本身保持完整。这样 `baseIndex`/`linkTo` 的算术一个字都不用改（它们本来就是数"日志里可记的消息"）。若改成在 `formatSpan` 里过滤，就必须另算一个"含被撤回消息"的上界——多一个算错的入口，没有必要。

`lastLoggedSeq` 照常推进到 `task.toSeq`（[`src/index.js:406-411`](../src/index.js#L406-L411)）：水位是"日志执行器处理到哪了"，不是"库里有什么"——附录 A 的场景 2 就落在这条语义上。

### 4.3 处置二：已经落库 → 删除

判定的同一个区间里，可能已经有条目（取证案例就是），所以每条被撤回的**可记消息**都要走一次"取-删"：

```js
// 由标记的 sourceEventSeqs 或 [from, to] 得到被遮蔽的 seq 集合
for (const seq of withdrawnSeqs) {
  const event = at(seq)
  if (!isLoggableMessage(event)) continue            // 非消息（如 developer/message）从来没有条目
  const index = countLoggableMessages(session.snapshotEvents(inherited, seq))  // 与 baseIndex 同源
  const name = messageName(sessionId, index)         // msg-<session>-<index>
  const { found } = await cli.knowledgeGet(name)
  if (found) await cli.knowledgeDelete(name)
}
```

三点必须成对理解：

- **序号换算复用同一条算式**：`countLoggableMessages(snapshot(inherited, seq))` 与 [`src/index.js:373`](../src/index.js#L373) 的 `baseIndex` 完全同源，所以名字不会漂。
- **删除范围不受当前任务区间限制**：被撤回的消息早就处理过了（`seq < fromSeq`），我们靠日志前缀现算名字去找它——这就是"已落库"这条路径唯一需要的东西。
- **`knowledge-delete` 对不存在的名字退出 1**，所以必须"先 get 再删"，不能盲目删；重复执行（重放、重试）因此也是安全的。

### 4.4 摘要输入一起跳过

`buildTranscript`（[`src/consolidator.js:260-318`](../src/consolidator.js#L260-L318)）逐条读消息正文。上一版方案没管这里，结果就是最大的残留漏洞：条目清空了、输入还在，摘要里照样留着原句。把撤回区间传进去，在构造 `entries` 之前 `continue`（[:274-292](../src/consolidator.js#L274-L292)）。

水位语义不受影响，这点要写进测试：

- 被跳过的事件**不进 `entries`**，所以 `lastSeq`/`complete` 的含义不变（[:300-318](../src/consolidator.js#L300-L318)）；
- 整个 span 都被撤回时 `transcript.trim() === ''`，执行器走既有分支把 `lastConsolidatedSeq` 直接推到 `task.toSeq`（[:700-703](../src/consolidator.js#L700-L703)），**不会**卡住反复重切。

注意 `consolidate` 的 span 上界是 `min(session.seq, lastLoggedSeq)`（[:570](../src/consolidator.js#L570)、[:644](../src/consolidator.js#L644)），标记同样可能被切在外面——所以它也按 §4.1 扫 `[fromSeq, session.seq)`。

### 4.5 边、游标与摘要成员集

**写本文件时补到的一处**：上一轮只说了"跳过条目"，但图上有两处会跟着错。

1. **`belongTo` 边**（[`src/writer.js:215-234`](../src/writer.js#L215-L234)）：`writeSessionNode` 机械地按 `[linkFrom, linkTo)` 循环断边。撤回序号必须**跳过**——不写指向不存在节点的边。既有悬空边被容忍（`$not-summaried` 是对 `statement.tail` 的反连接，遍历的是存在的节点，指向不存在名字的边不影响判批），但这不代表我们应该**新增**悬空边。
2. **游标 `linkTo` 不要去改。** [`src/index.js:390`](../src/index.js#L390) 的 `linkTo = baseIndex + formatted.length` 在"`formatted` 保持完整"（§4.2）的前提下**本来就是对的**：它数的是 span 里全部可记消息，含被撤回的那些，所以游标单调推进到 span 末尾。反过来，若把它改成"最后真正写出的序号 + 1"，队尾被撤回时游标会偏低，下个 span 从更低的序号重新连边——白花 CLI 调用（`statementCreate` 幂等），而且在跳过集没同步应用时正好把上一条的悬空边又造出来。**两条必须成对做：游标按全部可记消息推进，循环里跳过撤回序号。**
3. **摘要成员集 `items`**（[`src/consolidator.js:828-834`](../src/consolidator.js#L828-L834)）：它按可记事件逐个推序号、生成 `msg-*` 名字给 `writeSummary` 断 `summary` 边。而 `writeSummary` 的契约写得很直白——"`items` 是**实际写出的**条目列表"（[`src/writer.js:153`](../src/writer.js#L153)）。所以这里也必须跳过撤回序号，否则我们等于替不存在的条目断言关系。

### 4.6 delete 通道（这是全案唯一的净增依赖）

hypatia 4.0.0 已经提供删除能力，但插件客户端还没有通道：

| 位置 | 现状 |
|---|---|
| hypatia CLI | `knowledge-delete` 子命令存在（`hypatia --help` 实测）；`knowledge-update` 也在 |
| hypatia MCP | `tools/list` 20 个工具里含 `knowledge_delete`、`knowledge_update`（本机实测） |
| 插件 CLI 客户端 | [`src/hypatia-cli.js:256-357`](../src/hypatia-cli.js#L256-L357) 只有 get/create/statementCreate/search/similar/query/listShelves |
| 插件 MCP 客户端 | [`src/hypatia-mcp.js:473-537`](../src/hypatia-mcp.js#L473-L537) 同上 |
| 转发层 | [`src/hypatia-client.js:69-83`](../src/hypatia-client.js#L69-L83) 逐方法转发，也要加一个 |

两个建议，都属于实现细节、不改变终案：

- **不要把它加进 `REQUIRED_TOOLS`**（[`src/hypatia-mcp.js:44`](../src/hypatia-mcp.js#L44)）。那是硬依赖清单，缺一个就把整个二进制判为"没有可用的 MCP"，插件会在这一轮把**所有**调用退回 CLI——代价远大于"删除不可用"。正确做法是加一条**能力探测**，与 `noEmbed`/`similarFilters` 同款（MCP 路径读 `tools/list` 的 inputSchema，`featuresOf`，[:63-72](../src/hypatia-mcp.js#L63-L72)；CLI 路径读 `--help` 文本，`probeFeatures`，[`src/hypatia-cli.js:188-207`](../src/hypatia-cli.js#L188-L207)），名字例如 `canDelete`。探测结果照既有做法记一行日志。
- **老服务端/老二进制要降级而不是失败**：没有该子命令时 CLI 退出 2（`unrecognized subcommand`）、MCP 报未知工具 → 这一轮**只跳过、不删**，并 warn 一次。撤回区间内的消息仍然不会被重新写进去（防线是区间锚定，不是删除），库里可能留一条孤儿正文——记入 §7 的已知残留，不新增失败路径。

## 5. 刻意不做的事

### 5.1 不做清单

| 不做 | 理由 |
|---|---|
| 改 `dsh-rewind-plugin`（发新事件让别家订阅） | 宿主契约已经够了；改它要发版并做版本联动，收益为零 |
| 撤回账本 / 新任务 kind / `progress` 新字段 / 作用域迁移 | 判定是纯函数，可随时从日志重算；账本只服务于"历史回扫"，而取向是只向前生效 |
| 独立撤回条目 + `belongTo` + `retracted` 标签 + `EXCLUDED_TAGS` 改动 + 技能排除清单 | 撤回区间内的消息**根本不会进库**，召回侧一行都不用动 |
| 状态面板计数 | 纯可见性装饰，要动 host/client 两侧；需要时单开一步 |
| 删除引用被删条目的 statements | 既有语义（悬挂边保留）且被明确接受；加级联会引入"按名字误删"的风险 |
| 历史回扫（给过去所有被撤回的消息补删） | 取向是只向前生效；结构上留了口子——真要做时，用同一个判定函数加一个手工触发的任务即可，设计不用改 |

### 5.2 被否决的三版与各自的死因

| 版本 | 形态 | 死因 |
|---|---|---|
| v1 | 新任务 kind `retract-messages` + 持久化撤回账本 + 独立撤回条目 + 标签通道 + 面板 | 为"完整性"造了三处状态，而问题本身只要求读一次那个区间 |
| v2 | `knowledge_update` 清空正文、保留条目做墓碑 | 删正文不可逆且仍要新增 update 通道；复杂度高于直接跳过/删除，且"留档"的价值在"不可还原"这个事实面前不成立 |
| v1/v2 共有的假设 | "回退几乎总发生在 flush 之前，跳过覆盖绝大多数情形，删除只是罕见补刀" | **被推翻**：`turn/end` 的 flush 是 `immediate: true`，用户看到回合结束后才按回退，条目大概率**已经落库**；唯一现实数据点（`session-007cef11`）反而证明"回退之后才落库"也存在。两种时序都现实存在，所以必须双路径，不能赌哪一条更常见 |

## 6. 实施顺序与验收清单

### 6.1 落地顺序

1. `collector.js`：`withdrawnRanges` + 单元测试（纯函数，无副作用，先钉住白名单）。
2. `index.js`（`log-message`）：跳过集 + `writeSessionNode` 的跳过参数（连带 §4.5 的游标断言）。
3. 客户端 delete 通道 + 能力探测（可独立先落，不接线也不会改变行为）。
4. `index.js`：已落库 → 删除分支（接线后立刻用集成测试验证）。
5. `consolidator.js`：transcript 与 `items` 两处跳过。

前两步完成即"回退之后不再产生无法辨认的记忆"；第 4、5 步补齐另一半。

### 6.2 测试

- **单元**：`withdrawnRanges` 只认白名单两个 kind 的 `user/message` + `replace`；`compact-checkpoint` 的 `user/message` + `replace` **不**命中；`model`、`user`+`producer`、`system/message` 自替换、`tool/result` 单节点替换、`append` 都不命中；没有 `sourceEventSeqs` 的标记不认（不猜区间）；同一日志重复调用结果恒等。
- **单元**：`withdrawalWork` / `withdrawnOrdinals`——本 span 与"已经落库要删"按位置分开、序号与 `baseIndex` 同源、fork 的继承前缀不占序号、非消息的被遮蔽 seq 不产生条目名。
- **单元**：`belongTo` 跳过集——撤回序号不产生边，游标仍推进到 span 末尾（断言 `lastBelongToIndex`）。
- ~~**单元**：替换副本不被记成人类消息~~——这项属于 append-origin 采集修复，**本次未做**（§7 第 8 条、§9），所以现在没有它对应测试；一旦做了，这条测试要按"`source.kind === 'user'` 且 `surfaceOp.op === 'replace'` 的事件不产生 `msg-*`"补上。
- **行为**：同一区间两种时序各一条——标记在任务区间内（未落库 → 不创建）、标记落在 `[toSeq, session.seq)` 内（已落库 → delete 被调用）。
- **行为**：同一区间跨两次 flush 重放，不重复创建、不重复删除（幂等）。
- **摘要**：撤回事件不进 transcript；全被撤回的 span 走空文本分支并把水位推到 `toSeq`；`items` 不含撤回序号。
- **契约**（沿用 `test/integration/cli-contract.test.mjs` 的做法：临时 shelf + `--shelf` 钉死）：删除真的落到 shelf；同会话其它条目不动；无 delete 能力的二进制下只跳过、不抛错。

### 6.3 硬验收条件

**一条**：compaction 的 `replace`（`source.kind === 'compact-checkpoint'`）在任何路径上都**不触发**跳过或删除。这条不通过就不能发布——它是"删错数据"与"删掉该删的"之间唯一的隔板（§2.2）。

## 7. 已知残留与边界

1. **回退前已写出的摘要可能仍含被撤回内容。** 摘要一旦写出就没有重写路径（`writeSummary` 按名幂等，hypatia 侧也没有"重写摘要"的操作），我们能保证的只是原始条目已删/未写。这是"只向前生效"的必然代价——诚实的做法是说清楚，而不是假装摘要也干净了。
2. **删除不可逆。** 正文删除后在 hypatia 侧永远拿不回来；取证只能回到会话日志与 `/export`（回退插件明确保证导出含已撤回消息）。
3. **删除通道不可用时**（老二进制/老服务端）会留下孤儿正文：它不会被再次写入，但**它仍在库里**——`msg-*` 本来就不进向量索引（`embed: false`），可全文检索仍能找到它（既有的 `--exclude-tags message` 之类过滤照旧有效）。这是降级路径上唯一真正的代价，所以要 warn 一次，不要静默。
4. **重启对账的交互**（写文档时发现）：`reconcileProgress` 只看该会话是否还有 `msg-*`（[`src/housekeeping.js:70-76`](../src/housekeeping.js#L70-L76)），把"一条都没有"当作"shelf 被清空"的正面证据。若一次回退让某个会话一条 `msg-*` 都不剩（极罕见），它的 progress 行会在重启后被重置，于是重新记一遍日志（仍会被判定跳过）并重新 consolidation（新摘要名 + 一次模型调用）。行为自洽、代价有界，但要知道它存在；要根治得让 reconcile 把"日志前缀里全是被撤回的消息"视为已验证为空，那需要给它 session/日志访问，超出本次范围。
5. **水位不回落。** 撤回区间一旦落到水位之前就永不重读——"被撤回的条目已不在库里"是终态，不存在"撤销回退后记忆自动回来"的路径（因为对话层本来也不可还原）。
6. **fork / 继承前缀**：判定按 `[max(fromSeq, inheritedEventCount), session.seq)` 读，与既有钳制一致（[`src/index.js:372-373`](../src/index.js#L372-L373)）；父会话的撤回不会波及子会话已继承的前缀（子会话的日志里没有那条标记，这是继承语义本身的边界，不是本次引入的）。
7. **覆盖范围是两个包（口径见 §2.4）。** 已实现：`dsh-rewind-plugin` 与 `plugin:rollback`（`@domitor-syh/dsh-rollback` 与 `@nianchu/dsh-rollback` 代码同源，一条判据覆盖两个包）。其余写 replace 的包不予兼容：`dsh-retrace` 的 `model` 与 `dsh-message-recall` 的 `user`+`producer` 属识别字段不可靠或用量低；用量更高的 fork 类插件本就不需要。加新成员按 §2.4 第 5 条走（语义 + citation 精确性两项都要核）。
8. **替换副本会被现有采集逻辑记一条。** `dsh-message-recall` 的墓碑（`kind: 'user'` + replace）今天就会被写成 `msg-*`；按 §2.3 末的 append-origin 判据修掉即可，它与撤回处理相互独立，可以单独先落。

9. **跨 compaction checkpoint 的回退会少删。** 标记列的是它遮蔽的 surface 节点；若切片里夹着一条 compaction checkpoint，被它折叠进摘要的那些原始消息**不在列表里**（列的是 checkpoint 自己的 seq，而它不是可记消息），于是留在记忆里。方向是安全的（少删而非错删），要根治得让判定认识 checkpoint 与它折叠的 seq 的关系——那等于引入 surface 折叠语义，与 §2.2 第三个硬条件的取向冲突，因此不做。
10. **标记晚于会话最后一次 flush。** 回退若发生在会话关闭之后（最后一次 `log-message` 已经推进过水位），就没有任务会再扫到那条标记，被撤回的消息留在库里。这是"只向前生效、且只在线扫描"的固有边界——与不做历史回扫是同一条取向。
11. **`belongTo` 悬空边在一种交错下仍可能出现。** `log-message` 的跳过集只覆盖"标记还在它扫描窗口内"的那些序号；若某会话的 `lastBelongToIndex` 落后于 `baseIndex`（`session-node` 与 `log-message` 交错时理论上可能），更早被撤回的序号仍可能连出一条边。悬空边是既有语义明确接受的（§3 事实 3），所以不为此加状态或加锁；真要做只能给游标加一份"已处理撤回"的持久记录，而那正是终案否掉的那台机器。

## 8. 证据索引

| 事实 | 出处 | 复核方式 |
|---|---|---|
| 回退只追加标记、从不删改 | `dsh-rewind-plugin` README:15、`:64`、`:104`、`:111`、`:113`；`lib/index.js:2614-2618` | 读源码 + 会话日志实证 |
| 标记字段与正文 | `lib/index.js:132-133`、`:2481-2487`、`:225-233` | 读源码 |
| 真实标记样本 | `session-007cef11` 日志 seq 389：`source.kind=dsh-rewind`、`sourceEventSeqs=[365,367]`、`surfaceOp={op:replace,startSeq:365,endSeq:367}` | 解压会话日志逐字核对 |
| `SurfaceOp` 契约与顺序保证 | `packages/core/session/src/types.ts:449-465`；`packages/core/session/src/surface.ts:410-419`、`:102-108` | 读宿主源码 |
| compaction 的 checkpoint 也是 `user/message` + `replace` | `packages/compaction/compaction-basic/src/region.ts:506-509`；`packages/compaction/compaction/src/checkpoint.ts:22-41` | 读宿主源码（**本次新补**） |
| 另两个 replace 生产者 | `packages/compaction/compaction-tool-result-pruner/src/index.ts:169`；`packages/core/agent-loop/src/runtime-context.ts:108` | 读宿主源码 + 会话日志 seq 395/396 |
| 采集不看 surface；序号按前缀数 | [`src/collector.js:106-137`](../src/collector.js#L106-L137)、[`:231`](../src/collector.js#L231)、[`:364`](../src/collector.js#L364) | 读本仓库源码 |
| `turn/end` flush 是 immediate | [`src/collector.js:330`](../src/collector.js#L330)；[`src/queue.js:311-332`](../src/queue.js#L311-L332) | 读本仓库源码 |
| 写入按名幂等、从不重写 | [`src/writer.js:133-143`](../src/writer.js#L133-L143) | 读本仓库源码 |
| 摘要水位与 transcript | [`src/consolidator.js:570`](../src/consolidator.js#L570)、[`:644`](../src/consolidator.js#L644)、[`:274-292`](../src/consolidator.js#L274-L292)、[`:700-703`](../src/consolidator.js#L700-L703) | 读本仓库源码 |
| `items` 是"实际写出的条目" | [`src/writer.js:145-193`](../src/writer.js#L145-L193) | 读本仓库源码 |
| 取证：两条同问题消息都在回退后落库 | shelf `msg-…-3`（01:12:28.555）、`msg-…-4`（01:12:28.566）；标记时间 01:09:31.605Z | 查 shelf + 解压日志 |
| delete 能力已存在 | `hypatia --help`；`hypatia mcp` 的 `tools/list` | 本机实测 |
| delete 不级联删 statements（悬挂边被接受） | 记忆条目 `wu-knowledge-delete-retains-statements-7487bf50` | 检索既有决策 |
| 重启对账只看 `msg-*` 是否存在 | [`src/housekeeping.js:44-76`](../src/housekeeping.js#L44-L76) | 读本仓库源码（**本次新补**） |
| 同类插件的 replace 生产者实况（13 包代码审计） | `dsh-retrace` `lib/marker-carrier.js:62,66`；`dsh-message-recall` `lib/main.js:216,217,226`；`@domitor-syh/dsh-rollback` `lib/index.js:964`；`@nianchu/dsh-rollback` `lib/index.js:1465`；`dsh-clear-mind` `dist/src/collapse.js:183`、`dist/src/commit.js:279` | `npm view <pkg> dist.tarball` + 解包 grep；关键四条逐条复核 |
| 人类转写只取 append-origin 事件 | `packages/core/session/src/surface.ts:89-102` | 读宿主源码（**本次新补**） |

## 9. 实现状态（2026-10-14）

本文已按终案落地，**未提交、未发版**。

| 落点 | 内容 |
|---|---|
| [`src/collector.js`](../src/collector.js) | `WITHDRAWAL_SOURCE_KINDS`（`dsh-rewind`、`plugin:rollback`）、`withdrawnRanges` / `withdrawnSeqs`（判定）、`withdrawalWork`（判定 + 两种处置的分流）、`withdrawnOrdinals`（撤回 seq → 条目序号，与 `baseIndex` 同源）——四个都是不碰 session 的纯函数 |
| [`src/index.js`](../src/index.js) | `log-message`：调一次 `withdrawalWork`（标记窗口到 `session.seq`），区间内跳过、区间外按序号 `retractMessage`，两个集合合并成 `belongTo` 的跳过集；`session-node`：取一次日志、两遍扫出跳过集 |
| [`src/writer.js`](../src/writer.js) | `writeMessage({withdrawn})`、`retractMessage`（get-before-delete）、`writeSessionNode({skip})`；无删除能力时 warn 一次并降级为"只跳过" |
| [`src/consolidator.js`](../src/consolidator.js) | `buildTranscript` 跳过撤回事件；摘要 `items` 不含撤回序号 |
| [`src/hypatia-cli.js`](../src/hypatia-cli.js) / [`src/hypatia-mcp.js`](../src/hypatia-mcp.js) / [`src/hypatia-client.js`](../src/hypatia-client.js) | `knowledgeDelete` 两条传输 + `deleteKnowledge` 能力探测（**不在** `REQUIRED_TOOLS` 里） |

两个已定的实现选择：**① 修订行为默认开启、不加设置**；**② §2.3 末的 append-origin 采集修复本次不做**——所以 `dsh-message-recall` 的墓碑仍会被记成一条 `[已撤回]` 的 `msg-*`（§7 第 8 条仍然有效）。

测试落点：`test/collector-withdrawn.test.mjs`（判定、citation 精确性、`withdrawalWork` 的分流与序号、fork 前缀）、`test/writer.test.mjs`（跳过 / 删除 / 降级 / 跳过边）、`test/consolidator.test.mjs`（transcript 与 `items`）、`test/hypatia-cli.test.mjs` 与 `test/hypatia-mcp.test.mjs`（delete 语义与能力探测）、`test/integration/mcp-contract.test.mjs`（真实 hypatia 上两条传输的删除契约）。三个门都过：`npm test` 486 项、`npm run test:integration` 26 项、`npm run typecheck`。

**覆盖边界的处理（复核后收紧）**：`index.js` 的接线原本完全没有测试，现在它只剩"取两段日志、调 `withdrawalWork`、照结果跳过与删除"——判定、分流、序号换算全部搬进了 [`src/collector.js`](../src/collector.js) 的纯函数并有单测。仍然没有插件级 harness（`apply` 里的 executor 需要真实 cordis 服务），所以 `index.js` 里剩下的是取数与转发，不再有算术。

## 附录 A：两个时序场景

用户提出的两个场景**都成立**，且它们恰好是终案为什么必须是双路径的原因。

**场景 1：回退发生时，回退前的条目已经落库。**
→ 删（§4.3）。同一次执行里删掉；续写不得复活——防线是区间锚定（判定扫到 `session.seq`，标记必然在切片内），比删除本身更重要。`belongTo` 边按跳过集处理（§4.5）。

**场景 2：回退发生时条目还没落库，但水位已经上涨。**
→ **什么都不做**。水位语义是"日志执行器处理到哪了"，不是"库里有什么"，所以"水位过了这条消息、但它没被写入"完全合法。不要回退水位（那会打乱已连好的游标并重放整段）；序号空位永久保留（事实 2）；唯一的义务是"别复活"——跳过必须锚定在**区间**上，不能锚定在"条目当前是否存在"上。

**被推翻的那个假设**：早期版本断言"回退几乎总在 flush 之前，所以跳过覆盖绝大多数情形"。不成立（§5.2）。**复核补充**：场景②（任务区间整体位于标记之后）是空集，不必论证；需要防的只有"标记落在 `[toSeq, session.seq)`"这一种。

## 附录 B：与既有记忆治理原则的关系

已有的裁决原则是"保留旧知识和来源历史、不让少量向量候选决定哪条记忆失效"（记忆条目 `kb-memory-lifecycle-reconciliation`；同主题的 `wu-收回语义关系与lifecycle裁决权-0363a168`）。本方案的边界如下：

- 我们删的不是"过期知识"，而是**原始证据**（会话日志里的消息副本）；语义裁决、摘要、工作单元都不在删除范围内；
- 决策方是**人**（用户按了回退按钮），不是模型根据向量候选自行判断——本方案没有给模型新增任何"决定哪条记忆失效"的能力；
- 删除留下的悬挂边保留不动，与既有 `knowledge-delete` 语义一致（`wu-knowledge-delete-retains-statements-7487bf50`）；
- 反向的不变式也守住：撤回**不会被悄悄忘记**——真相在会话日志里，`/export` 仍在，随时可审计。区别只在于"长期记忆"这一层不再把它当成真实历史。
