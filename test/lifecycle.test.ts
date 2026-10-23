import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { WeChatChannel, type ChannelDependencies } from '../src/channel.ts'
import type { Config } from '../src/index.ts'
import { AuthExpiredError, type IlinkProtocolClient, type InboundMessage, type LoginQr, type LoginStatus } from '../src/ilink.ts'
import { StateStore } from '../src/pairing.ts'

class LifecycleClient implements IlinkProtocolClient {
  polls = 0
  closed = false
  pollAborted = false

  hasToken(): boolean { return true }
  getBotQr(): Promise<LoginQr> { throw new Error('unused') }
  getQrStatus(): Promise<LoginStatus> { throw new Error('unused') }
  acceptLogin(): void { throw new Error('unused') }
  getTypingTicket(): Promise<string> { return Promise.resolve('') }
  sendTyping(): Promise<void> { return Promise.resolve() }
  sendText(): Promise<void> { return Promise.resolve() }
  getUpdates(signal?: AbortSignal): Promise<{ cursor: string; messages: InboundMessage[] }> {
    this.polls += 1
    if (this.polls === 1) {
      return Promise.resolve({
        cursor: 'test-cursor',
        messages: [{
          messageId: 'm1',
          fromUserId: 'owner',
          contextToken: 'ctx',
          messageType: 1,
          text: 'long task',
        }],
      })
    }
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        this.pollAborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

class TypingAuthExpiryClient implements IlinkProtocolClient {
  polls = 0
  pollAborted = false
  closed = false
  sendCalls = 0
  private notifySecondPoll!: () => void
  private readonly secondPoll = new Promise<void>((resolve) => {
    this.notifySecondPoll = resolve
  })

  hasToken(): boolean { return true }
  getBotQr(): Promise<LoginQr> { throw new Error('unused') }
  getQrStatus(): Promise<LoginStatus> { throw new Error('unused') }
  acceptLogin(): void { throw new Error('unused') }
  async getTypingTicket(): Promise<string> {
    await this.secondPoll
    throw new AuthExpiredError('expired')
  }
  sendTyping(): Promise<void> { return Promise.resolve() }
  sendText(): Promise<void> {
    this.sendCalls += 1
    return Promise.resolve()
  }
  getUpdates(signal?: AbortSignal): Promise<{ cursor: string; messages: InboundMessage[] }> {
    this.polls += 1
    if (this.polls === 1) {
      return Promise.resolve({
        cursor: 'test-cursor',
        messages: [{
          messageId: 'm1',
          fromUserId: 'owner',
          contextToken: 'ctx',
          messageType: 1,
          text: 'task',
        }],
      })
    }
    this.notifySecondPoll()
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        this.pollAborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

test('lifecycle: dispose aborts poll, cancels turn, returns follow, and closes HTTP', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new StateStore(dir)
  store.saveState({ ownerId: 'owner', sessionId: null, pairedAt: '2026-10-23', lastActiveAt: '' })
  store.saveToken({ botToken: 'test-token', botId: '', cursor: '', loginTime: '' })
  const client = new LifecycleClient()
  let promptCalled = false
  let cancelCalls = 0
  let followFinished = false
  const sessions = {
    create: async () => ({ sessionId: 'session-live' }),
    inspect: async () => ({}),
    prompt: async () => {
      promptCalled = true
      return { accepted: true as const }
    },
    cancel: () => {
      cancelCalls += 1
      return { accepted: true as const }
    },
    follow: (_request: unknown, signal: AbortSignal) => ({
      async *[Symbol.asyncIterator]() {
        try {
          yield { type: 'snapshot' }
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
          })
        } finally {
          followFinished = true
        }
      },
    }),
  }
  const logger = { info() {}, warn() {}, error() {}, debug() {}, success() {} }
  const ctx = { logger: () => logger } as unknown as Context
  const config: Config = {
    autoStart: true,
    dataDir: dir,
    cwd: dir,
    chunkBytes: 1800,
    taskTimeoutMs: 60_000,
    pollTimeoutMs: 30_000,
    typingRefreshMs: 5_000,
    sessionIdleResetMinutes: 720,
  }
  const dependencies: ChannelDependencies = {
    client,
    store,
    sessionController: sessions as unknown as NonNullable<ChannelDependencies['sessionController']>,
    sleep: async () => undefined,
  }
  const channel = new WeChatChannel(ctx, config, dependencies)
  const dispose = channel.start()

  await waitFor(() => promptCalled && client.polls >= 2)
  await dispose()

  assert.equal(cancelCalls, 1)
  assert.equal(followFinished, true)
  assert.equal(client.pollAborted, true)
  assert.equal(client.closed, true)
  assert.equal(channel.isBusy(), false)
})

test('lifecycle: typing auth expiry aborts polling and rejects later work', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new StateStore(dir)
  store.saveState({ ownerId: 'owner', sessionId: null, pairedAt: '2026-10-23', lastActiveAt: '' })
  store.saveToken({ botToken: 'test-token', botId: '', cursor: '', loginTime: '' })
  const client = new TypingAuthExpiryClient()
  const sessions = {
    create: async () => ({ sessionId: 'unused' }),
    inspect: async () => ({}),
    prompt: async () => ({ accepted: true as const }),
    cancel: () => ({ accepted: true as const }),
    follow: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'snapshot' }
      },
    }),
  }
  const logger = { info() {}, warn() {}, error() {}, debug() {}, success() {} }
  const ctx = { logger: () => logger } as unknown as Context
  const config: Config = {
    autoStart: true,
    dataDir: dir,
    cwd: dir,
    chunkBytes: 1800,
    taskTimeoutMs: 60_000,
    pollTimeoutMs: 30_000,
    typingRefreshMs: 5_000,
    sessionIdleResetMinutes: 720,
  }
  const channel = new WeChatChannel(ctx, config, {
    client,
    store,
    sessionController: sessions as unknown as NonNullable<ChannelDependencies['sessionController']>,
    sleep: async () => undefined,
  })
  const dispose = channel.start()

  await waitFor(() => client.pollAborted && !channel.isBusy())
  await channel.dispatch({
    messageId: 'm2',
    fromUserId: 'owner',
    contextToken: 'ctx',
    messageType: 1,
    text: '/status',
  })
  assert.equal(client.polls, 2)
  assert.equal(client.sendCalls, 0)

  await dispose()
  assert.equal(client.closed, true)
})

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(condition(), true, 'condition did not become true')
}

