import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  getClaudeStatus,
  normalizeClaudeExecution,
  type ProviderEvent,
  type ProviderExecution,
} from './provider-comparison.js'

let authenticationFailed = false
let sdkAvailability: Promise<boolean> | undefined

export class ClaudeSdkUnavailableError extends Error {
  constructor() {
    super('Claude SDK kullanılamıyor')
    this.name = 'ClaudeSdkUnavailableError'
  }
}

export class ClaudeAuthenticationError extends Error {
  constructor() {
    super('Claude kimlik doğrulaması başarısız oldu. API anahtarını kontrol edin.')
    this.name = 'ClaudeAuthenticationError'
  }
}

async function loadQuery() {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    return sdk.query
  } catch {
    throw new ClaudeSdkUnavailableError()
  }
}

export async function getClaudeConnectionStatus(apiKey: string | undefined) {
  sdkAvailability ??= loadQuery().then(() => true).catch(() => false)
  const sdkAvailable = await sdkAvailability
  return getClaudeStatus(apiKey, sdkAvailable, authenticationFailed)
}

export async function runClaude(prompt: string, comparisonId: string): Promise<ProviderExecution> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey?.trim()) {
    throw new Error('API anahtarı eksik')
  }
  const query = await loadQuery()
  sdkAvailability = Promise.resolve(true)

  const startedAt = Date.now()
  const events: ProviderEvent[] = []
  const modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    thinkingTokens?: number
    costUSD: number
    costBasis?: 'list' | 'managed' | 'unknown'
  }> = {}
  let actualModel: string | undefined
  let response = ''
  let durationMs: number | undefined
  let providerCostUsd: number | undefined
  let resultFound = false

  const queryResult = query({
    prompt,
    options: {
      tools: [],
      settingSources: [],
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      maxTurns: 1,
      persistSession: false,
      cwd: tmpdir(),
    },
  })

  try {
    for await (const message of queryResult) {
      if (message.type === 'system' && message.subtype === 'init') {
        actualModel = message.model
        events.push({
          type: 'runtime',
          label: `Claude Agent SDK oturumu başladı · ${message.claude_code_version}`,
          timestamp: new Date().toISOString(),
        })
      } else if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') response += block.text
          else if (block.type === 'tool_use') {
            events.push({
              type: 'tool',
              label: `Araç çağrısı istendi: ${block.name}`,
              timestamp: new Date().toISOString(),
            })
          }
        }
      } else if (message.type === 'system' && message.subtype === 'task_started') {
        events.push({
          type: 'agent',
          label: 'Claude arka plan ajanı başladı',
          timestamp: new Date().toISOString(),
        })
      } else if (message.type === 'result') {
        resultFound = true
        if (message.subtype !== 'success' || message.is_error) {
          const errorDetails = 'errors' in message
            ? message.errors.join(' ')
            : 'result' in message
              ? message.result
              : ''
          if (isAuthenticationError(errorDetails)) {
            authenticationFailed = true
            throw new ClaudeAuthenticationError()
          }
          throw new Error('Claude Agent SDK bir hata sonucu döndürdü.')
        }
        response = message.result
        durationMs = message.duration_ms
        providerCostUsd = message.total_cost_usd
        for (const [model, metrics] of Object.entries(message.modelUsage)) {
          modelUsage[model] = metrics
        }
        const actualModels = Object.keys(message.modelUsage)
        if (actualModels.length) actualModel = actualModels.join(', ')
      }
    }
  } catch (error) {
    queryResult.close()
    if (isAuthenticationError(error)) {
      authenticationFailed = true
      throw new ClaudeAuthenticationError()
    }
    throw error
  }

  if (!resultFound) {
    throw new Error('Claude Agent SDK sonuç ölçümü döndürmedi.')
  }
  authenticationFailed = false

  const usageRows = Object.values(modelUsage)
  const sum = (select: (item: (typeof usageRows)[number]) => number | undefined) => {
    const values = usageRows.map(select).filter((value): value is number => value !== undefined)
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined
  }
  const reasoningTokens = sum((item) => item.thinkingTokens)
  const costBases = [...new Set(usageRows.map((item) => item.costBasis).filter(Boolean))]
  const costSource = costBases.includes('unknown')
    ? 'SDK fiyat tahmini · fiyat tabanı bilinmiyor'
    : costBases.includes('managed')
      ? 'SDK tarafından ölçüldü · kuruluş fiyatlandırması'
      : 'SDK tarafından ölçüldü · SDK fiyat tablosu'

  return normalizeClaudeExecution({
    id: randomUUID(),
    model: actualModel,
    response,
    inputTokens: sum((item) => item.inputTokens),
    outputTokens: sum((item) => item.outputTokens),
    cachedTokens: sum((item) => item.cacheReadInputTokens),
    cacheCreationTokens: sum((item) => item.cacheCreationInputTokens),
    reasoningTokens,
    durationMs: durationMs ?? Date.now() - startedAt,
    providerCostUsd,
    providerCostSource: costSource,
    events,
    rawMetrics: {
      modelUsage,
      durationMs,
    },
  }, comparisonId)
}

function isAuthenticationError(error: unknown): boolean {
  const authenticationMessage = /\b(401|403)\b|unauthorized|invalid.{0,24}(api )?key|api key.{0,30}(invalid|missing|not found|unauthorized)|authentication (failed|error)|not authenticated/i
  if (typeof error === 'string') return authenticationMessage.test(error)
  if (!error || typeof error !== 'object') return false
  const record = error as {
    message?: unknown
    stderr?: unknown
    status?: unknown
    statusCode?: unknown
    cause?: unknown
  }
  const status = record.status ?? record.statusCode
  if (status === 401 || status === 403) return true
  return (
    (typeof record.message === 'string' && authenticationMessage.test(record.message)) ||
    (typeof record.stderr === 'string' && authenticationMessage.test(record.stderr)) ||
    (record.cause !== undefined && isAuthenticationError(record.cause))
  )
}
