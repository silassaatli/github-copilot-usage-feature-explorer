import express from 'express'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { copilotPlans, pricingMetadata } from './data/copilot-plans.js'
import type { DatabaseHealth } from './db/init.js'
import { getRecommendation } from './services/advisor.js'
import {
  describeClaudeError,
  getClaudeConnectionStatus,
  isAllowedClaudeModel,
  listClaudeModels,
  runClaude,
  type RunClaudeOptions,
} from './services/claude.js'
import { describeCopilotError } from './services/copilot-runtime.js'
import type { CopilotService, RunRequest, Strategy } from './services/copilot-runner.js'
import { calculateLicense } from './services/licensing.js'
import {
  createComparisonSummary,
  normalizeCopilotExecution,
  runProvidersIndependently,
  type ProviderExecution,
  type ProviderId,
} from './services/provider-comparison.js'
import {
  addExecution,
  addProviderExecution,
  getHistory,
  getHistoryStore,
  type HistoryStatus,
} from './services/usage-history.js'
import { summarizeHistory } from './services/usage-report.js'

export interface AppDependencies {
  copilot: CopilotService
  /** Claude yapılandırması ve anahtarı yalnızca buradan okunur (sunucu tarafı .env). */
  env: NodeJS.ProcessEnv
  persistence: { health(): DatabaseHealth }
  claudeTimeoutMs: number
  /** Testlerde gerçek Claude Agent SDK yerine sahte sorgu işlevi. */
  claudeQueryFn?: RunClaudeOptions['queryFn']
  /** Verilirse derlenmiş ön yüz bu dizinden sunulur (production modu). */
  frontendDir?: string
  /**
   * 'localhost' (varsayılan): yalnızca yerel arayüzden erişime izin verir.
   * 'any': Host/Origin denetimini atlar. Yalnızca sahte sağlayıcılarla çalışan
   * halka açık demo dağıtımları (örn. Vercel) için kullanılır; gerçek Copilot/Claude
   * anahtarlarıyla asla 'any' kullanılmamalıdır.
   */
  trustedHosts?: 'localhost' | 'any'
}

const promptLimit = 12_000
const localHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hostnameOf(value: string | undefined, withScheme: boolean) {
  if (!value) return undefined
  try {
    return new URL(withScheme ? value : `http://${value}`).hostname
  } catch {
    return undefined
  }
}

type ParseResult = { ok: true; value: RunRequest } | { ok: false; error: string }

export function parseRunRequest(body: unknown): ParseResult {
  if (!isRecord(body)) return { ok: false, error: 'İstek gövdesi geçersiz.' }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return { ok: false, error: 'Lütfen bir görev açıklaması girin.' }
  }
  const prompt = body.prompt.trim()
  if (prompt.length > promptLimit) {
    return { ok: false, error: `Görev açıklaması ${promptLimit} karakteri aşamaz.` }
  }
  const model = body.model === undefined ? 'auto' : body.model
  if (typeof model !== 'string' || !model.trim() || model.length > 200) {
    return { ok: false, error: 'Model seçimi geçersiz.' }
  }
  const autoTier = body.autoTier
  if (autoTier !== undefined && (typeof autoTier !== 'string' || !autoTier.trim())) {
    return { ok: false, error: 'Otomatik yönlendirme profili geçersiz.' }
  }
  if (typeof autoTier === 'string' && model.trim() !== 'auto') {
    return { ok: false, error: 'Otomatik yönlendirme profili yalnızca Otomatik modelde kullanılabilir.' }
  }
  const strategy = body.strategy ?? 'normal'
  if (!['normal', 'skill', 'subagents', 'fleet'].includes(String(strategy))) {
    return { ok: false, error: 'Çalıştırma yöntemi geçersiz.' }
  }
  const limit = body.maxAiCreditLimit
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0)) {
    return { ok: false, error: 'AI Credit sınırı pozitif bir sayı olmalıdır.' }
  }
  return {
    ok: true,
    value: {
      prompt,
      model: model.trim(),
      ...(typeof autoTier === 'string' ? { autoTier: autoTier.trim() } : {}),
      strategy: strategy as Strategy,
      ...(typeof limit === 'number' ? { maxAiCreditLimit: limit } : {}),
    },
  }
}

