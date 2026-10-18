import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp, type AppDependencies } from '../server/app.ts'
import { openDatabase } from '../server/db/database.ts'
import { initPersistence, type DatabaseHealth } from '../server/db/init.ts'
import { CopilotRunError } from '../server/services/copilot-runtime.ts'
import type { CopilotService, RunRequest } from '../server/services/copilot-runner.ts'
import {
  createSqliteHistoryStore,
  setHistoryStore,
  type ExecutionRecord,
} from '../server/services/usage-history.ts'

// Bu testler gerçek Copilot veya Claude çağrısı yapmaz: sağlayıcılar sahtedir.

const secret = 'sk-ant-api03-TESTSECRET-must-never-leak-000000'
const env = { ANTHROPIC_API_KEY: secret }

// --- Günlüklerin gizli anahtarı içermediğini doğrulamak için konsolu yakala.
const logLines: string[] = []
const originalError = console.error
const originalLog = console.log
before(() => {
  console.error = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')) }
  console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')) }
})
after(() => {
  console.error = originalError
  console.log = originalLog
})

const responseBodies: string[] = []

function copilotExecution(input: RunRequest): ExecutionRecord {
  return {
    id: `copilot-${Math.random().toString(16).slice(2)}`,
    label: input.prompt.slice(0, 80),
    strategy: input.strategy,
    createdAt: new Date().toISOString(),
    comparisonId: input.comparisonId,
    response: 'Copilot yanıtı',
    requestedModel: input.model,
    model: 'copilot-real-model',
    usage: {
      status: 'available',
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 0,
      aiCredits: 0.5,
      nanoAiu: 500_000_000,
      modelCalls: 1,
      durationMs: 900,
      modelMetrics: [],
      calls: [],
      toolCalls: 0,
      subagentCalls: 0,
      skillsInvoked: [],
    },
    events: [],
  }
}

function fakeCopilot(mode: 'unavailable' | 'ready') {
  const runs: RunRequest[] = []
  const unavailable = () => Promise.reject(new CopilotRunError('COPILOT_UNAVAILABLE'))
  const service: CopilotService & { runs: RunRequest[] } = {
    runs,
    start: async () => mode === 'ready',
    stop: async () => undefined,
    getHealth: async () => mode === 'ready'
      ? { state: 'ready', message: 'Copilot bağlı', authenticated: true, cliVersion: '1.0.0' }
      : { state: 'unavailable', message: 'Copilot kullanılamıyor' },
    ensureReady: () => (mode === 'ready' ? Promise.resolve() : unavailable()),
    run: async (input) => {
      runs.push(input)
      if (mode !== 'ready') throw new CopilotRunError('COPILOT_UNAVAILABLE')
      return copilotExecution(input)
    },
    getModelCatalog: async () => {
      if (mode !== 'ready') throw new CopilotRunError('COPILOT_UNAVAILABLE')
      return { models: [{ id: 'auto', name: 'Auto' }], autoTiers: [], scope: 'auto-only', message: 'yalnızca auto' }
    },
    getQuota: () => (mode === 'ready' ? Promise.resolve({}) : unavailable()),
  }
  return service
}

type QueryParams = { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }

function fakeClaude() {
  const calls: QueryParams[] = []
  const queryFn = (params: QueryParams) => {
    calls.push(params)
    async function* messages() {
      yield { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', model: 'claude-test', claude_code_version: '9.9.9' }
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_1', content: [{ type: 'text', text: 'Merhaba' }] } }
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        duration_ms: 300,
        total_cost_usd: 0.00005,
        stop_reason: 'end_turn',
        result: 'Merhaba',
        usage: {},
        modelUsage: {
          'claude-haiku-5-5': {
            inputTokens: 20,
            outputTokens: 3,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.00005,
            costBasis: 'list',
          },
        },
      }
    }
    return Object.assign(messages(), {
      supportedModels: async () => [
        { value: 'default', displayName: 'Varsayılan', description: '', resolvedModel: 'claude-opus-5-5' },
        { value: 'haiku', displayName: 'Haiku', description: '', resolvedModel: 'claude-haiku-5-5' },
      ],
      close: () => undefined,
    }) as unknown as Query
  }
  return { queryFn, calls }
}

const readyDatabase: DatabaseHealth = {
  state: 'ready',
  storage: 'sqlite',
  persistent: true,
  retention: 1000,
  message: 'test',
}

