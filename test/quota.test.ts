import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QUOTA_PER_TOKEN, QuotaLedger } from '../src/quota.ts'

test('quota: never permits an eleventh send', () => {
  const ledger = new QuotaLedger()
  for (let index = 0; index < QUOTA_PER_TOKEN; index += 1) assert.equal(ledger.charge('ctx'), true)
  assert.equal(ledger.charge('ctx'), false)
  assert.equal(ledger.remaining('ctx'), 0)
})

test('quota: warning reserves its own slot and is emitted once', () => {
  const ledger = new QuotaLedger()
  for (let index = 0; index < 7; index += 1) ledger.charge('ctx')
  assert.equal(ledger.shouldWarnAfter('ctx', 3), true)
  assert.equal(ledger.shouldWarnAfter('ctx', 1), true)
  assert.equal(ledger.charge('ctx'), true)
  assert.equal(ledger.charge('ctx'), true)
  ledger.markWarned('ctx')
  assert.equal(ledger.remaining('ctx'), 1)
  assert.equal(ledger.shouldWarnAfter('ctx', 1), false)
  assert.equal(ledger.charge('ctx'), true)
  assert.equal(ledger.charge('ctx'), false)
})

test('quota: reset only clears the selected context token', () => {
  const ledger = new QuotaLedger()
  ledger.charge('a')
  ledger.charge('b')
  ledger.reset('a')
  assert.equal(ledger.remaining('a'), QUOTA_PER_TOKEN)
  assert.equal(ledger.remaining('b'), QUOTA_PER_TOKEN - 1)
})
