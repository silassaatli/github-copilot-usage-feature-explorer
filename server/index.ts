import 'dotenv/config'
import { CopilotClient } from '@github/copilot-sdk'
import type { CustomAgentConfig, ModelInfo, SessionConfig } from '@github/copilot-sdk'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getRecommendation } from './services/advisor.js'
import { describeClaudeError, getClaudeConnectionStatus, runClaude } from './services/claude.js'
import {
  closeCopilotSession,
  createCopilotConnection,
  createSessionWorkspace,
  CopilotRunError,
  denyAllPermissions,
  describeCopilotError,
  getSessionToolAllowlist,
  parseTimeoutMs,
  removeSessionWorkspace,
  runWithDeadline,
  toCopilotRunError,
  type UpstreamErrorInfo,
} from './services/copilot-runtime.js'
import { calculateLicense } from './services/licensing.js'
import { filterSelectableModels, getSelectableAutoTiers } from './services/model-catalog.js'
import { addExecution, addProviderExecution, getHistory } from './services/usage-history.js'
import {
  createComparisonSummary,
  normalizeCopilotExecution,
  runProvidersIndependently,
  type ProviderExecution,
  type ProviderId,
} from './services/provider-comparison.js'
import { copilotPlans, pricingMetadata } from './data/copilot-plans.js'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const copilotClient = new CopilotClient({ useLoggedInUser: true })
const copilotConnection = createCopilotConnection(copilotClient)
const skillDirectory = join(process.cwd(), 'skills')
const promptLimit = 12_000
const nanoAiuPerAiCredit = 1_000_000_000
const copilotRequestTimeoutMs = parseTimeoutMs(process.env.COPILOT_REQUEST_TIMEOUT_MS, 120_000)
const claudeRequestTimeoutMs = parseTimeoutMs(process.env.CLAUDE_REQUEST_TIMEOUT_MS, 120_000)
type AccountModel = Awaited<ReturnType<typeof copilotClient.rpc.models.list>>['models'][number]

app.use(express.json({ limit: '64kb' }))

app.get('/api/health', async (_request, response) => {
  const [copilot, claude] = await Promise.all([
    copilotConnection.getHealth(),
    getClaudeConnectionStatus(),
  ])
  response.json({
    status: copilot.state === 'ready' && copilot.authenticated ? 'ok' : 'degraded',
    services: {
      api: { state: 'ready' },
      copilot,
      // Anahtarın kendisi hiçbir zaman yanıta eklenmez; "verified" yalnızca
      // aynı anahtarla başarılı bir gerçek çalıştırmadan sonra true olur.
      claude,
    },
  })
})

app.get('/api/copilot/models', async (_request, response) => {
  try {
    await copilotConnection.ensureReady()
  } catch (error) {
    const described = describeCopilotError(error)
    response.status(described.status).json({
      status: 'unavailable',
      models: [],
      autoTiers: [],
      error: described.message,
      code: described.code,
    })
    return
  }
  try {
    let sessionModelIds: Set<string> | undefined
    let autoTiers: ReturnType<typeof getSelectableAutoTiers> = []
    let session: Awaited<ReturnType<typeof copilotClient.createSession>> | undefined
    const workspace = await createSessionWorkspace()
    try {
      session = await copilotClient.createSession(safeSessionConfig(workspace, { model: 'auto' }))
      const sessionCatalog = await session.rpc.model.list()
      sessionModelIds = new Set(
        sessionCatalog.list.flatMap((item) =>
          isRecord(item) && typeof item.id === 'string' ? [item.id] : [],
        ),
      )
      autoTiers = getSelectableAutoTiers(sessionCatalog.auto)
    } catch (error) {
      console.error('Oturum model kataloğu alınamadı:', error)
    } finally {
      if (session) await closeCopilotSession(copilotClient, session)
      await cleanupWorkspace(workspace)
    }

    const catalogModels = await getAccountModels()
    const models = filterSelectableModels(catalogModels, sessionModelIds).map(toPublicModel)
    const message = models.some((model) => model.id !== 'auto')
      ? undefined
      : modelCatalogFallbackMessage

    response.json({
      status: 'available',
      models,
      autoTiers,
      ...(message ? { message } : {}),
    })
  } catch (error) {
    console.error('Model kataloğu alınamadı:', error)
    response.status(503).json({
      status: 'unavailable',
      models: [],
      autoTiers: [],
      error: modelCatalogFallbackMessage,
    })
  }
})

