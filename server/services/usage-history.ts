import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

export interface ExecutionRecord {
  id: string
  label: string
  strategy: string
  createdAt: string
  response?: string
  requestedModel: string
  requestedAutoTier?: string
  model: string
  usage: {
    status: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    reasoningTokens: number
    aiCredits?: number
    nanoAiu?: number
    modelCalls: number
    durationMs: number
    context?: {
      currentTokens: number
      tokenLimit: number
      conversationTokens?: number
      systemTokens?: number
      percentage?: number
    }
    modelMetrics: Array<{
      id: string
      requests: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      reasoningTokens?: number
      nanoAiu?: number
    }>
    calls: Array<{
      model: string
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      reasoningTokens?: number
      durationMs?: number
      legacyRequestCost?: number
      timestamp: string
    }>
    toolCalls: number
    subagentCalls: number
    skillsInvoked: string[]
    legacyPremiumRequestCost?: number
    aiCreditsStatus?: string
    maxAiCreditLimit?: number
    limitUsagePercentage?: number
  }
  events: Array<{
    id: string
    type: string
    label: string
    timestamp: string
    details?: Record<string, string | number | undefined>
  }>
  comparisonId?: string
}

export type ProviderId = 'github-copilot' | 'claude'

export interface ProviderHistoryRecord {
  id: string
  label: string
  strategy: string
  createdAt: string
  provider: ProviderId
  comparisonId: string
  requestedModel?: string
  requestedAutoTier?: string
  actualModel?: string
  model?: string
  usage?: ExecutionRecord['usage']
  metrics?: {
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    durationMs?: number
    numTurns?: number
    modelCalls?: number
    toolCalls?: number
    providerCost?: number
    providerCostUnit?: 'AI Credit' | 'USD'
    providerCostSource?: string
  }
  error?: string
  errorCode?: string
  events: ExecutionRecord['events']
}

export interface HistoryQuery {
  limit?: number
  provider?: ProviderId
}

export interface HistoryStore {
  readonly kind: 'sqlite' | 'memory'
  add(record: ProviderHistoryRecord): void
  list(query?: HistoryQuery): ProviderHistoryRecord[]
  count(): number
}

const defaultListLimit = 30
const maxListLimit = 200

function clampLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return defaultListLimit
  return Math.min(limit, maxListLimit)
}

function cloneRecord(record: ProviderHistoryRecord): ProviderHistoryRecord {
  return { ...record, events: [...record.events] }
}

/** Kalıcı olmayan yedek depo: veritabanı açılamazsa kullanılır. */
export function createMemoryHistoryStore(maxRecords = defaultListLimit): HistoryStore {
  const records: ProviderHistoryRecord[] = []
  return {
    kind: 'memory',
    add(record) {
      records.unshift(cloneRecord(record))
      records.length = Math.min(records.length, maxRecords)
    },
    list(query = {}) {
      return records
        .filter((item) => !query.provider || item.provider === query.provider)
        .slice(0, clampLimit(query.limit))
        .map(cloneRecord)
    },
    count() {
      return records.length
    },
  }
}

type Row = Record<string, SQLInputValue>

