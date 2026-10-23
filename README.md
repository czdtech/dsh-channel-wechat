# dsh-channel-wechat

DeepSeek Harness 的个人微信 host 插件。包名与插件名均为 `dsh-channel-wechat`，入口导出 `name`、`inject`、`Config`、`apply`，仅注入 `sessionController`。

任务确认流程由独立插件 `dsh-task-confirm` 提供，本包不依赖它：两者只通过宿主服务名 `taskConfirm` 协作，确认插件缺席时微信通道照常工作。

当前完成 M1-M3 的离线实现：

- 兼容 Python 版 `~/.dsh-wechat/token.json` 与 `state.json`；
- 微信配对、命令、单飞、去重、分片、发送重试和额度控制；
- iLink 六个端点、扫码登录、游标持久化和 `-14` 失效处理；
- DSH 持久会话检查、惰性 `follow()` 首帧同步、prompt、cancel；
- 完整卸载时中止轮询和任务、结束 follow、清理定时器并关闭 HTTP 连接；
- Web 控制台「插件 → 微信通道」Settings UI，支持即时生效与重启生效字段。

M4 的附件、审批和主动推送不在本项目范围内。

## 开发验证

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

测试完全使用临时目录与 mock，不连接 iLink，不读取真实凭据。

## 配置

`cordis.patch.yml` 默认保持关闭：

```yaml
config:
  autoStart: false
  dataDir: '~/.dsh-wechat'
  cwd: '~'
  chunkBytes: 1800
  taskTimeoutMs: 1800000
  sessionIdleResetMinutes: 720
  pollTimeoutMs: 30000
  typingRefreshMs: 5000
```

默认值保持可分发：`cwd` 落在用户主目录，`dataDir` 落在 `~/.dsh-wechat`。需要固定到某个项目目录时，在 profile 的 `cordis.patch.yml` 里显式写 `cwd`，例如 `cwd: '~/work/my-agent'`。

`dataDir` 与 `cwd` 会通过 `@deepseek-ai/dsh-home-paths` 展开并解析为绝对路径。数据目录权限为 `0700`，`token.json` 和 `state.json` 采用临时文件、`0600` 权限和原子替换。

### Settings UI

打开 Web 控制台的「插件」页，在「微信通道」卡片进入详情，即可直接编辑配置并保存。所有字段均为 DSH volatile 配置，保存由 DSH 写入当前 profile 的 `cordis.patch.yml`，无需手工编辑 YAML。

| 字段 | 默认值 | 范围 / 说明 | 生效方式 |
| --- | --- | --- | --- |
| 启用微信通道（`autoStart`） | `false` | 开关 | 保存后启动或停止通道 |
| 工作目录（`cwd`） | `~` | 支持 `~` | 即时生效 |
| 单条消息字节上限（`chunkBytes`） | `1800` | 200–8000 | 即时生效 |
| 任务超时（`taskTimeoutMs`） | `1800000` | 10000–86400000 毫秒 | 即时生效 |
| 会话闲置重置（`sessionIdleResetMinutes`） | `720` | 0–43200 分钟；0 = 关闭 | 即时生效 |
| 长轮询超时（`pollTimeoutMs`） | `30000` | 5000–120000 毫秒 | 重启通道 |
| 输入状态刷新间隔（`typingRefreshMs`） | `5000` | 1000–60000 毫秒 | 即时生效 |
| 数据目录（`dataDir`） | `~/.dsh-wechat` | 只读 | 需手工配置 |

「立即生效」的字段由下一次微信任务读取；`autoStart`、`pollTimeoutMs` 和 `dataDir` 的变更会重启通道，**正在执行的微信任务会被取消**。`dataDir` 在 UI 中只读，因为更换目录会丢失配对与登录状态。

微信默认在同一个会话里连续对话，直到你发送 `/new`。设置「会话闲置重置」后，如果距离上一次任务结束已超过该时长，下一条消息会自动创建新会话，并先回复一条“（闲置超过 X，已开启新会话）”。计时从任务结束时开始，长任务执行期间不会重置；`0` 表示关闭自动重置。升级前已有的会话没有活动时间记录，会先沿用一次，任务结束后开始计时。

微信创建或恢复的会话会自动挂到 `cwd` 对应的工作区（该目录尚无工作区时会自动创建），因此在 Web 控制台中显示在对应工作区下，而不是「未分组」。

