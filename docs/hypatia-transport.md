# hypatia 传输层：私有 MCP 连接的设计与取舍

> **给谁看**：本插件的后续维护者。动手改 collector、writer、cascade、recall 这些组件，或设置卡片之前，先读 §1（四条路径）和 §7（维护须知）。
>
> **事实基线**：版本 2.3.0（tag 指向 `4bb2a69`）；文中每个行号都在 2026-10-12 于 `9cf4dc1` 上逐条复核。MCP 传输由 commit `8bdefbe` 引入——它的提交信息是 §3.1–§3.3 的主要书证。
>
> **相关代码**：[`src/hypatia-mcp.js`](../src/hypatia-mcp.js)（私有连接本身）、[`src/hypatia-client.js`](../src/hypatia-client.js)（传输选择与 CLI 降级）、[`src/hypatia-cli.js`](../src/hypatia-cli.js)（argv 路径）、[`src/config.js`](../src/config.js)（`transport` 设置）、[`src/auto-approve.js`](../src/auto-approve.js)（放行 Agent 自己的调用）。行为契约由 [`test/hypatia-mcp.test.mjs`](../test/hypatia-mcp.test.mjs) 与 [`test/integration/mcp-contract.test.mjs`](../test/integration/mcp-contract.test.mjs)（对真实 `hypatia mcp`）钉住。

本文回答一个反复被问到的问题：**这个插件用不用 hypatia 的 MCP？**

答案取决于"用"指什么。它**用了 MCP 协议**——自己 spawn `hypatia mcp`，在 DSH 的 `subprocess` service 上走 stdio JSON-RPC；但它**没有**把自己注册进 DSH 的 MCP 机制（即一条 `@deepseek-ai/dsh-mcp-client` 条目）。这两件事常被混为一谈，所以下面先把实际存在的四条调用路径分开（§1），再写清私有连接的行为契约（§2），不注册的四条硬理由与两条结论（§3）、代价（§4）和排障（§5）。如果你确实想让模型看见这些工具，做法在 §6，只是先读完代价。

