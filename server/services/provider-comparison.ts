export type ProviderId = 'github-copilot' | 'claude'

export interface ProviderEvent {
  type: string
  label: string
  timestamp?: string
}

export interface ProviderExecution {
  id: string
  comparisonId: string
  provider: ProviderId
  runtime: string
  requestedModel?: string
  actualModel?: string
  response?: string
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
  contextUtilization?: number
  skillsUsed?: string[]
  subagentsUsed?: number
  events: ProviderEvent[]
  error?: string
  errorCode?: string
  setupHint?: string
  rawMetrics?: Record<string, unknown>
}

interface CopilotExecutionInput {
  id: string
  requestedModel: string
  model: string
  response?: string
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    reasoningTokens: number
    aiCredits?: number
    modelCalls: number
    durationMs: number
    context?: { percentage?: number }
    modelMetrics: Array<{
      reasoningTokens?: number
    }>
    toolCalls: number
    subagentCalls: number
    skillsInvoked: string[]
  }
  events?: Array<{ type: string; label: string; timestamp?: string }>
}

interface ClaudeUsageInput {
  id: string
  requestedModel?: string
  model?: string
  response?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  durationMs?: number
  numTurns?: number
  modelCalls?: number
  toolCalls?: number
  providerCostUsd?: number
  providerCostSource?: string
  events?: ProviderEvent[]
  rawMetrics?: Record<string, unknown>
}

export function normalizeCopilotExecution(
  execution: CopilotExecutionInput,
  comparisonId: string,
): ProviderExecution {
  const reasoningReported = execution.usage.modelMetrics.some(
    (metric) => metric.reasoningTokens !== undefined,
  )
  return {
    id: execution.id,
    comparisonId,
    provider: 'github-copilot',
    runtime: 'GitHub Copilot SDK',
    requestedModel: execution.requestedModel,
    actualModel: execution.model === 'SDK tarafından bildirilmedi' ? undefined : execution.model,
    response: execution.response,
    inputTokens: execution.usage.inputTokens,
    outputTokens: execution.usage.outputTokens,
    cachedTokens: execution.usage.cacheReadTokens,
    ...(reasoningReported ? { reasoningTokens: execution.usage.reasoningTokens } : {}),
    durationMs: execution.usage.durationMs,
    modelCalls: execution.usage.modelCalls,
    toolCalls: execution.usage.toolCalls,
    ...(execution.usage.aiCredits !== undefined
      ? { providerCost: execution.usage.aiCredits, providerCostUnit: 'AI Credit' }
      : {}),
    ...(execution.usage.context?.percentage !== undefined
      ? { contextUtilization: execution.usage.context.percentage }
      : {}),
    skillsUsed: execution.usage.skillsInvoked,
    subagentsUsed: execution.usage.subagentCalls,
    events: execution.events ?? [],
    rawMetrics: {
      usage: execution.usage,
    },
  }
}

export function normalizeClaudeExecution(
  execution: ClaudeUsageInput,
  comparisonId: string,
): ProviderExecution {
  return {
    id: execution.id,
    comparisonId,
    provider: 'claude',
    runtime: 'Claude Agent SDK',
    ...(execution.requestedModel ? { requestedModel: execution.requestedModel } : {}),
    actualModel: execution.model,
    response: execution.response,
    inputTokens: execution.inputTokens,
    outputTokens: execution.outputTokens,
    cachedTokens: execution.cachedTokens,
    cacheCreationTokens: execution.cacheCreationTokens,
    reasoningTokens: execution.reasoningTokens,
    durationMs: execution.durationMs,
    ...(execution.numTurns !== undefined ? { numTurns: execution.numTurns } : {}),
    ...(execution.modelCalls !== undefined ? { modelCalls: execution.modelCalls } : {}),
    ...(execution.toolCalls !== undefined ? { toolCalls: execution.toolCalls } : {}),
    ...(execution.providerCostUsd !== undefined
      ? {
          providerCost: execution.providerCostUsd,
          providerCostUnit: 'USD',
          providerCostSource: execution.providerCostSource,
        }
      : {}),
    events: execution.events ?? [],
    rawMetrics: execution.rawMetrics,
  }
}

