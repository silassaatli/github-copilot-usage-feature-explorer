import type { EffortLevel, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeClaudeExecution,
  type ProviderEvent,
  type ProviderExecution,
} from './provider-comparison.js'

export type ClaudeErrorCode =
  | 'CLAUDE_NOT_CONFIGURED'
  | 'CLAUDE_INVALID_KEY_FORMAT'
  | 'CLAUDE_SDK_UNAVAILABLE'
  | 'CLAUDE_AUTH_FAILED'
  | 'CLAUDE_BILLING'
  | 'CLAUDE_RATE_LIMITED'
  | 'CLAUDE_OVERLOADED'
  | 'CLAUDE_MODEL_NOT_FOUND'
  | 'CLAUDE_INVALID_REQUEST'
  | 'CLAUDE_OUTPUT_LIMIT'
  | 'CLAUDE_CREDENTIAL_SOURCE'
  | 'CLAUDE_TIMEOUT'
  | 'REQUEST_CANCELLED'
  | 'CLAUDE_REQUEST_FAILED'

const errorCatalog: Record<ClaudeErrorCode, { status: number; message: string; setupHint?: string }> = {
  CLAUDE_NOT_CONFIGURED: {
    status: 503,
    message: 'Claude API anahtarı yapılandırılmamış.',
    setupHint: 'Anthropic Console API anahtarını proje kökündeki .env dosyasına ANTHROPIC_API_KEY olarak ekleyip sunucuyu yeniden başlatın.',
  },
  CLAUDE_INVALID_KEY_FORMAT: {
    status: 503,
    message: 'ANTHROPIC_API_KEY bir Anthropic API anahtarı değil (OAuth veya Admin anahtarı kullanılamaz).',
    setupHint: 'Anthropic Console > API Keys bölümünden bir API anahtarı oluşturup .env dosyasına ekleyin ve sunucuyu yeniden başlatın.',
  },
  CLAUDE_SDK_UNAVAILABLE: {
    status: 503,
    message: 'Claude Agent SDK yüklenemedi.',
    setupHint: 'Bağımlılıkları npm install ile yükleyip sunucuyu yeniden başlatın.',
  },
  CLAUDE_AUTH_FAILED: {
    status: 401,
    message: 'Claude kimlik doğrulaması başarısız oldu. API anahtarını kontrol edin.',
    setupHint: 'Anahtarın Anthropic Console\'da etkin olduğunu doğrulayın, .env dosyasını güncelleyip sunucuyu yeniden başlatın.',
  },
  CLAUDE_BILLING: {
    status: 402,
    message: 'Anthropic hesabında kullanılabilir kredi veya faturalandırma ayarı bulunamadı.',
    setupHint: 'Anthropic Console > Billing bölümünden kredi bakiyesini ve harcama limitlerini kontrol edin.',
  },
  CLAUDE_RATE_LIMITED: {
    status: 429,
    message: 'Claude API hız sınırına ulaşıldı. Bir süre bekleyip tekrar deneyin.',
  },
  CLAUDE_OVERLOADED: {
    status: 503,
    message: 'Claude hizmeti şu anda yoğun. Biraz sonra tekrar deneyin.',
  },
  CLAUDE_MODEL_NOT_FOUND: {
    status: 400,
    message: 'Yapılandırılan Claude modeli bulunamadı veya bu hesapta kullanılamıyor.',
    setupHint: 'CLAUDE_AGENT_MODEL değerini kontrol edin ya da kaldırarak SDK varsayılan modelini kullanın.',
  },
  CLAUDE_INVALID_REQUEST: {
    status: 400,
    message: 'Claude isteği geçersiz bulundu.',
  },
  CLAUDE_OUTPUT_LIMIT: {
    status: 502,
    message: 'Claude yanıtı çıktı sınırına ulaştı ve tamamlanamadı.',
  },
  CLAUDE_CREDENTIAL_SOURCE: {
    status: 500,
    message: 'Claude, .env dosyasındaki API anahtarı yerine başka bir kimlik bilgisiyle başlatıldı; çalıştırma durduruldu.',
  },
  CLAUDE_TIMEOUT: {
    status: 504,
    message: 'Claude yanıtı zaman sınırı içinde tamamlanmadı; çalıştırma durduruldu.',
  },
  REQUEST_CANCELLED: {
    status: 499,
    message: 'İstek iptal edildi; Claude çalıştırması durduruldu.',
  },
  CLAUDE_REQUEST_FAILED: {
    status: 502,
    message: 'Claude çalıştırılamadı. API erişimini kontrol edin.',
  },
}

