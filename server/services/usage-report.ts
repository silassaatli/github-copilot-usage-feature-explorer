import type { ProviderHistoryRecord, ProviderId } from './usage-history.js'

/** `reported`: bu metriği gerçekten bildiren çalıştırma sayısı. */
export interface MetricAggregate {
  total: number
  reported: number
}

export interface ProviderReport {
  provider: ProviderId
  runs: number
  successes: number
  failures: number
  durationMs: MetricAggregate
  inputTokens: MetricAggregate
  outputTokens: MetricAggregate
  modelCalls: MetricAggregate
  numTurns: MetricAggregate
  /** Copilot SDK'nın ölçtüğü AI Credit tüketimi (para birimi değildir). */
  aiCredits: MetricAggregate
  /** Claude Agent SDK'nın USD tahmini (fatura değildir). */
  estimatedCostUsd: MetricAggregate
  models: Array<{ model: string; runs: number }>
  errorCodes: Array<{ code: string; count: number }>
}

export interface UsageObservation {
  level: 'info' | 'warning'
  text: string
}

export interface UsageReport {
  generatedAt: string
  totalRuns: number
  firstRunAt?: string
  lastRunAt?: string
  providers: ProviderReport[]
  observations: UsageObservation[]
}

const providerNames: Record<ProviderId, string> = {
  'github-copilot': 'GitHub Copilot',
  claude: 'Claude',
}

function emptyAggregate(): MetricAggregate {
  return { total: 0, reported: 0 }
}

function add(aggregate: MetricAggregate, value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  aggregate.total += value
  aggregate.reported += 1
}

function metricsOf(record: ProviderHistoryRecord) {
  const usage = record.usage
  const metrics = record.metrics
  return {
    durationMs: usage?.durationMs ?? metrics?.durationMs,
    inputTokens: usage ? usage.inputTokens : metrics?.inputTokens,
    outputTokens: usage ? usage.outputTokens : metrics?.outputTokens,
    modelCalls: usage ? usage.modelCalls : metrics?.modelCalls,
    numTurns: metrics?.numTurns,
    aiCredits: usage
      ? usage.aiCredits
      : metrics?.providerCostUnit === 'AI Credit' ? metrics.providerCost : undefined,
    estimatedCostUsd: metrics?.providerCostUnit === 'USD' ? metrics.providerCost : undefined,
  }
}

function countBy(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
}

/**
 * Kayıtlı çalıştırmalardan rapor üretir. Yalnızca toplanmış veriler kullanılır;
 * bildirilmeyen metrikler toplama sıfır olarak eklenmez.
 */
export function summarizeHistory(records: ProviderHistoryRecord[], now = new Date()): UsageReport {
  const providers: ProviderReport[] = []
  for (const provider of ['github-copilot', 'claude'] as ProviderId[]) {
    const items = records.filter((item) => item.provider === provider)
    if (!items.length) continue
    const report: ProviderReport = {
      provider,
      runs: items.length,
      successes: items.filter((item) => !item.error).length,
      failures: items.filter((item) => item.error).length,
      durationMs: emptyAggregate(),
      inputTokens: emptyAggregate(),
      outputTokens: emptyAggregate(),
      modelCalls: emptyAggregate(),
      numTurns: emptyAggregate(),
      aiCredits: emptyAggregate(),
      estimatedCostUsd: emptyAggregate(),
      models: [],
      errorCodes: [],
    }
    for (const item of items) {
      if (item.error) continue
      const metrics = metricsOf(item)
      add(report.durationMs, metrics.durationMs)
      add(report.inputTokens, metrics.inputTokens)
      add(report.outputTokens, metrics.outputTokens)
      add(report.modelCalls, metrics.modelCalls)
      add(report.numTurns, metrics.numTurns)
      add(report.aiCredits, metrics.aiCredits)
      add(report.estimatedCostUsd, metrics.estimatedCostUsd)
    }
    report.models = countBy(
      items.flatMap((item) => {
        const model = item.actualModel ?? item.model
        return !item.error && model && model !== 'SDK tarafından bildirilmedi' ? [model] : []
      }),
    ).map(([model, runs]) => ({ model, runs }))
    report.errorCodes = countBy(items.flatMap((item) => (item.error ? [item.errorCode ?? 'BILINMIYOR'] : [])))
      .map(([code, count]) => ({ code, count }))
    providers.push(report)
  }

  const dates = records.map((item) => item.createdAt).sort()
  return {
    generatedAt: now.toISOString(),
    totalRuns: records.length,
    ...(dates.length ? { firstRunAt: dates[0], lastRunAt: dates[dates.length - 1] } : {}),
    providers,
    observations: buildObservations(providers),
  }
}

function buildObservations(providers: ProviderReport[]): UsageObservation[] {
  if (!providers.length) {
    return [{
      level: 'info',
      text: 'Henüz kayıtlı çalıştırma yok. Oyun Alanı veya Karşılaştırma Laboratuvarı’nda bir çalıştırma yaptığınızda rapor gerçek ölçümlerle dolar.',
    }]
  }
  const observations: UsageObservation[] = []
  for (const report of providers) {
    const name = providerNames[report.provider]
    if (report.failures) {
      const top = report.errorCodes[0]
      observations.push({
        level: 'warning',
        text: `${name}: ${report.runs} çalıştırmanın ${report.failures} tanesi başarısız oldu${top ? `; en sık hata kodu ${top.code} (${top.count})` : ''}.`,
      })
    }
    if (report.successes && report.inputTokens.reported < report.successes) {
      observations.push({
        level: 'info',
        text: `${name}: ${report.successes} başarılı çalıştırmanın ${report.successes - report.inputTokens.reported} tanesinde token bilgisi sağlayıcı tarafından bildirilmedi; bu çalıştırmalar token toplamına dahil edilmedi.`,
      })
    }
    if (report.provider === 'github-copilot' && report.successes && report.aiCredits.reported < report.successes) {
      observations.push({
        level: 'info',
        text: `GitHub Copilot: ${report.successes - report.aiCredits.reported} başarılı çalıştırmada AI Credit ölçümü yoktu.`,
      })
    }
    if (report.provider === 'claude' && report.estimatedCostUsd.reported) {
      observations.push({
        level: 'info',
        text: 'Claude maliyetleri Agent SDK’nın USD tahminidir, fatura değildir. Gerçek tutar için Anthropic Console > Usage sayfasına bakın.',
      })
    }
  }
  return observations
}