DSH 的配置写入器会显式保存整组字段，因此数值等于默认值时仍可能显示「已覆盖」，这是 DSH 的展示行为，不影响实际取值。

## 扫码登录

确保 Python 桥已经停止且进程消失后，构建并运行：

```bash
pnpm build
pnpm login -- ~/.dsh-wechat
```

终端会显示二维码，并以 `0600` 权限写入 `wx_qr.png`；程序不会输出 token。不要同时运行 Python 桥和插件轮询。

## 使用

首次启动会在本机输出 6 位配对码。在微信中发送：

```text
/pair ABC123
```

配对后可用以下命令（不区分大小写）：

| 命令 | 别名 | 说明 |
| --- | --- | --- |
| `/help` | `/?` | 查看命令列表和用法 |
| `/new` | `/reset` | 开启新会话；任务执行中需先发送 `/stop` |
| `/stop` | `/abort` | 停止当前任务；空闲时用于取消等待确认的任务 |
| `/status` | — | 查看运行状态（空闲 / 执行中 / 待确认）、当前会话、模型预设、工作目录、任务超时与依赖连接状态 |
| `/pair <配对码>` | — | 仅未配对时使用；配对成功后无需再发 |

直接发送普通文字会作为任务交给本机 DeepSeek Harness。Settings UI 的「微信通道」详情页底部也会展示同一份命令说明。非 owner 消息静默丢弃。

## 任务确认

需要改动文件、执行命令或调用子代理的任务分两阶段执行，微信和 Web 控制台行为一致：

1. **理解阶段**：模型可以先用只读工具调研（`read`、`grep`、`glob`、`web_fetch` 等），然后输出一段以「【任务理解】」开头的消息，写明目标、约束、做法和产出，并结束本轮。修改类工具此时会被宿主拒绝，模型无法抢跑。
2. **执行阶段**：你在下一条消息里回复「继续」「确认」或直接给出修正；模型按确认后的理解执行。回复「取消」则放弃本次任务。

纯问答或不需要动手的任务直接回答，不进入确认流程。子代理会话不受影响，避免无人可确认时卡死。

确认状态按会话保存在宿主内存中，DSH 重启后清空；微信的闲置重置会跳过等待确认的会话，避免确认时换掉会话。确认提示文本、只读工具白名单和取消关键词都在 `dsh-task-confirm` 中配置，默认值见其 README。

若正在等待确认的会话在电脑端被归档，通道会取消该确认并明确提示「待确认的任务已取消，已开启新会话」，不会让确认凭空消失。任务执行到一半时在电脑端归档会话，通道会收到 `workspace/session-stop` 并主动取消本轮。若宿主仍以 `blocked` 结束（例如归档发生在通道判断之前），通道会自动清掉旧会话并提示重发，无需手动 `/new`。

## 运行观测

通道把关键生命周期写入 stdout，`~/.dsh/logs/web.log`（0600）中可见：

```text
[wechat-channel] started paired=yes polling=yes
[wechat-channel] restart requested
[wechat-channel] stopped
[wechat-channel] turn blocked, session rotated
[wechat-channel] session archived, cancelling turn
PAIRING_CODE=XXXXXX      # 仅未配对时
PAIRING_OK=yes
```

这些行不含 owner 标识、会话 id 或凭据。插件自身的 info/warn 日志走宿主日志通道，不写入 `web.log`。

## 设计取舍

- **iLink 游标先落盘、消息后处理**：进程在两者之间崩溃会丢掉该批消息，但不会重复执行任务。对执行本机操作的任务而言，重复执行比丢消息更危险。
- **配对码经 stdout 进入 `web.log`**：该文件是 0600，与 `token.json` 同一信任边界，且配对成功后不再输出；配对码只在未配对期间有效。
- **每个 `context_token` 最多 10 条消息**：超长回答会被截断，额度接近耗尽时会先附一条提示占用最后一格；`/new` 重置当前会话的额度。
- **`cwd` 默认值是 `~`**：插件不内置任何个人目录；把 `cwd` 固定到项目目录后，微信会话归到该目录对应的工作区，而不是「未分组」。

切换与回滚步骤见 `docs/cutover.md`。任何 DSH 配置或权限变更都必须先获得用户批准。
