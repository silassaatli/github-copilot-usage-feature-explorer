import type { CopilotClient, CustomAgentConfig, ModelInfo, SessionConfig } from '@github/copilot-sdk'
import { randomUUID } from 'node:crypto'
import {
  closeCopilotSession,
  CopilotRunError,
  createSessionWorkspace,
  denyAllPermissions,
  getSessionToolAllowlist,
  removeSessionWorkspace,
  runWithDeadline,
  toCopilotRunError,
  type CopilotHealth,
  type UpstreamErrorInfo,
} from './copilot-runtime.js'
import { filterSelectableModels, getSelectableAutoTiers, type AutoTierChoice } from './model-catalog.js'
import type { ExecutionRecord } from './usage-history.js'

export type Strategy = 'normal' | 'skill' | 'subagents' | 'fleet'

export interface RunRequest {
  prompt: string
  model: string
  autoTier?: string
  strategy: Strategy
  maxAiCreditLimit?: number
  comparisonId?: string
}

export interface PublicCopilotModel {
  id: string
  name: string
  capabilities?: unknown
  billing?: { multiplier?: number }
  supportedReasoningEfforts?: string[]
  defaultReasoningEffort?: string
  policy?: { state: string; terms?: string }
}

export interface CopilotModelCatalog {
  models: PublicCopilotModel[]
  autoTiers: AutoTierChoice[]
  /** `auto-only`: hesap yalnızca Otomatik seçeneğini sunuyor. */
  scope: 'auto-only' | 'named'
  message?: string
}

/** Uygulamanın Copilot ile ilgili tüm ihtiyaçları; testlerde sahte uygulama verilebilir. */
export interface CopilotService {
  start(): Promise<boolean>
  stop(): Promise<void>
  getHealth(): Promise<CopilotHealth>
  ensureReady(): Promise<void>
  run(input: RunRequest, signal?: AbortSignal): Promise<ExecutionRecord>
  getModelCatalog(): Promise<CopilotModelCatalog>
  getQuota(): Promise<Record<string, unknown>>
}

interface ConnectionLike {
  start(): Promise<boolean>
  stop(): Promise<void>
  getHealth(): Promise<CopilotHealth>
  ensureReady(): Promise<void>
}

const nanoAiuPerAiCredit = 1_000_000_000
const fleetUnsupportedMessage = 'Bu SDK/CLI sürümünde Fleet modu kullanılamıyor.'
export const autoOnlyCatalogMessage =
  'Bu Copilot hesabının model kataloğu yalnızca Otomatik (auto) seçeneğini sunuyor. Modeli Copilot çalışma zamanında kendisi seçer; gerçekte kullanılan model sonuçta gösterilir.'

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

/** Bilinen değerlerin toplamı; hiçbiri bildirilmediyse `undefined` (sıfır değil). */
export function sumKnown(values: Array<number | undefined>): number | undefined {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return known.length ? known.reduce((total, value) => total + value, 0) : undefined
}

/**
 * Her Copilot oturumuna uygulanan güvenlik ayarları: boş geçici çalışma dizini,
 * yalnızca oturum içi yerleşik araçlar ve izin isteklerinin varsayılan reddi.
 */
