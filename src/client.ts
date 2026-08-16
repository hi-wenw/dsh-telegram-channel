import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: string
  title?: string
  username?: string
}

export interface TelegramMessage {
  message_id: number
  date: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface InlineKeyboardButton {
  text: string
  callback_data: string
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

export interface TelegramBotCommand {
  command: string
  description: string
}

export interface TelegramInputRichMessage {
  markdown: string
  skip_entity_detection?: boolean
}

export interface TelegramClientOptions {
  fetch?: typeof fetch
  baseUrl?: string
  pollingTimeoutSec?: number
}

export interface TelegramClientLike {
  getMe(): Promise<TelegramUser>
  getUpdates(offset?: number): Promise<TelegramUpdate[]>
  sendMessage(
    chatId: number,
    text: string,
    parseMode?: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<TelegramMessage>
  sendRichMessage(chatId: number, markdown: string): Promise<TelegramMessage>
  sendChatAction(chatId: number, action: string): Promise<boolean>
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>
  setMyCommands(commands: TelegramBotCommand[]): Promise<boolean>
}

function resolveProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.https_proxy
    || process.env.http_proxy
    || undefined
  )
}

/**
 * Node's global `fetch` ignores HTTP(S)_PROXY unless `NODE_USE_ENV_PROXY=1`.
 * Undici's EnvHttpProxyAgent honors the env vars (and NO_PROXY).
 */
function createDefaultFetch(): typeof fetch {
  if (!resolveProxyUrl()) return globalThis.fetch
  const agent = new EnvHttpProxyAgent()
  const proxied = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    })) as unknown as typeof fetch
  return proxied
}

export class TelegramClient implements TelegramClientLike {
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly pollingTimeoutSec: number

  constructor(token: string, options: TelegramClientOptions = {}) {
    if (!token) {
      throw new Error('bot token is required')
    }
    this.token = token
    this.fetchImpl = options.fetch ?? createDefaultFetch()
    this.baseUrl = options.baseUrl ?? 'https://api.telegram.org'
    this.pollingTimeoutSec = options.pollingTimeoutSec ?? 30
  }

  private redact(message: string): string {
    return message.split(this.token).join('***')
  }

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
      if (body !== undefined) {
        init.body = JSON.stringify(body)
      }
      const response = await this.fetchImpl(url, init)
      const json = (await response.json()) as { ok: boolean; result: T; description?: string }
      if (!json.ok) {
        throw new Error(json.description ?? 'Telegram API error')
      }
      return json.result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(this.redact(message))
    }
  }

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe')
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      timeout: this.pollingTimeoutSec,
      allowed_updates: ['message', 'callback_query'],
    }
    if (offset !== undefined) {
      body.offset = offset
    }
    return this.call<TelegramUpdate[]>('getUpdates', body)
  }

  async sendMessage(
    chatId: number,
    text: string,
    parseMode?: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<TelegramMessage> {
    const body: Record<string, unknown> = { chat_id: chatId, text }
    if (parseMode !== undefined) {
      body.parse_mode = parseMode
    }
    if (replyMarkup !== undefined) {
      body.reply_markup = replyMarkup
    }
    return this.call<TelegramMessage>('sendMessage', body)
  }

  async sendRichMessage(chatId: number, markdown: string): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      rich_message: {
        markdown,
        skip_entity_detection: true,
      },
    }
    return this.call<TelegramMessage>('sendRichMessage', body)
  }

  async sendChatAction(chatId: number, action: string): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action })
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId }
    if (text !== undefined) body.text = text
    return this.call<boolean>('answerCallbackQuery', body)
  }

  async setMyCommands(commands: TelegramBotCommand[]): Promise<boolean> {
    return this.call<boolean>('setMyCommands', { commands })
  }
}