const toDb = (value: unknown): SQLInputValue => {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

const fromDb = <T>(value: SQLInputValue): T | undefined =>
  (value === null || value === undefined ? undefined : value) as T | undefined

function parseJson<T>(value: SQLInputValue): T | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

/** Kayıtları SQLite'ta tutar; en yeni `retention` kayıt dışındakileri siler. */
export function createSqliteHistoryStore(
  db: DatabaseSync,
  { retention = 1_000 }: { retention?: number } = {},
): HistoryStore {
  const insertExecution = db.prepare(`
    INSERT INTO executions (
      id, comparison_id, provider, runtime, strategy, status, error_code, error_message, label,
      requested_model, requested_auto_tier, actual_model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, duration_ms, num_turns,
      model_calls, tool_calls, subagent_calls, skills_invoked, cost_amount, cost_unit,
      cost_source, nano_aiu, ai_credits_status, max_ai_credit_limit, context_tokens,
      context_limit, usage_json, created_at
    ) VALUES (
      $id, $comparisonId, $provider, $runtime, $strategy, $status, $errorCode, $errorMessage, $label,
      $requestedModel, $requestedAutoTier, $actualModel, $inputTokens, $outputTokens,
      $cacheReadTokens, $cacheWriteTokens, $reasoningTokens, $durationMs, $numTurns,
      $modelCalls, $toolCalls, $subagentCalls, $skillsInvoked, $costAmount, $costUnit,
      $costSource, $nanoAiu, $aiCreditsStatus, $maxAiCreditLimit, $contextTokens,
      $contextLimit, $usageJson, $createdAt
    )
  `)
  const insertModelUsage = db.prepare(`
    INSERT INTO model_usage (
      execution_id, model_id, requests, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, nano_aiu
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertEvent = db.prepare(`
    INSERT INTO execution_events (execution_id, seq, event_id, type, label, details_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const prune = db.prepare(`
    DELETE FROM executions WHERE id IN (
      SELECT id FROM executions ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )
  `)
  const selectAll = db.prepare('SELECT * FROM executions ORDER BY created_at DESC, rowid DESC LIMIT ?')
  const selectByProvider = db.prepare(
    'SELECT * FROM executions WHERE provider = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
  )
  const selectEvents = db.prepare(
    'SELECT * FROM execution_events WHERE execution_id = ? ORDER BY seq',
  )
  const countRows = db.prepare('SELECT COUNT(*) AS total FROM executions')

  function toRow(record: ProviderHistoryRecord): Row {
    const usage = record.usage
    const metrics = record.metrics
    const cacheWrite = usage?.modelMetrics.length
      ? usage.modelMetrics.reduce((total, item) => total + (item.cacheWriteTokens ?? 0), 0)
      : metrics?.cacheWriteTokens
    const costAmount = usage ? usage.aiCredits : metrics?.providerCost
    const costUnit = usage
      ? (usage.aiCredits !== undefined ? 'AI Credit' : undefined)
      : metrics?.providerCostUnit
    return {
      id: toDb(record.id),
      comparisonId: toDb(record.comparisonId),
      provider: toDb(record.provider),
      runtime: toDb(record.provider === 'claude' ? 'Claude Agent SDK' : 'GitHub Copilot SDK'),
      strategy: toDb(record.strategy),
      status: record.error ? 'error' : 'success',
      errorCode: toDb(record.errorCode),
      errorMessage: toDb(record.error),
      label: toDb(record.label.slice(0, 80)),
      requestedModel: toDb(record.requestedModel),
      requestedAutoTier: toDb(record.requestedAutoTier),
      actualModel: toDb(record.actualModel ?? record.model),
      inputTokens: toDb(usage?.inputTokens ?? metrics?.inputTokens),
      outputTokens: toDb(usage?.outputTokens ?? metrics?.outputTokens),
      cacheReadTokens: toDb(usage?.cacheReadTokens ?? metrics?.cachedTokens),
      cacheWriteTokens: toDb(cacheWrite),
      reasoningTokens: toDb(usage?.reasoningTokens ?? metrics?.reasoningTokens),
      durationMs: toDb(usage?.durationMs ?? metrics?.durationMs),
      numTurns: toDb(metrics?.numTurns),
      modelCalls: toDb(usage?.modelCalls ?? metrics?.modelCalls),
      toolCalls: toDb(usage?.toolCalls ?? metrics?.toolCalls),
      subagentCalls: toDb(usage?.subagentCalls),
      skillsInvoked: usage?.skillsInvoked.length ? JSON.stringify(usage.skillsInvoked) : null,
      costAmount: toDb(costAmount),
      costUnit: toDb(costUnit),
      costSource: toDb(metrics?.providerCostSource),
      nanoAiu: toDb(usage?.nanoAiu),
      aiCreditsStatus: toDb(usage?.aiCreditsStatus),
      maxAiCreditLimit: toDb(usage?.maxAiCreditLimit),
      contextTokens: toDb(usage?.context?.currentTokens),
      contextLimit: toDb(usage?.context?.tokenLimit),
      usageJson: usage ? JSON.stringify(usage) : null,
      createdAt: toDb(record.createdAt),
    }
  }

  function fromRow(row: Row): ProviderHistoryRecord {
    const provider = row.provider as ProviderId
    const usage = parseJson<ExecutionRecord['usage']>(row.usage_json)
    const events = (selectEvents.all(row.id as string) as Row[]).map((event) => {
      const details = parseJson<Record<string, string | number | undefined>>(event.details_json)
      return {
        id: (event.event_id as string | null) ?? `${row.id as string}-${event.seq as number}`,
        type: event.type as string,
        label: event.label as string,
        timestamp: event.occurred_at as string,
        ...(details ? { details } : {}),
      }
    })
    const record: ProviderHistoryRecord = {
      id: row.id as string,
      label: row.label as string,
      strategy: row.strategy as string,
      createdAt: row.created_at as string,
      provider,
      comparisonId: row.comparison_id as string,
      ...(fromDb(row.requested_model) ? { requestedModel: fromDb<string>(row.requested_model) } : {}),
      ...(fromDb(row.requested_auto_tier) ? { requestedAutoTier: fromDb<string>(row.requested_auto_tier) } : {}),
      ...(fromDb(row.actual_model) ? { actualModel: fromDb<string>(row.actual_model), model: fromDb<string>(row.actual_model) } : {}),
      ...(fromDb(row.error_message) ? { error: fromDb<string>(row.error_message) } : {}),
      ...(fromDb(row.error_code) ? { errorCode: fromDb<string>(row.error_code) } : {}),
      events,
    }
    if (usage) {
      record.usage = usage
    } else {
      const metrics = {
        inputTokens: fromDb<number>(row.input_tokens),
        outputTokens: fromDb<number>(row.output_tokens),
        cachedTokens: fromDb<number>(row.cache_read_tokens),
        cacheWriteTokens: fromDb<number>(row.cache_write_tokens),
        reasoningTokens: fromDb<number>(row.reasoning_tokens),
        durationMs: fromDb<number>(row.duration_ms),
        numTurns: fromDb<number>(row.num_turns),
        modelCalls: fromDb<number>(row.model_calls),
        toolCalls: fromDb<number>(row.tool_calls),
        providerCost: fromDb<number>(row.cost_amount),
        providerCostUnit: fromDb<'AI Credit' | 'USD'>(row.cost_unit),
        providerCostSource: fromDb<string>(row.cost_source),
      }
      record.metrics = Object.fromEntries(
        Object.entries(metrics).filter(([, value]) => value !== undefined),
      ) as ProviderHistoryRecord['metrics']
    }
    return record
  }

  return {
    kind: 'sqlite',
    add(record) {
      db.exec('BEGIN')
      try {
        insertExecution.run(toRow(record))
        for (const metric of record.usage?.modelMetrics ?? []) {
          insertModelUsage.run(
            record.id,
            metric.id,
            toDb(metric.requests),
            toDb(metric.inputTokens),
            toDb(metric.outputTokens),
            toDb(metric.cacheReadTokens),
            toDb(metric.cacheWriteTokens),
            toDb(metric.reasoningTokens),
            toDb(metric.nanoAiu),
          )
        }
        record.events.forEach((event, index) => {
          insertEvent.run(
            record.id,
            index,
            toDb(event.id),
            event.type,
            event.label,
            event.details ? JSON.stringify(event.details) : null,
            event.timestamp,
          )
        })
        prune.run(retention)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    list(query = {}) {
      const limit = clampLimit(query.limit)
      const rows = (query.provider
        ? selectByProvider.all(query.provider, limit)
        : selectAll.all(limit)) as Row[]
      return rows.map(fromRow)
    },
    count() {
      return (countRows.get() as { total: number }).total
    },
  }
}

let store: HistoryStore = createMemoryHistoryStore()

/** Uygulama başlangıcında kalıcı depoyu etkinleştirmek için. */
export function setHistoryStore(next: HistoryStore) {
  store = next
}

export function getHistoryStore(): HistoryStore {
  return store
}

function safeAdd(record: ProviderHistoryRecord) {
  try {
    store.add(record)
  } catch (error) {
    // Kayıt hatası kullanıcının çalıştırma sonucunu bozmamalı.
    console.error('Kullanım geçmişi kaydedilemedi:', error instanceof Error ? error.message : error)
  }
}

export function addExecution(execution: ExecutionRecord) {
  safeAdd({
    id: execution.id,
    label: execution.label,
    strategy: execution.strategy,
    createdAt: execution.createdAt,
    provider: 'github-copilot',
    comparisonId: execution.comparisonId ?? execution.id,
    requestedModel: execution.requestedModel,
    ...(execution.requestedAutoTier ? { requestedAutoTier: execution.requestedAutoTier } : {}),
    actualModel: execution.model,
    model: execution.model,
    usage: execution.usage,
    events: execution.events,
  })
}

export function addProviderExecution(execution: {
  id: string
  label: string
  comparisonId: string
  provider: ProviderId
  strategy?: string
  requestedModel?: string
  actualModel?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  durationMs?: number
  numTurns?: number
  modelCalls?: number
  toolCalls?: number
  providerCost?: number
  providerCostUnit?: 'AI Credit' | 'USD'
  providerCostSource?: string
  error?: string
  errorCode?: string
  events: Array<{ type: string; label: string; timestamp?: string }>
}) {
  const metrics = {
    inputTokens: execution.inputTokens,
    outputTokens: execution.outputTokens,
    cachedTokens: execution.cachedTokens,
    cacheWriteTokens: execution.cacheCreationTokens,
    reasoningTokens: execution.reasoningTokens,
    durationMs: execution.durationMs,
    numTurns: execution.numTurns,
    modelCalls: execution.modelCalls,
    toolCalls: execution.toolCalls,
    providerCost: execution.providerCost,
    providerCostUnit: execution.providerCostUnit,
    providerCostSource: execution.providerCostSource,
  }
  safeAdd({
    id: execution.id,
    label: execution.label,
    strategy: execution.strategy ?? 'normal',
    createdAt: new Date().toISOString(),
    provider: execution.provider,
    comparisonId: execution.comparisonId,
    ...(execution.requestedModel ? { requestedModel: execution.requestedModel } : {}),
    actualModel: execution.actualModel,
    model: execution.actualModel,
    metrics: Object.fromEntries(
      Object.entries(metrics).filter(([, value]) => value !== undefined),
    ) as ProviderHistoryRecord['metrics'],
    error: execution.error,
    ...(execution.errorCode ? { errorCode: execution.errorCode } : {}),
    events: execution.events.map((event, index) => ({
      id: `${execution.id}-${index}`,
      type: event.type,
      label: event.label,
      timestamp: event.timestamp ?? new Date().toISOString(),
    })),
  })
}

export function getHistory(query?: HistoryQuery): ProviderHistoryRecord[] {
  try {
    return store.list(query)
  } catch (error) {
    console.error('Kullanım geçmişi okunamadı:', error instanceof Error ? error.message : error)
    return []
  }
}
