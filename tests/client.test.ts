import assert from 'node:assert/strict'
import test from 'node:test'
import { TelegramClient } from '../src/client.ts'

test('getUpdates posts timeout and optional offset with callback_query', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
  }
  const client = new TelegramClient('SECRET-TOKEN', { fetch: fetchImpl, pollingTimeoutSec: 12 })
  await client.getUpdates(9)
  assert.match(calls[0]!.url, /\/botSECRET-TOKEN\/getUpdates$/)
  assert.deepEqual(calls[0]!.body, {
    timeout: 12,
    allowed_updates: ['message', 'callback_query'],
    offset: 9,
  })
})

test('errors redact token', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error('boom SECRET-TOKEN leaked')
  }
  const client = new TelegramClient('SECRET-TOKEN', { fetch: fetchImpl })
  await assert.rejects(async () => client.getMe(), (err: Error) => {
    assert.equal(err.message.includes('SECRET-TOKEN'), false)
    assert.match(err.message, /\*\*\*/)
    return true
  })
})

test('empty token throws in constructor', () => {
  assert.throws(() => new TelegramClient(''), /token/)
})

test('sendMessage can include reply_markup', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, text: 'x' },
    }), { status: 200 })
  }
  const client = new TelegramClient('TOK', { fetch: fetchImpl })
  await client.sendMessage(1, 'pick', undefined, {
    inline_keyboard: [[{ text: 'A', callback_data: 'bind:1' }]],
  })
  assert.deepEqual(calls[0]!.body.reply_markup, {
    inline_keyboard: [[{ text: 'A', callback_data: 'bind:1' }]],
  })
})

test('sendRichMessage posts native rich markdown body', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({
      ok: true,
      result: { message_id: 2, date: 0, chat: { id: 1, type: 'private' }, text: '# hi' },
    }), { status: 200 })
  }
  const client = new TelegramClient('TOK', { fetch: fetchImpl })
  await client.sendRichMessage(1, '# hi\n\n- a\n- b')
  assert.match(calls[0]!.url, /\/botTOK\/sendRichMessage$/)
  assert.deepEqual(calls[0]!.body, {
    chat_id: 1,
    rich_message: {
      markdown: '# hi\n\n- a\n- b',
      skip_entity_detection: true,
    },
  })
})
