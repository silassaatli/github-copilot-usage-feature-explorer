import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildClaudeEnv,
  ClaudeRunError,
  classifyKeyFormat,
  describeClaudeError,
  getClaudeConnectionStatus,
  parseClaudeConfig,
  resolveClaudeStatus,
  runClaude,
} from '../server/services/claude.ts'
import { runProvidersIndependently } from '../server/services/provider-comparison.ts'

// Testlerde gerçek SDK, ağ veya API anahtarı kullanılmaz; sorgu işlevi sahtedir.

const init = (apiKeySource = 'ANTHROPIC_API_KEY') => ({
  type: 'system',
  subtype: 'init',
  apiKeySource,
  model: 'claude-test-model',
  claude_code_version: '9.9.9',
})

const assistantText = (text: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: 'msg_1', content: [{ type: 'text', text }] },
})

const successResult = (overrides: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  duration_ms: 420,
  total_cost_usd: 0.0012,
  stop_reason: 'end_turn',
  result: 'Merhaba!',
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: {
    'claude-test-model': {
      inputTokens: 12,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.0012,
      costBasis: 'list',
    },
  },
  ...overrides,
})

type Script = (signal: AbortSignal) => AsyncGenerator<unknown>

function fakeQuery(script: Script) {
  const calls: Array<{ prompt: string; options?: Options }> = []
  let closed = 0
  const queryFn = (params: { prompt: string; options?: Options }) => {
    calls.push(params)
    const signal = params.options?.abortController?.signal ?? new AbortController().signal
    return Object.assign(script(signal), { close: () => { closed += 1 } }) as unknown as Query
  }
  return { queryFn, calls, get closed() { return closed } }
}

