# 行为对齐（Python 参考实现）

## 测试映射

| Python 用例 | TypeScript 用例 |
| --- | --- |
| `test_plain_heading` | `textutil: plain heading` |
| `test_leading_markdown_and_whitespace` | `textutil: leading markdown and whitespace` |
| `test_other_text` | `textutil: other text` |
| `test_links_and_images` | `textutil: links and images` |
| `test_lists_and_headings` | `textutil: lists and headings` |
| `test_code_fence_is_preserved` | `textutil: code fence is preserved` |
| `test_collapses_blank_lines` | `textutil: collapses blank lines` |
| `test_empty` | `textutil: empty` |
| `test_short_text_unchanged` | `textutil: short text unchanged` |
| `test_respects_byte_limit` | `textutil: respects byte limit` |
| `test_hard_split_long_line` | `textutil: hard split long line` |
| `test_prefers_newlines_and_preserves_content` | `textutil: prefers newlines and preserves content` |
| `test_text_before_tool` | `events: text before tool` |
| `test_text_after_tool_is_ignored` | `events: text after tool is ignored` |
| `test_no_tool_call` | `events: no tool call` |
| `test_invalid_content` | `events: invalid content` |
| `test_joins_multiple_text_blocks` | `events: joins multiple text blocks` |
| `test_round_trip_and_permissions` | `events: state round trip and permissions` |
| `test_corrupt_file_falls_back_to_unpaired` | `events: corrupt state falls back to unpaired` |
| `test_pairing_rejects_wrong_code_and_ignores_strangers` | `bridge: pairing rejects wrong code and ignores strangers` |
| `test_task_sends_understanding_then_answer` | `bridge: task merges the pre-tool understanding into the final reply` |
| `test_new_session_resets_state` | `bridge: new session resets state` |

以上 22 条逐项移植。另有 iLink、每 token 10 次额度和生命周期测试。

## 行为约束

- 继续直接读写 snake_case 的 `token.json` 和 `state.json`。
- 配对码为 6 位大写十六进制；规范化后分别做 SHA-256，再使用 `timingSafeEqual`。
- 未配对非 `/pair` 消息和已配对非 owner 消息静默丢弃；日志只保留 wxid 后 6 位。
- 配对错误最多回复 5 次，固定回复和命令文本与 Python 版一致。
- 消息去重上限 5000，超限一次删除最早 2000。
- UTF-8 分片预留 24 字节，多片使用 `[i/n]`，片间隔 0.2 秒；单片失败最多 3 次，间隔 1.5 秒。
- 每个 `context_token` 最多发送 10 次，告警占用额度且预留自己的发送位置。
- 只从含 `tool-call` 的 assistant/message 中提取首个工具前文本；仅 `【任务理解】` 前缀可提前发送。
- 含工具调用的中间 assistant 文本不进入最终回答；普通无工具回答正常汇总。
- `follow()` 必须先读取 snapshot，再提交 prompt。
- 持久 session 使用 `inspect` 后直接 prompt；恢复失败时创建新 session 并提示。
- `/stop`、超时和插件卸载都会调用 `cancel` 并中止本轮 follow。
