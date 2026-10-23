import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { WeChatChannel, type ChannelDependencies } from '../src/channel.ts'
import type { Config } from '../src/index.ts'
import { AuthExpiredError, type IlinkProtocolClient, type InboundMessage, type LoginQr, type LoginStatus } from '../src/ilink.ts'
import { StateStore } from '../src/pairing.ts'

type SessionService = NonNullable<ChannelDependencies['sessionController']>

class FakeClient implements IlinkProtocolClient {
  readonly sent: Array<{ userId: string; contextToken: string; text: string }> = []
  closed = false
  attempts = 0
  failuresRemaining = 0
  sendAuthExpired = false
  typingTicket = ''
  typingCancelAuthExpired = false

  hasToken(): boolean { return false }
  getBotQr(): Promise<LoginQr> { throw new Error('unused') }
  getQrStatus(): Promise<LoginStatus> { throw new Error('unused') }
  acceptLogin(): void { throw new Error('unused') }
  getUpdates(): Promise<{ cursor: string; messages: InboundMessage[] }> { throw new Error('unused') }
  getTypingTicket(): Promise<string> { return Promise.resolve(this.typingTicket) }
  sendTyping(_userId: string, _ticket: string, cancel: boolean): Promise<void> {
    if (cancel && this.typingCancelAuthExpired) return Promise.reject(new AuthExpiredError('expired'))
    return Promise.resolve()
  }
  sendText(userId: string, text: string, contextToken: string): Promise<void> {
    this.attempts += 1
    if (this.sendAuthExpired) return Promise.reject(new AuthExpiredError('expired'))
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      return Promise.reject(new Error('transient'))
    }
    this.sent.push({ userId, contextToken, text })
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

function setup(
  context: TestContext,
  sessionOverrides: Partial<SessionService> = {},
  workspaceRegistry?: ChannelDependencies['workspaceRegistry'],
  options: {
    config?: Partial<Config>
    now?: () => Date
    taskConfirm?: ChannelDependencies['taskConfirm']
    settleTimeoutMs?: number
    initialState?: { ownerId: string; sessionId: string | null; pairedAt: string; lastActiveAt: string }
    onEvent?: (name: string, listener: (request: { sessionId?: string }) => void) => () => void
  } = {},
): {
  channel: WeChatChannel
  client: FakeClient
  store: StateStore
  dir: string
  dispose: () => Promise<void>
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  const store = new StateStore(dir)
  if (options.initialState) store.saveState(options.initialState)
  const client = new FakeClient()
  let snapshotRead = false
  const sessions = {
    create: async () => ({ sessionId: 'session-test' }),
    inspect: async () => ({}),
    prompt: async () => {
      assert.equal(snapshotRead, true)
      return { accepted: true as const }
    },
    cancel: () => ({ accepted: true as const }),
    follow: () => ({
      async *[Symbol.asyncIterator]() {
        snapshotRead = true
        yield { type: 'snapshot' }
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            data: { message: { content: [
              { type: 'text', text: '【任务理解】看一下磁盘' },
              { type: 'tool-call', toolName: 'bash' },
              { type: 'text', text: '不应进入正文' },
            ] } },
          },
        }
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: '完成：看一下磁盘' }] } },
          },
        }
        yield { type: 'event', event: { type: 'turn/end', data: {} } }
      },
    }),
    ...sessionOverrides,
  }
  const config: Config = {
    autoStart: true,
    dataDir: dir,
    cwd: dir,
    chunkBytes: 1800,
    taskTimeoutMs: 30_000,
    pollTimeoutMs: 30_000,
    typingRefreshMs: 5_000,
    sessionIdleResetMinutes: 720,
    ...options.config,
  }
  const logger = { info() {}, warn() {}, error() {}, debug() {}, success() {} }
  const ctx = {
    logger: () => logger,
    ...(options.onEvent ? { on: options.onEvent } : {}),
  } as unknown as Context
  const dependencies: ChannelDependencies = {
    client,
    store,
    sessionController: sessions as unknown as NonNullable<ChannelDependencies['sessionController']>,
    ...(workspaceRegistry ? { workspaceRegistry } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.taskConfirm ? { taskConfirm: options.taskConfirm } : {}),
    ...(options.settleTimeoutMs ? { settleTimeoutMs: options.settleTimeoutMs } : {}),
    sleep: async () => undefined,
    announce: () => undefined,
  }
  const channel = new WeChatChannel(ctx, config, dependencies)
  const dispose = channel.start()
  context.after(async () => {
    await dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  return { channel, client, store, dir, dispose }
}

function message(id: number, user: string, text: string, contextToken = `ctx-${id}`): InboundMessage {
  return {
    messageId: String(id),
    fromUserId: user,
    contextToken,
    messageType: 1,
    text,
  }
}

async function waitIdle(channel: WeChatChannel): Promise<void> {
  const deadline = Date.now() + 2_000
  while (channel.isBusy() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(channel.isBusy(), false, 'turn did not finish')
}

/**
 * A follow stream that opens with `snapshot` then parks, imitating a hung turn.
 * The gate is released when the test ends: a generator suspended on a promise
 * that never settles outlives the test, and the runner cancels every remaining
 * test in the file over it.
 */
function hungFollow(context: TestContext): ReturnType<SessionService['follow']> {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  context.after(() => {
    release()
    return new Promise((resolve) => setImmediate(resolve))
  })
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot' }
      await gate
    },
  } as ReturnType<SessionService['follow']>
}