function waitForAbort(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

const isCode = (code: string) => (error: unknown) =>
  error instanceof ClaudeRunError && error.code === code

test('key formats are classified by prefix only', () => {
  assert.equal(classifyKeyFormat('sk-ant-api03-xxx'), 'api')
  assert.equal(classifyKeyFormat('sk-ant-oat01-xxx'), 'oauth')
  assert.equal(classifyKeyFormat('sk-ant-admin01-xxx'), 'admin')
  assert.equal(classifyKeyFormat('something-else'), 'unknown')
})

test('a present key is reported as configured but not verified', () => {
  const secret = 'sk-ant-api03-gizli-deger'
  const status = resolveClaudeStatus({ apiKey: secret, sdkAvailable: true })
  assert.equal(status.state, 'unverified')
  assert.equal(status.configured, true)
  assert.equal(status.verified, false)
  assert.equal(status.runnable, true)
  assert.doesNotMatch(JSON.stringify(status), /gizli-deger/)
})

test('missing, unsupported and SDK-less configurations are not runnable', () => {
  assert.equal(resolveClaudeStatus({ apiKey: undefined, sdkAvailable: true }).state, 'missing_key')
  assert.equal(resolveClaudeStatus({ apiKey: '  ', sdkAvailable: true }).runnable, false)
  assert.equal(
    resolveClaudeStatus({ apiKey: 'sk-ant-oat01-x', sdkAvailable: true }).state,
    'invalid_key_format',
  )
  assert.equal(resolveClaudeStatus({ apiKey: 'sk-ant-api03-x', sdkAvailable: false }).state, 'sdk_unavailable')
  const unknown = resolveClaudeStatus({ apiKey: 'sk-ant-usr-x', sdkAvailable: true })
  assert.equal(unknown.state, 'unverified')
  assert.match(unknown.setupHint ?? '', /biçimi tanınmadı/)
})

test('the subprocess environment drops nested-session markers and competing credentials', () => {
  const env = buildClaudeEnv({
    PATH: '/usr/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'parent',
    CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
    ANTHROPIC_AUTH_TOKEN: 'oauth',
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    ANTHROPIC_API_KEY: 'stale',
    GITHUB_TOKEN: 'ghp_x',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude',
  }, 'sk-ant-api03-from-dotenv')

  assert.equal(env.PATH, '/usr/bin')
  assert.match(env.CLAUDE_CONFIG_DIR ?? '', /copilot-explorer-claude-config$/)
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-api03-from-dotenv')
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Git\\bin\\bash.exe')
  for (const name of [
    'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_USE_BEDROCK',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'GITHUB_TOKEN',
  ]) {
    assert.equal(env[name], undefined, name)
  }
})

test('model and effort configuration are validated', () => {
  assert.deepEqual(parseClaudeConfig({}), {})
  assert.deepEqual(
    parseClaudeConfig({ CLAUDE_AGENT_MODEL: 'claude-haiku-5-5', CLAUDE_AGENT_EFFORT: 'low' }),
    { model: 'claude-haiku-5-5', effort: 'low' },
  )
  assert.deepEqual(parseClaudeConfig({ CLAUDE_AGENT_MODEL: 'bad model; rm', CLAUDE_AGENT_EFFORT: 'ultra' }), {})
})

test('a missing or unsupported key never starts the SDK', async () => {
  const fake = fakeQuery(async function* () { yield init() })
  await assert.rejects(
    runClaude('Merhaba', 'c-1', { env: {}, queryFn: fake.queryFn }),
    isCode('CLAUDE_NOT_CONFIGURED'),
  )
  await assert.rejects(
    runClaude('Merhaba', 'c-1', { env: { ANTHROPIC_API_KEY: 'sk-ant-oat01-x' }, queryFn: fake.queryFn }),
    isCode('CLAUDE_INVALID_KEY_FORMAT'),
  )
  assert.equal(fake.calls.length, 0)
})

test('a successful run returns real SDK metrics and marks the key as verified', async () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant-api03-success-key',
    CLAUDE_AGENT_MODEL: 'claude-haiku-5-5',
    CLAUDECODE: '1',
    PATH: '/bin',
  }
  const fake = fakeQuery(async function* () {
    yield init()
    yield assistantText('Merhaba!')
    yield successResult()
  })

  assert.equal((await getClaudeConnectionStatus(env)).state, 'unverified')
  const result = await runClaude('Merhaba', 'c-2', { env, queryFn: fake.queryFn })

  assert.equal(result.response, 'Merhaba!')
  assert.equal(result.requestedModel, 'claude-haiku-5-5')
  assert.equal(result.actualModel, 'claude-test-model')
  assert.equal(result.inputTokens, 12)
  assert.equal(result.outputTokens, 5)
  assert.equal(result.numTurns, 1)
  assert.equal(result.modelCalls, 1)
  assert.equal(result.toolCalls, 0)
  assert.equal(result.providerCost, 0.0012)
  assert.equal(result.providerCostUnit, 'USD')

  const options = fake.calls[0].options
  assert.deepEqual(options?.tools, [])
  assert.equal(options?.maxTurns, 1)
  assert.equal(options?.model, 'claude-haiku-5-5')
  assert.equal(options?.persistSession, false)
  assert.equal(options?.env?.CLAUDECODE, undefined)
  assert.ok(options?.abortController)
  assert.equal(fake.closed, 1)

  const status = await getClaudeConnectionStatus(env)
  assert.equal(status.state, 'verified')
  assert.equal(status.verified, true)
  assert.ok(status.lastVerifiedAt)

  // Başka bir anahtar için önceki doğrulama geçerli sayılmaz.
  const other = await getClaudeConnectionStatus({ ...env, ANTHROPIC_API_KEY: 'sk-ant-api03-other' })
  assert.equal(other.state, 'unverified')
})

test('metrics the SDK does not report are left undefined instead of guessed', async () => {
  const fake = fakeQuery(async function* () {
    yield init()
    yield successResult({ modelUsage: {}, usage: {}, total_cost_usd: 0 })
  })
  const result = await runClaude('Merhaba', 'c-3', {
    env: { ANTHROPIC_API_KEY: 'sk-ant-api03-no-metrics' },
    queryFn: fake.queryFn,
  })
  assert.equal(result.inputTokens, undefined)
  assert.equal(result.outputTokens, undefined)
  assert.equal(result.providerCost, undefined)
  assert.equal(result.modelCalls, undefined)
  assert.equal(result.numTurns, 1)
})

