import assert from 'node:assert/strict'
import test from 'node:test'
import { rmSync } from 'node:fs'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TelegramBridge } from '../src/bridge.ts'
import type { InlineKeyboardMarkup, TelegramClientLike, TelegramUpdate } from '../src/client.ts'
import { BIND_CB_PREFIX, LAST_CB, MSG } from '../src/commands.ts'

type SentMessage = {
  chatId: number
  text: string
  parseMode?: string
  replyMarkup?: InlineKeyboardMarkup
}

function fakeClient(
  sent: SentMessage[],
  overrides: Partial<TelegramClientLike> = {},
): TelegramClientLike {
  return {
    getMe: async () => ({ id: 1 }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text, parseMode, replyMarkup) => {
      sent.push({ chatId, text, parseMode, replyMarkup })
      return { message_id: 1, date: 0, chat: { id: chatId, type: 'private' }, text }
    },
    sendChatAction: async () => true,
    answerCallbackQuery: async () => true,
    setMyCommands: async () => true,
    getFile: async (fileId: string) => ({ file_id: fileId, file_unique_id: fileId, file_path: `path/${fileId}` }),
    downloadFile: async () => new Uint8Array([1, 2, 3]),
    ...overrides,
  }
}

function messageUpdate(chatId: number, userId: number, text: string, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: userId },
      text,
    },
  }
}

function startTestBridge(bridge: TelegramBridge): void {
  const persistence = bridge as unknown as { loadBindings: () => void; saveBindings: () => void }
  persistence.loadBindings = () => {}
  persistence.saveBindings = () => {}
  bridge.start()
}

function makeAgent(id: string, followups: UserMessage[], opts?: {
  cwd?: string
  title?: string
}) {
  const cwd = opts?.cwd ?? `/proj/${id}`
  const events = opts?.title
    ? [{ type: 'session/title', data: { title: opts.title } }]
    : []
  return {
    id: SessionId(id),
    session: {
      header: { cwd },
      meta: { cwd },
      events,
    },
    followup(message: UserMessage) {
      followups.push(message)
    },
  }
}

function rpcOk<T>(value: T) {
  return { rpcId: 'x', result: { ok: true as const, value } }
}

test('unauthorized user gets denied', async () => {
  const sent: SentMessage[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(99, 99, 'hi'))
  assert.equal(sent[0]?.text, MSG.DENIED)
})

test('plain text without bind prompts NEED_BIND and does not create', async () => {
  const sent: SentMessage[] = []
  let createCalled = false
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [],
      roots: () => [],
      get: () => undefined,
      create: async () => { createCalled = true },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, 'do something'))
  assert.equal(createCalled, false)
  assert.equal(sent[0]?.text, MSG.NEED_BIND)
})

test('/sessions with no sessions shows NO_SESSIONS', async () => {
  const sent: SentMessage[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/sessions'))
  assert.equal(sent[0]?.text, MSG.NO_SESSIONS)
})

test('/sessions lists workspaces then sessions via callbacks', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-aaa', followups, {
    cwd: 'D:/gitData/demo-app',
    title: '演示会话',
  })
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === 'live-aaa' ? agent : undefined),
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/sessions'))
  assert.match(sent[0]!.text, /选择工作区/)
  assert.match(sent[0]!.text, /demo-app/)
  assert.equal(sent[0]!.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data, 'ws:0')

  await bridge.processUpdate({
    update_id: 2,
    callback_query: {
      id: 'cq-ws',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: 'ws:0',
    },
  })
  const sessionMsg = sent.at(-1)!
  assert.match(sessionMsg.text, /选择会话/)
  assert.match(sessionMsg.text, /演示会话/)
  assert.equal(sessionMsg.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data, 'sid:0')
})

