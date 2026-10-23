window.__ModuleLoader__.load({
	id: "dsh-channel-wechat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let client_store = require("@deepseek-ai/dsh-client-store");

		/** Host Loader entry id and settings namespace. */
		const NS = "dsh-channel-wechat";

		const formLabels = {
			unavailable: "该插件当前未加载，暂时无法配置。",
			readOnly: "本部署的设置为只读。",
			saveFailed: "本部署没有接受这些值，请修正后重试。",
			save: "保存",
			saving: "保存中…",
		};

		const overriddenLabel = "已覆盖";
		const resetLabel = "恢复默认";

		const hintStyle = {
			color: "var(--dsw-alias-label-tertiary)",
			margin: 0,
			fontSize: "12px",
			lineHeight: 1.5,
		};

		const titleStyle = {
			fontSize: "13px",
			lineHeight: 1.5,
		};

		const commandRowStyle = {
			display: "grid",
			gridTemplateColumns: "max-content 1fr",
			columnGap: "12px",
			alignItems: "baseline",
			color: "var(--dsw-alias-label-primary)",
			fontSize: "13px",
			lineHeight: 1.5,
		};

		const commandStyle = {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: "12px",
			whiteSpace: "nowrap",
		};

		const commandHintStyle = {
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: "12px",
			lineHeight: 1.5,
		};

		const slashCommands = [
			["/help、/?", "查看命令列表和用法"],
			["/new、/reset", "开启新会话；任务执行中需先发送 /stop"],
			["/stop、/abort", "停止当前任务或取消待确认任务"],
			["/status", "查看运行状态、当前会话、工作目录和任务超时"],
			["/pair <配对码>", "未配对时绑定 owner；配对成功后无需再发"],
		];

		const rowStyle = {
			color: "var(--dsw-alias-label-primary)",
			display: "flex",
			alignItems: "flex-start",
			justifyContent: "space-between",
			gap: "16px",
			fontSize: "13px",
			lineHeight: 1.5,
		};

		/**
		 * Boolean form field: stages "true"/"false" so the shared Save button
		 * writes it through the same path as the other fields.
		 */
		function booleanField(field) {
			return {
				field,
				format: (value) => (value === true ? "true" : "false"),
				parse: (text) => ({ kind: "set", value: text === "true" }),
			};
		}

		/**
		 * Integer field with the same bounds as the host schema, so the page
		 * rejects a value before the write rather than after it.
		 */
		function integerField(field, min, max) {
			return {
				field,
				format: (value) => (typeof value === "number" ? String(value) : ""),
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const value = Number(trimmed);
					return Number.isInteger(value) && value >= min && value <= max
						? { kind: "set", value }
						: undefined;
				},
			};
		}

		var WeChatChannelController = class {
			constructor(ctx) {
				this.form = ctx.configForms.get(NS);
				this.model = new primitives.SettingsFormModel(this.form, [
					booleanField("autoStart"),
					primitives.settingsTextField("dataDir"),
					primitives.settingsTextField("cwd"),
					integerField("chunkBytes", 200, 8000),
					integerField("taskTimeoutMs", 10000, 86400000),
					integerField("sessionIdleResetMinutes", 0, 43200),
					integerField("pollTimeoutMs", 5000, 120000),
					integerField("typingRefreshMs", 1000, 60000),
				]);
				this.store = client_store.createSnapshotStore(this.projection());
				this.unsubscribe = this.model
					.bind(() => this.model.shell())
					.subscribe(() => this.store.set(this.projection()));
			}

			projection() {
				const shell = this.model.shell();
				return {
					available: shell.available,
					writable: shell.writable,
					dirty: shell.dirty,
					invalid: shell.invalid,
					saving: shell.saving,
					failed: shell.failed,
					autoStart: this.model.field("autoStart").text === "true",
					dataDir: this.model.field("dataDir"),
					cwd: this.model.field("cwd"),
					chunkBytes: this.model.field("chunkBytes"),
					taskTimeoutMs: this.model.field("taskTimeoutMs"),
					sessionIdleResetMinutes: this.model.field("sessionIdleResetMinutes"),
					pollTimeoutMs: this.model.field("pollTimeoutMs"),
					typingRefreshMs: this.model.field("typingRefreshMs"),
				};
			}

			inject() {
				return {
					hooks: { wechatChannel: this.store },
					edit: (field, text) => this.model.actions().edit(field, text),
					resetField: (field) => this.model.actions().resetField(field),
					setAutoStart: (enabled) =>
						this.model.actions().edit("autoStart", enabled ? "true" : "false"),
					save: () => this.model.save(),
					discard: () => this.model.actions().discard(),
				};
			}

			dispose() {
				this.unsubscribe();
				this.model.dispose();
			}
		};

		/**
		 * Render the settings card, or the one-liner the Plugins grid shows.
		 * @param props - slot view, hooks, staged-form actions, and form.
		 * @returns the summary text or the form.
		 */
		function WeChatChannelCard(props) {
			const state = props.useWechatChannel((snapshot) => snapshot);
			if (props.view === "summary") {
				return "在微信里和本机的 dsh 对话，接收任务进度和结果。";
			}

			const disabled = !state.writable || state.saving;
			const field = (id, label, name, hint, invalidLabel, options) => {
				const extra = options || {};
				return react_jsx_runtime.jsx(
					primitives.SettingsValueField,
					{
						id,
						label,
						hint,
						overriddenLabel,
						resetLabel,
						invalidLabel,
						numeric: extra.numeric === true,
						disabled: disabled || extra.readOnly === true,
						...state[name],
						onEdit: (text) => props.edit(name, text),
						onReset: () => props.resetField(name),
					},
				);
			};

			return react_jsx_runtime.jsx(primitives.SettingsForm, {
				labels: formLabels,
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [
					react_jsx_runtime.jsxs(
						"div",
						{
							style: rowStyle,
							children: [
								react_jsx_runtime.jsxs("div", {
									children: [
										react_jsx_runtime.jsx("div", {
											style: titleStyle,
											children: "启用微信通道",
										}),
										react_jsx_runtime.jsx("div", {
											style: hintStyle,
											children: "关闭后停止 iLink 长轮询，微信不再响应消息。",
										}),
									],
								}),
								react_jsx_runtime.jsx(primitives.Switch, {
									checked: state.autoStart,
									label: "启用微信通道",
									disabled,
									onChange: props.setAutoStart,
								}),
							],
						},
					),
					react_jsx_runtime.jsx("p", {
						style: { ...hintStyle, margin: "4px 0" },
						children:
							"保存后：cwd、分片大小、任务超时、会话闲置重置和输入状态刷新间隔即时生效；autoStart、数据目录或长轮询超时会重启通道并取消正在执行的微信任务。",
					}),
					field(
						"plugin-config-wechat-cwd",
						"工作目录",
						"cwd",
						"微信新建会话的工作目录，支持 ~；会话会归入该目录对应的工作区。",
						"请输入目录。",
					),
					field(
						"plugin-config-wechat-chunk-bytes",
						"单条消息字节上限",
						"chunkBytes",
						"超长回复按此大小分条发送，范围 200–8000。",
						"请输入 200–8000 的整数。",
						{ numeric: true },
					),
					field(
						"plugin-config-wechat-task-timeout",
						"任务超时（毫秒）",
						"taskTimeoutMs",
						"单次任务的最长执行时间，范围 10000–86400000。",
						"请输入 10000–86400000 的整数。",
						{ numeric: true },
					),
					field(
						"plugin-config-wechat-session-idle",
						"会话闲置重置（分钟）",
						"sessionIdleResetMinutes",
						"超过该时长没有收到任务时，下一条消息自动开启新会话；默认 720（12 小时），0 表示关闭。范围 0–43200（30 天）。",
						"请输入 0–43200 的整数。",
						{ numeric: true },
					),
					field(
						"plugin-config-wechat-poll-timeout",
						"长轮询超时（毫秒）",
						"pollTimeoutMs",
						"iLink 长轮询等待时间，范围 5000–120000；保存后重启通道。",
						"请输入 5000–120000 的整数。",
						{ numeric: true },
					),
					field(
						"plugin-config-wechat-typing-refresh",
						"输入状态刷新间隔（毫秒）",
						"typingRefreshMs",
						"“正在输入”状态的刷新间隔，范围 1000–60000。",
						"请输入 1000–60000 的整数。",
						{ numeric: true },
					),
					field(
						"plugin-config-wechat-data-dir",
						"数据目录",
						"dataDir",
						"保存配对状态和登录凭据；修改后需要重新配对和扫码登录，因此只读。",
						"",
						{ readOnly: true },
					),
					react_jsx_runtime.jsxs("div", {
						style: {
							borderTop:
								"1px solid var(--dsw-alias-border-secondary, rgba(128, 128, 128, 0.2))",
							marginTop: "8px",
							paddingTop: "12px",
							display: "grid",
							gap: "6px",
						},
						children: [
							react_jsx_runtime.jsx("div", {
								style: titleStyle,
								children: "微信斜杠命令",
							}),
							react_jsx_runtime.jsx("p", {
								style: { ...hintStyle, margin: 0 },
								children:
									"在微信里直接发送，命令不区分大小写；普通文字会作为任务交给本机 dsh。涉及改文件、执行命令的任务会先给出【任务理解】，回复「继续」后才执行。",
							}),
							...slashCommands.map(([command, description]) =>
								react_jsx_runtime.jsxs(
									"div",
									{
										style: commandRowStyle,
										children: [
											react_jsx_runtime.jsx("code", {
												style: commandStyle,
												children: command,
											}),
											react_jsx_runtime.jsx("span", {
												style: commandHintStyle,
												children: description,
											}),
										],
									},
									command,
								),
							),
						],
					}),
				],
			});
		}

		const inject = ["slots", "configForms"];

		function apply(ctx) {
			const controller = new WeChatChannelController(ctx);
			ctx.effect(
				() => () => controller.dispose(),
				"wechat-channel: settings form",
			);
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], () =>
						ctx.slots.inject("plugins.item", () =>
							ctx.slots.register(
								{
									name: "plugins.item",
									id: NS,
									order: 30,
									label: () => "微信通道",
									inject: () => controller.inject(),
								},
								WeChatChannelCard,
							),
						),
					),
				"wechat-channel: settings page",
			);
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
