import { randomUUID } from 'node:crypto'
import type { CopilotHealth } from '../services/copilot-runtime.js'
import type { CopilotModelCatalog, CopilotService, RunRequest } from '../services/copilot-runner.js'
import type { ExecutionRecord } from '../services/usage-history.js'
import type { RunClaudeOptions } from '../services/claude.js'

/**
 * Vercel gibi genel erişimli demo dağıtımları için sahte sağlayıcılar.
 * Gerçek Copilot/Claude çağrısı yapmaz, hesap/anahtar gerektirmez; yalnızca
 * görsel vitrin amaçlıdır. `server/app.ts` zaten `copilot`/`claudeQueryFn`
 * bağımlılıklarını enjekte edilebilir tutuyor (bkz. tests/api.test.ts).
 */

const demoModels = [
  { id: 'gpt-5.1', name: 'GPT-5.1' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (Copilot üzerinden)' },
  { id: 'gpt-5.1-mini', name: 'GPT-5.1 mini' },
]

function demoCopilotUsage(strategy: RunRequest['strategy']) {
  const base = { input: 180, output: 420, tool: 0, turns: 1 }
  if (strategy === 'skill') Object.assign(base, { tool: 1, turns: 2, output: 520 })
  if (strategy === 'subagents') Object.assign(base, { tool: 2, turns: 3, output: 780 })
  if (strategy === 'fleet') Object.assign(base, { tool: 4, turns: 5, output: 1240 })
  return base
}

function demoCopilotExecution(input: RunRequest): ExecutionRecord {
  const usage = demoCopilotUsage(input.strategy)
  const nanoAiu = Math.round((usage.input * 0.5 + usage.output * 1.5) * 1_000_000)
  return {
    id: randomUUID(),
    label: input.prompt.slice(0, 80),
    strategy: input.strategy,
    createdAt: new Date().toISOString(),
    comparisonId: input.comparisonId,
    response: `[Demo] Copilot bu görevi "${input.strategy}" yöntemiyle tamamladı. Bu, gerçek bir model yanıtı değil; örnek bir vitrin çıktısıdır.`,
    requestedModel: input.model,
    model: input.model === 'auto' ? demoModels[0].id : input.model,
    usage: {
      status: 'available',
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: 0,
      aiCredits: nanoAiu / 1_000_000_000,
      nanoAiu,
      modelCalls: usage.turns,
      durationMs: 600 + usage.turns * 350,
      modelMetrics: [
        {
          id: input.model === 'auto' ? demoModels[0].id : input.model,
          requests: usage.turns,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      calls: [],
      toolCalls: usage.tool,
      subagentCalls: input.strategy === 'subagents' ? 2 : 0,
      skillsInvoked: input.strategy === 'skill' ? ['demo-skill'] : [],
    },
    events: [
      {
        id: randomUUID(),
        type: 'runtime',
        label: 'Demo modu: sahte Copilot çalıştırması (gerçek hesap kullanılmadı)',
        timestamp: new Date().toISOString(),
      },
    ],
  }
}

export function createFakeCopilotService(): CopilotService {
  const health: CopilotHealth = {
    state: 'ready',
    message: 'Demo modu: sahte Copilot sağlayıcısı (gerçek hesap kullanılmıyor)',
    authenticated: true,
    cliVersion: 'demo',
  }
  return {
    start: async () => true,
    stop: async () => undefined,
    getHealth: async () => health,
    ensureReady: async () => undefined,
    run: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      return demoCopilotExecution(input)
    },
    getModelCatalog: async (): Promise<CopilotModelCatalog> => ({
      models: demoModels.map((model) => ({ id: model.id, name: model.name })),
      autoTiers: [],
      scope: 'named',
      message: 'Demo modu: bu katalog örnek verilerdir, gerçek hesap kataloğu değildir.',
    }),
    getQuota: async () => ({
      demo: true,
      message: 'Demo modu: gerçek kota bilgisi gösterilmiyor.',
    }),
  }
}

const demoClaudeModels = [
  { value: 'default', displayName: 'Varsayılan', description: 'SDK varsayılan modeli', resolvedModel: 'claude-opus-5-5' },
  { value: 'haiku', displayName: 'Haiku', description: 'Hızlı ve düşük maliyetli', resolvedModel: 'claude-haiku-5-5' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Dengeli', resolvedModel: 'claude-sonnet-5-5' },
  { value: 'opus', displayName: 'Opus', description: 'En yetenekli', resolvedModel: 'claude-opus-5-5' },
]

type ClaudeQueryFn = NonNullable<RunClaudeOptions['queryFn']>

/** `sk-ant-api…` biçiminde ama gerçek olmayan bir demo anahtarı; hiçbir API çağrısı yapılmaz. */
export const demoAnthropicApiKey = 'sk-ant-api03-demo000000000000000000000000000000000000000000'

export function createFakeClaudeQueryFn(): ClaudeQueryFn {
  const queryFn: ClaudeQueryFn = (params) => {
    const promptText = typeof params.prompt === 'string' ? params.prompt : ''
    const model = params.options?.model ?? 'claude-sonnet-5-5'
    async function* messages() {
      yield {
        type: 'system',
        subtype: 'init',
        apiKeySource: 'ANTHROPIC_API_KEY',
        model,
        claude_code_version: 'demo',
      }
      if (!promptText) return
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: `demo-${randomUUID()}`,
          content: [
            {
              type: 'text',
              text: `[Demo] Claude bu görevi tamamladı. Bu, gerçek bir model yanıtı değil; örnek bir vitrin çıktısıdır. (İstem: "${promptText.slice(0, 60)}")`,
            },
          ],
        },
      }
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        duration_ms: 700,
        total_cost_usd: 0.0021,
        stop_reason: 'end_turn',
        result: 'demo',
        usage: {},
        modelUsage: {
          [model]: {
            inputTokens: 210,
            outputTokens: 340,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.0021,
            costBasis: 'list',
          },
        },
      }
    }
    return Object.assign(messages(), {
      supportedModels: async () => demoClaudeModels,
      close: () => undefined,
    }) as ReturnType<ClaudeQueryFn>
  }
  return queryFn
}