/** Kullanıcıya gösterilmesi güvenli, sabit Türkçe mesaj taşıyan Claude hatası. */
export class ClaudeRunError extends Error {
  readonly code: ClaudeErrorCode

  constructor(code: ClaudeErrorCode) {
    super(errorCatalog[code].message)
    this.name = 'ClaudeRunError'
    this.code = code
  }
}

export function describeClaudeError(error: unknown) {
  const code = error instanceof ClaudeRunError ? error.code : 'CLAUDE_REQUEST_FAILED'
  const entry = errorCatalog[code]
  return {
    status: entry.status,
    code,
    message: entry.message,
    ...(entry.setupHint ? { setupHint: entry.setupHint } : {}),
  }
}

export type KeyFormat = 'api' | 'oauth' | 'admin' | 'unknown'

/** Anahtarın yalnızca biçim önekini sınıflandırır; değeri hiçbir yere yazmaz. */
export function classifyKeyFormat(apiKey: string): KeyFormat {
  if (apiKey.startsWith('sk-ant-api')) return 'api'
  if (apiKey.startsWith('sk-ant-oat')) return 'oauth'
  if (apiKey.startsWith('sk-ant-admin')) return 'admin'
  return 'unknown'
}

function keyFingerprint(apiKey: string) {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
}

// Alt sürece aktarılmayacak değişkenler: Claude Code oturum işaretleri ve
// kimlik/sağlayıcı geçersiz kılmaları (iç içe oturum, OAuth token, Bedrock/Vertex
// yönlendirmesi vb.) ile Claude'un ihtiyaç duymadığı GitHub token'ları.
const strippedPrefixes = ['CLAUDECODE', 'CLAUDE_', 'ANTHROPIC_']
const strippedNames = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN'])
const preservedNames = new Set(['CLAUDE_CODE_GIT_BASH_PATH'])
const claudeConfigDir = join(tmpdir(), 'copilot-explorer-claude-config')

/**
 * Claude Code alt süreci için ortamı oluşturur. Kimlik bilgisi olarak yalnızca
 * .env'den okunan ANTHROPIC_API_KEY kullanılır; böylece istek makinedeki bir
 * claude.ai oturumuna veya üst süreçten gelen başka bir token'a düşmez.
 */
export function buildClaudeEnv(
  source: NodeJS.ProcessEnv,
  apiKey: string,
  configDir: string = claudeConfigDir,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (strippedNames.has(upper)) continue
    if (!preservedNames.has(upper) && strippedPrefixes.some((prefix) => upper.startsWith(prefix))) {
      continue
    }
    env[name] = value
  }
  env.ANTHROPIC_API_KEY = apiKey
  // Ayrı yapılandırma dizini: alt süreç ~/.claude içindeki claude.ai oturumunu
  // ve kullanıcı ayarlarını görmez.
  env.CLAUDE_CONFIG_DIR = configDir
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'copilot-usage-feature-explorer/0.0.0'
  return env
}

interface ClaudeModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  thinkingTokens?: number
  costUSD: number
  costBasis?: 'list' | 'managed' | 'unknown'
}

export interface CollectedClaudeRun {
  initModel?: string
  apiKeySource?: string
  claudeCodeVersion?: string
  response: string
  modelCallIds: Set<string>
  toolCalls: number
  assistantError?: string
  resultFound: boolean
  resultSubtype?: string
  isError?: boolean
  apiErrorStatus?: number | null
  numTurns?: number
  durationMs?: number
  totalCostUsd?: number
  stopReason?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  modelUsage: Record<string, ClaudeModelUsage>
  events: ProviderEvent[]
}