export interface ComparisonSummary {
  faster?: ProviderId | 'tie'
  fewerInputTokens?: ProviderId | 'tie'
  fewerOutputTokens?: ProviderId | 'tie'
  fewerTotalTokens?: ProviderId | 'tie'
  fewerModelCalls?: ProviderId | 'tie'
  fewerToolCalls?: ProviderId | 'tie'
  costs: Array<{
    provider: ProviderId
    amount: number
    unit: 'AI Credit' | 'USD'
  }>
}

function lowerValue(
  left: number | undefined,
  right: number | undefined,
  leftProvider: ProviderId,
  rightProvider: ProviderId,
): ProviderId | 'tie' | undefined {
  if (left === undefined || right === undefined) return undefined
  if (left === right) return 'tie'
  return left < right ? leftProvider : rightProvider
}

export function createComparisonSummary(
  executions: ProviderExecution[],
): ComparisonSummary {
  const copilot = executions.find((item) => item.provider === 'github-copilot' && !item.error)
  const claude = executions.find((item) => item.provider === 'claude' && !item.error)
  if (!copilot || !claude) {
    return {
      costs: executions.flatMap((item) =>
        item.providerCost !== undefined && item.providerCostUnit
          ? [{ provider: item.provider, amount: item.providerCost, unit: item.providerCostUnit }]
          : [],
      ),
    }
  }

  const leftTotal = copilot.inputTokens !== undefined && copilot.outputTokens !== undefined
    ? copilot.inputTokens + copilot.outputTokens
    : undefined
  const rightTotal = claude.inputTokens !== undefined && claude.outputTokens !== undefined
    ? claude.inputTokens + claude.outputTokens
    : undefined

  return {
    ...(lowerValue(copilot.durationMs, claude.durationMs, 'github-copilot', 'claude')
      ? { faster: lowerValue(copilot.durationMs, claude.durationMs, 'github-copilot', 'claude') }
      : {}),
    ...(lowerValue(copilot.inputTokens, claude.inputTokens, 'github-copilot', 'claude')
      ? { fewerInputTokens: lowerValue(copilot.inputTokens, claude.inputTokens, 'github-copilot', 'claude') }
      : {}),
    ...(lowerValue(copilot.outputTokens, claude.outputTokens, 'github-copilot', 'claude')
      ? { fewerOutputTokens: lowerValue(copilot.outputTokens, claude.outputTokens, 'github-copilot', 'claude') }
      : {}),
    ...(lowerValue(leftTotal, rightTotal, 'github-copilot', 'claude')
      ? { fewerTotalTokens: lowerValue(leftTotal, rightTotal, 'github-copilot', 'claude') }
      : {}),
    ...(lowerValue(copilot.modelCalls, claude.modelCalls, 'github-copilot', 'claude')
      ? { fewerModelCalls: lowerValue(copilot.modelCalls, claude.modelCalls, 'github-copilot', 'claude') }
      : {}),
    ...(lowerValue(copilot.toolCalls, claude.toolCalls, 'github-copilot', 'claude')
      ? { fewerToolCalls: lowerValue(copilot.toolCalls, claude.toolCalls, 'github-copilot', 'claude') }
      : {}),
    costs: executions.flatMap((item) =>
      item.providerCost !== undefined && item.providerCostUnit
        ? [{ provider: item.provider, amount: item.providerCost, unit: item.providerCostUnit }]
        : [],
    ),
  }
}

export async function runProvidersIndependently(
  providers: ProviderId[],
  comparisonId: string,
  runners: Record<ProviderId, () => Promise<ProviderExecution>>,
  describeError?: (
    provider: ProviderId,
    error: unknown,
  ) => { error: string; errorCode: string; setupHint?: string } | undefined,
): Promise<ProviderExecution[]> {
  return Promise.all(providers.map(async (provider) => {
    try {
      return await runners[provider]()
    } catch (error) {
      const described = describeError?.(provider, error)
      return {
        id: `${comparisonId}-${provider}`,
        comparisonId,
        provider,
        runtime: provider === 'claude' ? 'Claude Agent SDK' : 'GitHub Copilot SDK',
        events: [],
        error: described?.error ?? (provider === 'claude'
          ? 'Claude çalıştırılamadı. Kimlik doğrulama ve API erişimini kontrol edin.'
          : 'Copilot çalıştırılamadı. SDK bağlantısını ve Copilot erişimini kontrol edin.'),
        ...(described ? { errorCode: described.errorCode } : {}),
        ...(described?.setupHint ? { setupHint: described.setupHint } : {}),
      }
    }
  }))
}