test('bridge: pairing rejects wrong code and ignores strangers', async (context) => {
  const { channel, client } = setup(context)
  await channel.dispatch(message(1, 'stranger', 'hello'))
  assert.equal(client.sent.length, 0)
  await channel.dispatch(message(2, 'stranger', '/pair WRONG'))
  assert.equal(client.sent.at(-1)?.text, '配对码不正确。')
  await channel.dispatch(message(3, 'owner', `/pair ${channel.pairingCodeForTest().toLowerCase()}`))
  assert.equal(channel.currentState().ownerId, 'owner')
  assert.match(client.sent.at(-1)?.text ?? '', /配对成功/)
  const count = client.sent.length
  await channel.dispatch(message(4, 'stranger', '/pair ANYTHING'))
  assert.equal(client.sent.length, count)
})

test('bridge: task merges the pre-tool understanding into the final reply', async (context) => {
  const { channel, client } = setup(context)
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '看一下磁盘'))
  await waitIdle(channel)
  assert.deepEqual(client.sent.map(({ text }) => text), ['【任务理解】看一下磁盘\n\n完成：看一下磁盘'])
  assert.equal(channel.currentState().sessionId, 'session-test')
})

test('bridge: understanding-only turn sends the understanding once', async (context) => {
  const { channel, client } = setup(context, {
    prompt: async () => ({ accepted: true as const }),
    follow: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'snapshot' }
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            data: { message: { content: [
              { type: 'text', text: '【任务理解】目标：看磁盘\n回复「继续」开始执行。' },
              { type: 'tool-call', toolName: 'bash' },
            ] } },
          },
        }
        yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } }
      },
    }) as ReturnType<SessionService['follow']>,
  })
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '看一下磁盘'))
  await waitIdle(channel)
  assert.deepEqual(client.sent.map(({ text }) => text), ['【任务理解】目标：看磁盘\n回复「继续」开始执行。'])
})

test('bridge: empty pending turn asks for confirmation instead of empty output', async (context) => {
  const confirm = {
    marker: '【任务理解】',
    phase: () => 'pending' as const,
    cancel: () => false,
  }
  const { channel, client } = setup(
    context,
    {
      prompt: async () => ({ accepted: true as const }),
      follow: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'snapshot' }
          yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } }
        },
      }) as ReturnType<SessionService['follow']>,
    },
    undefined,
    { taskConfirm: confirm },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '看一下磁盘'))
  await waitIdle(channel)
  assert.deepEqual(client.sent.map(({ text }) => text), ['已了解任务，回复「继续」开始执行，回复「取消」放弃。'])
})