/** Agent SDK mesaj akışını tek bir ölçüm kaydında toplar. */
export async function collectClaudeRun(
  messages: AsyncIterable<SDKMessage>,
  hooks: { onInit?: (init: { apiKeySource: string; model: string }) => void } = {},
): Promise<CollectedClaudeRun> {
  const run: CollectedClaudeRun = {
    response: '',
    modelCallIds: new Set(),
    toolCalls: 0,
    resultFound: false,
    modelUsage: {},
    events: [],
  }
  let streamedText = ''

  for await (const message of messages) {
    if (message.type === 'system' && message.subtype === 'init') {
      run.initModel = message.model
      run.apiKeySource = message.apiKeySource
      run.claudeCodeVersion = message.claude_code_version
      run.events.push({
        type: 'runtime',
        label: `Claude Agent SDK oturumu başladı · ${message.claude_code_version}`,
        timestamp: new Date().toISOString(),
      })
      hooks.onInit?.({ apiKeySource: message.apiKeySource, model: message.model })
    } else if (message.type === 'assistant') {
      if (message.error) {
        run.assistantError = message.error
        continue
      }
      if (message.message.id) run.modelCallIds.add(message.message.id)
      for (const block of message.message.content) {
        if (block.type === 'text') streamedText += block.text
        else if (block.type === 'tool_use') {
          run.toolCalls += 1
          run.events.push({
            type: 'tool',
            label: `Araç çağrısı istendi: ${block.name}`,
            timestamp: new Date().toISOString(),
          })
        }
      }
    } else if (message.type === 'result') {
      run.resultFound = true
      run.resultSubtype = message.subtype
      run.isError = message.is_error
      run.numTurns = message.num_turns
      run.durationMs = message.duration_ms
      run.totalCostUsd = message.total_cost_usd
      run.stopReason = message.stop_reason
      run.usage = message.usage
      run.modelUsage = { ...message.modelUsage }
      if ('api_error_status' in message) run.apiErrorStatus = message.api_error_status
      if (message.subtype === 'success') run.response = message.result
    }
  }

  if (!run.response) run.response = streamedText
  return run
}

/** Toplanan çalıştırmadan, SDK'nın yapılandırılmış hata alanlarıyla hata kodu çıkarır. */
export function classifyClaudeRun(run: CollectedClaudeRun): ClaudeErrorCode | undefined {
  switch (run.assistantError) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'verification_required':
      return 'CLAUDE_AUTH_FAILED'
    case 'billing_error':
    case 'account_on_hold':
      return 'CLAUDE_BILLING'
    case 'rate_limit':
      return 'CLAUDE_RATE_LIMITED'
    case 'overloaded':
      return 'CLAUDE_OVERLOADED'
    case 'model_not_found':
      return 'CLAUDE_MODEL_NOT_FOUND'
    case 'invalid_request':
      return 'CLAUDE_INVALID_REQUEST'
    case 'max_output_tokens':
      return 'CLAUDE_OUTPUT_LIMIT'
    case undefined:
      break
    default:
      return 'CLAUDE_REQUEST_FAILED'
  }
  switch (run.apiErrorStatus) {
    case 401:
    case 403:
      return 'CLAUDE_AUTH_FAILED'
    case 402:
      return 'CLAUDE_BILLING'
    case 429:
      return 'CLAUDE_RATE_LIMITED'
    case 529:
      return 'CLAUDE_OVERLOADED'
  }
  if (!run.resultFound || run.isError || run.resultSubtype !== 'success') {
    return 'CLAUDE_REQUEST_FAILED'
  }
  return undefined
}

export type ClaudeConnectionState =
  | 'missing_key'
  | 'invalid_key_format'
  | 'sdk_unavailable'
  | 'unverified'
  | 'verified'
  | 'auth_failed'
  | 'error'

export interface ClaudeConnectionStatus {
  state: ClaudeConnectionState
  configured: boolean
  /** Yalnızca gerçek bir Claude çalıştırması bu anahtarla başarılı olduysa true. */
  verified: boolean
  /** Çalıştırma denenebilir mi (anahtar var ve biçimi reddedilmedi). */
  runnable: boolean
  message: string
  setupHint?: string
  keyFormat?: KeyFormat
  model: string
  lastVerifiedAt?: string
  lastErrorCode?: ClaudeErrorCode
}

export interface ClaudeRunOutcome {
  keyFingerprint: string
  ok: boolean
  code?: ClaudeErrorCode
  at: string
}

/**
 * Bağlantı durumunu hesaplar. Anahtarın varlığı yalnızca "yapılandırıldı"
 * anlamına gelir; "doğrulandı" durumu ancak aynı anahtarla başarılı bir gerçek
 * çalıştırmadan sonra raporlanır.
 */