一个阅读提示：**§3.5 和 §3.6 是结论**，只有代码与提交信息支撑，没有书面论证；其余结论都有源码或上游文档可查，证据汇总在 §8。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 用 MCP 协议吗？ | **用**。`transport` 默认 `mcp`（[`src/config.js:29`](../src/config.js#L29)），插件自己持有 `hypatia mcp` 进程，stdio JSON-RPC，协议版本 `2025-06-18`（[`src/hypatia-mcp.js:33`](../src/hypatia-mcp.js#L33)） |
| 用 DSH 的 MCP 机制吗？ | **不用**。它不是 `@deepseek-ai/dsh-mcp-client` 条目，模型看不到这些工具，插件调用也不经过工具策略、hook 或审批（[`src/hypatia-mcp.js:5-8`](../src/hypatia-mcp.js#L5-L8)） |
| 那模型怎么用 hypatia？ | 走 Agent 自己的 bash `hypatia …`（CLI），由本插件的 autoApprove 放行 |
| 能改成注册进 DSH 吗？ | 能，自己加一条 client entry 即可；但它与插件并存时会操作同一个 shelf（见 §6） |

> 术语约定：下文"**DSH 的 MCP 机制**"专指 `@deepseek-ai/dsh-mcp-client` 这个 Cordis 插件；"**私有 MCP 连接**"指本插件自己持有的 `hypatia mcp` 子进程。

## 1. 四条调用路径，先分清

谈"用不用 MCP"之前必须先把路径分开：它们由不同主体发起，规则也完全不同，混在一起谈必然说不清。

| # | 路径 | 谁发起 | 传输 | 过审批？ |
|---|---|---|---|---|
| 1 | 插件的写入与后台检索 | 插件（collector → queue → writer / cascade / recall） | 私有 `hypatia mcp`（默认） | **不过**：链路上没有 shell、没有工具调用，也就没有可审批的对象 |
| 2 | 同上，MCP 不可用时 | 插件 | 每次调用一条 `hypatia` 命令，argv 数组 | **不过** |
| 3 | Agent 的检索与显式记忆 | 模型（bash 工具） | `hypatia` CLI | **过**，由 autoApprove 窄匹配放行 |
| 4 | 设置卡片的 shelf 清单 | 插件 | **始终** `hypatia list`（CLI） | 不过 |

路径 1、2 是插件给自己的。它们共用**同一个客户端实例**（[`src/index.js:239`](../src/index.js#L239)）：writer、cascade 和 recall，Memory 标签页的查询都由它发出。所以 `transport` 是一个全局选择，不是逐调用的选择——想验证某次调用走了哪条路，只能看日志（§5 末行）。

路径 3 是给模型的，走的是另一条通道。**同一个 shelf，两条互不知道的通道**：插件不知道模型写了什么，模型也不知道插件刚刚写了什么。README 开头那句"没有 shell、没有工具调用、没有沙箱提权、没有审批弹窗"（[`README.zh-CN.md:18-19`](../README.zh-CN.md#L18-L19)）说的正是路径 1、2。

路径 4 为什么必须例外：`hypatia mcp` 只在启动时读一次 shelf registry，运行期间才连接的 shelf 会一直缺席设置卡片，而这份清单的全部意义就是发现这种变化（[`src/hypatia-client.js:10-13`](../src/hypatia-client.js#L10-L13)、[`:78`](../src/hypatia-client.js#L78)）。

## 2. 私有连接的行为契约

下面每条都是"换了传输就不可能自动一致"的性质。分四组看。

### 2.1 进程与并发

- **一个进程，按需启动，串行应答。** `hypatia mcp` 本来就一次只应答一个请求，所以插件侧也把调用排成一条链——这样一次调用的超时衡量的是它自己，而不是排在它前面的那些（[`src/hypatia-mcp.js:10-12`](../src/hypatia-mcp.js#L10-L12)）。
- **超时**：单次调用 30 s（[:35](../src/hypatia-mcp.js#L35)），握手 10 s（[:37](../src/hypatia-mcp.js#L37)）。
- **关闭**：先关 stdin（EOF 结束 `hypatia mcp` 的读循环），3 s 后 `terminate()` 兜底（[:151](../src/hypatia-mcp.js#L151)）。
- **空闲 60 s 后关闭进程**（[:39](../src/hypatia-mcp.js#L39)）。两条原因都出自 hypatia 自身的实现：语义调用之后嵌入模型的分配一直留着（插件源码注记为数百 MB 量级），而注册表、`shelf.toml` 与模型可用性都只在启动时读一次（hypatia `docs/agent-interfaces.md` §3「配置只读一次」）。
- **两个例外动作。** 收到 `shelf '<name>' is not connected` 时重置连接，好让重试时发现期间新连接的 shelf（[:433-435](../src/hypatia-mcp.js#L433-L435)）；插件 dispose 时，先让在飞任务排空（受 queue 期限约束），再关连接（[`src/index.js:248-250`](../src/index.js#L248-L250)）。

### 2.2 能力探测

- **硬依赖只有 6 个工具**：`knowledge_get`、`knowledge_create`、`statement_create`、`search`、`similar`、`query`；缺任何一个就判定这个二进制提供不了可用的 MCP（[`src/hypatia-mcp.js:44-51`](../src/hypatia-mcp.js#L44-L51)）。
- **可选能力不从版本号猜。** MCP 路径读 `tools/list` 里对应 inputSchema 的 properties——`knowledge_create` / `statement_create` 的 `embed`、`similar` 的 `exclude_tags`（[:63-72](../src/hypatia-mcp.js#L63-L72)）；CLI 路径改读 `--help` 的文本（[`src/hypatia-cli.js:175-207`](../src/hypatia-cli.js#L175-L207)）。必须先问再试是有具体原因的，每个工具都声明 `additionalProperties: false`，服务端不认识的参数会直接校验失败，而不是被忽略。
- **探测结果记一行日志**，所以 profile 日志里能看出这一轮写入带不带这些标志（[`src/hypatia-client.js:57-67`](../src/hypatia-client.js#L57-L67)）。

### 2.3 两种传输必须产出同样的条目

- 结果被映射到 CLI 客户端的同一套接口上，所以 writer、cascade、recall、housekeeping 都不知道实际是谁在跑（[`src/hypatia-mcp.js:19-20`](../src/hypatia-mcp.js#L19-L20)）。
- 内容以 JSON 传，不再是单个 argv 元素，因此不再被 96 KiB 的命令行上限截断（[`src/hypatia-cli.js:29-31`](../src/hypatia-cli.js#L29-L31)）。
- tags / scopes 仍按 CLI 的规则处理：逗号切分、去空白，丢掉空项，并且**结尾逗号表示追加全局 scope `""`**（[`src/hypatia-mcp.js:385-403`](../src/hypatia-mcp.js#L385-L403)）。这一步必须在插件侧补：`hypatia mcp` 服务端不会自己切分列表、也不读结尾逗号，缺了它，同一份数据会因为传输不同而存成两样，scope 查询也会跨传输失配。
- 一个编码细节：孤立的 UTF-16 代理对（`.slice()` 切过 emoji 就会留下）会被 `JSON.stringify` 写成裸 `\ud83d` 转义，hypatia 的 JSON 解析器会拒绝，整个请求随之失败。CLI 路径碰不到这个问题，因为 Node 会把 argv 编成 UTF-8，坏字符在那里变成 U+FFFD。MCP 路径用 `toWellFormed()` 做同样的替换（[:74-83](../src/hypatia-mcp.js#L74-L83)）。

### 2.4 失败语义

- **`MCP_UNAVAILABLE`**（二进制没有 `mcp` 子命令、缺必需工具，或握手答不出 `initialize` / `tools/list`）→ 整轮降级到 CLI，只警告一次，profile 重载后重新尝试 MCP；排在它后面的调用会拿到 `MCP_CLOSED`，同样转 CLI（[`src/hypatia-client.js:37-55`](../src/hypatia-client.js#L37-L55)）。
- **其它失败**（一次启动超时、一次崩溃）只属于那一次调用，并向上抛——一个完全起不来的二进制走 CLI 也一样失败，而偶发的启动失败未必重演（[`src/hypatia-mcp.js:86-97`](../src/hypatia-mcp.js#L86-L97)）。

## 3. 为什么不用 DSH 的 MCP 机制

3.1–3.4 有源码或上游文档支撑，3.5–3.6 是结论。

### 3.1 与插件的前提正面冲突（设计层面，有据）

这个插件存在的前提是：**让模型自己决定何时写记忆，等于不写记忆**。`dsh-hypatia` 把写入留给 Agent，实际结果是"模型加载了协议，却在十五个会话中只有一个会话主动执行了 `hypatia` 命令，而且是被直接要求才执行的"（[`README.zh-CN.md:14-16`](../README.zh-CN.md#L14-L16)、bundled skill 里同样的前提见 [`skills/hypatia-memory/SKILL.md:220-222`](../skills/hypatia-memory/SKILL.md#L220-L222)）；而本插件的分工是"写入全自动、读取由 Agent 负责"（[`README.zh-CN.md:10-12`](../README.zh-CN.md#L10-L12)、[`skills/hypatia-memory/SKILL.md:10-11`](../skills/hypatia-memory/SKILL.md#L10-L11)）。

而 `dsh-mcp-client` 注册出来的东西是**模型面向的工具**：命名 `mcp__<serverName>__<rawName>`，客户端 `inject: ['tools']`，`serverName` 在一个注册作用域内还必须唯一（DSH 上游 `docs/config-catalog.md:2028-2030`）。走这条路，等于把"何时写记忆"的决策权交回模型——正是本插件要消除的失败模式。

### 3.2 后台写入没有 agent 上下文（有据）

collector 订阅的是 DSH 原生事件 `session/event`，在后台跑（[`src/collector.js:370`](../src/collector.js#L370)、[`src/index.js:315`](../src/index.js#L315)），不伴随任何模型回合。注册进 harness 工具 registry 的模型面向工具，是给 agent 侧调用的；插件的写入链路（collector → queue → writer）没有 agent 可借。

所以问题不是"能不能自动批准"，这条路径**根本不在工具调用的世界里**。

### 3.3 审批链路会掐死无人值守写入（有据）

DSH 对 MCP 服务器的描述很明确：

> Each configured server contributes ordinary harness tools with cancellation, **permission checks**, **recorded results**…（DSH 上游 `docs/subsystems/mcp.md:7`）

插件每次写入都要过审批——每个日志 span 一次落库（span 在回合边界切分，每条消息一条 `msg-*` 条目），外加每次固化——而后台没人点按钮。对照 autoApprove 的取向更能看出方向：它只放行 **Agent 自己的纯 `hypatia` bash 调用**，判据极窄——可执行词必须是受信 basename，且引号外不含 `& ; | < > \` \n $(`。理由写在源码注释里："一个会 pipe、redirect、chain 或 substitute 的命令，就是一个能做别的事而不只是跟 hypatia 说话的命令"（[`src/auto-approve.js:11-14`](../src/auto-approve.js#L11-L14)、[`:84-88`](../src/auto-approve.js#L84-L88)）。为后台写入申请一个更宽的授权，方向正好相反。

顺带一提：`recorded results` 意味着每次后台写入都会落进会话记录与工具台账——插件在后台做的事会开始出现在会话历史里。

### 3.4 工具面污染与命名冲突（实测 + 文档）

实测 `hypatia 4.0.0` 的 `hypatia mcp`，`tools/list` 返回 **20 个工具**（清单见附录 A）。全塞进每个会话的工具列表，一是白烧 token，二是主动诱导模型自己去写记忆，于是和后台写入器重复落库。另外 `serverName` 要求 `[A-Za-z0-9_-]{1,32}` 且在一个注册作用域内唯一——而用户很可能已经自己配过一个 hypatia 服务器。

### 3.5 配置所有权（结论，未见书面论证）

配置一个 MCP 服务器，需要用户在**目标 Cordis scope** 里手写一条 `@deepseek-ai/dsh-mcp-client` entry，而 DSH 文档写明："Callers with no visible configured server receive no MCP prompt text or tools in native or PTC mode."——看不见已配置服务器的调用者，既拿不到 MCP 提示文本也拿不到工具（DSH 上游 `docs/subsystems/mcp.md:24`）。也就是说，写入通道会从"插件自带、装好即用"变成"依赖用户是否配对，配错 scope 就静默失效"。

### 3.6 反过来说，注册能带来什么（结论）

只有一样东西是私有连接拿不到的：**模型可以直接调用这 20 个工具**。而这恰好是 3.1–3.4 要避免的。除此之外，MCP 协议本身的好处一条没丢（见 §2）——所以准确的说法是"用了 MCP 协议，没用 DSH 的 MCP 注册机制"，不是"没用 MCP"。

## 4. 代价（是取舍，不是白拿）

| 代价 | 说明 |
|---|---|
| **插件侧串行** | 一个进程一次只答一个请求，插件侧的调用同样排在一条链上，所以每个调用都要等它前面那个跑完。最坏的情况是前一个调用正卡在 `similar` 重载嵌入模型，或一次写入正在偿还逾期的嵌入债务——**会话启动时的 rules / taboos 预载也在同一条链上**。CLI 路径没有这条链（每次调用各自起进程），并发只受 `queue.concurrency` 约束（默认 1，上限 8；[`src/config.js:75`](../src/config.js#L75)、[`:184`](../src/config.js#L184)），而它本来就是跨会话上限、单会话内部按序——所以默认配置下两种传输差别很小，这条代价只在调大 `concurrency` 之后才真正显现 |
| **内存** | 语义调用后嵌入模型常驻（数百 MB），靠 60 s 空闲关闭进程回收 |
| **新鲜度** | registry 只在启动时读，新连接的 shelf 要等进程重启或重置才可见，所以 shelf 清单退回 CLI |
| **超时即杀** | 单次调用超过 30 s 就杀掉进程，下一次调用另起一个 |

## 5. 故障排查对照

| 现象 | 含义与处置 |
|---|---|
| 警告 `hypatia mcp unavailable: …; using the hypatia CLI until the profile reloads` | 二进制早于 `hypatia mcp`（消息会引用它的 `unrecognized subcommand`）、缺本插件调用的某个工具，或握手返回错误。一切继续走 CLI；升级 hypatia 并重载 profile 才能用上 MCP |
| 每次调用都失败 `hypatia mcp exited …` 或 `timed out` | 二进制能启动但它的 MCP server 起不来。`binaries` 里一个改了 clap 退出码或措辞的包装脚本不会被识别为旧二进制。设 `transport: cli` |
| 设置卡片里看不到刚连接的 shelf | 预期行为：清单走 `hypatia list`；若某次调用报 `is not connected`，连接会重置 |
| 想知道这一轮到底走哪条 | profile 日志有 `writing to shelf "…" (transport: …)`（[`src/index.js:255`](../src/index.js#L255)）与 `hypatia over mcp\|cli: no-embed …, similar filters …`（[`src/hypatia-client.js:64`](../src/hypatia-client.js#L64)） |

（前两行同 [`README.zh-CN.md:511-512`](../README.zh-CN.md#L511-L512)。）

## 6. 如果你确实想让模型看见 hypatia 工具

两者不冲突：你自己加一条 client entry 就行，大致形如

```yaml
# 示意：形状取自 DSH 上游 packages/mcp/mcp-client/README.zh.md「最小配置」，
# 未在本仓库验证
- id: mcp-hypatia
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: hypatia
    transport: stdio
    command: hypatia
    args: ['mcp']
```

模型随即拿到 `mcp__hypatia__<tool>` 这一组工具。但请先看清代价：

- 它与插件操作**同一个 shelf**。模型的手写记忆和后台的自动记忆会并存；而插件的写入器靠"先 get 再 create"按**条目名**判重（[`src/writer.js`](../src/writer.js)），模型用别的名字写同一件事，它认不出来。
- 这些调用会过审批、会进会话记录，权限规则的 key 也是这组 `mcp__hypatia__*` 工具名。
- stdio 协商会先起一个临时探测进程、再起实际服务进程（DSH 上游 `packages/mcp/mcp-client/README.zh.md:28`），正好是插件自己那条私有连接（一个进程，按需启动）的对立面。
- 本插件不需要这个配置才工作。不要为了"让模型能检索"而加它——那条路已经由路径 3（bash + autoApprove）覆盖，成本低得多。

## 7. 维护须知：改传输层时要一起改的地方

- **新增插件要调用的工具**：硬依赖加进 `REQUIRED_TOOLS`，可选参数加进 `featuresOf`（[`src/hypatia-mcp.js:44-72`](../src/hypatia-mcp.js#L44-L72)），并在 [`src/hypatia-cli.js:175-207`](../src/hypatia-cli.js#L175-L207) 的 `--help` 探测里给出对应说法——否则两种传输的能力面会分叉。
- **新增一次调用**：MCP 与 CLI 两条路径都要实现，接口在 [`src/hypatia-client.js`](../src/hypatia-client.js) 收口。调用方（writer、cascade、recall、housekeeping、memory-api）不应知道传输。
- **传列表**（tags、scopes）：必须走 `asCliList`，别直接把数组交给服务端（§2.3 第三条）。
- **shelf 清单**：留在 CLI，别顺手挪到 MCP。
- **不要**为了"统一"把这条连接改注册成 `dsh-mcp-client` 条目。理由见 §3，而且那会让模型的写入与后台写入器在同一 shelf 上重复落库。
- **改完跑测试**：`npm test`（含 [`test/hypatia-mcp.test.mjs`](../test/hypatia-mcp.test.mjs)，用假 server 钉住契约）与 `npm run test:integration`（对真实 `hypatia mcp` 和真实 CLI 各跑一遍，用一次性 shelf）。这两组测试都会在你改变行为时失败，它们是本文件最可靠的对照。

## 8. 证据索引

**本仓库**

- [`src/hypatia-mcp.js`](../src/hypatia-mcp.js) —— 私有连接的实现（进程、串行、超时、能力探测、结果映射）
- [`src/hypatia-client.js`](../src/hypatia-client.js) —— 传输选择与 CLI 降级
- [`src/hypatia-cli.js`](../src/hypatia-cli.js) —— argv 路径、`--help` 能力探测、96 KiB 上限
- [`src/config.js:29`](../src/config.js#L29) —— `transport` 默认值与 schema（`z.union(['mcp','cli'])`）
- [`src/auto-approve.js`](../src/auto-approve.js) —— Agent 自身调用的窄匹配放行
- [`README.zh-CN.md:150-170`](../README.zh-CN.md#L150-L170) —— 传输章节（面向用户的行为描述）
- commit `8bdefbe` —— 引入 MCP 传输；提交信息是 §3.1–§3.3 的主要书证

**DSH 上游（deepseek-harness）**

- `docs/subsystems/mcp.md:7` —— MCP 服务器贡献的是普通 harness 工具，带权限检查与结果记录
- `docs/subsystems/mcp.md:24` —— 每个服务器一条 client entry，按 Cordis scope 配置；无可见服务器则无工具
- `docs/config-catalog.md:2028-2030` —— `mcp__<serverName>__<rawName>` 命名与 `serverName` 的唯一性要求
- `packages/mcp/mcp-client/README.zh.md`「最小配置」一节（`:30-46`）—— §6 的配置形状取自此处；`:28` 说明 stdio 协商会先起一个临时探测进程

**实测**

- 2026-10-12 复核：`hypatia 4.0.0`（`~/.local/bin/hypatia`）；`hypatia mcp --help` 存在 → 当前环境走 MCP，而非 CLI 降级
- 同次复核：`initialize` 回应 `protocolVersion: 2025-06-18`，`tools/list` 返回 20 个工具（见附录 A）

## 附录 A：实测 `hypatia mcp` 工具清单（20 个）

```
list_shelves, shelf_status, query, search, similar, session_current,
scope_list, scope_exists, tag_list, tag_exists, knowledge_create,
knowledge_get, knowledge_update, knowledge_delete, statement_create,
statement_delete, archive_store, archive_get, archive_list, backfill
```

插件只调用其中 6 个，也就是 §2.2 列的必需项；其余 14 个它从不发出。此外，只有 2 项可选参数能力（`knowledge_create` / `statement_create` 的 `embed`、`similar` 的 `exclude_tags`）会在握手时通过 schema 探测，用来决定写入时带不带对应标志。