app.get('/api/copilot/quota', async (_request, response) => {
  try {
    await copilotConnection.ensureReady()
    const result = await copilotClient.rpc.account.getQuota({})
    response.json({ status: 'available', quotas: result.quotaSnapshots })
  } catch {
    response.json({
      status: 'unavailable',
      quotas: {},
      message: 'Bu hesap veya SDK sürümü kota bilgisini sunmuyor.',
    })
  }
})

app.get('/api/usage/history', (_request, response) => {
  response.json({ executions: getHistory() })
})

app.get('/api/claude/status', async (_request, response) => {
  response.json(await getClaudeConnectionStatus())
})

app.post('/api/claude/chat', async (request, response) => {
  const parsed = parseRunRequest({ ...request.body, model: 'auto', strategy: 'normal' })
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error })
    return
  }
  const comparisonId = randomUUID()
  try {
    const result = await runClaude(parsed.value.prompt, comparisonId, {
      signal: createRequestSignal(response),
      timeoutMs: claudeRequestTimeoutMs,
    })
    addClaudeHistory(result, parsed.value.prompt)
    response.json(result)
  } catch (error) {
    const described = describeClaude(error)
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
  if (
    !providers.length ||
    providers.some((provider) => provider !== 'github-copilot' && provider !== 'claude')
  ) {
    response.status(400).json({ error: 'Sağlayıcı seçimi geçersiz.' })
    return
  }
  const parsed = parseRunRequest({
    ...request.body,
    model: 'auto',
    strategy: request.body.strategy ?? 'normal',
  })
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error })
    return
  }

  const comparisonId = randomUUID()
  const selectedProviders = providers as ProviderId[]
  const signal = createRequestSignal(response)
  const executions = await runProvidersIndependently(selectedProviders, comparisonId, {
    'github-copilot': async () => {
      if (!selectedProviders.includes('github-copilot')) throw new Error('Provider not selected')
      const execution = await runCopilot({ ...parsed.value, comparisonId }, signal)
      return normalizeCopilotExecution(execution, comparisonId)
    },
    claude: async () => {
      if (!selectedProviders.includes('claude')) throw new Error('Provider not selected')
      return runClaude(parsed.value.prompt, comparisonId, {
        signal,
        timeoutMs: claudeRequestTimeoutMs,
      })
    },
  }, (provider, error) => {
    if (provider === 'claude') {
      const described = describeClaude(error)
      return {
        error: described.message,
        errorCode: described.code,
        ...(described.setupHint ? { setupHint: described.setupHint } : {}),
      }
    }
    const described = describeCopilotError(error)
    if (described.code === 'COPILOT_REQUEST_FAILED') {
      console.error('Karşılaştırmadaki Copilot çalıştırması başarısız oldu:', error)
    }
    return { error: described.message, errorCode: described.code }
  })

  for (const execution of executions) {
    if (execution.provider === 'claude' && !execution.error) {
      addClaudeHistory(execution, parsed.value.prompt)
    } else if (execution.error) {
      addProviderExecution({
        id: execution.id,
        label: parsed.value.prompt.replace(/\s+/g, ' ').slice(0, 80),
        comparisonId,
        provider: execution.provider,
        actualModel: execution.actualModel,
        inputTokens: execution.inputTokens,
        outputTokens: execution.outputTokens,
        cachedTokens: execution.cachedTokens,
        reasoningTokens: execution.reasoningTokens,
        durationMs: execution.durationMs,
        modelCalls: execution.modelCalls,
        toolCalls: execution.toolCalls,
        providerCost: execution.providerCost,
        providerCostUnit: execution.providerCostUnit,
        error: execution.error,
        events: execution.events,
      })
    }
  }

  response.json({
    comparisonId,
    executions,
    summary: createComparisonSummary(executions),
  })
})

app.post('/api/copilot/chat', async (request, response) => {
  const parsed = parseRunRequest(request.body)
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error })
    return
  }

  try {
    const result = await runCopilot(parsed.value, createRequestSignal(response))
    response.json(result)
  } catch (error) {
    sendCopilotError(response, error, 'Copilot isteği başarısız oldu:', 'Copilot isteği tamamlanamadı.')
  }
})