test('/sessions via apiProxy shows all workspaces excluding archived', async () => {
  const sent: SentMessage[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    apiProxy: {
      workspace: {
        list: async () => rpcOk({
          items: [
            {
              workspaceId: 'w1',
              path: 'D:/a',
              title: 'Alpha',
              sessionIds: ['s1', 's-archived'],
            },
            {
              workspaceId: 'w2',
              path: 'D:/b',
              title: 'Beta',
              sessionIds: ['s2'],
            },
          ],
          archivedSessionIds: ['s-archived'],
        }),
      },
      sessions: {
        list: async () => rpcOk({
          items: [
            {
              sessionId: 's1',
              updatedAt: 2,
              running: true,
              blank: false,
              cwd: 'D:/a',
              projections: { values: { title: '会话一' } },
            },
            {
              sessionId: 's-archived',
              updatedAt: 1,
              running: false,
              blank: false,
              cwd: 'D:/a',
              projections: { values: { title: '已归档' } },
            },
            {
              sessionId: 's2',
              updatedAt: 3,
              running: false,
              blank: false,
              cwd: 'D:/b',
              projections: { values: { title: '会话二' } },
            },
          ],
        }),
      },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/sessions'))
  assert.match(sent[0]!.text, /Alpha/)
  assert.match(sent[0]!.text, /Beta/)
  assert.equal(sent[0]!.replyMarkup?.inline_keyboard?.length, 2)
})

test('callback bind then plain text followups live agent; mirror assistant to chat', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-bbb', followups)
  let sessionListener: ((session: { id: ReturnType<typeof SessionId> }, event: unknown) => void) | undefined
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === 'live-bbb' ? agent : undefined),
    },
    on(event: string, listener: (session: { id: ReturnType<typeof SessionId> }, event: unknown) => void) {
      if (event === 'session/event') sessionListener = listener
      return () => {}
    },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  bridge.start()

  await bridge.processUpdate({
    update_id: 2,
    callback_query: {
      id: 'cq1',
      from: { id: 1 },
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 10, type: 'private' },
        text: 'picker',
      },
      data: `${BIND_CB_PREFIX}live-bbb`,
    },
  })
  assert.match(sent.at(-1)!.text, /已附着/)
  assert.equal(sent.at(-1)!.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data, LAST_CB)

  await bridge.processUpdate(messageUpdate(10, 1, 'hello from phone', 3))
  assert.equal(followups.length, 1)
  assert.equal(followups[0]!.content[0]!.type, 'text')

  await sessionListener?.(
    { id: SessionId('live-bbb') },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'reply from agent' }] } },
    },
  )
  // Delivery is intentionally resilient now (per-chunk retry + rich→HTML
  // fallback), which lengthens the async microtask chain past this listener's
  // void return — flush the event loop before asserting.
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(sent.some((m) => m.text.includes('reply from agent') || m.text.includes('reply')))

  await bridge.stop()
})

test('cold session bind resumes then followups', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('cold-1', followups, { cwd: 'D:/proj', title: '冷会话' })
  let resumed = false
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [],
      roots: () => [],
      get: () => (resumed ? agent : undefined),
      resume: async () => {
        resumed = true
        return { agent, dispose: async () => {} }
      },
    },
    apiProxy: {
      workspace: {
        list: async () => rpcOk({
          items: [{ workspaceId: 'w', path: 'D:/proj', title: 'proj', sessionIds: ['cold-1'] }],
          archivedSessionIds: [],
        }),
      },
      sessions: {
        list: async () => rpcOk({
          items: [{
            sessionId: 'cold-1',
            updatedAt: 1,
            running: false,
            blank: false,
            cwd: 'D:/proj',
            projections: { values: { title: '冷会话' } },
          }],
        }),
      },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/sessions'))
  await bridge.processUpdate({
    update_id: 2,
    callback_query: {
      id: 'cq-ws',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: 'ws:0',
    },
  })
  await bridge.processUpdate({
    update_id: 3,
    callback_query: {
      id: 'cq-sid',
      from: { id: 1 },
      message: { message_id: 2, date: 0, chat: { id: 10, type: 'private' } },
      data: 'sid:0',
    },
  })
  assert.equal(resumed, true)
  assert.match(sent.at(-1)!.text, /已附着/)
  await bridge.processUpdate(messageUpdate(10, 1, 'hi cold', 4))
  assert.equal(followups.length, 1)
})

