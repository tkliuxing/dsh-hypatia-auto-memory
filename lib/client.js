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
		function isRecord(value) {
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
			const view = described.find((entry) => isRecord(entry) && entry.ns === "hypatia-auto-memory-shelves");
			if (!isRecord(view) || !isRecord(view.base)) return void 0;
			const { shelves, error } = view.base;
			return {
				shelves: Array.isArray(shelves) ? shelves.flatMap((shelf) => isRecord(shelf) && typeof shelf.name === "string" ? [{
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
		//#region \0dsh-hypatia-css:/Users/baihaoran/Code/github.com/tkliuxing/hypatia/dsh-hypatia-auto-memory/src/client/SettingsCard.module.css.mjs
		const css = ".jdP5nG_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}.jdP5nG_card:hover{border-color:var(--dsw-alias-label-dimmed)}.jdP5nG_cardOpen{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}.jdP5nG_header{appearance:none;width:100%;color:inherit;cursor:pointer;font:inherit;text-align:left;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.jdP5nG_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.jdP5nG_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.jdP5nG_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.jdP5nG_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.jdP5nG_pending{corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.jdP5nG_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.jdP5nG_chevronOpen{transform:rotate(180deg)}.jdP5nG_body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.jdP5nG_status,.jdP5nG_readOnly,.jdP5nG_hint,.jdP5nG_advancedHint,.jdP5nG_error{margin:0;font-size:12px;line-height:1.5}.jdP5nG_status,.jdP5nG_readOnly,.jdP5nG_hint,.jdP5nG_advancedHint{color:var(--dsw-alias-label-tertiary)}.jdP5nG_status{padding:12px 16px;list-style:none}.jdP5nG_readOnly{padding-top:12px}.jdP5nG_field{gap:6px;padding:12px 0;display:grid}.jdP5nG_body>.jdP5nG_field+.jdP5nG_group,.jdP5nG_body>.jdP5nG_group+.jdP5nG_field{border-top:.5px solid var(--dsw-alias-border-l2)}.jdP5nG_group{padding:12px 0}.jdP5nG_groupTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-weight:500;line-height:1.5}.jdP5nG_limitsTitle{border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);margin:16px 0 0;padding-top:12px;font-size:13px;font-weight:500;line-height:1.5}.jdP5nG_limitsTitle+.jdP5nG_hint{margin-top:4px}.jdP5nG_group>.jdP5nG_field:first-of-type{padding-top:12px}.jdP5nG_group>.jdP5nG_field+.jdP5nG_field,.jdP5nG_pairedFields{border-top:.5px solid var(--dsw-alias-border-l2)}.jdP5nG_fieldHead{align-items:center;gap:8px;display:flex}.jdP5nG_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.jdP5nG_reset{color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;background:0 0;border:0;padding:0;font-size:12px;line-height:1.5}.jdP5nG_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.jdP5nG_reset:disabled{cursor:default}.jdP5nG_input{box-sizing:border-box;width:100%;min-width:0;display:flex}.jdP5nG_select{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);width:100%;min-width:0;height:32px;color:var(--dsw-alias-label-primary);font:inherit;background:0 0;border-radius:8px;padding:0 8px;font-size:13px}.jdP5nG_select:disabled{opacity:.5}.jdP5nG_select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.jdP5nG_warning{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.jdP5nG_pairedFields{grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:4px 0;padding:4px 0;display:grid}.jdP5nG_pairedFields .jdP5nG_field{min-width:0}.jdP5nG_switch{box-sizing:border-box;background:var(--dsw-alias-border-l3);cursor:pointer;border:0;border-radius:10px;width:36px;height:20px;padding:2px;position:relative}.jdP5nG_switchOn{background:var(--dsw-alias-brand-primary)}.jdP5nG_switch:disabled{cursor:default;opacity:.5}.jdP5nG_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.jdP5nG_switchThumb{corner-shape:round;background:var(--dsw-alias-label-primary-foreground);border-radius:50%;width:16px;height:16px;transition:transform .12s;display:block}.jdP5nG_switchOn .jdP5nG_switchThumb{transform:translate(16px)}.jdP5nG_modelSelection{gap:10px;padding:12px 0;display:grid}.jdP5nG_notice{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.jdP5nG_catalogError{color:var(--dsw-alias-label-error);justify-content:space-between;align-items:center;gap:12px;font-size:12px;line-height:1.5;display:flex}.jdP5nG_catalogError button{color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;background:0 0;border:0;padding:0}.jdP5nG_models{border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;gap:6px;min-width:0;max-height:280px;margin:0;padding:10px;display:grid;overflow:auto}.jdP5nG_models legend{color:var(--dsw-alias-label-secondary);padding:0 4px;font-size:12px}.jdP5nG_modelGroup{gap:6px;display:grid}.jdP5nG_modelGroup+.jdP5nG_modelGroup{border-top:.5px solid var(--dsw-alias-border-l3);margin-top:4px;padding-top:10px}.jdP5nG_providerName{color:var(--dsw-alias-label-tertiary);padding:0 6px;font-size:11px;font-weight:500}.jdP5nG_model{cursor:pointer;border-radius:6px;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;min-width:0;padding:6px;display:grid}.jdP5nG_model:hover{background:var(--dsw-alias-bg-layer-4)}.jdP5nG_modelName,.jdP5nG_route{text-overflow:ellipsis;white-space:nowrap;display:block;overflow:hidden}.jdP5nG_modelName{color:var(--dsw-alias-label-primary);font-size:13px}.jdP5nG_route{color:var(--dsw-alias-label-tertiary);margin-top:2px;font-size:11px}.jdP5nG_unavailable{color:var(--dsw-alias-label-tertiary);font-size:11px}.jdP5nG_error{color:var(--dsw-alias-label-error)}.jdP5nG_advancedHint{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px}.jdP5nG_footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}@media (width<=480px){.jdP5nG_pairedFields{grid-template-columns:minmax(0,1fr);gap:0}.jdP5nG_pairedFields .jdP5nG_field+.jdP5nG_field{border-top:.5px solid var(--dsw-alias-border-l2)}}";
		const tagId = "dsh-hypatia-auto-memory/SettingsCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-hypatia-auto-memory";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var SettingsCard_module_css_default = {
			"description": "jdP5nG_description",
			"readOnly": "jdP5nG_readOnly",
			"fieldHead": "jdP5nG_fieldHead",
			"pairedFields": "jdP5nG_pairedFields",
			"switch": "jdP5nG_switch",
			"switchOn": "jdP5nG_switchOn",
			"modelGroup": "jdP5nG_modelGroup",
			"providerName": "jdP5nG_providerName",
			"header": "jdP5nG_header",
			"modelName": "jdP5nG_modelName",
			"pending": "jdP5nG_pending",
			"footer": "jdP5nG_footer",
			"select": "jdP5nG_select",
			"switchThumb": "jdP5nG_switchThumb",
			"reset": "jdP5nG_reset",
			"input": "jdP5nG_input",
			"unavailable": "jdP5nG_unavailable",
			"limitsTitle": "jdP5nG_limitsTitle",
			"hint": "jdP5nG_hint",
			"headText": "jdP5nG_headText",
			"status": "jdP5nG_status",
			"groupTitle": "jdP5nG_groupTitle",
			"name": "jdP5nG_name",
			"card": "jdP5nG_card",
			"chevronOpen": "jdP5nG_chevronOpen",
			"field": "jdP5nG_field",
			"catalogError": "jdP5nG_catalogError",
			"route": "jdP5nG_route",
			"error": "jdP5nG_error",
			"model": "jdP5nG_model",
			"group": "jdP5nG_group",
			"advancedHint": "jdP5nG_advancedHint",
			"label": "jdP5nG_label",
			"body": "jdP5nG_body",
			"cardOpen": "jdP5nG_cardOpen",
			"warning": "jdP5nG_warning",
			"models": "jdP5nG_models",
			"chevron": "jdP5nG_chevron",
			"modelSelection": "jdP5nG_modelSelection",
			"notice": "jdP5nG_notice"
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
			unsaved: "未保存"
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
			unsaved: "Unsaved"
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
			ctx.effect(() => () => {
				unregister();
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