test('bridge: status reports a pending confirmation', async (context) => {
  let phase: 'gate' | 'pending' = 'pending'
  const confirm = {
    marker: '【任务理解】',
    phase: () => phase,
    cancel: () => {
      phase = 'gate'
      return true
    },
  }
  const { channel, client } = setup(context, {}, undefined, { taskConfirm: confirm })
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  await channel.dispatch(message(2, 'owner', '看一下磁盘'))
  await waitIdle(channel)
  client.sent.length = 0
  await channel.dispatch(message(3, 'owner', '/status'))
  const status = client.sent.at(-1)?.text ?? ''
  assert.match(status, /状态：待确认/)
  assert.match(status, /模型：由 profile 决定/)
  assert.match(status, /确认插件：已连接/)
  assert.match(status, /工作区：未连接/)
})

test('bridge: /stop cancels a pending confirmation without a running turn', async (context) => {
  let cancelled = 0
  const confirm = {
    marker: '【任务理解】',
    phase: () => 'pending' as const,
    cancel: () => {
      cancelled += 1
      return true
    },
  }
  const { channel, client } = setup(context, {}, undefined, { taskConfirm: confirm })
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  await channel.dispatch(message(2, 'owner', '看一下磁盘'))
  await waitIdle(channel)
  client.sent.length = 0
  await channel.dispatch(message(3, 'owner', '/stop'))
  assert.equal(cancelled, 1)
  assert.equal(client.sent.at(-1)?.text, '已取消等待确认的任务。')
})

test('bridge: idle reset keeps a session that waits for confirmation', async (context) => {
  let clock = new Date('2026-10-23T08:00:00.000Z')
  let created = 0
  const confirm = {
    marker: '【任务理解】',
    phase: () => 'pending' as const,
    cancel: () => true,
  }
  const { channel, client } = setup(
    context,
    { create: async () => ({ sessionId: `session-${++created}` }) },
    undefined,
    { config: { sessionIdleResetMinutes: 1 }, now: () => clock, taskConfirm: confirm },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  await channel.dispatch(message(2, 'owner', '第一件事'))
  await waitIdle(channel)
  clock = new Date(clock.getTime() + 2 * 60_000)
  client.sent.length = 0
  await channel.dispatch(message(3, 'owner', '继续'))
  await waitIdle(channel)
  assert.equal(created, 1)
  assert.doesNotMatch(client.sent.map(({ text }) => text).join('\n'), /已开启新会话/)
})

test('bridge: created session is attached to the workspace owning cwd', async (context) => {
  const attached: string[] = []
  let resolveCalls = 0
  let createCalls = 0
  const workspace = {
    attachSession: async (sessionId: string) => { attached.push(sessionId) },
  }
  const registry = {
    resolveByPath: async () => {
      resolveCalls += 1
      return workspace
    },
    create: async () => {
      createCalls += 1
      return workspace
    },
  }
  const { channel } = setup(context, {}, registry)
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  await channel.dispatch(message(2, 'owner', '看一下磁盘'))
  await waitIdle(channel)
  assert.deepEqual(attached, ['session-test'])
  assert.equal(resolveCalls, 1)
  assert.equal(createCalls, 0)
})

test('bridge: missing workspace is created for cwd', async (context) => {
  const attached: string[] = []
  const created: Array<{ path: string; title?: string }> = []
  const workspace = {
    attachSession: async (sessionId: string) => { attached.push(sessionId) },
  }
  const registry = {
    resolveByPath: async () => undefined,
    create: async (path: string, title?: string) => {
      created.push({ path, title })
      return workspace
    },
  }
  const { channel, dir } = setup(context, {}, registry)
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  await channel.dispatch(message(2, 'owner', '看一下磁盘'))
  await waitIdle(channel)
  assert.deepEqual(attached, ['session-test'])
  assert.deepEqual(created, [{ path: dir, title: basename(dir) }])
})

test('bridge: new session resets state', async (context) => {
  const { channel, client } = setup(context)
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  client.sent.length = 0
  await channel.dispatch(message(3, 'owner', '/new'))
  assert.equal(channel.currentState().sessionId, null)
  assert.match(client.sent.at(-1)?.text ?? '', /已开启新会话/)
})

test('bridge: idle reset starts a new session after the configured gap', async (context) => {
  let clock = new Date('2026-10-23T08:00:00.000Z')
  let created = 0
  const { channel, client, store } = setup(
    context,
    { create: async () => ({ sessionId: `session-${++created}` }) },
    undefined,
    { config: { sessionIdleResetMinutes: 1 }, now: () => clock },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '第一件事'))
  await waitIdle(channel)
  assert.equal(channel.currentState().sessionId, 'session-1')
  assert.equal(channel.currentState().lastActiveAt, clock.toISOString())
  assert.equal(store.loadState().lastActiveAt, clock.toISOString())

  clock = new Date(clock.getTime() + 2 * 60_000)
  client.sent.length = 0
  await channel.dispatch(message(3, 'owner', '第二件事'))
  await waitIdle(channel)
  assert.equal(created, 2)
  assert.equal(channel.currentState().sessionId, 'session-2')
  assert.deepEqual(client.sent.map(({ text }) => text), [
    '（闲置超过 2 分钟，已开启新会话）',
    '【任务理解】看一下磁盘\n\n完成：看一下磁盘',
  ])
})

