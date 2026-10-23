import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Response, type RequestInit } from 'undici'
import {
  AuthExpiredError,
  IlinkClient,
  type IlinkHttp,
  type IlinkLane,
} from '../src/ilink.ts'
import type { TokenState } from '../src/pairing.ts'

class MockHttp implements IlinkHttp {
  readonly calls: Array<{ url: string; init: RequestInit; lane: IlinkLane }> = []
  readonly responses: Array<Record<string, unknown>> = []
  closed = false

  request(url: string | URL, init: RequestInit, lane: IlinkLane): Promise<Response> {
    this.calls.push({ url: String(url), init, lane })
    const body = this.responses.shift()
    if (!body) throw new Error('missing mock response')
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

const EMPTY_TOKEN: TokenState = { botToken: '', botId: '', cursor: '', loginTime: '' }

test('ilink: all six endpoints preserve protocol fields and cursor', async () => {
  const http = new MockHttp()
  http.responses.push(
    { qrcode: 'qr-id', qrcode_img_content: 'qr-content' },
    { status: 'confirmed', bot_token: 'test-token', ilink_bot_id: 'test-bot' },
    {
      get_updates_buf: 'cursor-next',
      msgs: [{
        message_id: 'm1',
        from_user_id: 'user-test',
        context_token: 'context-test',
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: 'hello' } }],
      }],
    },
    { errcode: 0 },
    { typing_ticket: 'ticket-test' },
    { errcode: 0 },
  )
  const persisted: TokenState[] = []
  const client = new IlinkClient(EMPTY_TOKEN, { http, persistToken: (token) => persisted.push(token) })

  const qr = await client.getBotQr()
  const status = await client.getQrStatus(qr.qrcodeId)
  client.acceptLogin(status)
  const page = await client.getUpdates()
  await client.sendText('user-test', 'reply', 'context-test')
  assert.equal(await client.getTypingTicket('user-test', 'context-test'), 'ticket-test')
  await client.sendTyping('user-test', 'ticket-test', false)
  await client.close()

  assert.deepEqual(qr, { qrcodeId: 'qr-id', imageContent: 'qr-content' })
  assert.equal(page.cursor, 'cursor-next')
  assert.equal(page.messages[0]?.text, 'hello')
  assert.equal(persisted.at(-1)?.cursor, 'cursor-next')
  assert.equal(http.closed, true)
  assert.deepEqual(http.calls.map(({ url }) => new URL(url).pathname), [
    '/ilink/bot/get_bot_qrcode',
    '/ilink/bot/get_qrcode_status',
    '/ilink/bot/getupdates',
    '/ilink/bot/sendmessage',
    '/ilink/bot/getconfig',
    '/ilink/bot/sendtyping',
  ])
  assert.deepEqual(http.calls.map(({ lane }) => lane), ['send', 'send', 'poll', 'send', 'typing', 'typing'])

  const updatesBody = JSON.parse(String(http.calls[2]?.init.body)) as Record<string, unknown>
  assert.equal(updatesBody.get_updates_buf, '')
  assert.deepEqual(updatesBody.base_info, { channel_version: '2.1.10' })
  const configBody = JSON.parse(String(http.calls[4]?.init.body)) as Record<string, unknown>
  assert.equal(configBody.ilink_user_id, 'user-test')
  assert.equal('base_info' in configBody, false)
  const headers = http.calls[2]?.init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer test-token')
  assert.equal(headers.AuthorizationType, 'ilink_bot_token')
  assert.equal(headers['iLink-App-ClientVersion'], '131338')
})

test('ilink: errcode -14 clears persistent token and is not retried', async () => {
  const http = new MockHttp()
  http.responses.push({ errcode: -14, errmsg: 'expired' })
  const persisted: TokenState[] = []
  const client = new IlinkClient(
    { botToken: 'test-token', botId: 'test-bot', cursor: 'test-cursor', loginTime: 'test-time' },
    { http, persistToken: (token) => persisted.push(token) },
  )

  await assert.rejects(client.getUpdates(), AuthExpiredError)
  assert.equal(http.calls.length, 1)
  assert.deepEqual(persisted.at(-1), {
    botToken: '',
    botId: '',
    cursor: '',
    loginTime: persisted.at(-1)?.loginTime,
  })
  assert.equal(client.hasToken(), false)
})

test('ilink: external abort is not treated as an empty poll timeout', async () => {
  const http: IlinkHttp = {
    request: (_url, init) => new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }),
    close: async () => undefined,
  }
  const client = new IlinkClient(
    { botToken: 'test-token', botId: '', cursor: '', loginTime: '' },
    { http },
  )
  const controller = new AbortController()
  const pending = client.getUpdates(controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