export function resolveClaudeStatus({
  apiKey,
  sdkAvailable,
  lastOutcome,
  model,
}: {
  apiKey: string | undefined
  sdkAvailable: boolean
  lastOutcome?: ClaudeRunOutcome
  model?: string
}): ClaudeConnectionStatus {
  const key = apiKey?.trim()
  const modelLabel = model ?? 'SDK varsayılanı'
  if (!sdkAvailable) {
    return {
      state: 'sdk_unavailable',
      configured: Boolean(key),
      verified: false,
      runnable: false,
      message: 'Claude SDK kullanılamıyor',
      setupHint: errorCatalog.CLAUDE_SDK_UNAVAILABLE.setupHint,
      model: modelLabel,
    }
  }
  if (!key) {
    return {
      state: 'missing_key',
      configured: false,
      verified: false,
      runnable: false,
      message: 'Yapılandırılmamış',
      setupHint: errorCatalog.CLAUDE_NOT_CONFIGURED.setupHint,
      model: modelLabel,
    }
  }
  const keyFormat = classifyKeyFormat(key)
  if (keyFormat === 'oauth' || keyFormat === 'admin') {
    return {
      state: 'invalid_key_format',
      configured: true,
      verified: false,
      runnable: false,
      message: 'Anahtar türü uygun değil',
      setupHint: errorCatalog.CLAUDE_INVALID_KEY_FORMAT.setupHint,
      keyFormat,
      model: modelLabel,
    }
  }
  const base = { configured: true, runnable: true, keyFormat, model: modelLabel }
  const outcome = lastOutcome?.keyFingerprint === keyFingerprint(key) ? lastOutcome : undefined
  if (outcome?.ok) {
    return {
      ...base,
      state: 'verified',
      verified: true,
      message: 'Bağlantı doğrulandı',
      lastVerifiedAt: outcome.at,
    }
  }
  if (outcome?.code === 'CLAUDE_AUTH_FAILED') {
    return {
      ...base,
      state: 'auth_failed',
      verified: false,
      message: 'Kimlik doğrulama başarısız',
      setupHint: errorCatalog.CLAUDE_AUTH_FAILED.setupHint,
      lastErrorCode: outcome.code,
    }
  }
  if (outcome?.code) {
    return {
      ...base,
      state: 'error',
      verified: false,
      message: 'Son çalıştırma başarısız',
      setupHint: errorCatalog[outcome.code].setupHint,
      lastErrorCode: outcome.code,
    }
  }
  return {
    ...base,
    state: 'unverified',
    verified: false,
    message: 'Yapılandırıldı · doğrulanmadı',
    setupHint: keyFormat === 'unknown'
      ? 'Anahtar biçimi tanınmadı (beklenen: sk-ant-api…). Geçerliliği ilk Claude çalıştırmasında doğrulanır.'
      : 'Anahtar mevcut; geçerliliği ilk Claude çalıştırmasında doğrulanır.',
  }
}

const effortLevels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ClaudeConfig {
  model?: string
  effort?: EffortLevel
}

/** CLAUDE_AGENT_MODEL / CLAUDE_AGENT_EFFORT değerlerini doğrular; geçersizse yok sayar. */
export function parseClaudeConfig(source: NodeJS.ProcessEnv): ClaudeConfig {
  const model = source.CLAUDE_AGENT_MODEL?.trim()
  const effort = source.CLAUDE_AGENT_EFFORT?.trim()
  return {
    ...(model && /^[A-Za-z0-9._:[\]-]{1,100}$/.test(model) ? { model } : {}),
    ...(effort && (effortLevels as string[]).includes(effort) ? { effort: effort as EffortLevel } : {}),
  }
}

type QueryFn = (params: { prompt: string; options?: Options }) => Query

let sdkAvailability: Promise<boolean> | undefined
let lastOutcome: ClaudeRunOutcome | undefined

async function loadQuery(): Promise<QueryFn> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    return sdk.query
  } catch {
    throw new ClaudeRunError('CLAUDE_SDK_UNAVAILABLE')
  }
}