async function startApp(overrides: Partial<AppDependencies> = {}, { keepStore = false } = {}) {
  const { db } = openDatabase(':memory:')
  if (!keepStore) setHistoryStore(createSqliteHistoryStore(db))
  const app = createApp({
    copilot: fakeCopilot('unavailable'),
    env,
    persistence: { health: () => readyDatabase },
    claudeTimeoutMs: 5_000,
    ...overrides,
  })
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    async call(path: string, init: RequestInit & { json?: unknown } = {}) {
      const { json, ...rest } = init
      const response = await fetch(`${base}${path}`, {
        ...rest,
        ...(json !== undefined
          ? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json', ...rest.headers } }
          : {}),
      })
      const text = await response.text()
      responseBodies.push(text)
      let body: Record<string, unknown>
      try {
        body = JSON.parse(text) as Record<string, unknown>
      } catch {
        body = { raw: text }
      }
      return { status: response.status, body, text, headers: response.headers }
    },
    close: () => new Promise<void>((resolve) => server.close(() => { db.close(); resolve() })),
  }
}

test('health separates Copilot, Claude and database states without exposing the key', async () => {
  const api = await startApp()
  const { status, body } = await api.call('/api/health')
  assert.equal(status, 200)
  assert.equal(body.status, 'degraded')
  const services = body.services as Record<string, Record<string, unknown>>
  assert.equal(services.copilot.state, 'unavailable')
  assert.equal(services.claude.state, 'unverified')
  assert.equal(services.claude.verified, false)
  assert.equal(services.database.persistent, true)
  await api.close()
})

test('requests from other origins or hosts are rejected before reaching providers', async () => {
  const copilot = fakeCopilot('ready')
  const api = await startApp({ copilot })
  const foreign = await api.call('/api/copilot/chat', {
    method: 'POST',
    json: { prompt: 'x' },
    headers: { Origin: 'https://evil.example' },
  })
  assert.equal(foreign.status, 403)
  assert.equal(foreign.body.code, 'FORBIDDEN_ORIGIN')
  assert.equal(copilot.runs.length, 0)

  const local = await api.call('/api/health', { headers: { Origin: 'http://localhost:5173' } })
  assert.equal(local.status, 200)

  const rebinding = await new Promise<number>((resolve, reject) => {
    const url = new URL(`${api.base}/api/health`)
    const request = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'attacker.example:3001' } },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      },
    )
    request.on('error', reject)
    request.end()
  })
  assert.equal(rebinding, 403)
  await api.close()
})

test('unknown API routes and malformed bodies return JSON errors', async () => {
  const api = await startApp()
  const missing = await api.call('/api/does-not-exist')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'NOT_FOUND')
  const invalid = await api.call('/api/copilot/chat', {
    method: 'POST',
    body: '{"prompt":',
    headers: { 'Content-Type': 'application/json' },
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.code, 'INVALID_JSON')
  await api.close()
})

test('Copilot run validation rejects bad input without calling the provider', async () => {
  const copilot = fakeCopilot('ready')
  const api = await startApp({ copilot })
  const cases: Array<Record<string, unknown>> = [
    { prompt: '' },
    { prompt: 'x'.repeat(12_001) },
    { prompt: 'x', strategy: 'everything' },
    { prompt: 'x', model: 'gpt-x', autoTier: 'balance' },
    { prompt: 'x', maxAiCreditLimit: -1 },
    { prompt: 'x', model: 42 },
  ]
  for (const json of cases) {
    const { status } = await api.call('/api/copilot/chat', { method: 'POST', json })
    assert.equal(status, 400, JSON.stringify(json).slice(0, 60))
  }
  assert.equal(copilot.runs.length, 0)
  await api.close()
})

test('Copilot model selection reaches the provider and successes are recorded', async () => {
  const copilot = fakeCopilot('ready')
  const api = await startApp({ copilot })
  const { status, body } = await api.call('/api/copilot/chat', {
    method: 'POST',
    json: { prompt: 'Merhaba', model: 'auto', autoTier: 'balance', strategy: 'skill' },
  })
  assert.equal(status, 200)
  assert.equal(body.model, 'copilot-real-model')
  assert.deepEqual(
    { model: copilot.runs[0].model, autoTier: copilot.runs[0].autoTier, strategy: copilot.runs[0].strategy },
    { model: 'auto', autoTier: 'balance', strategy: 'skill' },
  )

  await api.call('/api/copilot/fleet', { method: 'POST', json: { prompt: 'Fleet', model: 'named-model' } })
  assert.equal(copilot.runs[1].strategy, 'fleet')
  assert.equal(copilot.runs[1].model, 'named-model')

  const history = await api.call('/api/usage/history?provider=github-copilot')
  assert.equal((history.body.executions as unknown[]).length, 2)
  await api.close()
})