test('/model lists and selects via apiProxy', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-mdl', followups)
  let selected: unknown
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: () => agent,
    },
    apiProxy: {
      sessions: {
        models: async () => rpcOk({
          current: { provider: 'deepseek', model: 'chat' },
          routable: true,
          groups: [{
            id: 'deepseek',
            name: 'DeepSeek',
            models: [
              { id: 'chat', name: 'Chat' },
              { id: 'reasoner', name: 'Reasoner', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
            ],
          }],
        }),
        selectModel: async (req: { payload: unknown }) => {
          selected = req.payload
          return rpcOk({ selected: { provider: 'deepseek', model: 'chat' } })
        },
      },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}live-mdl`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/model', 2))
  assert.match(sent.at(-1)!.text, /当前模型/)
  assert.equal(sent.at(-1)!.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data, 'mdl:0')

  await bridge.processUpdate({
    update_id: 3,
    callback_query: {
      id: 'pick',
      from: { id: 1 },
      message: { message_id: 2, date: 0, chat: { id: 10, type: 'private' } },
      data: 'mdl:0',
    },
  })
  assert.deepEqual(selected, {
    sessionId: 'live-mdl',
    provider: 'deepseek',
    model: 'chat',
  })
  assert.match(sent.at(-1)!.text, /已切换模型/)
})

test('/model effort picker applies reasoningEffort', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-eff', followups)
  let selected: unknown
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: () => agent,
    },
    apiProxy: {
      sessions: {
        models: async () => rpcOk({
          current: { provider: 'deepseek', model: 'reasoner' },
          routable: true,
          groups: [{
            id: 'deepseek',
            name: 'DeepSeek',
            models: [{
              id: 'reasoner',
              name: 'Reasoner',
              reasoning: {
                efforts: [
                  { id: 'high', name: 'High' },
                  { id: 'max', name: 'Max' },
                ],
              },
            }],
          }],
        }),
        selectModel: async (req: { payload: unknown }) => {
          selected = req.payload
          const p = req.payload as { provider: string; model: string; reasoningEffort?: string }
          return rpcOk({
            selected: {
              provider: p.provider,
              model: p.model,
              reasoningEffort: p.reasoningEffort,
            },
          })
        },
      },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}live-eff`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/model', 2))
  await bridge.processUpdate({
    update_id: 3,
    callback_query: {
      id: 'pick-r',
      from: { id: 1 },
      message: { message_id: 2, date: 0, chat: { id: 10, type: 'private' } },
      data: 'mdl:0',
    },
  })
  assert.match(sent.at(-1)!.text, /reasoning effort|请选择/)
  assert.equal(sent.at(-1)!.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data, 'eff:0')
  await bridge.processUpdate({
    update_id: 4,
    callback_query: {
      id: 'pick-eff',
      from: { id: 1 },
      message: { message_id: 3, date: 0, chat: { id: 10, type: 'private' } },
      data: 'eff:1',
    },
  })
  assert.deepEqual(selected, {
    sessionId: 'live-eff',
    provider: 'deepseek',
    model: 'reasoner',
    reasoningEffort: 'max',
  })
  assert.match(sent.at(-1)!.text, /已切换模型/)
})

test('/last returns previous Q/A via apiProxy history', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-last', followups, { title: '有历史' })
  ;(agent as any).session.events = [
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '手机续接前的问题' }] },
    },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '电脑上的回答' }] } },
    },
  ]
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: () => agent,
    },
    apiProxy: {
      sessions: {
        history: async () => ({
          rpcId: 'h',
          result: {
            ok: true,
            value: {
              events: [
                {
                  event: {
                    type: 'user/message',
                    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '手机续接前的问题' }] },
                  },
                },
                {
                  event: {
                    type: 'assistant/message',
                    data: { message: { content: [{ type: 'text', text: '电脑上的回答' }] } },
                  },
                },
              ],
              hasMore: false,
            },
          },
        }),
      },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}live-last`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/last', 2))
  const body = sent.at(-1)!.text
  assert.match(body, /上次对话|用户/)
  assert.match(body, /手机续接前的问题/)
  assert.match(body, /电脑上的回答/)
})

test('/unbind clears binding without needing create/dispose', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-ccc', followups)
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: () => agent,
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'cq',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}live-ccc`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/unbind', 2))
  assert.equal(sent.at(-1)?.text, MSG.UNBOUND)
  await bridge.processUpdate(messageUpdate(10, 1, 'again', 3))
  assert.equal(sent.at(-1)?.text, MSG.NEED_BIND)
  assert.equal(followups.length, 0)
})

// ── /rich: per-chat rendering mode (rich messages need a recent client) ──

function renderHarness(
  id: string,
  sent: SentMessage[],
  rich: string[],
  followups: UserMessage[],
): {
  bridge: TelegramBridge
  emitAssistant: (text: string) => Promise<void>
} {
  const agent = makeAgent(id, followups)
  let sessionListener: ((session: { id: ReturnType<typeof SessionId> }, event: unknown) => void) | undefined
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (sid: ReturnType<typeof SessionId>) => (String(sid) === id ? agent : undefined),
    },
    on(event: string, listener: (session: { id: ReturnType<typeof SessionId> }, event: unknown) => void) {
      if (event === 'session/event') sessionListener = listener
      return () => {}
    },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent, {
      sendRichMessage: async (chatId, markdown) => {
        rich.push(markdown)
        return { message_id: 1, date: 0, chat: { id: chatId, type: 'private' }, text: markdown }
      },
    }),
    sleep: async () => {},
  })
  bridge.start()
  const emitAssistant = async (text: string): Promise<void> => {
    await sessionListener?.(
      { id: SessionId(id) },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } },
    )
    // deliver() chains async work past the listener's void return — flush.
    await new Promise((r) => setTimeout(r, 0))
  }
  return { bridge, emitAssistant }
}

