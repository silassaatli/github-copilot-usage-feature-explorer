import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createComparisonSummary,
  getClaudeAuthStatus,
  getClaudeStatus,
  normalizeClaudeExecution,
  normalizeCopilotExecution,
  runProvidersIndependently,
  type ProviderExecution,
} from '../server/services/provider-comparison.ts'

test('normalizes Copilot measurements without mapping AI Credits to USD', () => {
  const result = normalizeCopilotExecution({
    id: 'copilot-1',
    requestedModel: 'auto',
    model: 'mai-code-1.1-flash',
    response: 'Yanıt',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      reasoningTokens: 4,
      aiCredits: 0.2,
      modelCalls: 1,
      durationMs: 500,
      context: { percentage: 25 },
      modelMetrics: [{ reasoningTokens: 4 }],
      toolCalls: 0,
      subagentCalls: 0,
      skillsInvoked: [],
    },
  }, 'comparison-1')

  assert.equal(result.provider, 'github-copilot')
  assert.equal(result.actualModel, 'mai-code-1.1-flash')
  assert.equal(result.providerCost, 0.2)
  assert.equal(result.providerCostUnit, 'AI Credit')
  assert.equal(result.contextUtilization, 25)
})

test('normalizes Claude SDK usage and labels its USD estimate separately', () => {
  const result = normalizeClaudeExecution({
    id: 'claude-1',
    model: 'claude-sonnet-current',
    inputTokens: 80,
    outputTokens: 30,
    cachedTokens: 12,
    reasoningTokens: 7,
    durationMs: 650,
    providerCostUsd: 0.004,
    providerCostSource: 'SDK tarafından ölçüldü · SDK fiyat tablosu',
  }, 'comparison-1')

  assert.equal(result.provider, 'claude')
  assert.equal(result.actualModel, 'claude-sonnet-current')
  assert.equal(result.providerCost, 0.004)
  assert.equal(result.providerCostUnit, 'USD')
})

test('comparison summary compares only matching metrics and keeps billing units separate', () => {
  const executions: ProviderExecution[] = [
    {
      id: 'copilot-1',
      comparisonId: 'comparison-1',
      provider: 'github-copilot',
      runtime: 'GitHub Copilot SDK',
      inputTokens: 100,
      outputTokens: 20,
      durationMs: 500,
      modelCalls: 2,
      toolCalls: 1,
      providerCost: 0.2,
      providerCostUnit: 'AI Credit',
      events: [],
    },
    {
      id: 'claude-1',
      comparisonId: 'comparison-1',
      provider: 'claude',
      runtime: 'Claude Agent SDK',
      inputTokens: 80,
      outputTokens: 30,
      durationMs: 700,
      providerCost: 0.004,
      providerCostUnit: 'USD',
      events: [],
    },
  ]
  const summary = createComparisonSummary(executions)

  assert.equal(summary.faster, 'github-copilot')
  assert.equal(summary.fewerInputTokens, 'claude')
  assert.equal(summary.fewerOutputTokens, 'github-copilot')
  assert.equal(summary.fewerTotalTokens, 'claude')
  assert.equal(summary.fewerModelCalls, undefined)
  assert.equal(summary.fewerToolCalls, undefined)
  assert.deepEqual(summary.costs, [
    { provider: 'github-copilot', amount: 0.2, unit: 'AI Credit' },
    { provider: 'claude', amount: 0.004, unit: 'USD' },
  ])
})

test('provider failures are isolated and do not discard a successful result', async () => {
  const executions = await runProvidersIndependently(
    ['github-copilot', 'claude'],
    'comparison-1',
    {
      'github-copilot': async () => ({
        id: 'copilot-1',
        comparisonId: 'comparison-1',
        provider: 'github-copilot',
        runtime: 'GitHub Copilot SDK',
        response: 'Tamam',
        events: [],
      }),
      claude: async () => {
        throw new Error('upstream failed')
      },
    },
  )

  assert.equal(executions[0].response, 'Tamam')
  assert.match(executions[1].error ?? '', /Claude çalıştırılamadı/)
  assert.equal(executions[1].errorCode, undefined)
})

test('provider failures can carry a safe described error and code', async () => {
  const executions = await runProvidersIndependently(
    ['github-copilot', 'claude'],
    'comparison-2',
    {
      'github-copilot': async () => {
        throw new Error('raw internal detail')
      },
      claude: async () => {
        throw new Error('upstream failed')
      },
    },
    (provider) => provider === 'github-copilot'
      ? { error: 'Copilot hız sınırına ulaşıldı.', errorCode: 'COPILOT_RATE_LIMITED' }
      : undefined,
  )

  assert.equal(executions[0].error, 'Copilot hız sınırına ulaşıldı.')
  assert.equal(executions[0].errorCode, 'COPILOT_RATE_LIMITED')
  assert.match(executions[1].error ?? '', /Claude çalıştırılamadı/)
  assert.equal(executions[1].errorCode, undefined)
})

test('Claude is unavailable without an API key and status never returns the key', () => {
  assert.deepEqual(getClaudeAuthStatus(undefined), {
    state: 'missing_key',
    configured: false,
    message: 'API anahtarı eksik',
    setupHint: 'Anthropic Console API anahtarını proje kökündeki .env dosyasına ekleyip uygulamayı yeniden başlatın.',
  })
  assert.deepEqual(getClaudeAuthStatus('configured-but-not-returned'), {
    state: 'ready',
    configured: true,
    message: 'Hazır',
    setupHint: undefined,
  })
  assert.equal(getClaudeStatus('configured-but-not-returned', false, false).state, 'sdk_unavailable')
  assert.equal(getClaudeStatus('configured-but-not-returned', true, true).state, 'auth_failed')
})
