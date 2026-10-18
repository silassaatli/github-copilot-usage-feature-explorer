export interface ExecutionRecord {
  id: string
  label: string
  strategy: string
  createdAt: string
  response?: string
  requestedModel: string
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

export interface ProviderHistoryRecord {
  id: string
  label: string
  strategy: string
  createdAt: string
  provider: 'github-copilot' | 'claude'
  comparisonId: string
  requestedModel?: string
  actualModel?: string
  model?: string
  usage?: ExecutionRecord['usage']
  metrics?: {
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    reasoningTokens?: number
    durationMs?: number
    modelCalls?: number
    toolCalls?: number
    providerCost?: number
    providerCostUnit?: 'AI Credit' | 'USD'
  }
  error?: string
  events: ExecutionRecord['events']
}

const maxHistory = 30
const executions: ProviderHistoryRecord[] = []

export function addExecution(execution: ExecutionRecord) {
  const stored: ProviderHistoryRecord = {
    id: execution.id,
    label: execution.label,
    strategy: execution.strategy,
    createdAt: execution.createdAt,
    provider: 'github-copilot',
    comparisonId: execution.comparisonId ?? execution.id,
    requestedModel: execution.requestedModel,
    actualModel: execution.model,
    model: execution.model,
    usage: execution.usage,
    events: execution.events,
  }
  addHistoryRecord(stored)
}

export function addProviderExecution(execution: {
  id: string
  label: string
  comparisonId: string
  provider: 'github-copilot' | 'claude'
  actualModel?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
  durationMs?: number
  modelCalls?: number
  toolCalls?: number
  providerCost?: number
  providerCostUnit?: 'AI Credit' | 'USD'
  error?: string
  events: Array<{ type: string; label: string; timestamp?: string }>
}) {
  addHistoryRecord({
    id: execution.id,
    label: execution.label,
    strategy: 'normal',
    createdAt: new Date().toISOString(),
    provider: execution.provider,
    comparisonId: execution.comparisonId,
    actualModel: execution.actualModel,
    model: execution.actualModel,
    metrics: {
      inputTokens: execution.inputTokens,
      outputTokens: execution.outputTokens,
      cachedTokens: execution.cachedTokens,
      reasoningTokens: execution.reasoningTokens,
      durationMs: execution.durationMs,
      modelCalls: execution.modelCalls,
      toolCalls: execution.toolCalls,
      providerCost: execution.providerCost,
      providerCostUnit: execution.providerCostUnit,
    },
    error: execution.error,
    events: execution.events.map((event) => ({
      id: `${execution.id}-${event.type}-${event.timestamp ?? 'event'}`,
      type: event.type,
      label: event.label,
      timestamp: event.timestamp ?? new Date().toISOString(),
    })),
  })
}

function addHistoryRecord(record: ProviderHistoryRecord) {
  executions.unshift(record)
  executions.length = Math.min(executions.length, maxHistory)
}

export function getHistory(): ProviderHistoryRecord[] {
  return executions.map((execution) => ({ ...execution, events: [...execution.events] }))
}
