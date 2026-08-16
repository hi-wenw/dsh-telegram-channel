import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { TelegramBridge } from './bridge.js'

export const name = 'dsh-telegram-channel'
/** agents: followup; apiProxy: workspace/session catalog + /model (Cordis requires inject to read ctx.apiProxy). */
export const inject = ['agents', 'apiProxy']

export interface TelegramChannelConfig {
  token?: string
  allowedUserIds?: number[]
  allowAllUsers?: boolean
  maxMessageLength?: number
  pollingTimeoutSec?: number
  rendering?: string
}

export const Config: Schema<TelegramChannelConfig> = Schema.object({
  token: Schema.string().default(''),
  allowedUserIds: Schema.array(Schema.number()).default([]),
  allowAllUsers: Schema.boolean().default(false),
  maxMessageLength: Schema.number().default(4096),
  pollingTimeoutSec: Schema.number().default(30),
  rendering: Schema.string().default('rich'),
})

function resolveAllowedUserIds(config: TelegramChannelConfig): number[] {
  if (config.allowedUserIds && config.allowedUserIds.length > 0) {
    return config.allowedUserIds
  }
  const raw = process.env.DSH_TELEGRAM_ALLOWED_USER_IDS ?? ''
  return raw
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n) && n > 0)
}

export function apply(ctx: Context, config: TelegramChannelConfig): void {
  const token = (config.token && config.token.length > 0)
    ? config.token
    : (process.env.DSH_TELEGRAM_TOKEN ?? '')
  if (!token) {
    ctx.logger.error(
      'dsh-telegram-channel: missing bot token (set config.token or DSH_TELEGRAM_TOKEN); polling not started',
    )
    return
  }
  const bridge = new TelegramBridge(ctx, {
    token,
    allowedUserIds: resolveAllowedUserIds(config),
    allowAllUsers: config.allowAllUsers ?? false,
    maxMessageLength: config.maxMessageLength ?? 4096,
    pollingTimeoutSec: config.pollingTimeoutSec ?? 30,
    rendering: config.rendering === 'html' ? 'html' : 'rich',
  })
  ctx.effect(() => {
    bridge.start()
    return () => { void bridge.stop() }
  }, 'dsh-telegram-channel.serve')
}

export * from './format.js'
export * from './client.js'
export * from './auth.js'
export * from './commands.js'
export * from './label.js'
export * from './bridge.js'
