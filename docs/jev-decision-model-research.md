# Jev/Laya 决策模型在 dsh-hypatia-auto-memory 中的调研与实验结论

> 调研日期：2026-09-23～24　·　实验脚本见 `docs/jev-decision-model-research-scripts/`

## 1. 背景与问题

**目标**：评估能否用「决策模型」（Jev / Laya）替代或辅助 LLM 分析 session 内容，从而节省 LLM token。

**数据来源**：

- Flowtivity 文章《[Laya: open-source Jev alternative](https://flowtivity.ai/blog/laya-open-source-jev-alternative/)》
- Vercel AI Gateway 官方文档（Jev evaluation API）

## 2. 决策模型是什么：Jev vs Laya

两者都是 **System 1 决策引擎**（非自回归）：输入 `state` + 一组 typed questions，输出 `choice / score / boolean` 三种**带概率的答案**，**不生成文本**。

| 维度 | Jev（TypeSafe AI） | Laya（Convai） |
|---|---|---|
| 许可 | 闭源、waitlist API、无权重 | Apache 2.0、完整 safetensors |
| 接入 | Vercel AI Gateway `/v1/evaluate` | 本地 Python sidecar |
| 成本 | $0.042 / 1M 输入 token | $0（自托管，需 GPU） |
| 零样本精度 | 未公开（实测见下） | typed-decisions 0.362 |
| 微调精度 | 不可微调 | 0.766（Kaggle 4h / 几千条标注） |
| 上下文 | 64k token（state 32k） | 512 / 1024 token |
| 选项数 | 最多 255 | 超过 20 退化 |

**核心约束**：两者都无法生成文本，因此**不能替代**摘要、工作单元正文、cascade 归档等任何生成任务。只能做"该不该 / 是不是 / 选哪个"的**有界决策**。

## 3. 全链路决策节点梳理

| 节点 | 现在做法 | Jev 适配度 | 结论 |
|---|---|---|---|
| 关系裁决 `adjudicate`（verdict+target） | LLM 6 选 1 + 选目标 | ❌ | 实测不可靠 |
| 工作单元分类 | LLM 顺带生成 | ⚠️ | 缺"过程"上下文，弱 |
| **memoryWorthy 门控** | 无 | ✅ | 实测可靠 |
| **topic-shift 检测** | 阈值硬切 | ✅ | 实测可用但温和 |
| 自动批准（auto-approve.js） | 确定性 allowlist | ❌ | 确定性更对，Jev 加风险 |
| 脱敏（redactSecrets） | 正则已知形状 | ⚠️ | 高风险低收益 |
| 召回相关性 | 向量 + 关键词 | ❌ | 决策模型不擅长 |
| hypatia-dream 分诊 | agent 全量读图 | ⚠️ | 粗门可用，价值未证 |

## 4. 实验过程与结果

### 4.1 接入方式（重要更正）

Jev **不是聊天模型**，不走 `/v1/chat/completions`。正确接口：

```
POST https://ai-gateway.vercel.sh/v1/evaluate
Authorization: Bearer $AI_GATEWAY_API_KEY
{ "model": "typesafe-ai/jev", "state": "...", "questions": { ... } }
```

三种 question 类型：`boolean`（P(true)）、`choice`（choice + probabilities + confidence）、`score`（score + probabilities + confidence）。

实测：端到端延迟 **~200–300ms**；918 input token → **$0.00004** 量级。对后台队列完全无压力。

### 4.2 合成裁决基准（乐观假象）

6 个手写干净 case（6 种 verdict 各一），结果 **verdict 6/6 + target 6/6 全对、置信度 0.83–0.99、0 次 defer**。

其中 A5（一条事实性错误的新记忆"RefCell 比 Mutex 快"）被正确判为 `contradicts`（conf 0.99）——一度让人以为 Jev 能直接替掉 `adjudicate`。

### 4.3 真实数据裁决（打回原形）

从 shelf 抽取 **12 条真实 work unit + `hypatia similar` 挖出的真实候选**（噪声：近重复、跨层 `kb-*`、稀疏、主题相关但不同）。结果：

- **verdict 塌缩**：`extends` ×10、`refines` ×2，`duplicate/contradicts/supersedes/unrelated` **一次都没出现**。
- **target 塌缩**：`c0` ×10、`c1` ×2、`c2` ×0、`none` ×0——而 `c0` 就是向量最近邻，说明 Jev 的 target ≈ "直接选最近邻"。
- **7/12 触发 defer**（置信度 <0.6），且这些 defer 恰恰是真正的模糊 case。
- 反例：`s7-200硬件与i-o容量判断` → `现场协议资料阻塞项`，被判 `extends`（conf 0.91）——高置信的疑似错误连边。

**结论**：Jev 在真实数据上 ≈ "给最近邻加一条 extends 边"，冗余于已有的向量距离，且**偏向不安全方向**（插件语义是"宁可缺边不可错边"）。

### 4.4 提示词变体对照（换问法没用）

- **V-A 原子化**：把 6 选 1 拆成 `isDuplicate / contradicts / isUnrelated` 三个布尔 + 窄选择 `relKind`。结果 `extends` 塌缩 **换成了 `duplicate` 塌缩**（`isDuplicate` 在 0.74–0.85 上把"主题重叠"误判成"内容重复"）。`isUnrelated` 恒 ~0.05——因为候选本来就是 `similar` 预筛的相关项，这题是废话。
- **V-B 完整上下文 + 反连边指令 + related 门**：喂 600 字完整候选正文、加"宁可缺边不可错边"指令、加 `related` 布尔门。结果 **惰性**：`related` 恒 0.73–0.91（门从未触发），verdict 相对 baseline 基本不变。

**结论**：不是问法问题，是**任务结构问题**——候选被预筛成"相关"，真正要分辨的是"重复 vs 新增 vs 矛盾"的**细粒度内容差异**，零样本 Jev 做不到。

### 4.5 memoryWorthy 门控（唯一稳定可靠的信号）

| case | 内容 | P(true) | 判定 |
|---|---|---|---|
| G1 | 登录 500 bug 报告 | 0.50 | defer |
| G2 | Arc<Mutex> 结论 | 0.86 | 存 ✓ |
| G3 | "好的，明白了" | 0.02 | 不存 ✓ |
| G4 | "收到，这就去办" | 0.01 | 不存 ✓ |

闲聊被果断拒绝（0.01–0.02）、真内容放行（0.86）、模糊 defer（0.5）——**方向完全正确**。

### 4.6 topic-shift 检测（安全方向可用）

12 个真实 turn 边界（6 切 / 6 不切，含 2 条合成跨域对照）：

- **6 个 NO-SHIFT 全部 0 次误判成 shift**（4 个果断 no-shift，2 个 defer）。
- 明显切换被抓住：T1「分析→写DEMO」0.90，合成 T5/T6 0.96/0.98。
- 模糊（0.34–0.43）→ defer。
- 2 个"错"（T2「提交并推送」、T3「总结固化」）实为**同域子任务切换**，Jev 判 no-shift 是**安全且可辩护**的。

**关键规律**：topic-shift 的安全默认是"不切（合并）"，Jev 恰好偏向"不切/defer"→ **成功**；而裁决的安全默认是"不连边"，Jev 却偏向"连边"→ **失败**。**Jev 适合做"安全默认值正好是它偏好方向"的题。**

## 5. 核心结论

**Jev（零样本）的适配条件 = 「明确的二值判断」+「安全默认 = 它偏好的方向」+「能接受 defer」。**

| 节点 | 结论 |
|---|---|
| 关系裁决 verdict+target | ❌ 零样本不可靠，偏向不安全方向，提示词救不了 |
| 工作单元分类 | ⚠️ 缺过程上下文，弱 |
| **memoryWorthy 门控** | ✅ 可靠（省抽取 token） |
| **topic-shift 检测** | ✅ 可用但温和（提摘要质量，填已知空白） |
| 自动批准 / 脱敏 / 召回 / dream 分诊 | ❌ / ⚠️，确定性或专用工具更合适 |

最终收敛成**两道门**：抽取前的 `memoryWorthy` 门 + 切 span 的 `topic-shift` 门，两者都默认关闭、都走"高置信才行动、否则 defer 现状"的语义。

## 6. "非零样本"路径

- **few-shot（上下文例子）对非自回归模型基本无效**——Jev/Laya 是 ModernBERT + 决策头，没有 GPT 式 in-context 模仿机制；且实测指令型输入对 Jev 是惰性的。
- **Jev（闭源）无法 fine-tune**；温度校准只能重排概率、**不改变 argmax**，而裁决失败正是 argmax 错（选 extends 而非 unrelated），所以校准救不了。
- **Laya（开源）可以真 fine-tune**：Kaggle 两张 T4 约 4 小时，零样本 0.362 → 微调 0.766。这是真正的"非零样本"。
- **零成本标注红利**：现有 LLM 裁决路径 `adjudicate` 每次都在产出 `(unit, candidates → verdict, target)` 三元组，日志化即可积累训练集，无需人工标注。
- **诚实边界**：即便 fine-tune，只能提升"有共识"的部分（topic-shift 的 T2/T3 已暴露部分标签本身有歧义）；造不出标签里不存在的信号。

## 7. 建议与下一步

1. **短期（已可落地）**：把 `memoryWorthy` + `topic-shift` 做成 `consolidation.jev` 配置块下的可选模块，默认关闭。`memoryWorthy` 在抽取前以 P(true)<0.15 拦掉纯闲聊 span；`topicShift` 在 turn 边界以 P(shift)≥0.7 提前切 span。
2. **中期（零成本起步）**：给 `adjudicate` 加旁路落盘，把 LLM 裁决日志攒成训练集。
3. **长期（需决策）**：数据攒够后，评估 Laya fine-tune（GPU + Python sidecar + 温度校准）是否值得投入。

## 8. 实验脚本清单

位于 `docs/jev-decision-model-research-scripts/`：

| 脚本 | 用途 |
|---|---|
| `jev-demo.mjs` | 最小 DEMO：三种 question 类型 + 结果解读 |
| `jev-adjudication-experiment.mjs` | 合成裁决基准（6 case，带标注） |
| `extract-real-cases.mjs` + `jev-real-cases.json` | 从 shelf 抽取真实裁决 case |
| `jev-real-experiment.mjs` | 真实数据裁决（12 case） |
| `jev-prompt-variants.mjs` | 提问方式对照（V-A 原子化 vs V-B 完整上下文） |
| `extract-topic-boundaries.mjs` + `jev-topic-cases.json` | 抽取真实 topic-shift 边界 |
| `jev-topic-shift.mjs` | topic-shift 检测实验 |

所有脚本均：读取 `AI_GATEWAY_API_KEY` 环境变量、带 1s 请求间隔、带 503/429/5xx 指数退避重试（5 次）。
