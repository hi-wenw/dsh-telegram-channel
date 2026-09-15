import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject } from '../src/index.ts'

test('apiProxy is optional and is not a hard Cordis dependency', () => {
  assert.deepEqual(inject, ['agents'])
})

test('apply without token does not throw and does not start effect', () => {
  const effects: string[] = []
  const ctx = {
    effect(_fn: () => () => void, name: string) {
      effects.push(name)
      return () => {}
    },
    logger: { info() {}, error() {}, warn() {} },
    agents: {},
  } as any
  const prev = process.env.DSH_TELEGRAM_TOKEN
  delete process.env.DSH_TELEGRAM_TOKEN
  assert.doesNotThrow(() => apply(ctx, { token: '', allowedUserIds: [1] }))
  assert.deepEqual(effects, [])
  if (prev !== undefined) process.env.DSH_TELEGRAM_TOKEN = prev
  else delete process.env.DSH_TELEGRAM_TOKEN
})