app.post('/api/copilot/fleet', async (request, response) => {
  const parsed = parseRunRequest(request.body)
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error })
    return
  }

  try {
    const result = await runCopilot({ ...parsed.value, strategy: 'fleet' }, createRequestSignal(response))
    response.json(result)
  } catch (error) {
    sendCopilotError(response, error, 'Fleet çalıştırması başarısız oldu:', 'Deneysel Fleet çalıştırması tamamlanamadı.')
  }
})

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

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    next: express.NextFunction,
  ) => {
    if (response.headersSent) {
      next(error)
      return
    }
    if (
      error instanceof SyntaxError &&
      'status' in error &&
      error.status === 400
    ) {
      response.status(400).json({ error: 'İstek gövdesi geçerli JSON olmalıdır.' })
      return
    }
    if (isRecord(error) && error.type === 'entity.too.large') {
      response.status(413).json({ error: 'İstek gövdesi izin verilen boyutu aşıyor.' })
      return
    }
    console.error('API isteği işlenemedi:', error)
    response.status(500).json({ error: 'Sunucu isteği işleyemedi.' })
  },
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toPublicModel(model: ModelInfo | AccountModel) {
  return {
    id: model.id,
    name: model.name,
    capabilities: model.capabilities,
    billing: model.billing,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    policy: model.policy,
  }
}

/**
 * Her Copilot oturumuna uygulanan güvenlik ayarları: boş geçici çalışma dizini,
 * yalnızca oturum içi yerleşik araçlar ve izin isteklerinin varsayılan reddi.
 */
function safeSessionConfig(workspace: string, config: SessionConfig): SessionConfig {
  return {
    ...config,
    workingDirectory: workspace,
    availableTools: getSessionToolAllowlist(),
    onPermissionRequest: denyAllPermissions,
  }
}

