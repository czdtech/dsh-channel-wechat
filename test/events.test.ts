import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StateStore } from '../src/pairing.ts'
import { extractPreToolText } from '../src/text.ts'

test('events: text before tool', () => {
  const content = [
    { type: 'reasoning', text: 'internal' },
    { type: 'text', text: '【任务理解】整理目录' },
    { type: 'tool-call', toolName: 'bash' },
  ]
  assert.deepEqual(extractPreToolText(content), ['【任务理解】整理目录', true])
})

test('events: text after tool is ignored', () => {
  assert.deepEqual(extractPreToolText([
    { type: 'tool-call', toolName: 'bash' },
    { type: 'text', text: '【任务理解】太晚了' },
  ]), ['', true])
})

test('events: no tool call', () => {
  assert.deepEqual(extractPreToolText([{ type: 'text', text: '纯聊天回复' }]), ['', false])
})

test('events: invalid content', () => {
  assert.deepEqual(extractPreToolText(null), ['', false])
  assert.deepEqual(extractPreToolText('text'), ['', false])
})

test('events: joins multiple text blocks', () => {
  assert.deepEqual(extractPreToolText([
    { type: 'text', text: '第一段' },
    { type: 'reasoning', text: '...' },
    { type: 'text', text: '第二段' },
    { type: 'tool-call' },
  ]), ['第一段\n第二段', true])
})

test('events: state round trip and permissions', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new StateStore(dir)
  const state = {
    ownerId: 'wxid_x',
    sessionId: 'session-1',
    pairedAt: '2026-10-22',
    lastActiveAt: '2026-10-22T12:00:00.000Z',
  }
  store.saveState(state)
  assert.deepEqual(store.loadState(), state)
  assert.equal(statSync(store.statePath).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
})

test('events: corrupt state falls back to unpaired', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new StateStore(dir)
  writeFileSync(store.statePath, '{not json', 'utf8')
  assert.deepEqual(store.loadState(), { ownerId: '', sessionId: null, pairedAt: '', lastActiveAt: '' })
})

test('events: token uses compatible snake case and corrupt token is empty', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new StateStore(dir)
  const token = { botToken: 'test-token', botId: 'test-bot', cursor: 'test-cursor', loginTime: 'test-time' }
  store.saveToken(token)
  assert.deepEqual(store.loadToken(), token)
  assert.deepEqual(JSON.parse(readFileSync(store.tokenPath, 'utf8')), {
    bot_token: 'test-token',
    ilink_bot_id: 'test-bot',
    updates_buf: 'test-cursor',
    login_time: 'test-time',
  })
  assert.equal(statSync(store.tokenPath).mode & 0o777, 0o600)
  writeFileSync(store.tokenPath, '{not json', 'utf8')
  assert.deepEqual(store.loadToken(), { botToken: '', botId: '', cursor: '', loginTime: '' })
})

test('events: a created data directory is private', (context) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(base, { recursive: true, force: true }))
  const dir = join(base, 'nested', 'store')
  const store = new StateStore(dir)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  store.saveToken({ botToken: 't', botId: '', cursor: '', loginTime: '' })
  assert.equal(statSync(store.tokenPath).mode & 0o777, 0o600)
})

test('events: a foreign directory keeps its permissions until it holds state', (context) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-channel-wechat-'))
  context.after(() => rmSync(base, { recursive: true, force: true }))
  const dir = join(base, 'foreign')
  mkdirSync(dir, { mode: 0o755 })
  chmodSync(dir, 0o755)

  const store = new StateStore(dir)
  assert.equal(statSync(dir).mode & 0o777, 0o755)
  store.saveState({ ownerId: 'owner', sessionId: null, pairedAt: '', lastActiveAt: '' })
  assert.equal(statSync(dir).mode & 0o777, 0o755)
  assert.equal(statSync(store.statePath).mode & 0o777, 0o600)

  // Adoption: a directory that already holds our files is tightened on the next start.
  new StateStore(dir)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
})
