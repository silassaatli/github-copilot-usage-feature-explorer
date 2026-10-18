import type { UsageHistoryRecord } from '../types'

/** Kaydın ölçümlerini sağlayıcıdan bağımsız tek biçime getirir. */
export function recordMetrics(record: UsageHistoryRecord) {
  const usage = record.usage
  const metrics = record.metrics
  return {
    inputTokens: usage ? usage.inputTokens : metrics?.inputTokens,
    outputTokens: usage ? usage.outputTokens : metrics?.outputTokens,
    cachedTokens: usage ? usage.cacheReadTokens : metrics?.cachedTokens,
    reasoningTokens: usage ? usage.reasoningTokens : metrics?.reasoningTokens,
    durationMs: usage?.durationMs ?? metrics?.durationMs,
    modelCalls: usage ? usage.modelCalls : metrics?.modelCalls,
    numTurns: metrics?.numTurns,
    toolCalls: usage?.toolCalls ?? metrics?.toolCalls,
    aiCredits: usage ? usage.aiCredits : metrics?.providerCostUnit === 'AI Credit' ? metrics.providerCost : undefined,
    estimatedUsd: metrics?.providerCostUnit === 'USD' ? metrics.providerCost : undefined,
    costSource: metrics?.providerCostSource,
  }
}