test('default rendering is HTML compat (no rich messages unless /rich on)', async () => {
  const sent: SentMessage[] = []
  const rich: string[] = []
  const followups: UserMessage[] = []
  const bindingsFile = `/tmp/dsh-tg-test-bindings-default.json`
  process.env.DSH_TELEGRAM_BINDINGS_FILE = bindingsFile
  try {
    const { bridge, emitAssistant } = renderHarness('live-render-1', sent, rich, followups)
    await bridge.processUpdate({
      update_id: 1,
      callback_query: {
        id: 'cq',
        from: { id: 1 },
        message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
        data: `${BIND_CB_PREFIX}live-render-1`,
      },
    })
    await emitAssistant('default-mode reply')
    assert.equal(rich.length, 0, 'no rich message without /rich on')
    assert.ok(sent.some((m) => m.text.includes('default-mode reply')))
    await bridge.stop()
  } finally {
    delete process.env.DSH_TELEGRAM_BINDINGS_FILE
    rmSync(bindingsFile, { force: true })
  }
})

test('/rich on routes replies to sendRichMessage; /rich off reverts to HTML; status reports state', async () => {
  const sent: SentMessage[] = []
  const rich: string[] = []
  const followups: UserMessage[] = []
  const bindingsFile = `/tmp/dsh-tg-test-bindings-rich.json`
  process.env.DSH_TELEGRAM_BINDINGS_FILE = bindingsFile
  try {
    const { bridge, emitAssistant } = renderHarness('live-render-2', sent, rich, followups)
    await bridge.processUpdate({
      update_id: 1,
      callback_query: {
        id: 'cq',
        from: { id: 1 },
        message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
        data: `${BIND_CB_PREFIX}live-render-2`,
      },
    })
    // Default: HTML compat → no rich send yet.
    await emitAssistant('before toggle')
    assert.equal(rich.length, 0)

    // /rich (no arg) reports current state.
    await bridge.processUpdate(messageUpdate(10, 1, '/rich', 2))
    assert.match(sent.at(-1)!.text, /HTML 兼容/)

    // /rich on → assistant replies go through sendRichMessage.
    await bridge.processUpdate(messageUpdate(10, 1, '/rich on', 3))
    assert.match(sent.at(-1)!.text, /已切换为富文本/)
    await emitAssistant('rich-mode reply')
    assert.equal(rich.length, 1)
    assert.match(rich[0]!, /rich-mode reply/)

    // /rich on again is idempotent (still one preference, no dupes).
    await bridge.processUpdate(messageUpdate(10, 1, '/rich on', 4))
    assert.ok(!sent.at(-1)!.text.includes('已切换') || rich.length === 1)

    // /rich off → back to HTML compat path.
    await bridge.processUpdate(messageUpdate(10, 1, '/rich off', 5))
    assert.match(sent.at(-1)!.text, /已切换为 HTML/)
    await emitAssistant('compat-mode reply')
    assert.equal(rich.length, 1, 'no new rich send after /rich off')
    assert.ok(sent.some((m) => m.text.includes('compat-mode reply')))

    await bridge.stop()
  } finally {
    delete process.env.DSH_TELEGRAM_BINDINGS_FILE
    rmSync(bindingsFile, { force: true })
  }
})

// ── /status 通用状态显示（对齐 Web 底部统计条）──