async function cleanupWorkspace(workspace: string) {
  try {
    await removeSessionWorkspace(workspace)
  } catch (error) {
    console.error('Geçici oturum dizini silinemedi:', error instanceof Error ? error.message : error)
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

/** Claude hatasını güvenli koda çevirir; sunucu günlüğüne yalnızca kod ve hata adı yazılır. */
function describeClaude(error: unknown) {
  const described = describeClaudeError(error)
  console.error(
    `Claude Agent SDK çalıştırması başarısız oldu (${described.code}):`,
    error instanceof Error ? error.name : 'UnknownError',
  )
  return described
}

function sendCopilotError(
  response: express.Response,
  error: unknown,
  logMessage: string,
  fallbackMessage: string,
) {
  const described = describeCopilotError(error, fallbackMessage)
  if (described.code === 'COPILOT_REQUEST_FAILED') console.error(logMessage, error)
  if (response.headersSent || response.destroyed) return
  response.status(described.status).json({ error: described.message, code: described.code })
}

type Strategy = 'normal' | 'skill' | 'subagents' | 'fleet'

interface RunRequest {
  prompt: string
  model: string
  autoTier?: string
  strategy: Strategy
  maxAiCreditLimit?: number
  comparisonId?: string
}

type ParseResult =
  | { ok: true; value: RunRequest }
  | { ok: false; error: string }

function parseRunRequest(body: unknown): ParseResult {
  if (!isRecord(body)) {
    return { ok: false, error: 'İstek gövdesi geçersiz.' }
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return { ok: false, error: 'Lütfen bir görev açıklaması girin.' }
  }
  const prompt = body.prompt.trim()
  if (prompt.length > promptLimit) {
    return { ok: false, error: `Görev açıklaması ${promptLimit} karakteri aşamaz.` }
  }

  const model = body.model === undefined ? 'auto' : body.model
  if (typeof model !== 'string' || !model.trim()) {
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
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0)
  ) {
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

const analysisAgents: CustomAgentConfig[] = [
  {
    name: 'frontend-reviewer',
    displayName: 'Ön yüz inceleyicisi',
    description: 'Ön yüz tasarım ve erişilebilirlik risklerini inceler.',
    prompt: 'Görevi yalnızca analiz et. Dosya değiştirme veya komut çalıştırma. Görünür görev metninden çıkarılabilen ön yüz risklerini kısa maddelerle açıkla.',
    tools: [],
    infer: true,
  },
  {
    name: 'backend-reviewer',
    displayName: 'Arka yüz inceleyicisi',
    description: 'API ve sunucu tarafı risklerini inceler.',
    prompt: 'Görevi yalnızca analiz et. Dosya değiştirme veya komut çalıştırma. Görünür görev metninden çıkarılabilen API ve sunucu risklerini kısa maddelerle açıkla.',
    tools: [],
    infer: true,
  },
  {
    name: 'data-reviewer',
    displayName: 'Veri inceleyicisi',
    description: 'Veri ve saklama etkilerini inceler.',
    prompt: 'Görevi yalnızca analiz et. Dosya değiştirme veya komut çalıştırma. Görünür görev metninden çıkarılabilen veri ve gizlilik risklerini kısa maddelerle açıkla.',
    tools: [],
    infer: true,
  },
]

async function runCopilot(input: RunRequest, signal?: AbortSignal) {
  await copilotConnection.ensureReady()
  if (input.model !== 'auto') {
    const models = await getAccountModels()
    if (!models.some((model) => model.id === input.model)) {
      throw new CopilotRunError('UNSUPPORTED_MODEL', 'Seçilen model bu Copilot hesabında kullanılamıyor.')
    }
  }

  const customAgents = input.strategy === 'subagents' ? analysisAgents : undefined
  const workspace = await createSessionWorkspace()
  const session = await copilotClient.createSession(safeSessionConfig(workspace, {
    model: input.model,
    ...(input.strategy === 'skill'
      ? { skillDirectories: [skillDirectory], enableSkills: true }
      : {}),
    ...(customAgents ? { customAgents } : {}),
    ...(input.maxAiCreditLimit
      ? { sessionLimits: { maxAiCredits: input.maxAiCreditLimit } }
      : {}),
  })).catch(async (error: unknown) => {
    await cleanupWorkspace(workspace)
    throw toCopilotRunError(error)
  })
  const deadline = {
    timeoutMs: copilotRequestTimeoutMs,
    signal,
    onInterrupt: () => session.abort(),
  }
  let upstreamError: UpstreamErrorInfo | undefined

  const executionId = randomUUID()
  const startedAt = Date.now()
  const events: ActivityEvent[] = []
  const calls: ModelCall[] = []
  const activeTools = new Map<string, string>()
  let context: ContextUsage | undefined
  let assistantResponse = ''
  let modelInUse: string | undefined
  let limitReached = false

  session.on((event) => {
    if (event.type === 'assistant.message') {
      assistantResponse = event.data.content
    } else if (event.type === 'session.error') {
      upstreamError = {
        errorType: event.data.errorType,
        errorCode: event.data.errorCode,
        statusCode: event.data.statusCode,
      }
    } else if (event.type === 'assistant.usage') {
      const data = event.data
      modelInUse = data.model
      calls.push({
        model: data.model,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cacheReadTokens: data.cacheReadTokens,
        cacheWriteTokens: data.cacheWriteTokens,
        reasoningTokens: data.reasoningTokens,
        durationMs: data.duration,
        legacyRequestCost: data.cost,
        timestamp: event.timestamp,
      })
      events.push({
        id: event.id,
        type: 'model',
        label: `${data.model} · model çağrısı`,
        timestamp: event.timestamp,
      })
    } else if (event.type === 'session.usage_info') {
      context = {
        currentTokens: event.data.currentTokens,
        tokenLimit: event.data.tokenLimit,
        conversationTokens: event.data.conversationTokens,
        systemTokens: event.data.systemTokens,
        percentage:
          event.data.tokenLimit > 0
            ? (event.data.currentTokens / event.data.tokenLimit) * 100
            : undefined,
      }
    } else if (event.type === 'tool.execution_start') {
      activeTools.set(event.data.toolCallId, event.data.toolName)
      events.push({
        id: event.id,
        type: 'tool-start',
        label: `Araç başladı: ${event.data.toolName}`,
        timestamp: event.timestamp,
      })
    } else if (event.type === 'tool.execution_complete') {
      events.push({
        id: event.id,
        type: 'tool-complete',
        label: `Araç ${event.data.success ? 'tamamlandı' : 'başarısız'}: ${activeTools.get(event.data.toolCallId) ?? event.data.toolCallId}`,
        timestamp: event.timestamp,
      })
      activeTools.delete(event.data.toolCallId)
    } else if (event.type === 'skill.invoked') {
      events.push({
        id: event.id,
        type: 'skill',
        label: `Skill çağrıldı: ${event.data.name}`,
        timestamp: event.timestamp,
      })
    } else if (event.type === 'subagent.started') {
      events.push({
        id: event.id,
        type: 'subagent',
        label: `Alt ajan başladı: ${event.data.agentDisplayName}`,
        timestamp: event.timestamp,
        details: {
          name: event.data.agentName,
          model: event.data.model,
        },
      })
    } else if (event.type === 'subagent.selected') {
      events.push({
        id: event.id,
        type: 'subagent',
        label: `Alt ajan seçildi: ${event.data.agentDisplayName}`,
        timestamp: event.timestamp,
        details: { name: event.data.agentName },
      })
    } else if (event.type === 'subagent.configured') {
      events.push({
        id: event.id,
        type: 'subagent',
        label: 'Alt ajan yapılandırıldı',
        timestamp: event.timestamp,
        details: {
          model: event.data.model,
          reasoningEffort: event.data.reasoningEffort,
          contextTier: event.data.contextTier,
        },
      })
    } else if (
      event.type === 'subagent.completed' ||
      event.type === 'subagent.failed'
    ) {
      events.push({
        id: event.id,
        type: 'subagent',
        label: `Alt ajan ${event.type === 'subagent.completed' ? 'tamamlandı' : 'başarısız'}: ${event.data.agentDisplayName}`,
        timestamp: event.timestamp,
        details: {
          model: event.data.model,
          durationMs: event.data.durationMs,
          tokens: event.data.totalTokens,
          toolCalls: event.data.totalToolCalls,
        },
      })
    } else if (
      event.type === 'hook.start' ||
      event.type === 'hook.end' ||
      event.type === 'hook.progress'
    ) {
      events.push({
        id: event.id,
        type: 'hook',
        label: `Hook olayı: ${event.type}`,
        timestamp: event.timestamp,
      })
    } else if (event.type === 'session.model_change') {
      modelInUse = event.data.newModel;
    } else if (event.type === 'session_limits_exhausted.requested') {
      limitReached = true
      events.push({
        id: event.id,
        type: 'limit',
        label: `Oturum AI Credit sınırına ulaştı (${event.data.usedAiCredits} / ${event.data.maxAiCredits})`,
        timestamp: event.timestamp,
      })
      void session.rpc.ui.handlePendingSessionLimitsExhausted({
        requestId: event.data.requestId,
        response: { action: 'cancel' },
      }).catch((error: unknown) => {
        console.error('Oturum AI Credit sınırı güvenli biçimde yanıtlanamadı:', error)
      })
    } else if (event.type === 'session_limits_exhausted.completed') {
      events.push({
        id: event.id,
        type: 'limit',
        label: `AI Credit sınırı yanıtı: ${event.data.response.action}`,
        timestamp: event.timestamp,
      })
    }
  })

  try {
    if (input.autoTier) {
      const catalog = await session.rpc.model.list()
      const supportedTiers = getSelectableAutoTiers(catalog.auto)
      if (!supportedTiers.some((tier) => tier.id === input.autoTier)) {
        throw new CopilotRunError('UNSUPPORTED_MODEL', 'Seçilen otomatik yönlendirme profili bu oturumda desteklenmiyor.')
      }
      await session.setAutoTier(input.autoTier)
    }

    try {
      if (input.strategy === 'fleet') {
        if (typeof session.rpc.fleet?.start !== 'function') {
          throw new CopilotRunError('UNSUPPORTED_FEATURE', fleetUnsupportedMessage)
        }
        let result
        try {
          result = await runWithDeadline(() => session.rpc.fleet.start({
            prompt: input.prompt,
            wait: true,
          }), deadline)
        } catch (error) {
          if (isUnsupportedRpcError(error)) {
            throw new CopilotRunError('UNSUPPORTED_FEATURE', fleetUnsupportedMessage)
          }
          throw error
        }
        if (!result.started) {
          throw new CopilotRunError('UNSUPPORTED_FEATURE', fleetUnsupportedMessage)
        }
      } else {
        const prompt =
          input.strategy === 'skill'
            ? `Uygunsa code-review skill'ini kullan. Skill kullanılamıyorsa bunu açıkça belirt.\n\nGörev:\n${input.prompt}`
            : input.strategy === 'subagents'
              ? `Kayıtlı uzman ajanlardan görev için yararlı olanlara delegasyon yapmayı dene. Runtime delegasyonu desteklemiyorsa bunu belirt; hiçbir dosyayı değiştirme ve komut çalıştırma.\n\nGörev:\n${input.prompt}`
              : input.prompt
        // SDK'nın kendi bekleme süresi, iptal edebilen runWithDeadline sınırından biraz uzun tutulur.
        const result = await runWithDeadline(
          () => session.sendAndWait({ prompt }, copilotRequestTimeoutMs + 5_000),
          deadline,
        )
        if (result) assistantResponse = result.data.content
      }
    } catch (error) {
      if (limitReached) throw new CopilotRunError('SESSION_LIMIT_REACHED')
      throw error
    }

    let metrics: Awaited<ReturnType<typeof session.rpc.usage.getMetrics>> | undefined
    let metricsStatus: 'available' | 'unavailable' = 'available'
    try {
      metrics = await session.rpc.usage.getMetrics()
    } catch {
      metricsStatus = 'unavailable'
    }

    const modelMetrics = metrics
      ? Object.entries(metrics.modelMetrics).flatMap(([id, metric]) =>
          metric
            ? [{
                id,
                requests: metric.requests.count,
                inputTokens: metric.usage.inputTokens,
                outputTokens: metric.usage.outputTokens,
                cacheReadTokens: metric.usage.cacheReadTokens,
                cacheWriteTokens: metric.usage.cacheWriteTokens,
                reasoningTokens: metric.usage.reasoningTokens,
                nanoAiu: metric.totalNanoAiu,
              }]
            : [],
        )
      : []
    const nanoAiu =
      metrics?.totalNanoAiu ??
      modelMetrics.reduce((total, metric) => total + (metric.nanoAiu ?? 0), 0)
    const hasNanoAiu =
      metrics?.totalNanoAiu !== undefined ||
      modelMetrics.some((metric) => metric.nanoAiu !== undefined)
    const eventInputTokens = calls.reduce(
      (total, call) => total + (call.inputTokens ?? 0),
      0,
    )
    const eventOutputTokens = calls.reduce(
      (total, call) => total + (call.outputTokens ?? 0),
      0,
    )

    const usage = {
      status: metricsStatus,
      inputTokens: modelMetrics.length
        ? modelMetrics.reduce((total, item) => total + item.inputTokens, 0)
        : eventInputTokens,
      outputTokens: modelMetrics.length
        ? modelMetrics.reduce((total, item) => total + item.outputTokens, 0)
        : eventOutputTokens,
      cacheReadTokens: modelMetrics.length
        ? modelMetrics.reduce((total, item) => total + item.cacheReadTokens, 0)
        : calls.reduce((total, call) => total + (call.cacheReadTokens ?? 0), 0),
      reasoningTokens: modelMetrics.reduce(
        (total, item) => total + (item.reasoningTokens ?? 0),
        0,
      ),
      aiCredits: hasNanoAiu ? nanoAiu / nanoAiuPerAiCredit : undefined,
      nanoAiu: hasNanoAiu ? nanoAiu : undefined,
      modelCalls: metrics
        ? Object.values(metrics.modelMetrics).reduce(
            (total, item) => total + (item?.requests.count ?? 0),
            0,
          )
        : calls.length,
      durationMs: Date.now() - startedAt,
      context,
      modelMetrics,
      calls,
      toolCalls: events.filter((item) => item.type === 'tool-complete').length,
      subagentCalls: events.filter(
        (item) => item.type === 'subagent' && item.label.includes('başladı'),
      ).length,
      skillsInvoked: events
        .filter((item) => item.type === 'skill')
        .map((item) => item.label.replace('Skill çağrıldı: ', '')),
      legacyPremiumRequestCost: metrics?.totalPremiumRequestCost,
      aiCreditsStatus: metrics?.aiCreditsStatus,
      maxAiCreditLimit: input.maxAiCreditLimit,
      limitUsagePercentage:
        input.maxAiCreditLimit !== undefined && hasNanoAiu
          ? (nanoAiu / nanoAiuPerAiCredit / input.maxAiCreditLimit) * 100
          : undefined,
    }

    const execution = {
      id: executionId,
      label: input.prompt.replace(/\s+/g, ' ').slice(0, 80),
      strategy: input.strategy,
      createdAt: new Date().toISOString(),
      comparisonId: input.comparisonId,
      response: assistantResponse,
      requestedModel: input.model,
      model: metrics?.currentModel ?? modelInUse ?? 'SDK tarafından bildirilmedi',
      ...(input.autoTier ? { requestedAutoTier: input.autoTier } : {}),
      usage,
      events,
    }
    addExecution(execution)
    return execution
  } catch (error) {
    throw toCopilotRunError(error, upstreamError)
  } finally {
    // Temizlik hiçbir zaman hata fırlatmaz; asıl hata korunur.
    await closeCopilotSession(copilotClient, session)
    await cleanupWorkspace(workspace)
  }
}

function addClaudeHistory(execution: ProviderExecution, prompt: string) {
  addProviderExecution({
    id: execution.id,
    label: prompt.replace(/\s+/g, ' ').slice(0, 80),
    comparisonId: execution.comparisonId,
    provider: execution.provider,
    actualModel: execution.actualModel,
    inputTokens: execution.inputTokens,
    outputTokens: execution.outputTokens,
    cachedTokens: execution.cachedTokens,
    reasoningTokens: execution.reasoningTokens,
    durationMs: execution.durationMs,
    modelCalls: execution.modelCalls,
    toolCalls: execution.toolCalls,
    providerCost: execution.providerCost,
    providerCostUnit: execution.providerCostUnit,
    events: execution.events,
  })
}

async function getAccountModels(): Promise<Array<ModelInfo | AccountModel>> {
  try {
    return (await copilotClient.rpc.models.list({})).models
  } catch (error) {
    console.error('Hesap model kataloğu alınamadı; SDK model listesi kullanılacak:', error)
    return copilotClient.listModels()
  }
}

interface ActivityEvent {
  id: string
  type: string
  label: string
  timestamp: string
  details?: Record<string, string | number | undefined>
}

interface ModelCall {
  model: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  durationMs?: number
  legacyRequestCost?: number
  timestamp: string
}

interface ContextUsage {
  currentTokens: number
  tokenLimit: number
  conversationTokens?: number
  systemTokens?: number
  percentage?: number
}

const fleetUnsupportedMessage = 'Bu SDK/CLI sürümünde Fleet modu kullanılamıyor.'

const modelCatalogFallbackMessage =
  'Bu SDK oturumunda adlandırılmış model kataloğu kullanılamıyor. Auto çalışma zamanında uygun modeli seçer.'

function isUnsupportedRpcError(error: unknown) {
  if (!(error instanceof Error)) return false
  return /unsupported|not supported|method not found|unknown method/i.test(error.message)
}

function stopCopilot() {
  return copilotConnection.stop().catch((stopError: unknown) => {
    console.error('Copilot istemcisi kapatılamadı:', stopError)
    process.exitCode = 1
  })
}

function startServer() {
  const server = app.listen(port, '127.0.0.1', (error?: Error) => {
    if (error) {
      console.error('API sunucusu başlatılamadı:', error)
      process.exitCode = 1
      void stopCopilot()
      return
    }
    console.log(`Copilot API sunucusu http://127.0.0.1:${port} adresinde çalışıyor.`)
  })

  // Copilot CLI başlatılamasa bile API dinlemeye devam eder (degraded mode);
  // Copilot gerektiren uç noktalar 503 / COPILOT_UNAVAILABLE döndürür.
  void copilotConnection.start().then((ready) => {
    if (ready) console.log('Copilot istemcisi hazır.')
  })

  let isShuttingDown = false
  const shutdown = () => {
    if (isShuttingDown) return
    isShuttingDown = true
    server.close((error) => {
      if (error) {
        console.error('API sunucusu kapatılamadı:', error)
        process.exitCode = 1
      }
      void stopCopilot()
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

startServer()