test('bridge: activity within the idle window keeps the session', async (context) => {
  let clock = new Date('2026-10-23T08:00:00.000Z')
  let created = 0
  const { channel, client } = setup(
    context,
    { create: async () => ({ sessionId: `session-${++created}` }) },
    undefined,
    { config: { sessionIdleResetMinutes: 10 }, now: () => clock },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  await channel.dispatch(message(2, 'owner', '第一件事'))
  await waitIdle(channel)
  clock = new Date(clock.getTime() + 5 * 60_000)
  client.sent.length = 0
  await channel.dispatch(message(3, 'owner', '第二件事'))
  await waitIdle(channel)
  assert.equal(created, 1)
  assert.equal(channel.currentState().sessionId, 'session-1')
  assert.doesNotMatch(client.sent.map(({ text }) => text).join('\n'), /已开启新会话/)
})

test('bridge: idle reset can be disabled with zero', async (context) => {
  let clock = new Date('2026-10-23T08:00:00.000Z')
  let created = 0
  const { channel, client } = setup(
    context,
    { create: async () => ({ sessionId: `session-${++created}` }) },
    undefined,
    { config: { sessionIdleResetMinutes: 0 }, now: () => clock },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  await channel.dispatch(message(2, 'owner', '第一件事'))
  await waitIdle(channel)
  clock = new Date(clock.getTime() + 48 * 60 * 60_000)
  client.sent.length = 0
  await channel.dispatch(message(3, 'owner', '第二件事'))
  await waitIdle(channel)
  assert.equal(created, 1)
  assert.equal(channel.currentState().sessionId, 'session-1')
  assert.doesNotMatch(client.sent.map(({ text }) => text).join('\n'), /已开启新会话/)
})

test('bridge: archived session is rotated instead of failing the task', async (context) => {
  let created = 0
  const workspace = { attachSession: async () => undefined }
  const registry = {
    resolveByPath: async () => workspace,
    create: async () => workspace,
    archivedSessionIds: ['session-1'],
  }
  const { channel, client } = setup(
    context,
    { create: async () => ({ sessionId: `session-${++created}` }) },
    registry as unknown as ChannelDependencies['workspaceRegistry'],
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  await channel.dispatch(message(2, 'owner', '第一件事'))
  await waitIdle(channel)
  assert.equal(channel.currentState().sessionId, 'session-1')

  client.sent.length = 0
  await channel.dispatch(message(3, 'owner', '第二件事'))
  await waitIdle(channel)
  assert.equal(created, 2)
  assert.equal(channel.currentState().sessionId, 'session-2')
  assert.match(client.sent.at(0)?.text ?? '', /已在电脑端被归档/)
})

test('bridge: blocked turns rotate to a fresh session automatically', async (context) => {
  let created = 0
  let turns = 0
  const { channel, client, store } = setup(context, {
    create: async () => ({ sessionId: `session-${++created}` }),
    prompt: async () => ({ accepted: true as const }),
    follow: () => {
      const blocked = ++turns === 1
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'snapshot' }
          if (blocked) {
            yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'blocked' } } } }
            return
          }
          yield {
            type: 'event',
            event: {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: '正常完成' }] } },
            },
          }
          yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } }
        },
      }
    },
  })
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  assert.equal(client.sent.at(-1)?.text, '任务被阻止（会话可能已在电脑端被归档），已开启新会话，请重新发送任务。')
  assert.equal(channel.currentState().sessionId, null)
  assert.equal(store.loadState().sessionId, null)

  client.sent.length = 0
  await channel.dispatch(message(3, 'owner', '再来一次'))
  await waitIdle(channel)
  assert.equal(created, 2)
  assert.equal(channel.currentState().sessionId, 'session-2')
  assert.match(client.sent.at(-1)?.text ?? '', /正常完成/)
})

