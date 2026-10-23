# M0 验证结论

验证环境为 DSH `0.2.1-rc.2`，使用隔离 web host。

- `ctx.sessionController.create(request)` 返回 `{ sessionId }`。
- `prompt(request, signal)` 接受 session、requestId、queue/steer 模式和 content。
- `follow(request, signal)` 返回惰性 `AsyncIterable`。必须先取得 iterator，并 `await iterator.next()` 收到首帧 `snapshot`，再调用 `prompt`，否则会漏事件。
- 真实 prompt 已完成并收到 `turn/end`。
- `cancel({ sessionId })` 返回 accepted，事件流随后收到 `turn/end`。
- 对已有非空 sessionId 再调用 `create({ sessionId })` 会返回不同 session，不能用于恢复。
- 持久 session 应先 `inspect` 确认存在，随后仍按上一条先取 `follow` 的首帧 `snapshot` 再 `prompt`；不存在时才创建新 session。
- effect dispose 已验证成功。
- 隔离实例需要继承 secrets 才能获得可用模型；验证过程未记录或写入任何 secret。