/** İstemci bağlantıyı yanıt tamamlanmadan kapatırsa iptal sinyali üretir. */
function createRequestSignal(response: express.Response): AbortSignal {
  const controller = new AbortController()
  response.on('close', () => {
    if (!response.writableFinished) controller.abort()
  })
  return controller.signal
}

function promptLabel(prompt: string) {
  return prompt.replace(/\s+/g, ' ').slice(0, 80)
}

/** Claude hatasını güvenli koda çevirir; günlüğe yalnızca kod ve hata adı yazılır. */
function describeClaude(error: unknown) {
  const described = describeClaudeError(error)
  console.error(
    `Claude Agent SDK çalıştırması başarısız oldu (${described.code}):`,
    error instanceof Error ? error.name : 'UnknownError',
  )
  return described
}

/** Copilot hatasını güvenli koda çevirir; beklenmeyen hatalar yalnızca mesajıyla günlüğe yazılır. */
function describeCopilot(error: unknown, fallbackMessage?: string) {
  const described = describeCopilotError(error, fallbackMessage)
  if (described.code === 'COPILOT_REQUEST_FAILED') {
    console.error('Copilot çalıştırması başarısız oldu:', error instanceof Error ? error.message : error)
  }
  return described
}

/** Sağlayıcı sonucunu geçmişe yazar; tam istem ve yanıt saklanmaz, yalnızca kısa etiket. */
function recordProviderHistory(
  execution: ProviderExecution,
  prompt: string,
  context: { strategy: string; requestedModel?: string },
) {
  addProviderExecution({
    id: execution.id,
    label: promptLabel(prompt),
    comparisonId: execution.comparisonId,
    provider: execution.provider,
    strategy: context.strategy,
    requestedModel: execution.requestedModel ?? context.requestedModel,
    actualModel: execution.actualModel,
    inputTokens: execution.inputTokens,
    outputTokens: execution.outputTokens,
    cachedTokens: execution.cachedTokens,
    cacheCreationTokens: execution.cacheCreationTokens,
    reasoningTokens: execution.reasoningTokens,
    durationMs: execution.durationMs,
    numTurns: execution.numTurns,
    modelCalls: execution.modelCalls,
    toolCalls: execution.toolCalls,
    providerCost: execution.providerCost,
    providerCostUnit: execution.providerCostUnit,
    providerCostSource: execution.providerCostSource,
    error: execution.error,
    errorCode: execution.errorCode,
    events: execution.events,
  })
}

function failedExecution(
  provider: ProviderId,
  comparisonId: string,
  described: { message: string; code: string; setupHint?: string },
): ProviderExecution {
  return {
    id: randomUUID(),
    comparisonId,
    provider,
    runtime: provider === 'claude' ? 'Claude Agent SDK' : 'GitHub Copilot SDK',
    events: [],
    error: described.message,
    errorCode: described.code,
    ...(described.setupHint ? { setupHint: described.setupHint } : {}),
  }
}