test('SDK authentication and billing errors map to coded failures and update status', async () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-rejected-key' }
  const auth = fakeQuery(async function* () {
    yield init()
    yield { type: 'assistant', error: 'authentication_failed', message: { id: 'x', content: [] } }
    yield successResult({ is_error: true, result: 'Invalid API key', modelUsage: {} })
  })
  await assert.rejects(runClaude('x', 'c-4', { env, queryFn: auth.queryFn }), isCode('CLAUDE_AUTH_FAILED'))
  assert.equal((await getClaudeConnectionStatus(env)).state, 'auth_failed')

  const billing = fakeQuery(async function* () {
    yield init()
    yield { type: 'assistant', error: 'billing_error', message: { id: 'y', content: [] } }
    yield successResult({ is_error: true, modelUsage: {} })
  })
  await assert.rejects(
    runClaude('x', 'c-5', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-no-credit' }, queryFn: billing.queryFn }),
    isCode('CLAUDE_BILLING'),
  )

  const status = fakeQuery(async function* () {
    yield init()
    yield { ...successResult({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] }), api_error_status: 429 }
  })
  await assert.rejects(
    runClaude('x', 'c-6', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-busy' }, queryFn: status.queryFn }),
    isCode('CLAUDE_RATE_LIMITED'),
  )
})

test('a run that is not using the .env key is stopped', async () => {
  let abortedByInit = false
  const fake = fakeQuery(async function* (signal) {
    yield init('none')
    abortedByInit = signal.aborted
    yield successResult()
  })
  await assert.rejects(
    runClaude('x', 'c-7', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-oauth-fallback' }, queryFn: fake.queryFn }),
    isCode('CLAUDE_CREDENTIAL_SOURCE'),
  )
  assert.equal(abortedByInit, true)
})

test('timeouts abort the running SDK query', async () => {
  let aborted = false
  const fake = fakeQuery(async function* (signal) {
    yield init()
    signal.addEventListener('abort', () => { aborted = true })
    await waitForAbort(signal)
  })
  await assert.rejects(
    runClaude('x', 'c-8', {
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-slow' },
      queryFn: fake.queryFn,
      timeoutMs: 20,
    }),
    isCode('CLAUDE_TIMEOUT'),
  )
  assert.equal(aborted, true)
  assert.equal(fake.closed, 1)
})

test('client cancellation aborts the running SDK query', async () => {
  const controller = new AbortController()
  const fake = fakeQuery(async function* (signal) {
    yield init()
    queueMicrotask(() => controller.abort())
    await waitForAbort(signal)
  })
  await assert.rejects(
    runClaude('x', 'c-9', {
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-cancel' },
      queryFn: fake.queryFn,
      signal: controller.signal,
    }),
    isCode('REQUEST_CANCELLED'),
  )

  const notStarted = fakeQuery(async function* () { yield init() })
  await assert.rejects(
    runClaude('x', 'c-10', {
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-cancel' },
      queryFn: notStarted.queryFn,
      signal: AbortSignal.abort(),
    }),
    isCode('REQUEST_CANCELLED'),
  )
  assert.equal(notStarted.calls.length, 0)
})

test('unexpected SDK failures are described without raw details', () => {
  const described = describeClaudeError(new Error('spawn C:\\secret\\path sk-ant-api03-leak'))
  assert.equal(described.code, 'CLAUDE_REQUEST_FAILED')
  assert.equal(described.status, 502)
  assert.doesNotMatch(described.message, /secret|leak/)
  assert.equal(describeClaudeError(new ClaudeRunError('CLAUDE_NOT_CONFIGURED')).status, 503)
})

test('a Claude failure in a comparison keeps the successful Copilot result', async () => {
  const executions = await runProvidersIndependently(
    ['github-copilot', 'claude'],
    'c-11',
    {
      'github-copilot': async () => ({
        id: 'copilot-1',
        comparisonId: 'c-11',
        provider: 'github-copilot',
        runtime: 'GitHub Copilot SDK',
        response: 'Copilot yanıtı',
        events: [],
      }),
      claude: () => runClaude('x', 'c-11', { env: {} }),
    },
    (provider, error) => {
      if (provider !== 'claude') return undefined
      const described = describeClaudeError(error)
      return { error: described.message, errorCode: described.code, setupHint: described.setupHint }
    },
  )

  assert.equal(executions[0].response, 'Copilot yanıtı')
  assert.equal(executions[1].errorCode, 'CLAUDE_NOT_CONFIGURED')
  assert.match(executions[1].setupHint ?? '', /ANTHROPIC_API_KEY/)
})