test('lifecycle: poll failures back off exponentially without dropping later messages', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new StateStore(dir)
  store.saveState({ ownerId: 'owner', sessionId: null, pairedAt: '2026-10-23', lastActiveAt: '' })
  store.saveToken({ botToken: 'test-token', botId: '', cursor: '', loginTime: '' })
  const sleeps: number[] = []
  let polls = 0
  const sent: string[] = []
  const client = {
    polls: 0,
    hasToken: () => true,
    getBotQr: () => { throw new Error('unused') },
    getQrStatus: () => { throw new Error('unused') },
    acceptLogin: () => { throw new Error('unused') },
    getUpdates: async (signal?: AbortSignal): Promise<{ cursor: string; messages: InboundMessage[] }> => {
      polls += 1
      if (polls <= 2) throw new Error('flaky')
      if (polls === 3) {
        return {
          cursor: 'c',
          messages: [{ messageId: 'm1', fromUserId: 'owner', contextToken: 'ctx', messageType: 1, text: '/status' }],
        }
      }
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      return { cursor: 'c', messages: [] }
    },
    sendText: async (_to: string, text: string) => { sent.push(text) },
    getTypingTicket: async () => '',
    sendTyping: async () => undefined,
    close: async () => undefined,
  }
  const sessions = {
    create: async () => ({ sessionId: 'session-1' }),
    inspect: async () => ({}),
    prompt: async () => ({ accepted: true as const }),
    cancel: () => ({ accepted: true as const }),
    follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'snapshot' } } }),
  }
  const logger = { info() {}, warn() {}, error() {}, debug() {}, success() {} }
  const ctx = { logger: () => logger } as unknown as Context
  const config: Config = {
    autoStart: true,
    dataDir: dir,
    cwd: dir,
    chunkBytes: 1800,
    taskTimeoutMs: 60_000,
    pollTimeoutMs: 30_000,
    typingRefreshMs: 5_000,
    sessionIdleResetMinutes: 720,
  }
  const channel = new WeChatChannel(ctx, config, {
    client,
    store,
    sessionController: sessions as unknown as NonNullable<ChannelDependencies['sessionController']>,
    sleep: async (ms) => { sleeps.push(ms) },
  })
  const dispose = channel.start()
  await waitFor(() => sent.length > 0)
  await dispose()

  assert.deepEqual(sleeps.slice(0, 2), [1_000, 2_000])
  assert.match(sent.at(-1) ?? '', /状态：空闲/)
})