test('an unavailable Copilot returns a coded error and the failure is recorded', async () => {
  const api = await startApp()
  const { status, body } = await api.call('/api/copilot/chat', { method: 'POST', json: { prompt: 'Merhaba' } })
  assert.equal(status, 503)
  assert.equal(body.code, 'COPILOT_UNAVAILABLE')

  const catalog = await api.call('/api/copilot/models')
  assert.equal(catalog.status, 503)
  assert.equal(catalog.body.code, 'COPILOT_UNAVAILABLE')

  const quota = await api.call('/api/copilot/quota')
  assert.equal(quota.status, 200)
  assert.equal(quota.body.status, 'unavailable')

  const history = await api.call('/api/usage/history?status=error')
  const [failed] = history.body.executions as Array<Record<string, unknown>>
  assert.equal(failed.errorCode, 'COPILOT_UNAVAILABLE')
  assert.equal(failed.provider, 'github-copilot')
  await api.close()
})

test('an auto-only Copilot catalog is reported as such', async () => {
  const api = await startApp({ copilot: fakeCopilot('ready') })
  const { status, body } = await api.call('/api/copilot/models')
  assert.equal(status, 200)
  assert.equal(body.scope, 'auto-only')
  await api.close()
})

test('Claude model listing, selection and verification use the backend request', async () => {
  const claude = fakeClaude()
  const api = await startApp({ claudeQueryFn: claude.queryFn })
  const models = await api.call('/api/claude/models')
  assert.deepEqual((models.body.models as Array<{ value: string }>).map((item) => item.value), ['default', 'haiku'])

  const run = await api.call('/api/claude/chat', { method: 'POST', json: { prompt: 'Merhaba', claudeModel: 'haiku' } })
  assert.equal(run.status, 200)
  assert.equal(run.body.response, 'Merhaba')
  assert.equal(run.body.requestedModel, 'haiku')
  assert.equal(run.body.providerCostUnit, 'USD')
  const lastCall = claude.calls.at(-1)
  assert.equal(lastCall?.options?.model, 'haiku')
  assert.equal(lastCall?.options?.env?.ANTHROPIC_API_KEY, secret)

  const rejected = await api.call('/api/claude/chat', { method: 'POST', json: { prompt: 'x', claudeModel: 'opus-imaginary' } })
  assert.equal(rejected.status, 400)

  const health = await api.call('/api/health')
  assert.equal((health.body.services as Record<string, Record<string, unknown>>).claude.state, 'verified')
  await api.close()
})

test('Claude without a key fails clearly and the app keeps working', async () => {
  const api = await startApp({ env: {} })
  const { status, body } = await api.call('/api/claude/chat', { method: 'POST', json: { prompt: 'Merhaba' } })
  assert.equal(status, 503)
  assert.equal(body.code, 'CLAUDE_NOT_CONFIGURED')
  assert.match(String(body.setupHint), /ANTHROPIC_API_KEY/)
  const models = await api.call('/api/claude/models')
  assert.equal(models.status, 503)
  const advisor = await api.call('/api/advisor/recommend', { method: 'POST', json: { task: 'Kısa soru' } })
  assert.equal(advisor.status, 200)
  await api.close()
})

test('a failing provider does not discard the other provider in a comparison', async () => {
  const claude = fakeClaude()
  const api = await startApp({ claudeQueryFn: claude.queryFn })
  const { status, body } = await api.call('/api/compare', {
    method: 'POST',
    json: { prompt: 'Karşılaştır', providers: ['github-copilot', 'claude'] },
  })
  assert.equal(status, 200)
  const executions = body.executions as Array<Record<string, unknown>>
  const copilot = executions.find((item) => item.provider === 'github-copilot')
  const claudeResult = executions.find((item) => item.provider === 'claude')
  assert.equal(copilot?.errorCode, 'COPILOT_UNAVAILABLE')
  assert.equal(claudeResult?.response, 'Merhaba')
  assert.equal(claudeResult?.error, undefined)

  const invalid = await api.call('/api/compare', { method: 'POST', json: { prompt: 'x', providers: ['openai'] } })
  assert.equal(invalid.status, 400)
  const none = await api.call('/api/compare', { method: 'POST', json: { prompt: 'x', providers: [] } })
  assert.equal(none.status, 400)
  await api.close()
})

