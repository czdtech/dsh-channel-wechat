import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { ChannelSupervisor, apply, type Config } from '../src/index.ts'

const logger = { info() {}, warn() {}, error() {}, debug() {}, success() {} }

test('supervisor: restarts are serialized and never overlap', async () => {
  const events: string[] = []
  let next = 0
  const supervisor = new ChannelSupervisor({
    create: () => {
      const id = ++next
      return {
        start: () => {
          events.push(`start${id}`)
          return async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            events.push(`stop${id}`)
          }
        },
      }
    },
    log: logger,
  })

  supervisor.mount()
  const first = supervisor.restart()
  const second = supervisor.restart()
  const third = supervisor.restart()
  await Promise.all([first, second, third])
  await supervisor.dispose()

  assert.deepEqual(events, [
    'start1', 'stop1',
    'start2', 'stop2',
    'start3', 'stop3',
    'start4', 'stop4',
  ])
})

test('supervisor: a failing start is contained and retried on restart', async () => {
  let attempts = 0
  const errors: string[] = []
  const supervisor = new ChannelSupervisor({
    create: () => ({
      start: () => {
        attempts += 1
        if (attempts === 1) throw new Error('boom')
        return async () => undefined
      },
    }),
    log: { info() {}, error: (message: string) => errors.push(message) },
  })

  assert.doesNotThrow(() => supervisor.mount())
  assert.equal(supervisor.isMounted(), false)
  assert.equal(errors.length, 1)

  await supervisor.restart()
  assert.equal(attempts, 2)
  assert.equal(supervisor.isMounted(), true)
  await supervisor.dispose()
  assert.equal(supervisor.isMounted(), false)
})

test('supervisor: a disabled channel never mounts, and stops when disabled later', async () => {
  let started = 0
  let enabled = false
  const supervisor = new ChannelSupervisor({
    create: () => ({
      start: () => {
        started += 1
        return async () => undefined
      },
    }),
    log: logger,
    enabled: () => enabled,
  })

  supervisor.mount()
  assert.equal(started, 0)
  enabled = true
  await supervisor.restart()
  assert.equal(started, 1)
  enabled = false
  await supervisor.restart()
  assert.equal(started, 1)
  assert.equal(supervisor.isMounted(), false)
  await supervisor.dispose()
})

test('apply: autoStart=false registers the reload hook without a channel', async () => {
  const listeners: string[] = []
  let dispose: (() => Promise<void>) | undefined
  const ctx = {
    logger: () => logger,
    on: (name: string) => {
      listeners.push(name)
      return () => undefined
    },
    effect: (callback: () => () => Promise<void>) => {
      dispose = callback()
    },
    get: () => undefined,
    sessionController: {},
  } as unknown as Context
  const config: Config = {
    autoStart: false,
    dataDir: '~/.dsh-wechat',
    cwd: '~',
    chunkBytes: 1800,
    taskTimeoutMs: 1_800_000,
    pollTimeoutMs: 30_000,
    typingRefreshMs: 5_000,
    sessionIdleResetMinutes: 720,
  }

  assert.doesNotThrow(() => apply(ctx, config))
  assert.deepEqual(listeners, ['loader/volatile-update'])
  assert.ok(dispose)
  await dispose?.()
})
