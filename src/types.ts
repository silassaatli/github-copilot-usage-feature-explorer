export type SectionId =
  | 'playground'
  | 'usage'
  | 'advisor'
  | 'comparison'
  | 'licensing'
  | 'reports'
  | 'features'

export type Strategy = 'normal' | 'skill' | 'subagents' | 'fleet'
export type ProviderId = 'github-copilot' | 'claude'

export interface ExecutionEvent {
  id: string
  type: string
  label: string
  timestamp: string
  details?: Record<string, string | number | undefined>
}

/** Copilot çalıştırma sonucu. Token alanları sağlayıcı bildirmediyse tanımsızdır. */
export interface Execution {
  id: string
  label: string
  strategy: Strategy
  createdAt: string
  response?: string
  requestedModel: string
  requestedAutoTier?: string
  model: string
  usage: {
    status: string
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    reasoningTokens?: number
    aiCredits?: number
    nanoAiu?: number
    modelCalls?: number
    durationMs: number
    context?: { currentTokens: number; tokenLimit: number; percentage?: number }
    modelMetrics: Array<{
      id: string
      requests: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      reasoningTokens?: number
      nanoAiu?: number
    }>
    toolCalls: number
    subagentCalls: number
    skillsInvoked: string[]
    aiCreditsStatus?: 'complete' | 'partial' | 'unavailable'
    maxAiCreditLimit?: number
    limitUsagePercentage?: number
  }
  events?: ExecutionEvent[]
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
  events: Array<{ type: string; label: string; timestamp?: string }>
  error?: string
  errorCode?: string
  setupHint?: string
}

export interface ComparisonSummary {
  faster?: ProviderId | 'tie'
  fewerInputTokens?: ProviderId | 'tie'
  fewerOutputTokens?: ProviderId | 'tie'
  fewerTotalTokens?: ProviderId | 'tie'
  fewerModelCalls?: ProviderId | 'tie'
  fewerToolCalls?: ProviderId | 'tie'
  costs: Array<{ provider: ProviderId; amount: number; unit: 'AI Credit' | 'USD' }>
}

export interface UsageHistoryRecord {
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
  usage?: Execution['usage']
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
  events?: ExecutionEvent[]
}

export const claudeStatusStates = [
  'missing_key',
  'invalid_key_format',
  'sdk_unavailable',
  'unverified',
  'verified',
  'auth_failed',
  'error',
] as const
export type ClaudeStatusState = 'checking' | 'unreachable' | (typeof claudeStatusStates)[number]

export interface ClaudeStatus {
  state: ClaudeStatusState
  configured: boolean
  verified: boolean
  runnable: boolean
  message: string
  setupHint?: string
  model?: string
  lastVerifiedAt?: string
  lastErrorCode?: string
}

export interface CopilotHealth {
  state: 'starting' | 'ready' | 'unavailable' | 'unreachable'
  message: string
  cliVersion?: string
  authenticated?: boolean
  authType?: string
}

export interface DatabaseHealth {
  state: 'ready' | 'unavailable'
  storage: 'sqlite' | 'memory'
  persistent: boolean
  message: string
  sqliteVersion?: string
  schemaVersion?: number
  executions?: number
  retention: number
}

export interface HealthSnapshot {
  checkedAt: string
  copilot: CopilotHealth
  claude: ClaudeStatus
  database: DatabaseHealth
}

export interface CopilotModelOption {
  id: string
  name: string
  policy?: { state?: string }
  billing?: { multiplier?: number }
}

export interface ClaudeModelOption {
  value: string
  displayName: string
  description: string
  resolvedModel?: string
}

export interface LicensePlan {
  id: string
  name: string
  accountType: 'individual' | 'organization'
  monthlySeatPriceUsd: number | null
  includedAiCreditsPerSeat: number
  baseAiCreditsPerSeat?: number
  flexAiCreditsPerSeat?: number
}

export interface PricingMetadata {
  sources: string[]
  lastVerified: string
  aiCreditUsd: number
  includedCreditsNote: string
}

export interface MetricAggregate {
  total: number
  reported: number
}

export interface ProviderReport {
  provider: ProviderId
  runs: number
  successes: number
  failures: number
  durationMs: MetricAggregate
  inputTokens: MetricAggregate
  outputTokens: MetricAggregate
  modelCalls: MetricAggregate
  numTurns: MetricAggregate
  aiCredits: MetricAggregate
  estimatedCostUsd: MetricAggregate
  models: Array<{ model: string; runs: number }>
  errorCodes: Array<{ code: string; count: number }>
}

export interface UsageReport {
  generatedAt: string
  storage: 'sqlite' | 'memory'
  persistent: boolean
  totalRuns: number
  firstRunAt?: string
  lastRunAt?: string
  providers: ProviderReport[]
  observations: Array<{ level: 'info' | 'warning'; text: string }>
}