test('history can be filtered, summarized and cleared only with confirmation', async () => {
  const claude = fakeClaude()
  const api = await startApp({ claudeQueryFn: claude.queryFn, copilot: fakeCopilot('ready') })
  await api.call('/api/copilot/chat', { method: 'POST', json: { prompt: 'Copilot başarılı' } })
  await api.call('/api/claude/chat', { method: 'POST', json: { prompt: 'Claude başarılı' } })
  await api.call('/api/claude/chat', { method: 'POST', json: { prompt: 'Claude hatalı', claudeModel: 'yok-model' } })

  const all = await api.call('/api/usage/history')
  assert.equal(all.body.total, 2)
  assert.equal(all.body.persistent, true)
  assert.equal((await api.call('/api/usage/history?provider=claude')).body.total, 1)
  assert.equal((await api.call('/api/usage/history?status=error')).body.total, 0)
  assert.equal((await api.call('/api/usage/history?status=bogus')).status, 400)
  assert.equal((await api.call('/api/usage/history?provider=openai')).status, 400)

  const summary = await api.call('/api/usage/summary')
  const providers = summary.body.providers as Array<Record<string, Record<string, number>>>
  const copilotReport = providers.find((item) => (item.provider as unknown) === 'github-copilot')
  const claudeReport = providers.find((item) => (item.provider as unknown) === 'claude')
  assert.deepEqual(copilotReport?.aiCredits, { total: 0.5, reported: 1 })
  assert.deepEqual(copilotReport?.estimatedCostUsd, { total: 0, reported: 0 })
  assert.deepEqual(claudeReport?.estimatedCostUsd, { total: 0.00005, reported: 1 })
  assert.deepEqual(claudeReport?.aiCredits, { total: 0, reported: 0 })

  const unconfirmed = await api.call('/api/usage/history', { method: 'DELETE' })
  assert.equal(unconfirmed.status, 400)
  assert.equal(unconfirmed.body.code, 'CONFIRMATION_REQUIRED')
  const cleared = await api.call('/api/usage/history', { method: 'DELETE', json: { confirm: true } })
  assert.equal(cleared.body.deleted, 2)
  assert.equal((await api.call('/api/usage/history')).body.total, 0)
  await api.close()
})

test('licensing and advisor endpoints validate input and mark price sources', async () => {
  const api = await startApp()
  const plans = await api.call('/api/licensing/plans')
  assert.ok(Array.isArray(plans.body.plans))
  const planData = await api.call('/api/licensing/calculate', {
    method: 'POST',
    json: { plan: 'business', seats: 2, expectedCreditsPerSeat: 100 },
  })
  assert.equal(planData.body.seatPriceSource, 'plan-data')
  const userPrice = await api.call('/api/licensing/calculate', {
    method: 'POST',
    json: { plan: 'business', seats: 2, expectedCreditsPerSeat: 100, seatPriceUsd: 25 },
  })
  assert.equal(userPrice.body.seatPriceSource, 'user')
  assert.equal(userPrice.body.monthlySubscriptionUsd, 50)
  const invalidPlan = await api.call('/api/licensing/calculate', { method: 'POST', json: { plan: 'free', seats: 1 } })
  assert.equal(invalidPlan.status, 400)
  const invalidAdvisor = await api.call('/api/advisor/recommend', { method: 'POST', json: { task: '' } })
  assert.equal(invalidAdvisor.status, 400)
  await api.close()
})

test('the server starts without a database and reports non-persistent history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'explorer-nodb-'))
  try {
    const blocker = join(directory, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const persistence = initPersistence({ path: join(blocker, 'db', 'explorer.sqlite'), retention: 50 })
    // initPersistence'ın kurduğu yedek bellek deposu korunur.
    const api = await startApp({ persistence }, { keepStore: true })
    const health = await api.call('/api/health')
    const database = (health.body.services as Record<string, Record<string, unknown>>).database
    assert.equal(database.state, 'unavailable')
    assert.equal(database.persistent, false)
    await api.call('/api/copilot/chat', { method: 'POST', json: { prompt: 'Bellekte kayıt' } })
    const history = await api.call('/api/usage/history')
    assert.equal(history.body.persistent, false)
    assert.equal(history.body.storage, 'memory')
    assert.equal(history.body.total, 1)
    assert.equal((await api.call('/api/licensing/plans')).status, 200)
    persistence.close()
    await api.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the built frontend can be served by the API server', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'explorer-dist-'))
  try {
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Test arayüzü</title>')
    const api = await startApp({ frontendDir: directory })
    const page = await api.call('/kullanim')
    assert.equal(page.status, 200)
    assert.match(page.text, /Test arayüzü/)
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await api.call('/api/unknown')).status, 404)
    await api.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the API key never appears in any response body or log line', () => {
  assert.ok(responseBodies.length > 20)
  for (const body of responseBodies) assert.ok(!body.includes(secret), 'yanıt gövdesinde anahtar bulundu')
  for (const line of logLines) assert.ok(!line.includes(secret), 'günlükte anahtar bulundu')
})
