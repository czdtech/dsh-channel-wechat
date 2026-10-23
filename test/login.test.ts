import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { login } from '../src/login.ts'
import type { IlinkProtocolClient, LoginQr, LoginStatus } from '../src/ilink.ts'
import { StateStore, type TokenState } from '../src/pairing.ts'

interface FakeOptions {
  readonly status?: string
  readonly onStatus?: (abort: () => void) => Promise<LoginStatus>
}

class FakeLoginClient implements IlinkProtocolClient {
  private readonly persist: (token: TokenState) => void
  private readonly options: FakeOptions

  constructor(persist: (token: TokenState) => void, options: FakeOptions = {}) {
    this.persist = persist
    this.options = options
  }

  hasToken(): boolean { return false }
  getBotQr(): Promise<LoginQr> { return Promise.resolve({ qrcodeId: 'qr', imageContent: 'qr-content' }) }
  getQrStatus(_qrcodeId: string): Promise<LoginStatus> {
    if (this.options.onStatus) return this.options.onStatus(() => undefined)
    return Promise.resolve(this.options.status === 'expired'
      ? { status: 'expired' }
      : { status: 'confirmed', botToken: 'bot-token', botId: 'bot-id' })
  }
  acceptLogin(status: LoginStatus): void {
    if (status.status !== 'confirmed' || !status.botToken) throw new Error('not confirmed')
    this.persist({ botToken: status.botToken, botId: status.botId ?? '', cursor: '', loginTime: 'test' })
  }
  getUpdates(): never { throw new Error('unused') }
  sendText(): never { throw new Error('unused') }
  getTypingTicket(): never { throw new Error('unused') }
  sendTyping(): never { throw new Error('unused') }
  close(): Promise<void> { return Promise.resolve() }
}

test('login: a confirmed scan persists the token and a private QR file', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  await login(dir, undefined, {
    pollIntervalMs: 1,
    output: () => undefined,
    createClient: (_token, persist) => new FakeLoginClient(persist),
  })
  const store = new StateStore(dir)
  assert.equal(store.loadToken().botToken, 'bot-token')
  assert.equal(statSync(join(dir, 'wx_qr.png')).mode & 0o777, 0o600)
})

test('login: three expired QR codes fail with a clear error', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  await assert.rejects(
    login(dir, undefined, {
      pollIntervalMs: 1,
      output: () => undefined,
      createClient: (_token, persist) => new FakeLoginClient(persist, { status: 'expired' }),
    }),
    /二维码多次过期/,
  )
  assert.equal(new StateStore(dir).loadToken().botToken, '')
})

test('login: an abort while polling propagates', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  const controller = new AbortController()
  const client = new FakeLoginClient(() => undefined, {
    onStatus: () => new Promise((_resolve, reject) => {
      setTimeout(() => {
        controller.abort(new Error('登录已取消'))
        reject(new Error('aborted'))
      }, 1)
    }),
  })
  await assert.rejects(
    login(dir, controller.signal, {
      pollIntervalMs: 1,
      output: () => undefined,
      createClient: () => client,
    }),
    /登录已取消|aborted/,
  )
})
