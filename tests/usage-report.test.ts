import assert from 'node:assert/strict'
import test from 'node:test'
import { sumKnown } from '../server/services/copilot-runner.ts'
import type { ProviderHistoryRecord } from '../server/services/usage-history.ts'
import { summarizeHistory } from '../server/services/usage-report.ts'

const base = { label: 'x', strategy: 'normal', events: [] }

test('unreported metrics stay unknown instead of becoming zero', () => {
  assert.equal(sumKnown([]), undefined)
  assert.equal(sumKnown([undefined, undefined]), undefined)
  assert.equal(sumKnown([undefined, 0]), 0)
  assert.equal(sumKnown([3, undefined, 4]), 7)
})

test('the report counts how many runs reported each metric and keeps units apart', () => {
  const records: ProviderHistoryRecord[] = [
    {
      ...base,
      id: 'c1',
      createdAt: '2026-10-18T10:00:00.000Z',
      provider: 'claude',
      comparisonId: 'a',
      actualModel: 'claude-haiku-5-5',
      metrics: { inputTokens: 100, outputTokens: 10, providerCost: 0.001, providerCostUnit: 'USD', numTurns: 1 },
    },
    {
      ...base,
      id: 'c2',
      createdAt: '2026-10-18T11:00:00.000Z',
      provider: 'claude',
      comparisonId: 'b',
      actualModel: 'claude-haiku-5-5',
      metrics: {},
    },
    {
      ...base,
      id: 'c3',
      createdAt: '2026-10-18T12:00:00.000Z',
      provider: 'claude',
      comparisonId: 'c',
      error: 'Hız sınırı',
      errorCode: 'CLAUDE_RATE_LIMITED',
    },
  ]
  const report = summarizeHistory(records, new Date('2026-10-18T13:00:00.000Z'))
  const [claude] = report.providers
  assert.equal(report.totalRuns, 3)
  assert.equal(report.firstRunAt, '2026-10-18T10:00:00.000Z')
  assert.deepEqual({ runs: claude.runs, successes: claude.successes, failures: claude.failures }, { runs: 3, successes: 2, failures: 1 })
  assert.deepEqual(claude.inputTokens, { total: 100, reported: 1 })
  assert.deepEqual(claude.estimatedCostUsd, { total: 0.001, reported: 1 })
  assert.deepEqual(claude.aiCredits, { total: 0, reported: 0 })
  assert.deepEqual(claude.models, [{ model: 'claude-haiku-5-5', runs: 2 }])
  assert.deepEqual(claude.errorCodes, [{ code: 'CLAUDE_RATE_LIMITED', count: 1 }])
  assert.ok(report.observations.some((item) => /token bilgisi sağlayıcı tarafından bildirilmedi/.test(item.text)))
  assert.ok(report.observations.some((item) => item.level === 'warning' && /CLAUDE_RATE_LIMITED/.test(item.text)))
})

test('an empty history produces an explanatory report', () => {
  const report = summarizeHistory([])
  assert.equal(report.totalRuns, 0)
  assert.deepEqual(report.providers, [])
  assert.equal(report.observations.length, 1)
})