export async function getClaudeConnectionStatus(
  source: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeConnectionStatus> {
  sdkAvailability ??= loadQuery().then(() => true).catch(() => false)
  return resolveClaudeStatus({
    apiKey: source.ANTHROPIC_API_KEY,
    sdkAvailable: await sdkAvailability,
    lastOutcome,
    model: parseClaudeConfig(source).model,
  })
}

export interface RunClaudeOptions {
  signal?: AbortSignal
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Testlerde SDK yerine sahte bir sorgu işlevi kullanmak için. */
  queryFn?: QueryFn
}

export async function runClaude(
  prompt: string,
  comparisonId: string,
  { signal, timeoutMs = 120_000, env = process.env, queryFn }: RunClaudeOptions = {},
): Promise<ProviderExecution> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) throw new ClaudeRunError('CLAUDE_NOT_CONFIGURED')
  const keyFormat = classifyKeyFormat(apiKey)
  if (keyFormat === 'oauth' || keyFormat === 'admin') {
    throw new ClaudeRunError('CLAUDE_INVALID_KEY_FORMAT')
  }
  const query = queryFn ?? await loadQuery()
  if (!queryFn) {
    sdkAvailability = Promise.resolve(true)
    await mkdir(claudeConfigDir, { recursive: true })
  }
  if (signal?.aborted) throw new ClaudeRunError('REQUEST_CANCELLED')

  const config = parseClaudeConfig(env)
  const fingerprint = keyFingerprint(apiKey)
  const controller = new AbortController()
  let interruption: 'CLAUDE_TIMEOUT' | 'REQUEST_CANCELLED' | 'CLAUDE_CREDENTIAL_SOURCE' | undefined
  const interrupt = (code: NonNullable<typeof interruption>) => {
    interruption ??= code
    controller.abort()
  }
  const timer = setTimeout(() => interrupt('CLAUDE_TIMEOUT'), timeoutMs)
  const onAbort = () => interrupt('REQUEST_CANCELLED')
  signal?.addEventListener('abort', onAbort, { once: true })

  const startedAt = Date.now()
  const queryResult = query({
    prompt,
    options: {
      abortController: controller,
      tools: [],
      settingSources: [],
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      maxTurns: 1,
      persistSession: false,
      cwd: tmpdir(),
      env: buildClaudeEnv(env, apiKey),
      ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
    },
  })

  let run: CollectedClaudeRun
  try {
    run = await collectClaudeRun(queryResult, {
      onInit: ({ apiKeySource }) => {
        // Yalnızca .env anahtarıyla çalışılır; claude.ai oturumu vb. kabul edilmez.
        if (apiKeySource !== 'ANTHROPIC_API_KEY') interrupt('CLAUDE_CREDENTIAL_SOURCE')
      },
    })
  } catch {
    if (interruption) throw new ClaudeRunError(interruption)
    throw recordFailure(fingerprint, 'CLAUDE_REQUEST_FAILED')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    try {
      queryResult.close()
    } catch {
      // Sorgu zaten kapanmışsa yapılacak bir şey yok.
    }
  }

  if (interruption) throw new ClaudeRunError(interruption)
  const failure = classifyClaudeRun(run)
  if (failure) throw recordFailure(fingerprint, failure)
  lastOutcome = { keyFingerprint: fingerprint, ok: true, at: new Date().toISOString() }

  const usageRows = Object.values(run.modelUsage)
  const sum = (select: (item: ClaudeModelUsage) => number | undefined) => {
    const values = usageRows.map(select).filter((value): value is number => value !== undefined)
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined
  }
  const fromUsage = (value: number | undefined) => (usageRows.length ? undefined : value)
  const actualModels = Object.keys(run.modelUsage)
  const costBases = [...new Set(usageRows.map((item) => item.costBasis).filter(Boolean))]
  const costSource = costBases.includes('unknown')
    ? 'SDK fiyat tahmini · fiyat tabanı bilinmiyor'
    : costBases.includes('managed')
      ? 'SDK tarafından ölçüldü · kuruluş fiyatlandırması'
      : 'SDK tarafından ölçüldü · SDK fiyat tablosu'
  const hasCost = usageRows.length > 0 && Number.isFinite(run.totalCostUsd)

  return normalizeClaudeExecution({
    id: randomUUID(),
    requestedModel: config.model,
    model: actualModels.length ? actualModels.join(', ') : run.initModel,
    response: run.response,
    inputTokens: sum((item) => item.inputTokens) ?? fromUsage(run.usage?.input_tokens),
    outputTokens: sum((item) => item.outputTokens) ?? fromUsage(run.usage?.output_tokens),
    cachedTokens: sum((item) => item.cacheReadInputTokens) ?? fromUsage(run.usage?.cache_read_input_tokens),
    cacheCreationTokens:
      sum((item) => item.cacheCreationInputTokens) ?? fromUsage(run.usage?.cache_creation_input_tokens),
    reasoningTokens: sum((item) => item.thinkingTokens),
    durationMs: run.durationMs ?? Date.now() - startedAt,
    numTurns: run.numTurns,
    modelCalls: run.modelCallIds.size || undefined,
    toolCalls: run.toolCalls,
    ...(hasCost ? { providerCostUsd: run.totalCostUsd, providerCostSource: costSource } : {}),
    events: run.events,
    rawMetrics: {
      modelUsage: run.modelUsage,
      durationMs: run.durationMs,
      numTurns: run.numTurns,
      stopReason: run.stopReason,
      claudeCodeVersion: run.claudeCodeVersion,
    },
  }, comparisonId)
}

function recordFailure(fingerprint: string, code: ClaudeErrorCode) {
  lastOutcome = { keyFingerprint: fingerprint, ok: false, code, at: new Date().toISOString() }
  return new ClaudeRunError(code)
}
