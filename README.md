# dsh-channel-wechat

> **非官方声明**：本项目是独立开发者的第三方插件，与腾讯公司无关，也未获得其认可或授权；
> 「微信 / WeChat」是腾讯公司的商标。插件调用腾讯**官方开放**的微信 Bot 通道 iLink（域名
> `ilinkai.weixin.qq.com`，接口见微信开放平台的智能对话 / ClawBot 文档），不含逆向的私有
> 通讯协议，也不打包腾讯的代码或素材。
>
> 使用前请自行阅读并遵守《微信软件许可及服务协议》与所在地法规。微信对个人账号的自动化行为
> 保留处置权利，官方接口本身也可能收紧、变更或撤销绑定；账号与数据风险由使用者自行承担。
> 本软件按 MIT 协议「原样」提供，不带任何担保。

![ci](https://github.com/czdtech/dsh-channel-wechat/actions/workflows/ci.yml/badge.svg)

DeepSeek Harness 的个人微信 host 插件。它在 dsh 进程内长轮询 iLink，把你本人的微信消息作为任务交给本机 dsh 会话，再把回答分片发回微信。包名与插件名均为 `dsh-channel-wechat`，入口导出 `name`、`inject`、`Config`、`apply`，仅注入 `sessionController`。

任务确认流程由独立插件 `dsh-task-confirm` 提供，本包不依赖它：两者只通过宿主服务名 `taskConfirm` 协作，确认插件缺席时微信通道照常工作。

能力范围：

- 微信配对、命令、单飞、去重、分片、发送重试和额度控制；
- iLink 六个端点、扫码登录、游标持久化和 `-14` 失效处理；
- DSH 持久会话检查、惰性 `follow()` 首帧同步、prompt、cancel；
- 会话闲置重置，以及会话在电脑端被归档后的自动换新会话；
- 完整卸载时中止轮询和任务、结束 follow、清理定时器并关闭 HTTP 连接；
- Web 控制台「插件 → 微信通道」Settings UI，支持即时生效与重启生效字段。

附件、审批卡片和主动推送不在本项目范围内。

## 依赖要求

- 已安装 `dsh`，并能用 `dsh --profile <name>` 启动一个 host（本项目在 `0.2.1-rc.2` 上开发）；
- Node `>=20.18.1`（`AbortSignal.any` 与 undici 7 的最低要求）；
- 一个可以扫码的个人微信。iLink 凭据只落在本机数据目录，`0600` 权限，不进日志与输出。

## 安装

装进某个 dsh profile（名字按你的部署，下面以 `web` 为例）：

```bash
dsh plugin --profile web add github:czdtech/dsh-channel-wechat -w
```

安装只写 profile 的依赖树，需要重启该 profile 的 host 才会加载插件。

`lib/` 编译产物随仓库一起发布，所以从 GitHub 安装**不需要编译**，也不会碰到 pnpm 的构建脚本授权提示。改完 `src/` 记得 `pnpm build` 后把 `lib/` 一并提交。

插件自带的 `cordis.patch.yml` 以 `autoStart: false` 声明自己，所以**装上不等于上线**：安装后它只会出现在插件列表里，不会开始轮询。真正启用有两条路：

- Web 控制台「插件 → 微信通道」打开「启用微信通道」并保存；
- 或在该 profile 的 `cordis.patch.yml` 里追加同 id 的配置覆盖，见 `docs/cutover.md`。

clone 本仓库到本地后同样可以直接安装：`dsh plugin --profile web add <本仓库绝对路径>`。若你的 profile 目录是 pnpm workspace 根，pnpm 会要求补一个 `-w`。

## 开发验证

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

测试完全使用临时目录与 mock，不连接 iLink，不读取真实凭据。

### 提交前泄露拦截

仓库带了一个 pre-commit 钩子，只扫描**本次暂存的新增行**，命中本机绝对路径、本机用户名、
LaunchAgent 标签、`wxid_`、配对码、`?token=` / `Bearer` 长串、GitHub / OpenAI 令牌形态、
私钥块，或暂存了 `token.json`、`state.json`、`wx_qr.*`、`.env` 这类文件时拒绝提交。
它只报告文件名与命中条数，不打印原文——把命中内容打印出来等于再添一次泄露。

```bash
cp scripts/git-hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

钩子只防新提交，改不了已有历史；确认误报时可以用 `git commit --no-verify` 跳过。
判定标准很简单：凡是能从 `git log -p` 里读到「某台机器上的目录结构」或「某个账号的凭据」的内容，都不该出现在公开历史里。

同一套规则也在 CI 上以 `--all` 模式跑整棵已提交的树，所以漏网的提交至少会在下一次 PR 上被翻出来。

### 提交身份拦截

上面扫的是文件内容，但提交元数据一样会泄露：`git log --format='%ae %ce'` 在公开仓库里就是作者邮箱列表，
而内容扫描看不见它。钩子因此还检查 `AUTHOR`/`COMMITTER` 邮箱是否等于本仓库发布用的地址：

```bash
git config wechat.expectedAuthorEmail '<你的 noreply 地址>'   # 仓库级，不写全局
```

这个期望值只从仓库本地配置读取，脚本里不写死任何地址——没设这项的人（包括外部贡献者）
完全感觉不到这条检查存在。它也不进 CI：别人的提交身份不该由本仓库裁决。
注意它跑在「暂存区为空就提前退出」之前，因为 `git commit --amend --reset-author`
这类只改元数据的提交恰恰没有暂存行，也正是第一次把真实邮箱推上去的那条路径。

### CI

`.github/workflows/ci.yml` 在 Node `20.x`（engines 下限）和 `24.x`（作者本机版本）上跑：
`pnpm install --frozen-lockfile` → `typecheck` → `test` → 重新 `build` 并要求 `lib/` 零差异 → 泄露拦截全树扫描。

`lib/` 是随仓库发布的编译产物，所以那条 drift 检查是有意义的：改完 `src/` 忘记 `pnpm build` 就提交，CI 会直接告诉你 `lib/` 过期了，而不是让人装到一个和源码不一致的产物。
pnpm 版本钉在 workflow 里（`9.15.2`，对应 `lockfileVersion: 9.0`），没有写进 `package.json` 的 `packageManager`——那个字段会驱动 Corepack，而本项目的插件是装进 dsh profile 的，profile 用的是另一个 pnpm。

### 合并规则

`main` 上有两条 ruleset（Settings → Rules → Rulesets 可查）：

- `pr-needs-green-ci`：`required_status_checks`，要求 `verify (20.x)` 与 `verify (24.x)` 全绿、且分支已跟上 `main`。Owner 在这条上配了 `always` bypass，所以维护者的直接 `git push origin main` 照常可用；对其他人它拦 PR 合并。
- `main-no-deletion`：`deletion`，不给任何 bypass，谁都删不掉 `main`。

一条实测结论，配置时值得注意：`required_status_checks` 不只拦 PR 合并，也会拦直接 `git push`——不加 bypass 时，一个只改文档的提交会被 `push declined due to repository rule violations` 弹回来。

强推、分支更新与创建限制暂未配置：发布初期还需要修正历史，历史定稿后再收紧。

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

先确认**没有别的进程在用同一个微信 token 轮询**（例如另一份旧实现或第二个 host 实例）——同一 token 双轮询会互相抢消息。然后构建并运行登录：

```bash
pnpm install
pnpm build
pnpm login -- ~/.dsh-wechat
```

已作为插件安装到 profile 里时，直接跑安装目录中的登录入口即可（数据目录参数与上面一致）：

```bash
node ~/.dsh/profiles/web/node_modules/dsh-channel-wechat/lib/login.js ~/.dsh-wechat
```

终端会显示二维码，并以 `0600` 权限写入 `wx_qr.png`；程序不会输出 token。

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

启用、验证与回滚范例见 `docs/cutover.md`。

## 安全模型

- 只有配对的 owner 账号会被响应；其他微信号发来的消息静默丢弃，日志与输出里不出现任何微信 owner 标识。
- 配对码是 6 位大写十六进制，比较走 SHA-256 + `timingSafeEqual`；配对成功后不再接受配对码。
- iLink token 与通道状态落在 `dataDir`（目录 `0700`，文件 `0600`，临时文件 + 原子替换）；损坏时回退为未配对。
- 未捕获异常会拖垮整个 host，因此通道把取消、超时、卸载都做成有界清理。

## 许可

MIT，见 `LICENSE`。