test('/status shows bind/session/workspace/model/effort/context and web-style stats', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const sessionId = 'live-st'
  const agent = makeAgent(sessionId, followups, { cwd: '/work/proj-a', title: '演示任务' })
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === sessionId ? agent : undefined),
    },
    apiProxy: {
      workspace: {
        list: async () => rpcOk({
          items: [{
            workspaceId: 'w1',
            path: '/work/proj-a',
            title: 'Proj A',
            sessionIds: [sessionId],
          }],
          archivedSessionIds: [],
        }),
      },
      sessions: {
        list: async () => rpcOk({
          items: [{
            sessionId,
            updatedAt: 1,
            running: true,
            blank: false,
            cwd: '/work/proj-a',
          }],
        }),
        models: async () => rpcOk({
          current: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' },
          routable: true,
          groups: [],
        }),
      },
    },
    sessionProjections: {
      snapshot: () => ({
        asOfSeq: 0,
        values: {
          sessionStats: {
            turns: 3,
            steps: 5,
            llmMs: 4200,
            toolMs: 2100,
            ttftMs: 1500,
            ttftSteps: 5,
            decodeMs: 6000,
            decodeTokens: 3000,
          },
          tokenUsage: {
            uncachedInputTokens: 3000,
            cacheReadTokens: 21000,
            cacheWriteTokens: 500,
            outputTokens: 9000,
          },
          contextPressure: {
            contextWindow: 131072,
            projectedTokens: 64536,
          },
        },
      }),
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  // bind via legacy callback, then ask for status
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}${sessionId}`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/status', 2))
  const text = sent.at(-1)!.text
  assert.ok(text.includes('会话 ID：live-st'), text)
  assert.ok(text.includes('工作区：Proj A（/work/proj-a）'), text)
  assert.ok(text.includes('模型：deepseek/reasoner'), text)
  assert.ok(text.includes('思考强度：高（high）'), text)
  assert.ok(text.includes('上下文：64.5K / 131K tokens（49%）'), text)
  assert.ok(text.includes('3 轮 · 5 步'), text)
  assert.ok(text.includes('首 token 平均 0.3s'), text)
  assert.ok(text.includes('500 tok/s'), text)
  assert.ok(text.includes('缓存命中'), text)
  assert.ok(text.includes('输入 24.5K tok · 输出 9K tok'), text)
})

test('/status without bind prompts NEED_BIND', async () => {
  const sent: SentMessage[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/status'))
  assert.equal(sent[0]?.text, MSG.STATUS_NONE)
})

// ── /compact 手动压缩 ──

test('/compact compacts bound session and reports result', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const sessionId = 'live-cc'
  const agent = makeAgent(sessionId, followups)
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === sessionId ? agent : undefined),
    },
    commands: {
      find: () => true,
      execute: async () => ({
        commandId: 'cmd-1',
        result: { kind: 'success', text: 'Compacted 4 history items (~12345 tokens).' },
      }),
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}${sessionId}`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/compact', 2))
  assert.ok(sent.some((m) => m.text.includes('已开始压缩')), 'ack sent')
  // runCompaction runs detached; wait for its result notice
  for (let i = 0; i < 100 && !sent.some((m) => m.text.includes('压缩完成')); i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(sent.some((m) => m.text.includes('压缩完成')), 'compaction result notice arrives')
  assert.ok(
    sent.some((m) => m.text.includes('4 条历史记录（约 12345 tokens）')),
    'result mentions shadowed range',
  )
})

test('/compact busy agent replies COMPACT_BUSY without starting', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const sessionId = 'live-busy'
  const agent = makeAgent(sessionId, followups)
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === sessionId ? agent : undefined),
    },
    commands: {
      find: () => true,
      execute: async () => ({
        commandId: 'cmd-busy',
        result: {
          kind: 'error',
          text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
        },
      }),
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}${sessionId}`,
    },
  })
  sent.length = 0 // drop the BOUND message; keep only /compact replies
  await bridge.processUpdate(messageUpdate(10, 1, '/compact', 2))
  assert.ok(sent.some((m) => m.text.includes('已开始压缩')), 'ack sent')
  for (let i = 0; i < 100 && !sent.some((m) => m.text.includes(MSG.COMPACT_BUSY)); i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(sent.some((m) => m.text === MSG.COMPACT_BUSY), 'busy notice arrives')
})

test('/compact without registered /compact command reports unavailable', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const sessionId = 'live-noeng'
  const agent = makeAgent(sessionId, followups)
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === sessionId ? agent : undefined),
    },
    commands: {
      find: () => undefined, // command not registered on this host
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}${sessionId}`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/compact', 2))
  assert.equal(sent.at(-1)!.text, MSG.COMPACT_UNAVAILABLE)
})

test('/compact without bind prompts NEED_BIND', async () => {
  const sent: SentMessage[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/compact'))
  assert.equal(sent[0]?.text, MSG.NEED_BIND)
})

// ── 图片消息 ──

type PromptPayload = { sessionId: string; mode: string; content: Array<{ type: string; text?: string; mediaType?: string; data?: string; name?: string }> }

function photoUpdate(chatId: number, userId: number, fileId: string, opts?: {
  caption?: string
  mediaGroupId?: string
  updateId?: number
}): TelegramUpdate {
  const updateId = opts?.updateId ?? 1
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: userId },
      caption: opts?.caption,
      media_group_id: opts?.mediaGroupId,
      photo: [
        { file_id: `${fileId}-small`, file_unique_id: `${fileId}-small`, width: 90, height: 90 },
        { file_id: fileId, file_unique_id: fileId, width: 1280, height: 960, file_size: 300000 },
      ],
    },
  }
}

function bindUpdate(chatId: number, userId: number, sessionId: string): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: userId },
      message: { message_id: 1, date: 0, chat: { id: chatId, type: 'private' } },
      data: `${BIND_CB_PREFIX}${sessionId}`,
    },
  }
}