export function createApp(deps: AppDependencies) {
  const { copilot, env } = deps
  const app = express()
  app.disable('x-powered-by')

  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    next()
  })

  // Yalnızca yerel arayüzden gelen istekler kabul edilir: başka bir web sitesinin
  // (DNS rebinding veya çapraz kaynak form gönderimiyle) kullanıcıdan habersiz
  // model çağrısı başlatmasını engeller.
  app.use('/api', (request, response, next) => {
    if (deps.trustedHosts === 'any') {
      next()
      return
    }
    const host = hostnameOf(request.headers.host, false)
    if (!host || !localHostnames.has(host)) {
      response.status(403).json({ error: 'Bu API yalnızca yerel makineden kullanılabilir.', code: 'FORBIDDEN_HOST' })
      return
    }
    const origin = request.headers.origin
    if (origin !== undefined) {
      const originHost = hostnameOf(origin, true)
      if (!originHost || !localHostnames.has(originHost)) {
        response.status(403).json({ error: 'Bu API yalnızca yerel arayüzden kullanılabilir.', code: 'FORBIDDEN_ORIGIN' })
        return
      }
    }
    next()
  })

  app.use(express.json({ limit: '64kb' }))

  function parseClaudeModel(value: unknown): { ok: true; model?: string } | { ok: false; error: string } {
    if (value === undefined || value === null || value === '') return { ok: true }
    if (typeof value !== 'string' || !isAllowedClaudeModel(value.trim(), env)) {
      return { ok: false, error: 'Claude model seçimi geçersiz veya bu hesapta kullanılamıyor.' }
    }
    return { ok: true, model: value.trim() }
  }

  const claudeOptions = (signal: AbortSignal, model?: string): RunClaudeOptions => ({
    signal,
    timeoutMs: deps.claudeTimeoutMs,
    env,
    ...(model ? { model } : {}),
    ...(deps.claudeQueryFn ? { queryFn: deps.claudeQueryFn } : {}),
  })

  app.get('/api/health', async (_request, response) => {
    const [copilotHealth, claude] = await Promise.all([
      copilot.getHealth(),
      getClaudeConnectionStatus(env),
    ])
    const database = deps.persistence.health()
    response.json({
      status: copilotHealth.state === 'ready' && copilotHealth.authenticated && database.persistent ? 'ok' : 'degraded',
      checkedAt: new Date().toISOString(),
      services: {
        api: { state: 'ready' },
        copilot: copilotHealth,
        // Anahtarın kendisi hiçbir zaman yanıta eklenmez; "verified" yalnızca
        // aynı anahtarla başarılı bir gerçek çalıştırmadan sonra true olur.
        claude,
        database,
      },
    })
  })

  app.get('/api/copilot/models', async (_request, response) => {
    try {
      response.json({ status: 'available', ...(await copilot.getModelCatalog()) })
    } catch (error) {
      const described = describeCopilot(error, 'Copilot model kataloğu alınamadı.')
      response.status(described.status).json({
        status: 'unavailable',
        scope: 'unknown',
        models: [],
        autoTiers: [],
        error: described.message,
        code: described.code,
      })
    }
  })

  app.get('/api/copilot/quota', async (_request, response) => {
    try {
      response.json({
        status: 'available',
        source: 'Copilot SDK hesap RPC’si (deneysel)',
        fetchedAt: new Date().toISOString(),
        quotas: await copilot.getQuota(),
      })
    } catch (error) {
      const described = describeCopilotError(error)
      response.json({
        status: 'unavailable',
        quotas: {},
        code: described.code,
        message: described.code === 'COPILOT_UNAVAILABLE'
          ? described.message
          : 'Bu hesap veya SDK sürümü kota bilgisini sunmuyor.',
      })
    }
  })

  app.get('/api/usage/history', (request, response) => {
    const limit = Number(request.query.limit)
    const provider = request.query.provider
    const status = request.query.status
    if (provider !== undefined && provider !== 'github-copilot' && provider !== 'claude') {
      response.status(400).json({ error: 'Sağlayıcı filtresi geçersiz.' })
      return
    }
    if (status !== undefined && status !== 'success' && status !== 'error') {
      response.status(400).json({ error: 'Durum filtresi geçersiz.' })
      return
    }
    const filter = {
      ...(provider ? { provider: provider as ProviderId } : {}),
      ...(status ? { status: status as HistoryStatus } : {}),
    }
    const database = deps.persistence.health()
    let total: number | undefined
    try {
      total = getHistoryStore().count(filter)
    } catch {
      total = undefined
    }
    response.json({
      storage: database.storage,
      persistent: database.persistent,
      retention: database.retention,
      total,
      executions: getHistory({ ...filter, ...(Number.isInteger(limit) ? { limit } : {}) }),
    })
  })

  app.delete('/api/usage/history', (request, response) => {
    if (!isRecord(request.body) || request.body.confirm !== true) {
      response.status(400).json({ error: 'Geçmişi silmek için işlemi onaylayın.', code: 'CONFIRMATION_REQUIRED' })
      return
    }
    try {
      response.json({ deleted: getHistoryStore().clear() })
    } catch (error) {
      console.error('Kullanım geçmişi silinemedi:', error instanceof Error ? error.message : error)
      response.status(500).json({ error: 'Kullanım geçmişi silinemedi.', code: 'HISTORY_UNAVAILABLE' })
    }
  })

  app.get('/api/usage/summary', (_request, response) => {
    try {
      const database = deps.persistence.health()
      response.json({
        storage: database.storage,
        persistent: database.persistent,
        ...summarizeHistory(getHistoryStore().listAll()),
      })
    } catch (error) {
      console.error('Kullanım raporu oluşturulamadı:', error instanceof Error ? error.message : error)
      response.status(500).json({ error: 'Kullanım raporu oluşturulamadı.', code: 'HISTORY_UNAVAILABLE' })
    }
  })

  app.get('/api/claude/status', async (_request, response) => {
    response.json(await getClaudeConnectionStatus(env))
  })

  app.get('/api/claude/models', async (request, response) => {
    try {
      const models = await listClaudeModels({
        env,
        refresh: request.query.refresh === '1',
        ...(deps.claudeQueryFn ? { queryFn: deps.claudeQueryFn } : {}),
      })
      response.json({ status: 'available', models })
    } catch (error) {
      const described = describeClaude(error)
      response.status(described.status).json({
        status: 'unavailable',
        models: [],
        error: described.message,
        code: described.code,
        ...(described.setupHint ? { setupHint: described.setupHint } : {}),
      })
    }
  })

  app.post('/api/claude/chat', async (request, response) => {
    const parsed = parseRunRequest({ ...request.body, model: 'auto', autoTier: undefined, strategy: 'normal' })
    if (!parsed.ok) {
      response.status(400).json({ error: parsed.error })
      return
    }
    const claudeModel = parseClaudeModel(isRecord(request.body) ? request.body.claudeModel : undefined)
    if (!claudeModel.ok) {
      response.status(400).json({ error: claudeModel.error })
      return
    }
    const comparisonId = randomUUID()
    const context = { strategy: 'normal', requestedModel: claudeModel.model }
    try {
      const result = await runClaude(parsed.value.prompt, comparisonId, claudeOptions(createRequestSignal(response), claudeModel.model))
      recordProviderHistory(result, parsed.value.prompt, context)
      response.json(result)
    } catch (error) {
      const described = describeClaude(error)
      recordProviderHistory(failedExecution('claude', comparisonId, described), parsed.value.prompt, context)
      if (response.headersSent || response.destroyed) return
      response.status(described.status).json({
        error: described.message,
        code: described.code,
        ...(described.setupHint ? { setupHint: described.setupHint } : {}),
      })
    }
  })

  app.post('/api/compare', async (request, response) => {
    if (!isRecord(request.body) || !Array.isArray(request.body.providers)) {
      response.status(400).json({ error: 'Karşılaştırılacak sağlayıcıları seçin.' })
      return
    }
    const providers = [...new Set(request.body.providers)]
    if (!providers.length || providers.some((provider) => provider !== 'github-copilot' && provider !== 'claude')) {
      response.status(400).json({ error: 'Sağlayıcı seçimi geçersiz.' })
      return
    }
    const parsed = parseRunRequest({ ...request.body, strategy: request.body.strategy ?? 'normal' })
    if (!parsed.ok) {
      response.status(400).json({ error: parsed.error })
      return
    }
    const selectedProviders = providers as ProviderId[]
    const claudeModel = selectedProviders.includes('claude')
      ? parseClaudeModel(request.body.claudeModel)
      : { ok: true as const }
    if (!claudeModel.ok) {
      response.status(400).json({ error: claudeModel.error })
      return
    }

    const comparisonId = randomUUID()
    const signal = createRequestSignal(response)
    const executions = await runProvidersIndependently(selectedProviders, comparisonId, {
      'github-copilot': async () => {
        const execution = await copilot.run({ ...parsed.value, comparisonId }, signal)
        addExecution(execution)
        return normalizeCopilotExecution(execution, comparisonId)
      },
      claude: () => runClaude(parsed.value.prompt, comparisonId, claudeOptions(signal, claudeModel.model)),
    }, (provider, error) => {
      const described = provider === 'claude' ? describeClaude(error) : describeCopilot(error)
      return {
        error: described.message,
        errorCode: described.code,
        ...('setupHint' in described && described.setupHint ? { setupHint: described.setupHint } : {}),
      }
    })

    for (const execution of executions) {
      // Başarılı Copilot çalıştırmaları ayrıntılı ölçümleriyle yukarıda kaydedildi.
      if (execution.provider === 'github-copilot' && !execution.error) continue
      recordProviderHistory(execution, parsed.value.prompt, {
        strategy: execution.provider === 'github-copilot' ? parsed.value.strategy : 'normal',
        requestedModel: execution.provider === 'github-copilot' ? parsed.value.model : claudeModel.model,
      })
    }

    response.json({ comparisonId, executions, summary: createComparisonSummary(executions) })
  })

  async function handleCopilotRun(
    request: express.Request,
    response: express.Response,
    override: Partial<RunRequest>,
    fallbackMessage: string,
  ) {
    const parsed = parseRunRequest(request.body)
    if (!parsed.ok) {
      response.status(400).json({ error: parsed.error })
      return
    }
    const input = { ...parsed.value, ...override }
    try {
      const result = await copilot.run(input, createRequestSignal(response))
      addExecution(result)
      response.json(result)
    } catch (error) {
      const described = describeCopilot(error, fallbackMessage)
      const comparisonId = randomUUID()
      recordProviderHistory(failedExecution('github-copilot', comparisonId, described), input.prompt, {
        strategy: input.strategy,
        requestedModel: input.model,
      })
      if (response.headersSent || response.destroyed) return
      response.status(described.status).json({ error: described.message, code: described.code })
    }
  }

  app.post('/api/copilot/chat', (request, response) =>
    handleCopilotRun(request, response, {}, 'Copilot isteği tamamlanamadı.'))

  app.post('/api/copilot/fleet', (request, response) =>
    handleCopilotRun(request, response, { strategy: 'fleet' }, 'Deneysel Fleet çalıştırması tamamlanamadı.'))

  app.post('/api/advisor/recommend', (request, response) => {
    const body: unknown = request.body
    if (!isRecord(body) || typeof body.task !== 'string' || !body.task.trim()) {
      response.status(400).json({ error: 'Görev açıklamasını girin.' })
      return
    }
    response.json(getRecommendation(body))
  })

  app.post('/api/licensing/calculate', (request, response) => {
    const result = calculateLicense(request.body)
    if (!result.ok) {
      response.status(400).json({ error: result.error })
      return
    }
    response.json(result.value)
  })

  app.get('/api/licensing/plans', (_request, response) => {
    response.json({ plans: copilotPlans, pricing: pricingMetadata })
  })

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'İstenen API uç noktası bulunamadı.', code: 'NOT_FOUND' })
  })

  if (deps.frontendDir && existsSync(join(deps.frontendDir, 'index.html'))) {
    const frontendDir = deps.frontendDir
    app.use(express.static(frontendDir, { index: false }))
    app.use((request, response, next) => {
      if (request.method !== 'GET') {
        next()
        return
      }
      response.sendFile(join(frontendDir, 'index.html'))
    })
  }

  app.use(
    (error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
      if (response.headersSent) {
        next(error)
        return
      }
      if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
        response.status(400).json({ error: 'İstek gövdesi geçerli JSON olmalıdır.', code: 'INVALID_JSON' })
        return
      }
      if (isRecord(error) && error.type === 'entity.too.large') {
        response.status(413).json({ error: 'İstek gövdesi izin verilen boyutu aşıyor.', code: 'PAYLOAD_TOO_LARGE' })
        return
      }
      console.error('API isteği işlenemedi:', error instanceof Error ? error.message : error)
      response.status(500).json({ error: 'Sunucu isteği işleyemedi.', code: 'INTERNAL_ERROR' })
    },
  )

  return app
}