test('bridge: retries consume one quota slot per logical message', async (context) => {
  const { channel, client } = setup(context)
  const contextToken = 'shared-context'
  client.failuresRemaining = 2
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`, contextToken))
  for (let id = 2; id <= 20; id += 1) {
    await channel.dispatch(message(id, 'owner', '/status', contextToken))
  }
  assert.equal(client.sent.length, 10)
  assert.equal(client.attempts, 12)
})

test('bridge: turn errors are reported instead of becoming empty output', async (context) => {
  const { channel, client } = setup(context, {
    prompt: async () => ({ accepted: true as const }),
    follow: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'snapshot' }
        yield {
          type: 'event',
          event: {
            type: 'turn/end',
            data: { reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL' } } },
          },
        }
      },
    }) as ReturnType<SessionService['follow']>,
  })
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  assert.equal(client.sent.at(-1)?.text, '执行出错：模型调用失败（MISSING_CREDENTIAL）')
})

test('bridge: send auth expiry fuses without retrying or accepting more work', async (context) => {
  const { channel, client } = setup(context)
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sendAuthExpired = true
  const attempts = client.attempts

  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  assert.equal(client.attempts, attempts + 1)

  await channel.dispatch(message(3, 'owner', '/status'))
  assert.equal(client.attempts, attempts + 1)
})

test('bridge: typing cancellation auth expiry still releases busy state', async (context) => {
  const { channel, client } = setup(context)
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  client.typingTicket = 'ticket'
  client.typingCancelAuthExpired = true

  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  assert.deepEqual(client.sent.map(({ text }) => text), ['【任务理解】看一下磁盘\n\n完成：看一下磁盘'])
  const attempts = client.attempts

  await channel.dispatch(message(3, 'owner', '/status'))
  assert.equal(client.attempts, attempts)
})

test('bridge: status reports the real preset and connected dependencies', async (context) => {
  const workspace = { attachSession: async () => undefined }
  const registry = { resolveByPath: async () => workspace, create: async () => workspace }
  const confirm = { marker: '【任务理解】', phase: () => 'gate' as const, cancel: () => false }
  const { channel, client } = setup(
    context,
    { inspect: async () => ({ meta: { agentPreset: 'preset-x' } }) },
    registry,
    { taskConfirm: confirm },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  client.sent.length = 0
  await channel.dispatch(message(3, 'owner', '/status'))
  const status = client.sent.at(-1)?.text ?? ''
  assert.match(status, /模型：preset-x/)
  assert.match(status, /确认插件：已连接/)
  assert.match(status, /工作区：已连接/)
})

test('bridge: command aliases and unknown commands', async (context) => {
  const { channel, client } = setup(context)
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '/help'))
  assert.match(client.sent.at(-1)?.text ?? '', /可用命令/)
  await channel.dispatch(message(3, 'owner', '/?'))
  assert.match(client.sent.at(-1)?.text ?? '', /可用命令/)
  await channel.dispatch(message(4, 'owner', '/bogus'))
  assert.equal(client.sent.at(-1)?.text, '未知命令。发送 /help 查看可用命令。')
  await channel.dispatch(message(5, 'owner', '/reset'))
  assert.match(client.sent.at(-1)?.text ?? '', /已开启新会话/)
  await channel.dispatch(message(6, 'owner', '/abort'))
  assert.equal(client.sent.at(-1)?.text, '当前没有正在执行的任务。')
})

test('bridge: non-text and empty messages are answered or dropped by type', async (context) => {
  const { channel, client } = setup(context)
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  const image = { ...message(2, 'owner', ''), messageType: 2 }
  await channel.dispatch(image)
  assert.equal(client.sent.length, 0)
  await channel.dispatch(message(3, 'owner', '   '))
  assert.equal(client.sent.at(-1)?.text, '目前只支持文字消息。')
})

test('bridge: a second task while busy is rejected without queueing', async (context) => {
  const { channel, client } = setup(
    context,
    {
      prompt: async () => ({ accepted: true as const }),
      follow: () => hungFollow(context),
    },
    undefined,
    { settleTimeoutMs: 20 },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '长任务'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(channel.isBusy(), true)
  await channel.dispatch(message(3, 'owner', '插队'))
  assert.equal(client.sent.at(-1)?.text, '上一条任务仍在执行，请稍候；发送 /stop 可中止。')
  await channel.dispatch(message(4, 'owner', '/stop'))
  await waitIdle(channel)
})

test('bridge: timeout releases busy even when follow never settles', async (context) => {
  const { channel, client } = setup(
    context,
    {
      prompt: async () => ({ accepted: true as const }),
      follow: () => hungFollow(context),
    },
    undefined,
    { settleTimeoutMs: 20, config: { taskTimeoutMs: 20 } },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '长任务'))
  await waitIdle(channel)
  assert.equal(client.sent.at(-1)?.text, '任务超时（1 分钟），已停止。')
  assert.equal(channel.isBusy(), false)
})

test('bridge: /stop releases a hung turn within the settle grace', async (context) => {
  const { channel, client } = setup(
    context,
    {
      prompt: async () => ({ accepted: true as const }),
      follow: () => hungFollow(context),
    },
    undefined,
    { settleTimeoutMs: 20 },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '长任务'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  await channel.dispatch(message(3, 'owner', '/stop'))
  await waitIdle(channel)
  assert.deepEqual(client.sent.map(({ text }) => text), ['正在停止……', '已停止。'])
})

test('bridge: desktop archive cancels the running turn', async (context) => {
  let listener: ((request: { sessionId?: string }) => void) | undefined
  const { channel, client } = setup(
    context,
    {
      prompt: async () => ({ accepted: true as const }),
      follow: () => hungFollow(context),
    },
    undefined,
    {
      settleTimeoutMs: 20,
      onEvent: (name, callback) => {
        if (name === 'workspace/session-stop') listener = callback
        return () => undefined
      },
    },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '长任务'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(channel.isBusy(), true)
  listener?.({ sessionId: channel.currentState().sessionId ?? undefined })
  await waitIdle(channel)
  assert.equal(client.sent.at(-1)?.text, '已停止。')
})

test('bridge: archiving during a pending confirmation cancels it explicitly', async (context) => {
  let created = 0
  let cancelled = 0
  const confirm = {
    marker: '【任务理解】',
    phase: () => 'pending' as const,
    cancel: () => {
      cancelled += 1
      return true
    },
  }
  const workspace = { attachSession: async () => undefined }
  const registry = {
    resolveByPath: async () => workspace,
    create: async () => workspace,
    archivedSessionIds: ['session-1'],
  }
  const { channel, client } = setup(
    context,
    { create: async () => ({ sessionId: `fresh-${++created}` }) },
    registry as unknown as ChannelDependencies['workspaceRegistry'],
    {
      taskConfirm: confirm,
      initialState: { ownerId: 'owner', sessionId: 'session-1', pairedAt: '', lastActiveAt: '' },
    },
  )
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  assert.match(client.sent[0]?.text ?? '', /待确认的任务已取消/)
  assert.equal(cancelled, 1)
  assert.equal(channel.currentState().sessionId, 'fresh-1')
})

test('bridge: an unreadable stored session is replaced with a notice', async (context) => {
  let created = 0
  const { channel, client } = setup(
    context,
    {
      inspect: async () => { throw new Error('missing') },
      create: async () => ({ sessionId: `session-${++created}` }),
    },
    undefined,
    { initialState: { ownerId: 'owner', sessionId: 'gone', pairedAt: '', lastActiveAt: '' } },
  )
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  assert.match(client.sent[0]?.text ?? '', /上一次会话无法恢复/)
  assert.equal(channel.currentState().sessionId, 'session-1')
})

test('bridge: a failing workspace attach does not block the task', async (context) => {
  const registry = {
    resolveByPath: async () => { throw new Error('registry down') },
    create: async () => { throw new Error('create failed') },
  }
  const { channel, client } = setup(context, {}, registry as unknown as ChannelDependencies['workspaceRegistry'])
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  assert.match(client.sent.at(-1)?.text ?? '', /完成：看一下磁盘/)
})

test('bridge: max-tokens turns carry a truncation note', async (context) => {
  const { channel, client } = setup(context, {
    prompt: async () => ({ accepted: true as const }),
    follow: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'snapshot' }
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: '半截回答' }] } },
          },
        }
        yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } } }
      },
    }) as ReturnType<SessionService['follow']>,
  })
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  const text = client.sent.at(-1)?.text ?? ''
  assert.match(text, /半截回答/)
  assert.match(text, /本轮回答达到长度上限/)
})

test('bridge: unknown turn end kinds complete without an error reply', async (context) => {
  const { channel, client } = setup(context, {
    prompt: async () => ({ accepted: true as const }),
    follow: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'snapshot' }
        yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'future-kind' } } } }
      },
    }) as ReturnType<SessionService['follow']>,
  })
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '任务'))
  await waitIdle(channel)
  assert.equal(client.sent.at(-1)?.text, '（本轮没有文字输出）')
})

test('bridge: the quota warning is sent unnumbered after the last chunk', async (context) => {
  const longText = 'x'.repeat(3_000)
  const { channel, client } = setup(
    context,
    {
      prompt: async () => ({ accepted: true as const }),
      follow: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'snapshot' }
          yield {
            type: 'event',
            event: {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: longText }] } },
            },
          }
          yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } }
        },
      }) as ReturnType<SessionService['follow']>,
    },
    undefined,
    { config: { chunkBytes: 200 } },
  )
  await channel.dispatch(message(1, 'owner', `/pair ${channel.pairingCodeForTest()}`))
  client.sent.length = 0
  await channel.dispatch(message(2, 'owner', '长回答'))
  await waitIdle(channel)
  const texts = client.sent.map(({ text }) => text)
  assert.equal(texts.length, 10)
  assert.match(texts[0] ?? '', /^\[1\/9\]\n/)
  assert.match(texts[8] ?? '', /^\[9\/9\]\n/)
  assert.equal(texts[9], '（提示：本会话剩余 0 条消息额度，发送 /new 可重置。长回答会被截断。）')
})