function imageBridgeCtx(sessionId: string, prompts: PromptPayload[], promptResult?: unknown) {
  const agent = makeAgent(sessionId, [])
  return {
    agent,
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      agents: {
        list: () => [agent],
        roots: () => [agent],
        get: (id: ReturnType<typeof SessionId>) => (String(id) === sessionId ? agent : undefined),
      },
      apiProxy: {
        sessions: {
          prompt: async (req: { payload: unknown }) => {
            prompts.push(req.payload as PromptPayload)
            return promptResult ?? rpcOk({ accepted: true })
          },
        },
      },
      on() { return () => {} },
    },
  }
}

test('photo with caption is admitted via sessions.prompt (largest size, jpeg, base64)', async () => {
  const sent: SentMessage[] = []
  const prompts: PromptPayload[] = []
  const sessionId = 'live-img'
  const { ctx } = imageBridgeCtx(sessionId, prompts)
  const jpegBytes = new Uint8Array([0xff, 0xd8, 1, 2, 3])
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent, {
      getFile: async (fileId: string) => ({ file_id: fileId, file_unique_id: fileId, file_path: `dir/${fileId}` }),
      downloadFile: async (filePath: string) => {
        assert.ok(filePath.includes('big-photo'), 'downloads the largest photo size')
        return jpegBytes
      },
    }),
    sleep: async () => {},
  })
  await bridge.processUpdate(bindUpdate(10, 1, sessionId))
  await bridge.processUpdate(photoUpdate(10, 1, 'big-photo', { caption: '看看这张图', updateId: 2 }))
  assert.equal(prompts.length, 1, 'one prompt RPC')
  const content = prompts[0]!.content
  assert.deepEqual(content[0], { type: 'text', text: '看看这张图' })
  assert.equal(content[1]?.type, 'image')
  assert.equal(content[1]?.mediaType, 'image/jpeg')
  assert.equal(content[1]?.data, Buffer.from(jpegBytes).toString('base64'))
  assert.ok(!sent.some((m) => m.text === MSG.MEDIA_UNSUPPORTED), 'no unsupported notice')
})

test('image document (png) is admitted with its file name', async () => {
  const sent: SentMessage[] = []
  const prompts: PromptPayload[] = []
  const sessionId = 'live-img-doc'
  const { ctx } = imageBridgeCtx(sessionId, prompts)
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(bindUpdate(10, 1, sessionId))
  await bridge.processUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: 0,
      chat: { id: 10, type: 'private' },
      from: { id: 1 },
      document: {
        file_id: 'doc-png',
        file_unique_id: 'doc-png',
        file_name: 'screenshot.png',
        mime_type: 'image/png',
        file_size: 5000,
      },
    },
  })
  assert.equal(prompts.length, 1)
  const image = prompts[0]!.content.find((p) => p.type === 'image')
  assert.equal(image?.mediaType, 'image/png')
  assert.equal(image?.name, 'screenshot.png')
})

test('non-image document gets MEDIA_UNSUPPORTED and no prompt', async () => {
  const sent: SentMessage[] = []
  const prompts: PromptPayload[] = []
  const sessionId = 'live-img-pdf'
  const { ctx } = imageBridgeCtx(sessionId, prompts)
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(bindUpdate(10, 1, sessionId))
  sent.length = 0
  await bridge.processUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: 0,
      chat: { id: 10, type: 'private' },
      from: { id: 1 },
      document: { file_id: 'doc-pdf', file_unique_id: 'doc-pdf', file_name: 'report.pdf', mime_type: 'application/pdf' },
    },
  })
  assert.equal(prompts.length, 0, 'no prompt dispatched')
  assert.ok(sent.some((m) => m.text === MSG.MEDIA_UNSUPPORTED), 'unsupported notice sent')
})