export function safeSessionConfig(workspace: string, config: SessionConfig): SessionConfig {
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

function isUnsupportedRpcError(error: unknown) {
  if (!(error instanceof Error)) return false
  return /unsupported|not supported|method not found|unknown method/i.test(error.message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type ActivityEvent = ExecutionRecord['events'][number]
type ModelCall = ExecutionRecord['usage']['calls'][number]
type ContextUsage = NonNullable<ExecutionRecord['usage']['context']>

export function createCopilotService({
  client,
  connection,
  requestTimeoutMs,
  skillDirectory,
}: {
  client: CopilotClient
  connection: ConnectionLike
  requestTimeoutMs: number
  skillDirectory: string
}): CopilotService {
  type AccountModel = Awaited<ReturnType<typeof client.rpc.models.list>>['models'][number]

  async function getAccountModels(): Promise<Array<ModelInfo | AccountModel>> {
    try {
      return (await client.rpc.models.list({})).models
    } catch (error) {
      console.error('Hesap model kataloğu alınamadı; SDK model listesi kullanılacak:', error instanceof Error ? error.message : error)
      return client.listModels()
    }
  }

  function toPublicModel(model: ModelInfo | AccountModel): PublicCopilotModel {
    return {
      id: model.id,
      name: model.name,
      capabilities: model.capabilities,
      ...(model.billing ? { billing: { multiplier: model.billing.multiplier } } : {}),
      ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}),
      ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      ...(model.policy ? { policy: model.policy } : {}),
    }
  }

  async function getModelCatalog(): Promise<CopilotModelCatalog> {
    await connection.ensureReady()
    let sessionModelIds: Set<string> | undefined
    let autoTiers: AutoTierChoice[] = []
    const workspace = await createSessionWorkspace()
    let session: Awaited<ReturnType<typeof client.createSession>> | undefined
    try {
      // Yalnızca katalog okunur; oturuma mesaj gönderilmez.
      session = await client.createSession(safeSessionConfig(workspace, { model: 'auto' }))
      const sessionCatalog = await session.rpc.model.list()
      sessionModelIds = new Set(
        sessionCatalog.list.flatMap((item) =>
          isRecord(item) && typeof item.id === 'string' ? [item.id] : [],
        ),
      )
      autoTiers = getSelectableAutoTiers(sessionCatalog.auto)
    } catch (error) {
      console.error('Oturum model kataloğu alınamadı:', error instanceof Error ? error.message : error)
    } finally {
      if (session) await closeCopilotSession(client, session)
      await cleanupWorkspace(workspace)
    }

    const models = filterSelectableModels(await getAccountModels(), sessionModelIds).map(toPublicModel)
    const named = models.some((model) => model.id !== 'auto')
    return {
      models,
      autoTiers,
      scope: named ? 'named' : 'auto-only',
      ...(named ? {} : { message: autoOnlyCatalogMessage }),
    }
  }

  async function getQuota() {
    await connection.ensureReady()
    const result = await client.rpc.account.getQuota({})
    return result.quotaSnapshots as Record<string, unknown>
  }

  async function run(input: RunRequest, signal?: AbortSignal): Promise<ExecutionRecord> {
    await connection.ensureReady()
    if (input.model !== 'auto') {
      const models = await getAccountModels()
      if (!models.some((model) => model.id === input.model)) {
        throw new CopilotRunError('UNSUPPORTED_MODEL', 'Seçilen model bu Copilot hesabında kullanılamıyor.')
      }
    }

    const customAgents = input.strategy === 'subagents' ? analysisAgents : undefined
    const workspace = await createSessionWorkspace()
    const session = await client.createSession(safeSessionConfig(workspace, {
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
      timeoutMs: requestTimeoutMs,
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
        events.push({ id: event.id, type: 'model', label: `${data.model} · model çağrısı`, timestamp: event.timestamp })
      } else if (event.type === 'session.usage_info') {
        context = {
          currentTokens: event.data.currentTokens,
          tokenLimit: event.data.tokenLimit,
          conversationTokens: event.data.conversationTokens,
          systemTokens: event.data.systemTokens,
          percentage: event.data.tokenLimit > 0
            ? (event.data.currentTokens / event.data.tokenLimit) * 100
            : undefined,
        }
      } else if (event.type === 'tool.execution_start') {
        activeTools.set(event.data.toolCallId, event.data.toolName)
        events.push({ id: event.id, type: 'tool-start', label: `Araç başladı: ${event.data.toolName}`, timestamp: event.timestamp })
      } else if (event.type === 'tool.execution_complete') {
        events.push({
          id: event.id,
          type: 'tool-complete',
          label: `Araç ${event.data.success ? 'tamamlandı' : 'başarısız'}: ${activeTools.get(event.data.toolCallId) ?? event.data.toolCallId}`,
          timestamp: event.timestamp,
        })
        activeTools.delete(event.data.toolCallId)
      } else if (event.type === 'skill.invoked') {
        events.push({ id: event.id, type: 'skill', label: `Skill çağrıldı: ${event.data.name}`, timestamp: event.timestamp })
      } else if (event.type === 'subagent.started') {
        events.push({
          id: event.id,
          type: 'subagent',
          label: `Alt ajan başladı: ${event.data.agentDisplayName}`,
          timestamp: event.timestamp,
          details: { name: event.data.agentName, model: event.data.model },
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
      } else if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
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
      } else if (event.type === 'hook.start' || event.type === 'hook.end' || event.type === 'hook.progress') {
        const phase = event.type === 'hook.start' ? 'başladı' : event.type === 'hook.end' ? 'bitti' : 'ilerliyor'
        events.push({ id: event.id, type: 'hook', label: `Hook (kanca) ${phase}`, timestamp: event.timestamp })
      } else if (event.type === 'session.model_change') {
        modelInUse = event.data.newModel
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
          console.error('Oturum AI Credit sınırı güvenli biçimde yanıtlanamadı:', error instanceof Error ? error.message : error)
        })
      } else if (event.type === 'session_limits_exhausted.completed') {
        const action = event.data.response.action === 'cancel' ? 'çalıştırma durduruldu' : event.data.response.action
        events.push({ id: event.id, type: 'limit', label: `AI Credit sınırı yanıtı: ${action}`, timestamp: event.timestamp })
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
            result = await runWithDeadline(() => session.rpc.fleet.start({ prompt: input.prompt, wait: true }), deadline)
          } catch (error) {
            if (isUnsupportedRpcError(error)) {
              throw new CopilotRunError('UNSUPPORTED_FEATURE', fleetUnsupportedMessage)
            }
            throw error
          }
          if (!result.started) throw new CopilotRunError('UNSUPPORTED_FEATURE', fleetUnsupportedMessage)
        } else {
          const prompt =
            input.strategy === 'skill'
              ? `Uygunsa code-review skill'ini kullan. Skill kullanılamıyorsa bunu açıkça belirt.\n\nGörev:\n${input.prompt}`
              : input.strategy === 'subagents'
                ? `Kayıtlı uzman ajanlardan görev için yararlı olanlara delegasyon yapmayı dene. Runtime delegasyonu desteklemiyorsa bunu belirt; hiçbir dosyayı değiştirme ve komut çalıştırma.\n\nGörev:\n${input.prompt}`
                : input.prompt
          // SDK'nın kendi bekleme süresi, iptal edebilen runWithDeadline sınırından biraz uzun tutulur.
          const result = await runWithDeadline(
            () => session.sendAndWait({ prompt }, requestTimeoutMs + 5_000),
            deadline,
          )
          if (result) assistantResponse = result.data.content
        }
      } catch (error) {
        if (limitReached) throw new CopilotRunError('SESSION_LIMIT_REACHED')
        throw error
      }

      let metrics: Awaited<ReturnType<typeof session.rpc.usage.getMetrics>> | undefined
      try {
        metrics = await session.rpc.usage.getMetrics()
      } catch {
        metrics = undefined
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
      // Model kırılımı varsa onu, yoksa tek tek usage olaylarını kullan; ikisi de yoksa bilinmiyor.
      const fromMetricsOrCalls = (
        pickMetric: (item: (typeof modelMetrics)[number]) => number | undefined,
        pickCall: (item: ModelCall) => number | undefined,
      ) => (modelMetrics.length ? sumKnown(modelMetrics.map(pickMetric)) : sumKnown(calls.map(pickCall)))
      const nanoAiu = metrics?.totalNanoAiu ?? sumKnown(modelMetrics.map((item) => item.nanoAiu))
      const modelCalls = metrics
        ? sumKnown(Object.values(metrics.modelMetrics).map((item) => item?.requests.count))
        : (calls.length || undefined)

      const usage: ExecutionRecord['usage'] = {
        status: metrics ? 'available' : 'unavailable',
        inputTokens: fromMetricsOrCalls((item) => item.inputTokens, (item) => item.inputTokens),
        outputTokens: fromMetricsOrCalls((item) => item.outputTokens, (item) => item.outputTokens),
        cacheReadTokens: fromMetricsOrCalls((item) => item.cacheReadTokens, (item) => item.cacheReadTokens),
        reasoningTokens: fromMetricsOrCalls((item) => item.reasoningTokens, (item) => item.reasoningTokens),
        aiCredits: nanoAiu === undefined ? undefined : nanoAiu / nanoAiuPerAiCredit,
        nanoAiu,
        modelCalls,
        durationMs: Date.now() - startedAt,
        context,
        modelMetrics,
        calls,
        toolCalls: events.filter((item) => item.type === 'tool-complete').length,
        subagentCalls: events.filter((item) => item.type === 'subagent' && item.label.includes('başladı')).length,
        skillsInvoked: events
          .filter((item) => item.type === 'skill')
          .map((item) => item.label.replace('Skill çağrıldı: ', '')),
        legacyPremiumRequestCost: metrics?.totalPremiumRequestCost,
        aiCreditsStatus: metrics?.aiCreditsStatus,
        maxAiCreditLimit: input.maxAiCreditLimit,
        limitUsagePercentage:
          input.maxAiCreditLimit !== undefined && nanoAiu !== undefined
            ? (nanoAiu / nanoAiuPerAiCredit / input.maxAiCreditLimit) * 100
            : undefined,
      }

      return {
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
    } catch (error) {
      throw toCopilotRunError(error, upstreamError)
    } finally {
      // Temizlik hiçbir zaman hata fırlatmaz; asıl hata korunur.
      await closeCopilotSession(client, session)
      await cleanupWorkspace(workspace)
    }
  }

  return {
    start: () => connection.start(),
    stop: () => connection.stop(),
    getHealth: () => connection.getHealth(),
    ensureReady: () => connection.ensureReady(),
    run,
    getModelCatalog,
    getQuota,
  }
}
