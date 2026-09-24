window.__ModuleLoader__.load({
	id: "dsh-hypatia-auto-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/consolidation-models.ts
		/** Stable opaque key for one exact route. */
		function consolidationModelKey(route) {
			return `${route.provider}\0${route.model}`;
		}
		/**
		* Join the live model directory with selected routes that disappeared from it.
		* Disappeared routes remain visible so users can remove them deliberately.
		*/
		function consolidationModelCandidates(groups, stored, selected) {
			const storedByKey = new Map(stored.map((route) => [consolidationModelKey(route), route]));
			const candidates = groups.flatMap((group) => group.models.map((model) => {
				const route = {
					provider: group.id,
					model: model.id
				};
				const key = consolidationModelKey(route);
				storedByKey.delete(key);
				return {
					...route,
					key,
					providerName: group.name,
					modelName: model.name,
					available: true,
					selected: selected.has(key)
				};
			}));
			for (const route of storedByKey.values()) {
				const key = consolidationModelKey(route);
				candidates.push({
					...route,
					key,
					providerName: route.provider,
					modelName: route.model,
					available: false,
					selected: selected.has(key)
				});
			}
			return candidates;
		}
		function isRecord$1(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		/**
		* Pick the inventory namespace out of a settings descriptor.
		*
		* Reads the composition layer (`base`), which only the Host sets, rather than
		* the resolved value: a stray user-layer section for this namespace would
		* otherwise freeze the list.
		* @param described - the `namespaces` array a settings `describe()` returns.
		* @returns the listing, or undefined when the Host does not serve one.
		*/
		function readShelfInventory(described) {
			const view = described.find((entry) => isRecord$1(entry) && entry.ns === "hypatia-auto-memory-shelves");
			if (!isRecord$1(view) || !isRecord$1(view.base)) return void 0;
			const { shelves, error } = view.base;
			return {
				shelves: Array.isArray(shelves) ? shelves.flatMap((shelf) => isRecord$1(shelf) && typeof shelf.name === "string" ? [{
					name: shelf.name,
					path: typeof shelf.path === "string" ? shelf.path : "",
					connected: shelf.connected === true
				}] : []) : [],
				error: typeof error === "string" ? error : ""
			};
		}
		/**
		* Every shelf the dropdown offers: the listing, plus the stored and composed
		* values when the listing does not carry them, so the current choice always
		* renders and never silently changes to the first option.
		* @param shelves - the Host's listing.
		* @param keep - values that must stay selectable (current draft, stored, composed).
		* @returns options, listed shelves first in listing order.
		*/
		function shelfChoices(shelves, keep) {
			const choices = shelves.map((shelf) => ({
				...shelf,
				listed: true
			}));
			for (const name of keep) {
				if (name === "" || choices.some((choice) => choice.name === name)) continue;
				choices.push({
					name,
					path: "",
					connected: false,
					listed: false
				});
			}
			return choices;
		}
		//#endregion
		//#region \0dsh-hypatia-css:/Users/baihaoran/Code/github.com/tkliuxing/dsh-hypatia-auto-memory/src/client/SettingsCard.module.css.mjs
		const css$1 = ".MMni7a_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}.MMni7a_card:hover{border-color:var(--dsw-alias-label-dimmed)}.MMni7a_cardOpen{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}.MMni7a_header{appearance:none;width:100%;color:inherit;cursor:pointer;font:inherit;text-align:left;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.MMni7a_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.MMni7a_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.MMni7a_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.MMni7a_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.MMni7a_pending{corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.MMni7a_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.MMni7a_chevronOpen{transform:rotate(180deg)}.MMni7a_body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.MMni7a_status,.MMni7a_readOnly,.MMni7a_hint,.MMni7a_advancedHint,.MMni7a_error{margin:0;font-size:12px;line-height:1.5}.MMni7a_status,.MMni7a_readOnly,.MMni7a_hint,.MMni7a_advancedHint{color:var(--dsw-alias-label-tertiary)}.MMni7a_status{padding:12px 16px;list-style:none}.MMni7a_readOnly{padding-top:12px}.MMni7a_field{gap:6px;padding:12px 0;display:grid}.MMni7a_body>.MMni7a_field+.MMni7a_group,.MMni7a_body>.MMni7a_group+.MMni7a_field{border-top:.5px solid var(--dsw-alias-border-l2)}.MMni7a_group{padding:12px 0}.MMni7a_groupTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-weight:500;line-height:1.5}.MMni7a_limitsTitle{border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);margin:16px 0 0;padding-top:12px;font-size:13px;font-weight:500;line-height:1.5}.MMni7a_limitsTitle+.MMni7a_hint{margin-top:4px}.MMni7a_group>.MMni7a_field:first-of-type{padding-top:12px}.MMni7a_group>.MMni7a_field+.MMni7a_field,.MMni7a_pairedFields{border-top:.5px solid var(--dsw-alias-border-l2)}.MMni7a_fieldHead{align-items:center;gap:8px;display:flex}.MMni7a_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.MMni7a_reset{color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;background:0 0;border:0;padding:0;font-size:12px;line-height:1.5}.MMni7a_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.MMni7a_reset:disabled{cursor:default}.MMni7a_input{box-sizing:border-box;width:100%;min-width:0;display:flex}.MMni7a_select{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);width:100%;min-width:0;height:32px;color:var(--dsw-alias-label-primary);font:inherit;background:0 0;border-radius:8px;padding:0 8px;font-size:13px}.MMni7a_select:disabled{opacity:.5}.MMni7a_select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.MMni7a_warning{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.MMni7a_pairedFields{grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:4px 0;padding:4px 0;display:grid}.MMni7a_pairedFields .MMni7a_field{min-width:0}.MMni7a_switch{box-sizing:border-box;background:var(--dsw-alias-border-l3);cursor:pointer;border:0;border-radius:10px;width:36px;height:20px;padding:2px;position:relative}.MMni7a_switchOn{background:var(--dsw-alias-brand-primary)}.MMni7a_switch:disabled{cursor:default;opacity:.5}.MMni7a_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.MMni7a_switchThumb{corner-shape:round;background:var(--dsw-alias-label-primary-foreground);border-radius:50%;width:16px;height:16px;transition:transform .12s;display:block}.MMni7a_switchOn .MMni7a_switchThumb{transform:translate(16px)}.MMni7a_modelSelection{gap:10px;padding:12px 0;display:grid}.MMni7a_notice{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.MMni7a_catalogError{color:var(--dsw-alias-label-error);justify-content:space-between;align-items:center;gap:12px;font-size:12px;line-height:1.5;display:flex}.MMni7a_catalogError button{color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;background:0 0;border:0;padding:0}.MMni7a_models{border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;gap:6px;min-width:0;max-height:280px;margin:0;padding:10px;display:grid;overflow:auto}.MMni7a_models legend{color:var(--dsw-alias-label-secondary);padding:0 4px;font-size:12px}.MMni7a_modelGroup{gap:6px;display:grid}.MMni7a_modelGroup+.MMni7a_modelGroup{border-top:.5px solid var(--dsw-alias-border-l3);margin-top:4px;padding-top:10px}.MMni7a_providerName{color:var(--dsw-alias-label-tertiary);padding:0 6px;font-size:11px;font-weight:500}.MMni7a_model{cursor:pointer;border-radius:6px;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;min-width:0;padding:6px;display:grid}.MMni7a_model:hover{background:var(--dsw-alias-bg-layer-4)}.MMni7a_modelName,.MMni7a_route{text-overflow:ellipsis;white-space:nowrap;display:block;overflow:hidden}.MMni7a_modelName{color:var(--dsw-alias-label-primary);font-size:13px}.MMni7a_route{color:var(--dsw-alias-label-tertiary);margin-top:2px;font-size:11px}.MMni7a_unavailable{color:var(--dsw-alias-label-tertiary);font-size:11px}.MMni7a_error{color:var(--dsw-alias-label-error)}.MMni7a_advancedHint{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px}.MMni7a_footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}@media (width<=480px){.MMni7a_pairedFields{grid-template-columns:minmax(0,1fr);gap:0}.MMni7a_pairedFields .MMni7a_field+.MMni7a_field{border-top:.5px solid var(--dsw-alias-border-l2)}}";
		const tagId$1 = "dsh-hypatia-auto-memory/SettingsCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-hypatia-auto-memory";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var SettingsCard_module_css_default = {
			"advancedHint": "MMni7a_advancedHint",
			"body": "MMni7a_body",
			"card": "MMni7a_card",
			"cardOpen": "MMni7a_cardOpen",
			"catalogError": "MMni7a_catalogError",
			"chevron": "MMni7a_chevron",
			"chevronOpen": "MMni7a_chevronOpen",
			"description": "MMni7a_description",
			"error": "MMni7a_error",
			"field": "MMni7a_field",
			"fieldHead": "MMni7a_fieldHead",
			"footer": "MMni7a_footer",
			"group": "MMni7a_group",
			"groupTitle": "MMni7a_groupTitle",
			"headText": "MMni7a_headText",
			"header": "MMni7a_header",
			"hint": "MMni7a_hint",
			"input": "MMni7a_input",
			"label": "MMni7a_label",
			"limitsTitle": "MMni7a_limitsTitle",
			"model": "MMni7a_model",
			"modelGroup": "MMni7a_modelGroup",
			"modelName": "MMni7a_modelName",
			"modelSelection": "MMni7a_modelSelection",
			"models": "MMni7a_models",
			"name": "MMni7a_name",
			"notice": "MMni7a_notice",
			"pairedFields": "MMni7a_pairedFields",
			"pending": "MMni7a_pending",
			"providerName": "MMni7a_providerName",
			"readOnly": "MMni7a_readOnly",
			"reset": "MMni7a_reset",
			"route": "MMni7a_route",
			"select": "MMni7a_select",
			"status": "MMni7a_status",
			"switch": "MMni7a_switch",
			"switchOn": "MMni7a_switchOn",
			"switchThumb": "MMni7a_switchThumb",
			"unavailable": "MMni7a_unavailable",
			"warning": "MMni7a_warning"
		};
		//#endregion
		//#region src/client/locales.ts
		/** `hypatia-auto-memory` namespace dictionaries. */
		/** Dictionary namespace owned by this plugin. */
		const NS = "hypatia-auto-memory";
		/** Simplified Chinese dictionary and key source of truth. */
		const zh = {
			loading: "正在加载 {ns} 设置…",
			unavailable: "当前上下文不可用 {ns} 设置。",
			title: "Hypatia Auto Memory",
			description: "自动将对话轮次记录到 Hypatia，并在新内容足够多时通过独立模型路由进行后台整合。",
			enable: "启用自动记忆",
			autoApprove: "自动批准模型发起的 hypatia 命令",
			autoApproveHint: "仅限不含管道、重定向、命令串联的纯 hypatia 调用；插件自身的写入不经过此路径。关闭后模型每次检索都会弹出批准框。修改后需重载配置档生效。",
			shelf: "记忆写入的 shelf",
			shelfHint: "插件的记录、整合与会话开始时的规则预加载都读写这个 shelf；不是 default 时，会话开头会提示模型为 hypatia 命令加上 --shelf。修改后需重载配置档生效。每个 shelf 的记录进度单独保存，切回原来的 shelf 会从上次的位置继续；切到新的 shelf 后，每个有活动的会话会把完整历史重新记录进去并整合一遍（会消耗模型调用）。列表来自 hypatia list，约每分钟刷新一次。",
			shelfLoading: "正在读取 hypatia list…",
			shelfLoadFailed: "无法读取 shelf 列表。",
			shelfListingFailed: "hypatia list 执行失败，列表可能已过时：{message}",
			shelfDisconnected: "未连接",
			shelfOptionStatus: "（{status}）",
			shelfNotListed: "不在 hypatia list 中",
			shelfDisconnectedWarning: "shelf {shelf} 已注册但未连接，写入会失败。",
			shelfNotListedWarning: "hypatia 没有注册 shelf {shelf}，写入会失败；请先执行 hypatia connect <目录> --name {shelf}。",
			consolidationTitle: "整合候选模型",
			modelSelectionHint: "选择一个或多个模型。每次整合尝试（含重试）会按所选顺序轮转；未选择时只记录对话，不执行整合。",
			modelCatalogLoading: "正在读取可用模型…",
			modelCatalogFailed: "无法读取可用模型。",
			modelCatalogPartial: "部分提供方未能返回模型目录。",
			modelCatalogEmpty: "当前没有可选择的模型。",
			selectedModels: "用于轮转的模型",
			unavailableModels: "不可用或未再声明的模型",
			modelUnavailable: "当前不可用",
			retry: "重试",
			checkEveryTurns: "两次整合至少间隔 N 轮",
			minNewTokens: "最小新增 token 数",
			cascadeBatchSize: "归档批量",
			dedupMaxDistance: "关联距离上限",
			cascadeHint: "每积累这么多同层摘要，就归档为上一层的一条；关联距离上限决定新记忆要多接近既有条目才值得判定关系。",
			limitsTitle: "单次整合体量",
			limitsHint: "输入预算决定送入模型的对话长度（超出部分截断保留最近内容）；输出预算需容纳摘要与全部工作单元，过小会导致整合失败。",
			maxInputTokens: "输入预算（token）",
			maxOutputTokens: "输出预算（token）",
			maxWorkUnitsPerRun: "每次最多提取工作单元数",
			recallPreload: "召回：会话开始时预加载规则与禁忌",
			advancedHint: "高级字段（二进制、收集器上限、队列调优）可直接在 settings.yaml 的 {ns} 键下编辑。",
			reset: "重置",
			discard: "放弃",
			save: "保存",
			saving: "保存中…",
			saveFailed: "保存失败：{message}",
			readOnly: "只读：当前上下文不可写入设置文档。",
			unsaved: "未保存",
			viewMemory: "记忆",
			memoryTitle: "本会话的记忆",
			memoryUpdatedAt: "状态更新于 {time}",
			memoryRefresh: "刷新",
			memoryLoading: "正在读取记忆状态…",
			memoryNoSnapshot: "插件还没有发布记忆状态。启用后完成一轮对话再回来看看。",
			memoryLoadFailed: "无法读取记忆状态：{message}",
			memoryUnknown: "这个会话还没有记忆记录。第一轮对话结束后会开始记录。",
			memoryLogged: "对话记录",
			memorySeqValue: "第 {seq} 条事件",
			memoryConsolidated: "摘要整合",
			memoryCaughtUp: "已结清",
			memoryBehind: "较记录落后 {behind} 条",
			memoryPending: "待整合内容",
			memoryPendingValue: "约 {tokens} token",
			memorySessionNode: "会话节点",
			memorySessionNodeYes: "已建立",
			memorySessionNodeNo: "未建立（宿主未提供会话摘要）",
			memoryBelongTo: "已链接消息",
			memoryBelongToValue: "{count} 条",
			memoryDeferred: "等待会话载入的任务",
			memoryFailedTitle: "失败任务",
			memoryFailedItem: "{kind} 连续失败 {attempts} 次",
			memoryContentTitle: "记忆内容",
			memoryContentFailed: "无法读取 shelf 中的记忆内容：{message}",
			memorySummariesTitle: "跨度摘要",
			memoryWorkUnitsTitle: "工作单元",
			memoryNoSummaries: "这个会话还没有产生摘要。整合运行后会出现在这里。",
			memoryNoWorkUnits: "这个会话还没有提炼出工作单元。",
			memoryCount: "显示 {shown} / 共 {total}",
			memoryTier: "{level} 级",
			memoryWorkUnit: "工作单元",
			memoryEntryExpand: "展开",
			memoryEntryCollapse: "收起",
			memoryEntryEmpty: "这条条目的正文为空，或已超过展示上限。",
			memoryCopyCode: "复制",
			memoryCopiedCode: "已复制",
			memoryFootnotes: "脚注",
			memoryTruncated: "内容超出展示上限，较早的条目或过长的正文已被截断。",
			memoryHint: "诊断视图：原始 msg-* 对话正文不在此显示，需要时让 Agent 通过 hypatia 检索。状态每 5 秒重读一次；「状态更新于」是宿主最近一次看到这些状态发生变化的时间（首次读取也算一次），不变说明这段时间没有新进展。两个条数都按会话日志的事件序号计（含工具调用，不是消息条数），所以它们之差就是还没总结的部分。"
		};
		/** English dictionary checked against the Chinese key set. */
		const en = {
			loading: "Loading {ns} settings…",
			unavailable: "{ns} settings are not available in this context.",
			title: "Hypatia Auto Memory",
			description: "Auto-memory logs conversation turns into Hypatia and runs background consolidation on a dedicated model route.",
			enable: "Enable auto-memory",
			autoApprove: "Auto-approve the agent's own hypatia commands",
			autoApproveHint: "Only plain hypatia calls with no pipe, redirect or chaining; this plugin's own writes never take that path. With it off, every retrieval raises an approval prompt. Takes effect after a profile reload.",
			shelf: "Memory shelf",
			shelfHint: "Logging, consolidation and the session-start rules preload all read and write this shelf; when it is not default, each session is told to pass --shelf to its hypatia commands. Takes effect after a profile reload. Progress is kept per shelf, so switching back resumes where that shelf left off; on a new shelf, each session is logged from its start the next time it is active, and consolidated again (model calls). Choices come from hypatia list, refreshed about once a minute.",
			shelfLoading: "Reading hypatia list…",
			shelfLoadFailed: "Unable to load the shelf list.",
			shelfListingFailed: "hypatia list failed; the list may be stale: {message}",
			shelfDisconnected: "not connected",
			shelfOptionStatus: " ({status})",
			shelfNotListed: "not in hypatia list",
			shelfDisconnectedWarning: "Shelf {shelf} is registered but not connected; writes will fail.",
			shelfNotListedWarning: "hypatia has no shelf named {shelf}; writes will fail until you run hypatia connect <dir> --name {shelf}.",
			consolidationTitle: "Consolidation candidate models",
			modelSelectionHint: "Choose one or more models. Every consolidation attempt, including a retry, rotates through this order; without a selection, conversations continue logging but consolidation stays idle.",
			modelCatalogLoading: "Loading available models…",
			modelCatalogFailed: "Unable to load available models.",
			modelCatalogPartial: "Some providers did not return a model catalog.",
			modelCatalogEmpty: "No models are currently available.",
			selectedModels: "Models used for rotation",
			unavailableModels: "Unavailable or no longer advertised",
			modelUnavailable: "Unavailable",
			retry: "Retry",
			checkEveryTurns: "Minimum turns between consolidations",
			minNewTokens: "Min new tokens",
			cascadeBatchSize: "Archive batch",
			dedupMaxDistance: "Relation distance",
			cascadeHint: "Every batch of same-tier summaries is archived into one entry a tier up. Relation distance is how near a new memory must be to an existing one to be worth judging a relationship.",
			limitsTitle: "Per-run consolidation size",
			limitsHint: "The input budget caps how much conversation is sent to the model (overflow keeps the most recent content); the output budget must fit the summary plus every work unit — too small and consolidation fails.",
			maxInputTokens: "Input budget (tokens)",
			maxOutputTokens: "Output budget (tokens)",
			maxWorkUnitsPerRun: "Max work units per run",
			recallPreload: "Recall: preload rules & taboos at session start",
			advancedHint: "Advanced fields (binaries, collector caps, queue tuning) can be edited directly in settings.yaml under the {ns} key.",
			reset: "Reset",
			discard: "Discard",
			save: "Save",
			saving: "Saving…",
			saveFailed: "Save failed: {message}",
			readOnly: "Read-only: settings document is not writable in this context.",
			unsaved: "Unsaved",
			viewMemory: "Memory",
			memoryTitle: "This session's memory",
			memoryUpdatedAt: "State updated {time}",
			memoryRefresh: "Refresh",
			memoryLoading: "Reading memory status…",
			memoryNoSnapshot: "The plugin has not published a status snapshot yet. Enable it, finish a turn, and come back.",
			memoryLoadFailed: "Unable to read memory status: {message}",
			memoryUnknown: "This session has no memory record yet. Logging starts once the first turn ends.",
			memoryLogged: "Conversation log",
			memorySeqValue: "event {seq}",
			memoryConsolidated: "Summarisation",
			memoryCaughtUp: "caught up",
			memoryBehind: "{behind} events behind the log",
			memoryPending: "Waiting to summarise",
			memoryPendingValue: "~{tokens} tokens",
			memorySessionNode: "Session node",
			memorySessionNodeYes: "created",
			memorySessionNodeNo: "not created (the Host supplied no session summary)",
			memoryBelongTo: "Linked messages",
			memoryBelongToValue: "{count}",
			memoryDeferred: "Tasks waiting for the session to load",
			memoryFailedTitle: "Failed tasks",
			memoryFailedItem: "{kind} failed {attempts} times",
			memoryContentTitle: "Memory content",
			memoryContentFailed: "Unable to read memory content from the shelf: {message}",
			memorySummariesTitle: "Span summaries",
			memoryWorkUnitsTitle: "Work units",
			memoryNoSummaries: "This session has produced no summary yet. They appear here once consolidation runs.",
			memoryNoWorkUnits: "This session has yielded no work units yet.",
			memoryCount: "showing {shown} of {total}",
			memoryTier: "tier {level}",
			memoryWorkUnit: "work unit",
			memoryEntryExpand: "Expand",
			memoryEntryCollapse: "Collapse",
			memoryEntryEmpty: "This entry has no body, or it exceeded the display cap.",
			memoryCopyCode: "Copy",
			memoryCopiedCode: "Copied",
			memoryFootnotes: "Footnotes",
			memoryTruncated: "Content exceeded the display cap: earlier entries or over-long bodies were cut.",
			memoryHint: "Diagnostic view: raw msg-* conversation text is not shown here — ask the agent to retrieve it through hypatia. Status is re-read every 5 seconds; the timestamp is when the Host last saw that state change (the first read counts as one), so an unchanged one means nothing new happened. Both counts index the session log's event sequence (tool calls included, not messages), so their difference is what is left to summarise."
		};
		//#endregion
		//#region src/client/SettingsCard.tsx
		/**
		* Settings card for the `hypatia-auto-memory` namespace.
		*
		* The card owns its disclosure state and stages edits until Save. Its visual
		* treatment mirrors the DSH plugin-settings cards while remaining bundle-local.
		*/
		const DEFAULT_CONSOLIDATION = {
			models: [],
			maxInputTokens: 16e3,
			maxOutputTokens: 2e3,
			timeoutMs: 12e4,
			checkEveryTurns: 5,
			minNewTokens: 3e3,
			maxWorkUnitsPerRun: 3,
			adjudicate: true,
			dedupMaxDistance: .45,
			cascade: {
				enabled: true,
				batchSize: 16
			}
		};
		function getSnapshotValue(scope) {
			return scope.getSnapshot();
		}
		function subscribe(scope, cb) {
			return scope.subscribe(cb);
		}
		function sectionValue(snap) {
			return snap.value ?? snap.base ?? void 0;
		}
		function useScopeValue(scope) {
			const [snap, setSnap] = (0, react.useState)(() => getSnapshotValue(scope));
			(0, react.useEffect)(() => {
				setSnap(getSnapshotValue(scope));
				return subscribe(scope, () => setSnap(getSnapshotValue(scope)));
			}, [scope]);
			return {
				snap,
				value: (0, react.useMemo)(() => sectionValue(snap), [snap])
			};
		}
		function same(a, b) {
			return JSON.stringify(a) === JSON.stringify(b);
		}
		function SettingsCard({ scope, loadModelCatalog, loadShelfInventory, t }) {
			const { snap, value } = useScopeValue(scope);
			const disabled = !snap.writable;
			const base = (0, react.useMemo)(() => snap.base ?? {}, [snap.base]);
			const resolved = (0, react.useMemo)(() => value ?? base ?? {
				enabled: true,
				autoApprove: true,
				shelf: "default",
				consolidation: DEFAULT_CONSOLIDATION,
				recall: { preloadRulesTaboos: true }
			}, [value, base]);
			const [draft, setDraft] = (0, react.useState)(resolved);
			const [open, setOpen] = (0, react.useState)(false);
			const [saving, setSaving] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [catalogStatus, setCatalogStatus] = (0, react.useState)("idle");
			const [catalogGroups, setCatalogGroups] = (0, react.useState)([]);
			const [catalogPartial, setCatalogPartial] = (0, react.useState)(false);
			const catalogGeneration = (0, react.useRef)(0);
			const [shelfStatus, setShelfStatus] = (0, react.useState)("idle");
			const [shelves, setShelves] = (0, react.useState)([]);
			const [shelfListingError, setShelfListingError] = (0, react.useState)("");
			const shelfGeneration = (0, react.useRef)(0);
			(0, react.useEffect)(() => {
				setDraft(resolved);
			}, [resolved]);
			const dirty = (0, react.useMemo)(() => !same(draft, resolved), [draft, resolved]);
			const consolidation = draft.consolidation ?? DEFAULT_CONSOLIDATION;
			const recall = draft.recall ?? { preloadRulesTaboos: true };
			const saveBlocked = disabled || !dirty || saving;
			const updateConsolidation = (0, react.useCallback)((patch) => {
				setDraft((prev) => ({
					...prev,
					consolidation: {
						...prev.consolidation ?? DEFAULT_CONSOLIDATION,
						...patch
					}
				}));
			}, []);
			const loadCatalog = (0, react.useCallback)(async () => {
				const generation = ++catalogGeneration.current;
				setCatalogStatus("loading");
				setCatalogPartial(false);
				try {
					const catalog = await loadModelCatalog();
					if (generation !== catalogGeneration.current) return;
					setCatalogGroups(catalog.groups);
					setCatalogPartial(catalog.partial);
					setCatalogStatus("ready");
				} catch {
					if (generation !== catalogGeneration.current) return;
					setCatalogStatus("error");
				}
			}, [loadModelCatalog]);
			(0, react.useEffect)(() => {
				if (!open) return;
				loadCatalog();
				return () => {
					catalogGeneration.current += 1;
				};
			}, [open, loadCatalog]);
			const loadShelves = (0, react.useCallback)(async () => {
				const generation = ++shelfGeneration.current;
				setShelfStatus("loading");
				try {
					const inventory = await loadShelfInventory();
					if (generation !== shelfGeneration.current) return;
					setShelves(inventory.shelves);
					setShelfListingError(inventory.error);
					setShelfStatus("ready");
				} catch {
					if (generation !== shelfGeneration.current) return;
					setShelfStatus("error");
				}
			}, [loadShelfInventory]);
			(0, react.useEffect)(() => {
				if (!open) return;
				loadShelves();
				return () => {
					shelfGeneration.current += 1;
				};
			}, [open, loadShelves]);
			const draftShelf = draft.shelf ?? "default";
			const baseShelf = base.shelf ?? "default";
			const choices = (0, react.useMemo)(() => shelfChoices(shelves, [
				draftShelf,
				resolved.shelf ?? "default",
				baseShelf
			]), [
				shelves,
				draftShelf,
				resolved.shelf,
				baseShelf
			]);
			const chosen = choices.find((choice) => choice.name === draftShelf);
			const candidates = (0, react.useMemo)(() => {
				const models = consolidation.models ?? [];
				return consolidationModelCandidates(catalogGroups, models, new Set(models.map(consolidationModelKey)));
			}, [catalogGroups, consolidation.models]);
			const toggleModel = (0, react.useCallback)((candidate) => {
				if (disabled || saving) return;
				setDraft((current) => {
					const currentConsolidation = current.consolidation ?? DEFAULT_CONSOLIDATION;
					const currentModels = currentConsolidation.models ?? [];
					const key = consolidationModelKey(candidate);
					const models = currentModels.some((route) => consolidationModelKey(route) === key) ? currentModels.filter((route) => consolidationModelKey(route) !== key) : [...currentModels, {
						provider: candidate.provider,
						model: candidate.model
					}];
					return {
						...current,
						consolidation: {
							...currentConsolidation,
							models
						}
					};
				});
			}, [disabled, saving]);
			const discard = (0, react.useCallback)(() => {
				setDraft(resolved);
				setError(null);
			}, [resolved]);
			const save = (0, react.useCallback)(async () => {
				if (saveBlocked) return;
				setSaving(true);
				setError(null);
				try {
					const tasks = [];
					if (!same(draft.enabled, resolved.enabled)) tasks.push(scope.set("enabled", draft.enabled));
					if (!same(draft.autoApprove, resolved.autoApprove)) tasks.push(scope.set("autoApprove", draft.autoApprove));
					if (!same(draft.shelf, resolved.shelf)) tasks.push(scope.set("shelf", draft.shelf));
					if (!same(draft.consolidation, resolved.consolidation)) tasks.push(scope.set("consolidation", draft.consolidation));
					if (!same(draft.recall, resolved.recall)) tasks.push(scope.set("recall", draft.recall));
					await Promise.all(tasks);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`[${NS}] save failed:`, err);
					setError(message);
				} finally {
					setSaving(false);
				}
			}, [
				draft,
				resolved,
				saveBlocked,
				scope
			]);
			if (snap.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
				className: SettingsCard_module_css_default.status,
				children: t("loading", { ns: NS })
			});
			if (snap.status === "unavailable") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
				className: SettingsCard_module_css_default.status,
				children: t("unavailable", { ns: NS })
			});
			const availableGroups = /* @__PURE__ */ new Map();
			const unavailable = [];
			for (const candidate of candidates) {
				if (!candidate.available) {
					unavailable.push(candidate);
					continue;
				}
				const group = availableGroups.get(candidate.provider);
				if (group === void 0) availableGroups.set(candidate.provider, {
					providerName: candidate.providerName,
					candidates: [candidate]
				});
				else group.candidates.push(candidate);
			}
			const renderCandidate = (candidate) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: SettingsCard_module_css_default.model,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked: candidate.selected,
						disabled: disabled || saving,
						onChange: () => toggleModel(candidate)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: SettingsCard_module_css_default.modelName,
						children: candidate.modelName
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: SettingsCard_module_css_default.route,
						children: `${candidate.providerName} · ${candidate.provider}/${candidate.model}`
					})] }),
					!candidate.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: SettingsCard_module_css_default.unavailable,
						children: t("modelUnavailable")
					}) : null
				]
			}, candidate.key);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: `${SettingsCard_module_css_default.card} ${open ? SettingsCard_module_css_default.cardOpen : ""}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: SettingsCard_module_css_default.header,
					onClick: () => setOpen(!open),
					"aria-expanded": open,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: SettingsCard_module_css_default.headText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SettingsCard_module_css_default.name,
								children: t("title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SettingsCard_module_css_default.description,
								children: t("description")
							})]
						}),
						dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: SettingsCard_module_css_default.pending,
							children: t("unsaved")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: `${SettingsCard_module_css_default.chevron} ${open ? SettingsCard_module_css_default.chevronOpen : ""}` })
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: SettingsCard_module_css_default.body,
					children: [
						!snap.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: SettingsCard_module_css_default.readOnly,
							role: "status",
							children: t("readOnly")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SettingsCard_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SettingsCard_module_css_default.fieldHead,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: SettingsCard_module_css_default.label,
									htmlFor: "ham-enabled",
									children: t("enable")
								}), draft.enabled !== (base.enabled ?? true) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: SettingsCard_module_css_default.reset,
									disabled,
									onClick: () => setDraft((current) => ({
										...current,
										enabled: base.enabled ?? true
									})),
									children: t("reset")
								}) : null]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								id: "ham-enabled",
								type: "button",
								role: "switch",
								"aria-checked": draft.enabled ?? true,
								"aria-label": t("enable"),
								className: `${SettingsCard_module_css_default.switch} ${draft.enabled ?? true ? SettingsCard_module_css_default.switchOn : ""}`,
								disabled,
								onClick: () => setDraft((current) => ({
									...current,
									enabled: !(current.enabled ?? true)
								})),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: SettingsCard_module_css_default.switchThumb })
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SettingsCard_module_css_default.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: SettingsCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: SettingsCard_module_css_default.label,
										htmlFor: "ham-autoApprove",
										children: t("autoApprove")
									}), (draft.autoApprove ?? true) !== (base.autoApprove ?? true) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: SettingsCard_module_css_default.reset,
										disabled,
										onClick: () => setDraft((current) => ({
											...current,
											autoApprove: base.autoApprove ?? true
										})),
										children: t("reset")
									}) : null]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									id: "ham-autoApprove",
									type: "button",
									role: "switch",
									"aria-checked": draft.autoApprove ?? true,
									"aria-label": t("autoApprove"),
									className: `${SettingsCard_module_css_default.switch} ${draft.autoApprove ?? true ? SettingsCard_module_css_default.switchOn : ""}`,
									disabled,
									onClick: () => setDraft((current) => ({
										...current,
										autoApprove: !(current.autoApprove ?? true)
									})),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: SettingsCard_module_css_default.switchThumb })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: SettingsCard_module_css_default.hint,
									children: t("autoApproveHint")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SettingsCard_module_css_default.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: SettingsCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: SettingsCard_module_css_default.label,
										htmlFor: "ham-shelf",
										children: t("shelf")
									}), draftShelf !== baseShelf ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: SettingsCard_module_css_default.reset,
										disabled,
										onClick: () => setDraft((current) => ({
											...current,
											shelf: baseShelf
										})),
										children: t("reset")
									}) : null]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									id: "ham-shelf",
									className: SettingsCard_module_css_default.select,
									value: draftShelf,
									disabled: disabled || saving,
									onChange: (event) => {
										const shelf = event.target.value;
										setDraft((current) => ({
											...current,
											shelf
										}));
									},
									children: choices.map((choice) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
										value: choice.name,
										children: [
											choice.name,
											choice.path !== "" ? ` — ${choice.path}` : "",
											!choice.listed ? t("shelfOptionStatus", { status: t("shelfNotListed") }) : !choice.connected ? t("shelfOptionStatus", { status: t("shelfDisconnected") }) : ""
										]
									}, choice.name))
								}),
								shelfStatus === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: SettingsCard_module_css_default.notice,
									role: "status",
									children: t("shelfLoading")
								}) : null,
								shelfStatus === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: SettingsCard_module_css_default.catalogError,
									role: "alert",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("shelfLoadFailed") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: saving,
										onClick: () => {
											loadShelves();
										},
										children: t("retry")
									})]
								}) : null,
								shelfStatus === "ready" && shelfListingError !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: SettingsCard_module_css_default.notice,
									role: "status",
									children: t("shelfListingFailed", { message: shelfListingError })
								}) : null,
								shelfStatus === "ready" && shelfListingError === "" && chosen !== void 0 && (!chosen.listed || !chosen.connected) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: SettingsCard_module_css_default.warning,
									role: "status",
									children: t(chosen.listed ? "shelfDisconnectedWarning" : "shelfNotListedWarning", { shelf: chosen.name })
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: SettingsCard_module_css_default.hint,
									children: t("shelfHint")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: SettingsCard_module_css_default.group,
							"aria-labelledby": "ham-consolidation-title",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									id: "ham-consolidation-title",
									className: SettingsCard_module_css_default.groupTitle,
									children: t("consolidationTitle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: SettingsCard_module_css_default.hint,
									children: t("modelSelectionHint")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: SettingsCard_module_css_default.modelSelection,
									children: [
										catalogStatus === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: SettingsCard_module_css_default.notice,
											role: "status",
											children: t("modelCatalogLoading")
										}) : null,
										catalogStatus === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: SettingsCard_module_css_default.catalogError,
											role: "alert",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelCatalogFailed") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												disabled: saving,
												onClick: () => {
													loadCatalog();
												},
												children: t("retry")
											})]
										}) : null,
										catalogPartial ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: SettingsCard_module_css_default.notice,
											children: t("modelCatalogPartial")
										}) : null,
										candidates.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
											className: SettingsCard_module_css_default.models,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: t("selectedModels") }),
												[...availableGroups].map(([provider, group]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: SettingsCard_module_css_default.modelGroup,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														className: SettingsCard_module_css_default.providerName,
														children: group.providerName
													}), group.candidates.map(renderCandidate)]
												}, provider)),
												unavailable.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: SettingsCard_module_css_default.modelGroup,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														className: SettingsCard_module_css_default.providerName,
														children: t("unavailableModels")
													}), unavailable.map(renderCandidate)]
												}) : null
											]
										}) : catalogStatus === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: SettingsCard_module_css_default.notice,
											children: t("modelCatalogEmpty")
										}) : null
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: SettingsCard_module_css_default.pairedFields,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: SettingsCard_module_css_default.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: SettingsCard_module_css_default.fieldHead,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
												className: SettingsCard_module_css_default.label,
												htmlFor: "ham-checkEveryTurns",
												children: t("checkEveryTurns")
											}), consolidation.checkEveryTurns !== (base.consolidation?.checkEveryTurns ?? DEFAULT_CONSOLIDATION.checkEveryTurns) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: SettingsCard_module_css_default.reset,
												disabled,
												onClick: () => updateConsolidation({ checkEveryTurns: base.consolidation?.checkEveryTurns ?? DEFAULT_CONSOLIDATION.checkEveryTurns }),
												children: t("reset")
											}) : null]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											id: "ham-checkEveryTurns",
											className: SettingsCard_module_css_default.input,
											type: "number",
											min: 1,
											value: consolidation.checkEveryTurns,
											disabled,
											onChange: (event) => updateConsolidation({ checkEveryTurns: Number(event.target.value) })
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: SettingsCard_module_css_default.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: SettingsCard_module_css_default.fieldHead,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
												className: SettingsCard_module_css_default.label,
												htmlFor: "ham-minNewTokens",
												children: t("minNewTokens")
											}), consolidation.minNewTokens !== (base.consolidation?.minNewTokens ?? DEFAULT_CONSOLIDATION.minNewTokens) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: SettingsCard_module_css_default.reset,
												disabled,
												onClick: () => updateConsolidation({ minNewTokens: base.consolidation?.minNewTokens ?? DEFAULT_CONSOLIDATION.minNewTokens }),
												children: t("reset")
											}) : null]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											id: "ham-minNewTokens",
											className: SettingsCard_module_css_default.input,
											type: "number",
											min: 0,
											value: consolidation.minNewTokens,
											disabled,
											onChange: (event) => updateConsolidation({ minNewTokens: Number(event.target.value) })
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: SettingsCard_module_css_default.pairedFields,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: SettingsCard_module_css_default.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: SettingsCard_module_css_default.fieldHead,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
												className: SettingsCard_module_css_default.label,
												htmlFor: "ham-cascadeBatchSize",
												children: t("cascadeBatchSize")
											}), (consolidation.cascade?.batchSize ?? DEFAULT_CONSOLIDATION.cascade.batchSize) !== (base.consolidation?.cascade?.batchSize ?? DEFAULT_CONSOLIDATION.cascade.batchSize) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: SettingsCard_module_css_default.reset,
												disabled,
												onClick: () => updateConsolidation({ cascade: {
													...consolidation.cascade ?? DEFAULT_CONSOLIDATION.cascade,
													batchSize: base.consolidation?.cascade?.batchSize ?? DEFAULT_CONSOLIDATION.cascade.batchSize
												} }),
												children: t("reset")
											}) : null]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											id: "ham-cascadeBatchSize",
											className: SettingsCard_module_css_default.input,
											type: "number",
											min: 2,
											value: consolidation.cascade?.batchSize ?? DEFAULT_CONSOLIDATION.cascade.batchSize,
											disabled,
											onChange: (event) => updateConsolidation({ cascade: {
												...consolidation.cascade ?? DEFAULT_CONSOLIDATION.cascade,
												batchSize: Number(event.target.value)
											} })
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: SettingsCard_module_css_default.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: SettingsCard_module_css_default.fieldHead,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
												className: SettingsCard_module_css_default.label,
												htmlFor: "ham-dedupMaxDistance",
												children: t("dedupMaxDistance")
											}), (consolidation.dedupMaxDistance ?? DEFAULT_CONSOLIDATION.dedupMaxDistance) !== (base.consolidation?.dedupMaxDistance ?? DEFAULT_CONSOLIDATION.dedupMaxDistance) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: SettingsCard_module_css_default.reset,
												disabled,
												onClick: () => updateConsolidation({ dedupMaxDistance: base.consolidation?.dedupMaxDistance ?? DEFAULT_CONSOLIDATION.dedupMaxDistance }),
												children: t("reset")
											}) : null]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											id: "ham-dedupMaxDistance",
											className: SettingsCard_module_css_default.input,
											type: "number",
											min: 0,
											step: .05,
											value: consolidation.dedupMaxDistance ?? DEFAULT_CONSOLIDATION.dedupMaxDistance,
											disabled,
											onChange: (event) => updateConsolidation({ dedupMaxDistance: Number(event.target.value) })
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: SettingsCard_module_css_default.hint,
									children: t("cascadeHint")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
									className: SettingsCard_module_css_default.limitsTitle,
									children: t("limitsTitle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: SettingsCard_module_css_default.hint,
									children: t("limitsHint")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: SettingsCard_module_css_default.pairedFields,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: SettingsCard_module_css_default.field,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: SettingsCard_module_css_default.fieldHead,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
													className: SettingsCard_module_css_default.label,
													htmlFor: "ham-maxInputTokens",
													children: t("maxInputTokens")
												}), consolidation.maxInputTokens !== (base.consolidation?.maxInputTokens ?? DEFAULT_CONSOLIDATION.maxInputTokens) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: SettingsCard_module_css_default.reset,
													disabled,
													onClick: () => updateConsolidation({ maxInputTokens: base.consolidation?.maxInputTokens ?? DEFAULT_CONSOLIDATION.maxInputTokens }),
													children: t("reset")
												}) : null]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
												id: "ham-maxInputTokens",
												className: SettingsCard_module_css_default.input,
												type: "number",
												min: 1e3,
												step: 1e3,
												value: consolidation.maxInputTokens,
												disabled,
												onChange: (event) => updateConsolidation({ maxInputTokens: Number(event.target.value) })
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: SettingsCard_module_css_default.field,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: SettingsCard_module_css_default.fieldHead,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
													className: SettingsCard_module_css_default.label,
													htmlFor: "ham-maxOutputTokens",
													children: t("maxOutputTokens")
												}), consolidation.maxOutputTokens !== (base.consolidation?.maxOutputTokens ?? DEFAULT_CONSOLIDATION.maxOutputTokens) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: SettingsCard_module_css_default.reset,
													disabled,
													onClick: () => updateConsolidation({ maxOutputTokens: base.consolidation?.maxOutputTokens ?? DEFAULT_CONSOLIDATION.maxOutputTokens }),
													children: t("reset")
												}) : null]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
												id: "ham-maxOutputTokens",
												className: SettingsCard_module_css_default.input,
												type: "number",
												min: 200,
												step: 200,
												value: consolidation.maxOutputTokens,
												disabled,
												onChange: (event) => updateConsolidation({ maxOutputTokens: Number(event.target.value) })
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: SettingsCard_module_css_default.field,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: SettingsCard_module_css_default.fieldHead,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
													className: SettingsCard_module_css_default.label,
													htmlFor: "ham-maxWorkUnitsPerRun",
													children: t("maxWorkUnitsPerRun")
												}), consolidation.maxWorkUnitsPerRun !== (base.consolidation?.maxWorkUnitsPerRun ?? DEFAULT_CONSOLIDATION.maxWorkUnitsPerRun) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: SettingsCard_module_css_default.reset,
													disabled,
													onClick: () => updateConsolidation({ maxWorkUnitsPerRun: base.consolidation?.maxWorkUnitsPerRun ?? DEFAULT_CONSOLIDATION.maxWorkUnitsPerRun }),
													children: t("reset")
												}) : null]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
												id: "ham-maxWorkUnitsPerRun",
												className: SettingsCard_module_css_default.input,
												type: "number",
												min: 1,
												max: 10,
												value: consolidation.maxWorkUnitsPerRun,
												disabled,
												onChange: (event) => updateConsolidation({ maxWorkUnitsPerRun: Number(event.target.value) })
											})]
										})
									]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SettingsCard_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SettingsCard_module_css_default.fieldHead,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: SettingsCard_module_css_default.label,
									htmlFor: "ham-preloadRulesTaboos",
									children: t("recallPreload")
								}), (recall.preloadRulesTaboos ?? true) !== (base.recall?.preloadRulesTaboos ?? true) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: SettingsCard_module_css_default.reset,
									disabled,
									onClick: () => setDraft((current) => ({
										...current,
										recall: {
											...current.recall ?? { preloadRulesTaboos: true },
											preloadRulesTaboos: base.recall?.preloadRulesTaboos ?? true
										}
									})),
									children: t("reset")
								}) : null]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								id: "ham-preloadRulesTaboos",
								type: "button",
								role: "switch",
								"aria-checked": recall.preloadRulesTaboos ?? true,
								"aria-label": t("recallPreload"),
								className: `${SettingsCard_module_css_default.switch} ${recall.preloadRulesTaboos ?? true ? SettingsCard_module_css_default.switchOn : ""}`,
								disabled,
								onClick: () => setDraft((current) => ({
									...current,
									recall: {
										...current.recall ?? { preloadRulesTaboos: true },
										preloadRulesTaboos: !(current.recall?.preloadRulesTaboos ?? true)
									}
								})),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: SettingsCard_module_css_default.switchThumb })
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: SettingsCard_module_css_default.advancedHint,
							children: t("advancedHint", { ns: NS })
						}),
						error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: SettingsCard_module_css_default.error,
							role: "status",
							children: t("saveFailed", { message: error })
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SettingsCard_module_css_default.footer,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: !dirty || saving,
								onClick: discard,
								children: t("discard")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								disabled: saveBlocked,
								onClick: save,
								children: saving ? t("saving") : t("save")
							})]
						})
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/memory-client.ts
		/**
		* The Memory tab's read side: one same-origin request per refresh.
		*
		* The Host half serves it from `/api/dsh-hypatia-auto-memory/session`
		* (see `src/memory-api.js`), which is parameterized by session and authenticates
		* itself — unlike a settings namespace, it can answer for the one session the
		* tab is bound to instead of shipping every session's state to the browser.
		*
		* Zero runtime imports beyond `fetch`, so the parsing half is unit-tested under
		* `node:test` like `shelves.ts`.
		*/
		/** Route prefix the Host claims; the tab appends `/session`. */
		const MEMORY_API_PREFIX = "/api/dsh-hypatia-auto-memory";
		/**
		* The URL one refresh reads.
		* @param sessionId - the session the tab is bound to.
		* @param content - whether to ask the Host to read the shelf as well.
		* @returns a same-origin path with its query.
		*/
		function memoryUrl(sessionId, content) {
			const query = new URLSearchParams({ session: sessionId });
			if (content) query.set("content", "1");
			return `${MEMORY_API_PREFIX}/session?${query.toString()}`;
		}
		/** Fetch one session's memory from the Host. */
		const fetchMemory = async (sessionId, { content }) => {
			const response = await fetch(memoryUrl(sessionId, content), {
				method: "GET",
				credentials: "same-origin",
				headers: { accept: "application/json" }
			});
			const body = await response.json().catch(() => void 0);
			if (!response.ok) {
				const message = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${String(response.status)}`;
				throw new Error(message);
			}
			const payload = parseMemoryPayload(body, sessionId);
			if (payload === void 0) throw new Error("the Host returned an unreadable memory payload");
			return payload;
		};
		/**
		* Session-log events that are recorded but not yet consolidated.
		*
		* Both watermarks index the same log, so their difference is exactly the work
		* consolidation still owes. Clamped at zero: a consolidation run may cover a
		* range the logging watermark has not caught up to yet, which is not a backlog.
		*
		* @param session - the session half of a payload.
		* @returns the gap in session-log events.
		*/
		function consolidationGap(session) {
			return Math.max(0, session.loggedSeq - session.consolidatedSeq);
		}
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		function num(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : 0;
		}
		function str(value) {
			return typeof value === "string" ? value : "";
		}
		function parseFailedTasks(value) {
			if (!Array.isArray(value)) return [];
			return value.flatMap((entry) => isRecord(entry) ? [{
				kind: str(entry.kind),
				sessionId: str(entry.sessionId),
				attempts: num(entry.attempts),
				error: str(entry.error)
			}] : []);
		}
		function parseEntries(value) {
			if (!Array.isArray(value)) return [];
			return value.flatMap((entry) => {
				if (!isRecord(entry)) return [];
				const name = str(entry.name);
				if (name === "") return [];
				return [{
					name,
					markdown: str(entry.markdown),
					level: num(entry.level) || 1,
					createdAt: str(entry.createdAt)
				}];
			});
		}
		/**
		* Read the Host's answer into the tab's shape, defensively.
		*
		* A malformed field falls back to its zero value rather than reaching the DOM;
		* a payload with no usable `session` is rejected outright, because rendering a
		* panel of zeros for a session the Host never answered about would be a lie.
		*
		* A status-only answer parses to `content: undefined` — never to empty lists,
		* which is what made the five-second poll erase the shelf content. The Host also
		* states which half it sent (`content`), and that flag is what this prefers; the
		* key sniffing beside it keeps a bundle built after the flag from misreading a
		* Host that predates it, so the fix does not need a profile restart to land.
		*
		* @param value - the parsed response body.
		* @param sessionId - the session that was asked for.
		* @returns the payload, or undefined when the body is not one.
		*/
		function parseMemoryPayload(value, sessionId) {
			if (!isRecord(value) || !isRecord(value.session)) return void 0;
			const session = value.session;
			const carried = value.content === true || Object.hasOwn(value, "summaries") || Object.hasOwn(value, "contentError");
			return {
				session: {
					sessionId: str(session.sessionId) || sessionId,
					known: session.known === true,
					loggedSeq: num(session.loggedSeq),
					consolidatedSeq: num(session.consolidatedSeq),
					caughtUp: session.caughtUp === true,
					pendingTokens: num(session.pendingTokens),
					sessionNode: session.sessionNode === true,
					belongTo: num(session.belongTo),
					deferred: num(session.deferred),
					failed: num(session.failed),
					failedTasks: parseFailedTasks(session.failedTasks),
					error: str(session.error)
				},
				updatedAt: num(value.updatedAt),
				content: carried ? {
					summaries: parseEntries(value.summaries),
					workUnits: parseEntries(value.workUnits),
					summaryCount: num(value.summaryCount),
					workUnitCount: num(value.workUnitCount),
					truncated: value.truncated === true,
					error: str(value.contentError)
				} : void 0
			};
		}
		/**
		* Fold a new answer onto the one on screen.
		*
		* Status is always the newest. Content is only replaced by an answer that
		* carried content, so the poll cannot erase it. An answer whose shelf read
		* failed keeps the content already shown — entries, counts and the truncation
		* flag together, so the header still describes the list under it — and records
		* the error beside it, because a transient hypatia failure should not blank
		* what the reader was looking at.
		*
		* @param previous - the payload on screen, if any.
		* @param next - the answer just parsed.
		* @returns the payload to render.
		*/
		function mergeMemory(previous, next) {
			if (next.content === void 0) return {
				...next,
				content: previous?.content
			};
			if (next.content.error !== "" && previous?.content !== void 0) return {
				...next,
				content: {
					...previous.content,
					error: next.content.error
				}
			};
			return next;
		}
		//#endregion
		//#region \0dsh-hypatia-css:/Users/baihaoran/Code/github.com/tkliuxing/dsh-hypatia-auto-memory/src/client/MemoryView.module.css.mjs
		const css = ".KRU7mq_panel{box-sizing:border-box;width:100%;height:100%;min-height:0;padding:16px;padding-bottom:calc(var(--dsh-composer-height,152px) + 16px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);flex-direction:column;align-items:center;display:flex;overflow-y:auto}.KRU7mq_column{flex-direction:column;gap:20px;width:100%;min-width:0;max-width:880px;display:flex}.KRU7mq_head{justify-content:space-between;align-items:baseline;gap:12px;display:flex}.KRU7mq_title{color:var(--dsw-alias-label-primary);margin:0;font-size:15px;font-weight:600;line-height:1.4}.KRU7mq_headMeta{align-items:center;gap:10px;display:flex}.KRU7mq_updated{color:var(--dsw-alias-label-tertiary);font-size:12px}.KRU7mq_refresh{appearance:none;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;background:0 0;border-radius:8px;padding:2px 8px;font-size:12px}.KRU7mq_refresh:hover{border-color:var(--dsw-alias-label-dimmed);color:var(--dsw-alias-label-primary)}.KRU7mq_refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.KRU7mq_status,.KRU7mq_hint,.KRU7mq_error{margin:0;font-size:12px;line-height:1.6}.KRU7mq_status,.KRU7mq_hint{color:var(--dsw-alias-label-tertiary)}.KRU7mq_error{color:var(--dsw-alias-label-error)}.KRU7mq_group{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding-top:16px;display:flex}.KRU7mq_groupTitle{color:var(--dsw-alias-label-primary);align-items:baseline;gap:8px;margin:0;font-size:13px;font-weight:600;display:flex}.KRU7mq_count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:11px;font-weight:400}.KRU7mq_rows{grid-template-columns:max-content minmax(0,1fr);align-items:baseline;gap:7px 20px;margin:0;display:grid}.KRU7mq_row{display:contents}.KRU7mq_label{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:12px}.KRU7mq_value{min-width:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;align-items:baseline;gap:8px;margin:0;font-size:12px;display:flex}.KRU7mq_calm,.KRU7mq_busy{white-space:nowrap;border-radius:6px;padding:1px 6px;font-size:11px}.KRU7mq_calm{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}.KRU7mq_busy{color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3)}.KRU7mq_failures{gap:6px;margin:0;padding:0;list-style:none;display:grid}.KRU7mq_failure{background:var(--dsw-alias-bg-layer-2);border-radius:8px;gap:2px;padding:8px 10px;display:grid}.KRU7mq_failureKind{color:var(--dsw-alias-label-primary);font-size:12px}.KRU7mq_failureError{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:11px;line-height:1.5}.KRU7mq_entries{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}.KRU7mq_entry{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;overflow:hidden}.KRU7mq_entryHead{appearance:none;width:100%;color:inherit;cursor:pointer;font:inherit;text-align:left;background:0 0;border:0;justify-content:space-between;align-items:baseline;gap:12px;padding:8px 12px;display:flex}.KRU7mq_entryHead:hover{background:var(--dsw-alias-bg-layer-3)}.KRU7mq_entryHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.KRU7mq_entryName{min-width:0;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,ui-monospace, SFMono-Regular, Menlo, monospace);text-overflow:ellipsis;white-space:nowrap;font-size:11px;overflow:hidden}.KRU7mq_entryMeta{flex:none;align-items:baseline;gap:8px;display:flex}.KRU7mq_badge{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);white-space:nowrap;border-radius:6px;padding:1px 6px;font-size:11px}.KRU7mq_entryTime{color:var(--dsw-alias-label-quaternary);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:11px}.KRU7mq_entryToggle{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:11px}.KRU7mq_entryBody{border-top:.5px solid var(--dsw-alias-border-l2);overflow-wrap:anywhere;padding:10px 12px;font-size:13px;line-height:1.65}.KRU7mq_entryPreview{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;margin:0;padding:0 12px 10px;font-size:12px;line-height:1.5;overflow:hidden}.KRU7mq_hint{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px}";
		const tagId = "dsh-hypatia-auto-memory/MemoryView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-hypatia-auto-memory";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var MemoryView_module_css_default = {
			"badge": "KRU7mq_badge",
			"busy": "KRU7mq_busy",
			"calm": "KRU7mq_calm",
			"column": "KRU7mq_column",
			"count": "KRU7mq_count",
			"entries": "KRU7mq_entries",
			"entry": "KRU7mq_entry",
			"entryBody": "KRU7mq_entryBody",
			"entryHead": "KRU7mq_entryHead",
			"entryMeta": "KRU7mq_entryMeta",
			"entryName": "KRU7mq_entryName",
			"entryPreview": "KRU7mq_entryPreview",
			"entryTime": "KRU7mq_entryTime",
			"entryToggle": "KRU7mq_entryToggle",
			"error": "KRU7mq_error",
			"failure": "KRU7mq_failure",
			"failureError": "KRU7mq_failureError",
			"failureKind": "KRU7mq_failureKind",
			"failures": "KRU7mq_failures",
			"group": "KRU7mq_group",
			"groupTitle": "KRU7mq_groupTitle",
			"head": "KRU7mq_head",
			"headMeta": "KRU7mq_headMeta",
			"hint": "KRU7mq_hint",
			"label": "KRU7mq_label",
			"panel": "KRU7mq_panel",
			"refresh": "KRU7mq_refresh",
			"row": "KRU7mq_row",
			"rows": "KRU7mq_rows",
			"status": "KRU7mq_status",
			"title": "KRU7mq_title",
			"updated": "KRU7mq_updated",
			"value": "KRU7mq_value"
		};
		//#endregion
		//#region src/client/MemoryView.tsx
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
		/** How often the tab re-reads the status half while it is on screen. */
		const POLL_MS = 5e3;
		/** Local wall-clock stamp for the freshness line. */
		function formatTime(epochMs) {
			if (!Number.isFinite(epochMs) || epochMs <= 0) return "—";
			return new Date(epochMs).toLocaleTimeString();
		}
		/**
		* hypatia stamps `created_at` as `YYYY-MM-DD HH:MM:SS.ffffff`; the microseconds
		* are noise in a row that is 11px tall, so the tab shows down to the minute.
		* Slice rather than `new Date`: the space-separated form is not the ISO shape
		* every engine is required to parse.
		*/
		function formatEntryTime(stamp) {
			return stamp.length >= 16 ? stamp.slice(0, 16).replace("T", " ") : stamp;
		}
		/** The first non-empty line of a body, for a collapsed row's preview. */
		function firstLine(markdown) {
			for (const line of markdown.split("\n")) {
				const trimmed = line.replace(/^[#>\-*\s]+/, "").trim();
				if (trimmed !== "") return trimmed;
			}
			return "";
		}
		/** One collapsible distilled entry. */
		function Entry({ entry, badge, open, onToggle, labels, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: MemoryView_module_css_default.entry,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: MemoryView_module_css_default.entryHead,
					"aria-expanded": open,
					onClick: onToggle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: MemoryView_module_css_default.entryName,
						children: entry.name
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: MemoryView_module_css_default.entryMeta,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: MemoryView_module_css_default.badge,
								children: badge
							}),
							entry.createdAt !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: MemoryView_module_css_default.entryTime,
								children: formatEntryTime(entry.createdAt)
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: MemoryView_module_css_default.entryToggle,
								children: open ? t("memoryEntryCollapse") : t("memoryEntryExpand")
							})
						]
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: MemoryView_module_css_default.entryBody,
					children: entry.markdown === "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: MemoryView_module_css_default.status,
						children: t("memoryEntryEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
						text: entry.markdown,
						labels
					})
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: MemoryView_module_css_default.entryPreview,
					children: firstLine(entry.markdown)
				})]
			});
		}
		function MemoryView({ sessionId, fetch, t }) {
			const [payload, setPayload] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)("");
			/**
			* The entries the reader opened, by name. Absent means closed, which is the
			* default: a toggle survives the poll that replaces the payload, and an entry
			* a later poll adds starts closed rather than inheriting a neighbour's state.
			*/
			const [overrides, setOverrides] = (0, react.useState)({});
			/** The watermark whose content is already in hand, so a poll never re-reads it. */
			const [contentAt, setContentAt] = (0, react.useState)(void 0);
			const copyLabel = t("memoryCopyCode");
			const copiedLabel = t("memoryCopiedCode");
			const footnotes = t("memoryFootnotes");
			const labels = (0, react.useMemo)(() => ({
				code: {
					copyLabel,
					copiedLabel
				},
				footnotes
			}), [
				copyLabel,
				copiedLabel,
				footnotes
			]);
			/**
			* The session the tab is showing now. A request outlives the session it was
			* made for — a slow shelf read, or a poll already in flight at a switch — and
			* its answer must be dropped rather than folded into the next session's view.
			*/
			const activeSession = (0, react.useRef)(sessionId);
			const load = (0, react.useCallback)(async (content) => {
				const current = () => activeSession.current === sessionId;
				try {
					const next = await fetch(sessionId, { content });
					if (!current()) return;
					setPayload((previous) => mergeMemory(previous, next));
					setError("");
					if (content) setContentAt(next.session.consolidatedSeq);
				} catch (failure) {
					if (!current()) return;
					setError(failure instanceof Error ? failure.message : String(failure));
				} finally {
					if (current()) setLoading(false);
				}
			}, [fetch, sessionId]);
			(0, react.useEffect)(() => {
				activeSession.current = sessionId;
				setPayload(void 0);
				setOverrides({});
				setContentAt(void 0);
				setLoading(true);
				load(true);
			}, [load, sessionId]);
			(0, react.useEffect)(() => {
				const timer = setInterval(() => {
					if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
					load(false);
				}, POLL_MS);
				return () => clearInterval(timer);
			}, [load]);
			(0, react.useEffect)(() => {
				const at = payload?.session.consolidatedSeq;
				if (at === void 0 || contentAt === void 0) return;
				if (at !== contentAt) load(true);
			}, [
				payload?.session.consolidatedSeq,
				contentAt,
				load
			]);
			const toggle = (0, react.useCallback)((name, open) => {
				setOverrides((current) => ({
					...current,
					[name]: !open
				}));
			}, []);
			const session = payload?.session;
			const content = payload?.content;
			const summaries = content?.summaries ?? [];
			const workUnits = content?.workUnits ?? [];
			const renderEntries = (entries, kind) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: MemoryView_module_css_default.entries,
				children: entries.map((entry) => {
					const open = overrides[entry.name] === true;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Entry, {
						entry,
						badge: kind === "summary" ? t("memoryTier", { level: String(entry.level) }) : t("memoryWorkUnit"),
						open,
						onToggle: () => toggle(entry.name, open),
						labels,
						t
					}, entry.name);
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: MemoryView_module_css_default.panel,
				"data-conversation-composer-overlay": "",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: MemoryView_module_css_default.column,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
							className: MemoryView_module_css_default.head,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: MemoryView_module_css_default.title,
								children: t("memoryTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: MemoryView_module_css_default.headMeta,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: MemoryView_module_css_default.updated,
									children: t("memoryUpdatedAt", { time: formatTime(payload?.updatedAt ?? 0) })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: MemoryView_module_css_default.refresh,
									onClick: () => {
										load(true);
									},
									children: t("memoryRefresh")
								})]
							})]
						}),
						error !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: MemoryView_module_css_default.error,
							role: "status",
							children: t("memoryLoadFailed", { message: error })
						}) : null,
						loading && payload === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: MemoryView_module_css_default.status,
							children: t("memoryLoading")
						}) : session === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: MemoryView_module_css_default.status,
							children: t("memoryNoSnapshot")
						}) : !session.known ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: MemoryView_module_css_default.status,
							children: t("memoryUnknown")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
							className: MemoryView_module_css_default.group,
							"aria-label": t("memoryTitle"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
								className: MemoryView_module_css_default.rows,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: MemoryView_module_css_default.row,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
											className: MemoryView_module_css_default.label,
											children: t("memoryLogged")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
											className: MemoryView_module_css_default.value,
											children: t("memorySeqValue", { seq: String(session.loggedSeq) })
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: MemoryView_module_css_default.row,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
											className: MemoryView_module_css_default.label,
											children: t("memoryConsolidated")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", {
											className: MemoryView_module_css_default.value,
											children: [t("memorySeqValue", { seq: String(session.consolidatedSeq) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: session.caughtUp ? MemoryView_module_css_default.calm : MemoryView_module_css_default.busy,
												children: session.caughtUp ? t("memoryCaughtUp") : t("memoryBehind", { behind: String(consolidationGap(session)) })
											})]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: MemoryView_module_css_default.row,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
											className: MemoryView_module_css_default.label,
											children: t("memoryPending")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
											className: MemoryView_module_css_default.value,
											children: t("memoryPendingValue", { tokens: String(session.pendingTokens) })
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: MemoryView_module_css_default.row,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
											className: MemoryView_module_css_default.label,
											children: t("memorySessionNode")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
											className: MemoryView_module_css_default.value,
											children: session.sessionNode ? t("memorySessionNodeYes") : t("memorySessionNodeNo")
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: MemoryView_module_css_default.row,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
											className: MemoryView_module_css_default.label,
											children: t("memoryBelongTo")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
											className: MemoryView_module_css_default.value,
											children: t("memoryBelongToValue", { count: String(session.belongTo) })
										})]
									}),
									session.deferred > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: MemoryView_module_css_default.row,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
											className: MemoryView_module_css_default.label,
											children: t("memoryDeferred")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
											className: MemoryView_module_css_default.value,
											children: String(session.deferred)
										})]
									}) : null
								]
							})
						}),
						session !== void 0 && (session.failed > 0 || session.failedTasks.length > 0) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: MemoryView_module_css_default.group,
							"aria-label": t("memoryFailedTitle"),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: MemoryView_module_css_default.groupTitle,
								children: t("memoryFailedTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
								className: MemoryView_module_css_default.failures,
								children: [session.failedTasks.map((task, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: MemoryView_module_css_default.failure,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: MemoryView_module_css_default.failureKind,
										children: t("memoryFailedItem", {
											kind: task.kind,
											attempts: String(task.attempts)
										})
									}), task.error !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: MemoryView_module_css_default.failureError,
										children: task.error
									}) : null]
								}, `${task.kind}-${String(index)}`)), session.failedTasks.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
									className: MemoryView_module_css_default.failure,
									children: session.error
								}) : null]
							})]
						}) : null,
						content !== void 0 && content.error !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: MemoryView_module_css_default.group,
							"aria-label": t("memoryContentTitle"),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: MemoryView_module_css_default.groupTitle,
								children: t("memoryContentTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: MemoryView_module_css_default.error,
								role: "status",
								children: t("memoryContentFailed", { message: content.error })
							})]
						}) : null,
						content !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: MemoryView_module_css_default.group,
								"aria-label": t("memorySummariesTitle"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
									className: MemoryView_module_css_default.groupTitle,
									children: [t("memorySummariesTitle"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: MemoryView_module_css_default.count,
										children: t("memoryCount", {
											shown: String(summaries.length),
											total: String(content.summaryCount)
										})
									})]
								}), summaries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: MemoryView_module_css_default.status,
									children: t("memoryNoSummaries")
								}) : renderEntries(summaries, "summary")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: MemoryView_module_css_default.group,
								"aria-label": t("memoryWorkUnitsTitle"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
									className: MemoryView_module_css_default.groupTitle,
									children: [t("memoryWorkUnitsTitle"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: MemoryView_module_css_default.count,
										children: t("memoryCount", {
											shown: String(workUnits.length),
											total: String(content.workUnitCount)
										})
									})]
								}), workUnits.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: MemoryView_module_css_default.status,
									children: t("memoryNoWorkUnits")
								}) : renderEntries(workUnits, "workUnit")]
							}),
							content.truncated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: MemoryView_module_css_default.hint,
								children: t("memoryTruncated")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: MemoryView_module_css_default.hint,
								children: t("memoryHint")
							})
						] }) : null
					]
				})
			});
		}
		//#endregion
		//#region src/client/index.tsx
		const APPLY_CLAIM = "__dshHypatiaAutoMemoryApplied";
		function claimApply() {
			const scope = globalThis;
			if (scope[APPLY_CLAIM] === true) return false;
			scope[APPLY_CLAIM] = true;
			return true;
		}
		function releaseApply() {
			delete globalThis[APPLY_CLAIM];
		}
		/**
		* Required client services: settings, locale, slots, the Host model catalog,
		* and the settings descriptor. Each Remote namespace is its own service, so
		* `remote.settings` must be declared here or reading it throws.
		*/
		const inject = [
			"slots",
			"settingsScope",
			"locale",
			"remote",
			"remote.session",
			"remote.settings"
		];
		/** Mount the browser half. */
		function apply(ctx) {
			if (!claimApply()) return;
			const scope = ctx.get("settingsScope").bind({ namespace: NS });
			const locale = ctx.get("locale");
			ctx.effect(() => locale.register(NS, {
				zh,
				en
			}), "dsh-hypatia-auto-memory: locale dictionaries");
			const loadModelCatalog = async () => {
				const response = await ctx.remote.session.modelCatalog();
				if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
				return {
					groups: response.value.groups,
					partial: response.value.failures.length > 0
				};
			};
			const loadShelfInventory = async () => {
				const response = await ctx.remote.settings.describe();
				if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
				const inventory = readShelfInventory(response.value.namespaces);
				if (inventory === void 0) throw new Error("the Host publishes no shelf listing");
				return inventory;
			};
			const renderCard = (props) => (0, react.createElement)(SettingsCard, {
				scope,
				loadModelCatalog,
				loadShelfInventory,
				...props
			});
			const unregister = ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: NS,
				locale: NS
			}, renderCard));
			const t = locale.bind(NS);
			const unregisterMemoryView = ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "memory",
				order: 20,
				locale: NS,
				label: () => t("viewMemory"),
				inject: () => ({ fetch: fetchMemory })
			}, MemoryView));
			ctx.effect(() => () => {
				unregister();
				unregisterMemoryView();
				releaseApply();
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map