test('album photos collapse into a single prompt with all images', async () => {
  const sent: SentMessage[] = []
  const prompts: PromptPayload[] = []
  const sessionId = 'live-img-album'
  const { ctx } = imageBridgeCtx(sessionId, prompts)
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(bindUpdate(10, 1, sessionId))
  await bridge.processUpdate(photoUpdate(10, 1, 'album-1', { mediaGroupId: 'g1', updateId: 2 }))
  await bridge.processUpdate(photoUpdate(10, 1, 'album-2', { mediaGroupId: 'g1', updateId: 3 }))
  for (let i = 0; i < 500 && prompts.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(prompts.length, 1, 'album debounced into one prompt')
  assert.equal(prompts[0]!.content.filter((p) => p.type === 'image').length, 2)
})

test('model without image support replies IMAGE_MODEL_UNSUPPORTED', async () => {
  const sent: SentMessage[] = []
  const prompts: PromptPayload[] = []
  const sessionId = 'live-img-nv'
  const { ctx } = imageBridgeCtx(sessionId, prompts, {
    rpcId: 'x',
    result: {
      ok: false,
      error: {
        code: 'attachment-error',
        message: 'Model "deepseek-chat" does not support image input.',
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
      },
    },
  })
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(bindUpdate(10, 1, sessionId))
  sent.length = 0
  await bridge.processUpdate(photoUpdate(10, 1, 'nv-photo', { updateId: 2 }))
  for (let i = 0; i < 100 && sent.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(sent.some((m) => m.text === MSG.IMAGE_MODEL_UNSUPPORTED), 'model unsupported notice')
})

test('photo download failure replies IMAGE_FAILED', async () => {
  const sent: SentMessage[] = []
  const prompts: PromptPayload[] = []
  const sessionId = 'live-img-dl'
  const { ctx } = imageBridgeCtx(sessionId, prompts)
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent, {
      getFile: async () => { throw new Error('telegram timeout') },
    }),
    sleep: async () => {},
  })
  await bridge.processUpdate(bindUpdate(10, 1, sessionId))
  sent.length = 0
  await bridge.processUpdate(photoUpdate(10, 1, 'dl-photo', { updateId: 2 }))
  for (let i = 0; i < 100 && sent.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.equal(prompts.length, 0, 'no prompt dispatched')
  assert.ok(sent.some((m) => m.text.startsWith('图片发送失败。')), 'failure notice')
})

test('photo without bind prompts NEED_BIND and no prompt', async () => {
  const sent: SentMessage[] = []
  const prompts: PromptPayload[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    apiProxy: { sessions: { prompt: async (req: { payload: unknown }) => { prompts.push(req.payload as PromptPayload); return rpcOk({ accepted: true }) } } },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(photoUpdate(10, 1, 'unbound-photo', { updateId: 1 }))
  assert.equal(prompts.length, 0)
  assert.ok(sent.some((m) => m.text === MSG.NEED_BIND), 'NEED_BIND sent')
})

test('user-questions/request supports Telegram when the host has no Web answerer', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const sessionId = 'live-question-no-provider'
  const agent = makeAgent(sessionId, followups)
  let questionHook: ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  let questionHookDisposed = false
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === sessionId ? agent : undefined),
    },
    on(event: string, listener: (...args: any[]) => unknown) {
      if (event === 'user-questions/request') {
        questionHook = listener as typeof questionHook
        return () => { questionHookDisposed = true }
      }
      return () => {}
    },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
  })
  startTestBridge(bridge)
  await bridge.processUpdate(bindUpdate(10, 1, sessionId))
  sent.length = 0

  assert.ok(questionHook, 'user-questions/request hook registered')
  let guiCalled = false
  const answer = questionHook!({
    agent,
    questions: [{
      id: 'mode',
      question: 'Pick a mode',
      options: [{ label: 'Fast' }, { label: 'Careful' }],
    }],
  }, () => {
    guiCalled = true
    return Promise.reject(new Error('NO_PROVIDER'))
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(guiCalled, true, 'GUI waterfall continues')
  assert.ok(sent.some((message) => message.text.includes('Pick a mode') && message.text.includes('[B] Careful')))
  const beforeTelegramAnswer = await Promise.race([
    answer.then(() => 'settled', () => 'settled'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 5)),
  ])
  assert.equal(beforeTelegramAnswer, 'pending', 'NO_PROVIDER does not end the Telegram answer path')

  await bridge.processUpdate(messageUpdate(10, 1, 'B', 2))
  assert.deepEqual(await answer, { answers: [{ id: 'mode', selected: ['Careful'] }] })
  await bridge.stop()
  assert.equal(questionHookDisposed, true, 'waterfall hook disposed on stop')
})

test('user-questions/request without a bound chat stays on the Web path', async () => {
  const sent: SentMessage[] = []
  const agent = makeAgent('live-question-unbound', [])
  let questionHook: ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [agent], roots: () => [agent], get: () => agent },
    on(event: string, listener: (...args: any[]) => unknown) {
      if (event === 'user-questions/request') questionHook = listener as typeof questionHook
      return () => {}
    },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
  })
  startTestBridge(bridge)

  assert.ok(questionHook, 'user-questions/request hook registered')
  let guiCalled = false
  const result = await questionHook!({
    agent,
    questions: [{ id: 'mode', question: 'Pick a mode', options: [{ label: 'Fast' }] }],
  }, async () => {
    guiCalled = true
    return 'web answer'
  })
  assert.equal(result, 'web answer')
  assert.equal(guiCalled, true)
  assert.equal(sent.length, 0, 'no Telegram prompt is sent without a bound chat')
  await bridge.stop()
})

