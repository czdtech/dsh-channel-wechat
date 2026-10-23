# 保守切换与回滚

以下命令用于获批后的本机切换与回滚。任何时刻都不得同时运行 Python 桥和插件。

本文是运行手册模板：把 `REPO`、`OLD_BRIDGE`、`AGENT`、`OLD_AGENT` 和示例 `cwd`
换成你自己的部署值后再执行。标签名和目录名都是本机私有信息，不要提交真实值。

```bash
REPO="$HOME/code/dsh-channel-wechat"            # 本仓库
OLD_BRIDGE="$HOME/code/dsh-wechat"              # 旧 Python 桥（回滚材料）
AGENT="gui/$(id -u)/com.example.dsh-web"        # dsh web host 的 LaunchAgent
OLD_AGENT="gui/$(id -u)/com.example.dsh-wechat" # Python 桥的 LaunchAgent
```

## 切换前检查

```bash
cd "$REPO"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
ps -axo pid=,ppid=,command= | grep -F "$OLD_BRIDGE" | grep -v grep
```

3080 返回 `401` 表示服务存活且需要认证。Python 桥在进程列表中出现时，不得启用插件。

备份凭据和 owner 状态；备份目录必须保持私有：

```bash
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$HOME/.dsh-wechat/backups/$STAMP"
mkdir -p -m 700 "$BACKUP"
cp -p "$HOME/.dsh-wechat/token.json" "$BACKUP/token.json"
cp -p "$HOME/.dsh-wechat/state.json" "$BACKUP/state.json"
chmod 600 "$BACKUP/token.json" "$BACKUP/state.json"
```

不要打印或校验文件内容。

## 切换

先获得停止旧桥、安装包、修改 web profile 和重启 web host 的明确批准。

1. 停止 Python 桥并确认退出：

```bash
launchctl kill SIGTERM "$OLD_AGENT"
for PID in $(pgrep -f "$OLD_BRIDGE/(supervise\.sh|\.venv/bin/python -m dsh_wechat)" || true); do
  ps -p "$PID" -o pid=,command=
done
```

若仍列出进程，停止切换，不能启动插件。

2. 安装本地包。`-w` 是 pnpm workspace 根的要求：

```bash
dsh plugin --profile web add "$REPO" --save-exact -w
```

若报 `ERR_PNPM_UNEXPECTED_STORE`，说明调用的 pnpm 与 profile 不一致。使用
`~/.dsh/profiles/web/node_modules/.modules.yaml` 里记录的 pnpm 版本，不要用较旧
pnpm 重装现有依赖树。

3. 确认组合树。`dsh plugin add` 会把包加入 profile 的 `dsh.profile.bundles`；
插件包自带的 `cordis.patch.yml` 已经以 `autoStart: false` 插入该条目。不要再向
`~/.dsh/profiles/web/cordis.patch.yml` 添加 `insert`，否则会产生重复 id：

```bash
dsh --profile web --dump-config > /tmp/dsh-web-config.txt
grep -A12 'dsh-channel-wechat' /tmp/dsh-web-config.txt
```

4. 重启 web host；此时插件保持关闭：

```bash
launchctl kickstart -k "$AGENT"
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
```

5. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加同 id 的配置覆盖（不是 insert）：

```yaml
- id: dsh-channel-wechat
  config:
    autoStart: true
    dataDir: '~/.dsh-wechat'
    cwd: '~/work/my-agent'
    chunkBytes: 1800
    taskTimeoutMs: 1800000
    pollTimeoutMs: 30000
    typingRefreshMs: 5000
```

覆盖会替换该条 `config`，未写字段使用插件默认值；建议写全，避免未来默认值变化。
也可以在 Web 控制台「插件 → 微信通道」的 Settings UI 中修改并保存，DSH 会向同一文件写入覆盖；运行中保存 `autoStart`、`pollTimeoutMs` 等重启字段会重启通道并取消正在执行的微信任务。

6. 重启并验证：3080 返回 `401`，宿主出现到 `ilinkai.weixin.qq.com` 的持久
443 连接，`web.log` 出现 `[wechat-channel] started paired=yes polling=yes` 且无未捕获异常。以下检查不会打印 token/state 内容：

```bash
launchctl kickstart -k "$AGENT"
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
PID="$(launchctl print "$AGENT" | awk '/pid =/{print $3; exit}')"
dscacheutil -q host -a name ilinkai.weixin.qq.com
lsof -nP -a -p "$PID" -iTCP -sTCP:ESTABLISHED
```

7. 依次从 owner 微信发送 `/status`、一条普通文本、`/new`，再启动一个长任务并用
`/stop` 中止。非 owner 不应收到任何回复。

若 token 已失效，先确认 Python 桥已停止，再运行：

```bash
cd "$REPO"
pnpm build
pnpm login -- ~/.dsh-wechat
```

## 3 分钟回滚

计时后按顺序执行：

1. 把 web profile 中该条覆盖改成 `disabled: true`（彻底卸载插件），或把
`autoStart` 改回 `false`（保留插件但不轮询），然后重启 host：

```bash
launchctl kickstart -k "$AGENT"
```

2. 确认 3080 存活，并确认插件不再轮询：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
PID="$(launchctl print "$AGENT" | awk '/pid =/{print $3; exit}')"
lsof -nP -a -p "$PID" -iTCP -sTCP:ESTABLISHED
ps -axo pid=,ppid=,command= | grep -F "$OLD_BRIDGE" | grep -v grep || true
```

3. 只有当前 token/state 损坏时，才从切换前备份恢复；正常回滚不要覆盖数据。

4. 启动旧桥并确认只有一个实例：

```bash
launchctl kickstart "$OLD_AGENT"
ps -axo pid=,ppid=,command= | grep -F "$OLD_BRIDGE" | grep -v grep
```

5. 从 owner 微信发送一条测试消息并停止计时。目标不超过 3 分钟。

Python 实现、虚拟环境、LaunchAgent 和备份至少保留 2 周；任何删除都需另行批准。附件、审批和主动推送不在本次范围内。