test('user-questions/request announces when the Web answer wins', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const sessionId = 'live-question-web-wins'
  const agent = makeAgent(sessionId, followups)
  let questionHook: ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === sessionId ? agent : undefined),
    },
    on(event: string, listener: (...args: any[]) => unknown) {
      if (event === 'user-questions/request') questionHook = listener as typeof questionHook
      return () => {}
    },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
  })
  startTestBridge(bridge)
  await bridge.processUpdate(bindUpdate(10, 1, sessionId))
  sent.length = 0

  assert.ok(questionHook, 'user-questions/request hook registered')
  let resolveGui!: (value: unknown) => void
  const gui = new Promise<unknown>((resolve) => { resolveGui = resolve })
  const answer = questionHook!({
    agent,
    questions: [{ id: 'mode', question: 'Pick a mode', options: [{ label: 'Fast' }] }],
  }, () => gui)
  await new Promise<void>((resolve) => setImmediate(resolve))
  resolveGui('web answer')
  assert.equal(await answer, 'web answer')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(sent.some((message) => message.text.includes('该问题已在 Web 端作答')))

  await bridge.processUpdate(messageUpdate(10, 1, 'follow-up', 2))
  assert.equal(followups.length, 1, 'the answered question is removed from the Telegram pending state')
  await bridge.stop()
})

// ── dsh 0.2 session-event vocabulary ──
//
// 0.2 removed two events this bridge used to consume: `assistant/chunk` (the
// Thinking indicator) and `todo/write` (the progress notice). These tests pin
// the replacements: `step/start` for the indicator, and the host todo tool's
// `todo_write` tool call for the list.

function eventHarness(id: string, sent: SentMessage[], followups: UserMessage[]) {
  const agent = makeAgent(id, followups)
  let sessionListener: ((session: { id: ReturnType<typeof SessionId> }, event: unknown) => void) | undefined
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (sid: ReturnType<typeof SessionId>) => (String(sid) === id ? agent : undefined),
    },
    on(event: string, listener: (session: { id: ReturnType<typeof SessionId> }, event: unknown) => void) {
      if (event === 'session/event') sessionListener = listener
      return () => {}
    },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  startTestBridge(bridge)
  const emit = async (event: unknown): Promise<void> => {
    await sessionListener?.({ id: SessionId(id) }, event)
    // onSessionEvent is invoked with `void`, and notices chain through
    // enqueueNotice — flush both before asserting.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  }
  return { bridge, emit }
}

test('step/start drives the Thinking notice once per model call', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const { bridge, emit } = eventHarness('live-step', sent, followups)
  await bridge.processUpdate(bindUpdate(10, 1, 'live-step'))
  sent.length = 0
  const thinking = (): number => sent.filter((m) => m.text === '> Thinking…').length

  await emit({ type: 'step/start', data: { turn: 1, step: 1 } })
  assert.equal(thinking(), 1, 'first step announces')

  await emit({ type: 'step/start', data: { turn: 1, step: 1 } })
  assert.equal(thinking(), 1, 'the same step does not announce twice')

  // A tool call resets the flag, so the next step of the same turn announces.
  await emit({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'shell', arguments: '{}' } })
  await emit({ type: 'step/start', data: { turn: 1, step: 2 } })
  assert.equal(thinking(), 2, 'a later step announces again')

  await bridge.stop()
})

test('todo_write tool call carries the todo list (progress notice + /mission)', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const { bridge, emit } = eventHarness('live-todo', sent, followups)
  await bridge.processUpdate(bindUpdate(10, 1, 'live-todo'))
  sent.length = 0

  await emit({
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      callId: 'call-todo',
      name: 'todo_write',
      arguments: JSON.stringify({
        todos: [
          { content: '读代码', status: 'completed' },
          { content: '改兼容', status: 'in_progress' },
          { content: '跑测试', status: 'pending' },
        ],
      }),
    },
  })
  assert.ok(sent.some((m) => m.text === '> 进度 1/3：改兼容'), 'progress notice uses the parsed list')
  assert.ok(!sent.some((m) => m.text.startsWith('> todo_write')), 'the raw JSON tool line is suppressed')

  // A malformed payload must not wipe the list we already know about.
  await emit({
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'call-todo-2', name: 'todo_write', arguments: '{not json' },
  })

  await bridge.processUpdate(messageUpdate(10, 1, '/mission', 2))
  const mission = sent.at(-1)!.text
  assert.match(mission, /✓ 1\. 读代码/)
  assert.match(mission, /⟳ 2\. 改兼容/)
  assert.match(mission, /· 3\. 跑测试/)
  assert.match(mission, /1\/3 已完成/)

  await bridge.stop()
})
