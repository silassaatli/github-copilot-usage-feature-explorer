import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import './App.css'

type SectionId =
  | 'playground'
  | 'usage'
  | 'advisor'
  | 'comparison'
  | 'licensing'
  | 'features'

type Strategy = 'normal' | 'skill' | 'subagents' | 'fleet'

interface Execution {
  id: string
  label: string
  strategy: Strategy
  createdAt: string
  response?: string
  requestedModel: string
  requestedAutoTier?: string
  model: string
  usage: {
    status: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    reasoningTokens: number
    aiCredits?: number
    nanoAiu?: number
    modelCalls: number
    durationMs: number
    context?: {
      currentTokens: number
      tokenLimit: number
      percentage?: number
    }
    modelMetrics: Array<{
      id: string
      requests: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      reasoningTokens?: number
      nanoAiu?: number
    }>
    calls: Array<Record<string, unknown>>
    toolCalls: number
    subagentCalls: number
    skillsInvoked: string[]
    legacyPremiumRequestCost?: number
    aiCreditsStatus?: 'complete' | 'partial' | 'unavailable'
    maxAiCreditLimit?: number
    limitUsagePercentage?: number
  }
  events?: Array<{
    id: string
    type: string
    label: string
    timestamp: string
    details?: Record<string, string | number | undefined>
  }>
}

type ProviderId = 'github-copilot' | 'claude'
const claudeStatusStates = [
  'missing_key',
  'invalid_key_format',
  'sdk_unavailable',
  'unverified',
  'verified',
  'auth_failed',
  'error',
] as const
type ClaudeStatusState = 'checking' | (typeof claudeStatusStates)[number]

interface ClaudeStatus {
  state: ClaudeStatusState
  configured: boolean
  verified: boolean
  runnable: boolean
  message: string
  setupHint?: string
  model?: string
  lastVerifiedAt?: string
}

interface ProviderExecution {
  id: string
  comparisonId: string
  provider: ProviderId
  runtime: string
  requestedModel?: string
  actualModel?: string
  response?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  durationMs?: number
  numTurns?: number
  modelCalls?: number
  toolCalls?: number
  providerCost?: number
  providerCostUnit?: 'AI Credit' | 'USD'
  providerCostSource?: string
  contextUtilization?: number
  skillsUsed?: string[]
  subagentsUsed?: number
  events: Array<{ type: string; label: string; timestamp?: string }>
  error?: string
  errorCode?: string
  setupHint?: string
}

interface ComparisonSummary {
  faster?: ProviderId | 'tie'
  fewerInputTokens?: ProviderId | 'tie'
  fewerOutputTokens?: ProviderId | 'tie'
  fewerTotalTokens?: ProviderId | 'tie'
  fewerModelCalls?: ProviderId | 'tie'
  fewerToolCalls?: ProviderId | 'tie'
  costs: Array<{ provider: ProviderId; amount: number; unit: 'AI Credit' | 'USD' }>
}

interface UsageHistoryRecord {
  id: string
  label: string
  strategy: string
  createdAt: string
  provider: ProviderId
  comparisonId: string
  requestedModel?: string
  actualModel?: string
  model?: string
  usage?: Execution['usage']
  metrics?: {
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    reasoningTokens?: number
    durationMs?: number
    modelCalls?: number
    toolCalls?: number
    providerCost?: number
    providerCostUnit?: 'AI Credit' | 'USD'
  }
  error?: string
  errorCode?: string
  events: Execution['events']
}

interface ComparisonRow {
  strategy: Strategy
  execution?: Execution
  error?: string
}

interface CopilotModelOption {
  id: string
  name: string
  policy?: { state?: string }
  billing?: { multiplier?: number }
}

interface ClaudeModelOption {
  value: string
  displayName: string
  description: string
  resolvedModel?: string
}

interface LicensePlan {
  id: string
  name: string
  accountType: 'individual' | 'organization'
  monthlySeatPriceUsd: number | null
  includedAiCreditsPerSeat: number
}

const sections: Array<{ id: SectionId; title: string; icon: string }> = [
  { id: 'playground', title: 'Oyun Alanı', icon: '✳' },
  { id: 'usage', title: 'Kullanım Analizi', icon: '◫' },
  { id: 'advisor', title: 'Mod Danışmanı', icon: '⌁' },
  { id: 'comparison', title: 'Karşılaştırma Laboratuvarı', icon: '⇄' },
  { id: 'licensing', title: 'Lisans ve Maliyet', icon: '◇' },
  { id: 'features', title: 'Özellik Rehberi', icon: '▤' },
]

const strategies: Array<{ id: Strategy; title: string; hint: string }> = [
  { id: 'normal', title: 'Normal oturum', hint: 'Standart Copilot sohbeti' },
  { id: 'skill', title: 'Skill kullan', hint: 'Yerel kod inceleme skill’i' },
  { id: 'subagents', title: 'Alt ajanlarla analiz', hint: 'Güvenli, salt okunur analiz ajanları' },
  { id: 'fleet', title: 'Fleet · deneysel', hint: 'Bağımsız işleri paralel koordine eder' },
]

const featureCards = [
  { title: 'Sohbet', what: 'Soru-cevap ve fikir alışverişi için doğrudan sohbet.', when: 'Açıklama, küçük kod soruları ve hızlı yönlendirme.', avoid: 'Dosya veya çok adımlı işlem gerektiğinde.', cost: 'Model çağrısı ve gerçek token kullanımına bağlıdır.' },
  { title: 'Ajan Modu', what: 'Görevi araç ve adımlarla yerine getiren çalışma biçimi.', when: 'Dosya inceleme/değiştirme, terminal veya test gerektiğinde.', avoid: 'Basit sorular ve tek cümlelik yanıtlar.', cost: 'Araç adımları oturum süresini ve token kullanımını artırabilir.' },
  { title: 'Skills', what: 'Tekrar kullanılabilir, konuya özgü yönerge ve iş akışları.', when: 'Aynı uzmanlık yönergeleri tekrar tekrar gerektiğinde.', avoid: 'Bir defalık, çok basit görevler.', cost: 'Skill içeriği bağlama eklenirse token tüketimini artırabilir.' },
  { title: 'Özel ajanlar / Alt ajanlar', what: 'Belirli görevlere ayrılmış uzman ajan tanımları.', when: 'İzole ve uzmanlaşmış bir inceleme yarar sağladığında.', avoid: 'Küçük veya sıkı bağımlı görevler.', cost: 'Ek model çağrıları ve token kullanımı oluşturabilir.' },
  { title: 'Fleet / Orkestrasyon', what: 'Birden çok bağımsız işi paralel koordine eden deneysel mod.', when: 'Büyük iş parçaları paralel ilerleyebildiğinde.', avoid: 'Sıralı, küçük veya birbirine sıkı bağlı görevler.', cost: 'Ek ajan/model çalıştırmaları AI Credit kullanımını artırabilir.' },
  { title: 'MCP', what: 'Copilot oturumunu harici servis ve araçlara bağlayan protokol.', when: 'GitHub, Jira veya başka bir servis verisi gerektiğinde.', avoid: 'Harici veri veya araç gerekmiyorsa.', cost: 'Araç cevapları bağlama girebilir; ek token kullanımı olabilir.' },
  { title: 'Hooks', what: 'Oturum yaşam döngüsünde tetiklenen kancalar.', when: 'Tekrarlanabilir kontrol, kayıt veya politika gerekiyorsa.', avoid: 'Tek seferlik manuel işler.', cost: 'Hook çağrısı tek başına fiyat değildir; ek model işini tetikleyebilir.' },
  { title: 'Oturum sınırları', what: 'SDK destekliyorsa oturum AI Credit kullanımına üst sınır koyar.', when: 'Deney ve demo bütçesini sınırlamak istediğinizde.', avoid: 'Sınırın iş akışını kesebileceği üretim işlerinde yapılandırmadan.', cost: 'SDK sınırı kullanılır; burada sahte bir sayaç uygulanmaz.' },
  { title: 'Model seçimi', what: 'Kullanılabilir modeller arasından oturum modelini seçer.', when: 'Görev ve hız/kapasite ihtiyacına göre model seçerken.', avoid: 'Hesapta görünmeyen veya politika tarafından engellenmiş modeller.', cost: 'Gerçek fiyat bilgisi SDK model kataloğundan gösterilir.' },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatModelLabel(model: string | undefined) {
  if (!model) return '—'
  return model === 'auto' ? 'Otomatik' : model
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const result = await fetch(url, init)
  let payload: unknown
  try {
    payload = await result.json()
  } catch {
    throw new Error('Sunucudan okunabilir bir yanıt alınamadı.')
  }
  if (!result.ok) {
    const error = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : 'İstek tamamlanamadı.'
    const code = isRecord(payload) && typeof payload.code === 'string' ? payload.code : undefined
    throw new Error(code ? `${error} (Hata kodu: ${code})` : error)
  }
  return payload
}

function formatNumber(value: number | undefined) {
  return value === undefined ? '—' : new Intl.NumberFormat('tr-TR').format(value)
}

function formatCredits(value: number | undefined) {
  return value === undefined
    ? 'SDK verisi yok'
    : new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 6 }).format(value)
}

function strategyLabel(strategy: string) {
  return strategies.find((item) => item.id === strategy)?.title ?? strategy
}

function providerLabel(provider: ProviderId) {
  return provider === 'github-copilot' ? 'GitHub Copilot' : 'Claude'
}

function providerValueLabel(value: ProviderId | 'tie' | undefined) {
  if (!value) return 'Karşılaştırılamıyor'
  if (value === 'tie') return 'Eşit'
  return providerLabel(value)
}

function metricValue(value: number | undefined) {
  return value === undefined ? 'Kullanılamıyor' : formatNumber(value)
}

function isCopilotHistory(record: UsageHistoryRecord): record is UsageHistoryRecord & {
  provider: 'github-copilot'
  usage: Execution['usage']
} {
  return record.provider === 'github-copilot' && record.usage !== undefined
}

function isComparisonSummary(value: unknown): value is ComparisonSummary {
  return isRecord(value) && Array.isArray(value.costs)
}

function eventDetailText(details: Record<string, string | number | undefined>) {
  const labels: Record<string, string> = {
    name: 'Ad',
    model: 'Model',
    durationMs: 'Süre (ms)',
    tokens: 'Token',
    toolCalls: 'Araç çağrısı',
    reasoningEffort: 'Akıl yürütme düzeyi',
    contextTier: 'Bağlam katmanı',
  }
  return Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${labels[key] ?? key}: ${value}`)
    .join(' · ')
}

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('playground')
  const [prompt, setPrompt] = useState('')
  const [strategy, setStrategy] = useState<Strategy>('normal')
  const [maxAiCreditLimit, setMaxAiCreditLimit] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [providerExecutions, setProviderExecutions] = useState<ProviderExecution[]>([])
  const [requestedProviders, setRequestedProviders] = useState<ProviderId[]>([])
  const [comparisonSummary, setComparisonSummary] = useState<ComparisonSummary>()
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus>({
    state: 'checking',
    configured: false,
    verified: false,
    runnable: false,
    message: 'Bağlantı durumu denetleniyor.',
  })
  const [copilotModels, setCopilotModels] = useState<CopilotModelOption[]>([])
  const [copilotAutoTiers, setCopilotAutoTiers] = useState<Array<{ id: string; label: string }>>([])
  const [copilotModel, setCopilotModel] = useState('auto')
  const [copilotAutoTier, setCopilotAutoTier] = useState('')
  const [copilotModelsNote, setCopilotModelsNote] = useState('')
  const [claudeModels, setClaudeModels] = useState<ClaudeModelOption[]>([])
  const [claudeModel, setClaudeModel] = useState('')
  const [claudeModelsNote, setClaudeModelsNote] = useState('')
  const [history, setHistory] = useState<UsageHistoryRecord[]>([])
  const [historyProvider, setHistoryProvider] = useState<'all' | ProviderId>('all')
  const [historyError, setHistoryError] = useState('')
  const [historyStorage, setHistoryStorage] = useState<'sqlite' | 'memory' | ''>('')
  const [quota, setQuota] = useState<Record<string, unknown>>()
  const [quotaStatus, setQuotaStatus] = useState('')
  const [advisorTask, setAdvisorTask] = useState('')
  const [advisorAnswers, setAdvisorAnswers] = useState<
    Record<string, boolean | string>
  >({})
  const [recommendation, setRecommendation] = useState<Record<string, unknown>>()
  const [comparisonTask, setComparisonTask] = useState('')
  const [comparisonStrategies, setComparisonStrategies] = useState<Strategy[]>(['normal', 'skill'])
  const [comparisonResults, setComparisonResults] = useState<ComparisonRow[]>([])
  const [licensePlan, setLicensePlan] = useState('business')
  const [seats, setSeats] = useState(10)
  const [expectedCredits, setExpectedCredits] = useState(100)
  const [runsPerMonth, setRunsPerMonth] = useState(20)
  const [includedCredits, setIncludedCredits] = useState('')
  const [enterpriseSeatPrice, setEnterpriseSeatPrice] = useState('')
  const [licensePlans, setLicensePlans] = useState<LicensePlan[]>([])
  const [licenseResult, setLicenseResult] = useState<Record<string, unknown>>()
  const [licenseError, setLicenseError] = useState('')

  useEffect(() => {
    void refreshClaudeStatus().then((status) => {
      if (status?.runnable) void loadClaudeModels()
    })
    void loadCopilotModels()
    void requestJson('/api/licensing/plans')
      .then((payload) => {
        if (isRecord(payload) && Array.isArray(payload.plans)) {
          const plans = payload.plans.filter(isRecord) as unknown as LicensePlan[]
          setLicensePlans(plans)
          const business = plans.find((item) => item.id === 'business')
          if (business) setIncludedCredits(String(business.includedAiCreditsPerSeat))
        }
      })
      .catch((caught) => {
        setLicenseError(caught instanceof Error ? caught.message : 'Plan bilgileri alınamadı.')
      })
    void refreshHistory()
  }, [])

  async function loadCopilotModels() {
    try {
      const payload = await requestJson('/api/copilot/models')
      if (!isRecord(payload) || !Array.isArray(payload.models)) throw new Error('Copilot model kataloğu alınamadı.')
      const models = payload.models.filter(
        (item): item is CopilotModelOption =>
          isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' && item.id !== 'auto',
      )
      setCopilotModels(models)
      setCopilotAutoTiers(Array.isArray(payload.autoTiers)
        ? payload.autoTiers.filter((item): item is { id: string; label: string } =>
            isRecord(item) && typeof item.id === 'string' && typeof item.label === 'string')
        : [])
      setCopilotModelsNote(typeof payload.message === 'string' ? payload.message : '')
    } catch (caught) {
      setCopilotModels([])
      setCopilotModelsNote(caught instanceof Error ? caught.message : 'Copilot model kataloğu alınamadı.')
    }
  }

  async function loadClaudeModels() {
    try {
      const payload = await requestJson('/api/claude/models')
      if (!isRecord(payload) || !Array.isArray(payload.models)) throw new Error('Claude model listesi alınamadı.')
      setClaudeModels(payload.models.filter(
        (item): item is ClaudeModelOption =>
          isRecord(item) && typeof item.value === 'string' && typeof item.displayName === 'string',
      ))
      setClaudeModelsNote('')
    } catch (caught) {
      setClaudeModels([])
      setClaudeModelsNote(caught instanceof Error ? caught.message : 'Claude model listesi alınamadı.')
    }
  }

  function copilotModelPayload() {
    return {
      model: copilotModel,
      ...(copilotModel === 'auto' && copilotAutoTier ? { autoTier: copilotAutoTier } : {}),
    }
  }

  async function refreshClaudeStatus(): Promise<ClaudeStatus | undefined> {
    try {
      const payload = await requestJson('/api/claude/status')
      if (
        !isRecord(payload) ||
        typeof payload.configured !== 'boolean' ||
        typeof payload.message !== 'string'
      ) {
        throw new Error('Claude bağlantı durumu alınamadı.')
      }
      const state = claudeStatusStates.find((item) => item === payload.state)
      if (!state) throw new Error('Claude bağlantı durumu alınamadı.')
      const next: ClaudeStatus = {
        state,
        configured: payload.configured,
        verified: payload.verified === true,
        runnable: payload.runnable === true,
        message: payload.message,
        ...(typeof payload.setupHint === 'string' ? { setupHint: payload.setupHint } : {}),
        ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
        ...(typeof payload.lastVerifiedAt === 'string' ? { lastVerifiedAt: payload.lastVerifiedAt } : {}),
      }
      setClaudeStatus(next)
      return next
    } catch {
      setClaudeStatus({
        state: 'sdk_unavailable',
        configured: false,
        verified: false,
        runnable: false,
        message: 'Claude SDK kullanılamıyor',
        setupHint: 'API sunucusunu ve Claude SDK kurulumunu kontrol edin.',
      })
    }
  }

  useEffect(() => {
    if (activeSection !== 'usage' || quota) return
    void requestJson('/api/copilot/quota')
      .then((payload) => {
        if (isRecord(payload)) {
          setQuota(payload)
          setQuotaStatus(typeof payload.message === 'string' ? payload.message : '')
        }
      })
      .catch((caught) => {
        setQuotaStatus(caught instanceof Error ? caught.message : 'Kota bilgisi alınamadı.')
      })
  }, [activeSection, quota])

  async function refreshHistory() {
    try {
      const payload = await requestJson('/api/usage/history')
      if (isRecord(payload) && Array.isArray(payload.executions)) {
        setHistory(payload.executions as UsageHistoryRecord[])
        setHistoryStorage(payload.storage === 'sqlite' || payload.storage === 'memory' ? payload.storage : '')
      }
    } catch {
      setHistoryError('Oturum geçmişi şu anda alınamıyor.')
    }
  }

  async function runExecution(task: string, selectedStrategy: Strategy) {
    const endpoint = selectedStrategy === 'fleet'
      ? '/api/copilot/fleet'
      : '/api/copilot/chat'
    const payload = await requestJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: task,
        ...copilotModelPayload(),
        strategy: selectedStrategy,
        ...(maxAiCreditLimit.trim()
          ? { maxAiCreditLimit: Number(maxAiCreditLimit) }
          : {}),
      }),
    })
    if (!isRecord(payload) || typeof payload.id !== 'string' || !isRecord(payload.usage)) {
      throw new Error('Çalıştırma yanıtı beklenen biçimde değil.')
    }
    return payload as unknown as Execution
  }

  async function runProviderComparison(providers: ProviderId[]) {
    if (!prompt.trim() || isLoading) return
    if (
      providers.length === 2 &&
      !window.confirm('Bu işlem aynı görevi iki sağlayıcıda da çalıştırır. Copilot tarafında AI Credit tüketilebilir; Claude tarafı Anthropic API hesabınızdan token başına ücretlendirilir. Devam etmek istiyor musunuz?')
    ) return

    setIsLoading(true)
    setError('')
    setRequestedProviders(providers)
    setProviderExecutions([])
    setComparisonSummary(undefined)
    try {
      const payload = await requestJson('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          providers,
          strategy,
          ...copilotModelPayload(),
          ...(claudeModel ? { claudeModel } : {}),
          ...(maxAiCreditLimit.trim()
            ? { maxAiCreditLimit: Number(maxAiCreditLimit) }
            : {}),
        }),
      })
      if (!isRecord(payload) || !Array.isArray(payload.executions)) {
        throw new Error('Sağlayıcı karşılaştırma yanıtı beklenen biçimde değil.')
      }
      setProviderExecutions(payload.executions as ProviderExecution[])
      if (payload.executions.length === 2 && isComparisonSummary(payload.summary)) {
        setComparisonSummary(payload.summary)
      }
      await refreshClaudeStatus()
      await refreshHistory()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sağlayıcı karşılaştırması başarısız oldu.')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleAdvisor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setRecommendation(undefined)
    setError('')
    try {
      const payload = await requestJson('/api/advisor/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: advisorTask, ...advisorAnswers }),
      })
      if (isRecord(payload)) setRecommendation(payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Öneri oluşturulamadı.')
    }
  }

  async function handleComparison(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!comparisonTask.trim() || !comparisonStrategies.length || isLoading) return
    if (
      comparisonStrategies.length > 1 &&
      !window.confirm('Her çalıştırma Copilot kullanımı ve AI Credit tüketebilir. Seçilen çalıştırmaları başlatmak istiyor musunuz?')
    ) return
    setIsLoading(true)
    setError('')
    setComparisonResults([])
    try {
      const completed: ComparisonRow[] = []
      for (const item of comparisonStrategies) {
        try {
          const result = await runExecution(comparisonTask.trim(), item)
          completed.push({ strategy: item, execution: result })
          await refreshHistory()
        } catch (caught) {
          completed.push({
            strategy: item,
            error: caught instanceof Error ? caught.message : 'Çalıştırma başarısız oldu.',
          })
        }
        setComparisonResults([...completed])
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Karşılaştırma çalıştırılamadı.')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleLicense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLicenseError('')
    try {
      const payload = await requestJson('/api/licensing/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: licensePlan,
          seats,
          expectedCreditsPerSeat: expectedCredits,
          ...(includedCredits.trim() ? { includedCreditsPerSeat: Number(includedCredits) } : {}),
          ...(enterpriseSeatPrice.trim()
            ? { enterpriseSeatPriceUsd: Number(enterpriseSeatPrice) }
            : {}),
        }),
      })
      if (isRecord(payload)) setLicenseResult(payload)
    } catch (caught) {
      setLicenseResult(undefined)
      setLicenseError(caught instanceof Error ? caught.message : 'Hesaplama yapılamadı.')
    }
  }

  function toggleStrategy(item: Strategy) {
    setComparisonStrategies((current) =>
      current.includes(item)
        ? current.filter((entry) => entry !== item)
        : [...current, item],
    )
  }

  function handlePlanChange(planId: string) {
    setLicensePlan(planId)
    const plan = licensePlans.find((item) => item.id === planId)
    if (plan) setIncludedCredits(String(plan.includedAiCreditsPerSeat))
  }

  function copilotModelLabel() {
    if (copilotModel !== 'auto') return copilotModels.find((item) => item.id === copilotModel)?.name ?? copilotModel
    const tier = copilotAutoTiers.find((item) => item.id === copilotAutoTier)
    return tier ? `Otomatik · ${tier.label}` : 'Otomatik'
  }

  function claudeModelLabel() {
    if (!claudeModel) return claudeStatus.model ?? 'SDK varsayılanı'
    return claudeModels.find((item) => item.value === claudeModel)?.displayName ?? claudeModel
  }

  function renderCopilotModelSelect() {
    return (
      <div className="field-grow">
        <label htmlFor="copilot-model">Copilot modeli</label>
        <select id="copilot-model" value={copilotModel} disabled={isLoading} onChange={(event) => setCopilotModel(event.target.value)}>
          <option value="auto">Otomatik (Copilot seçer)</option>
          {copilotModels.map((item) => (
            <option key={item.id} value={item.id} disabled={item.policy?.state === 'disabled'}>
              {item.name}
              {typeof item.billing?.multiplier === 'number' ? ` · ${formatNumber(item.billing.multiplier)}x` : ''}
              {item.policy?.state === 'disabled' ? ' · politika nedeniyle kapalı' : ''}
            </option>
          ))}
        </select>
        {copilotModel === 'auto' && copilotAutoTiers.length > 0 && (
          <>
            <label htmlFor="copilot-auto-tier">Otomatik yönlendirme profili</label>
            <select id="copilot-auto-tier" value={copilotAutoTier} disabled={isLoading} onChange={(event) => setCopilotAutoTier(event.target.value)}>
              <option value="">Varsayılan</option>
              {copilotAutoTiers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </>
        )}
        <p className="helper">
          {copilotModels.length
            ? 'Liste Copilot hesabınızın model kataloğundan gelir; çarpan, AI Credit tüketimini temel orana göre gösterir.'
            : copilotModelsNote || 'Adlandırılmış model listesi alınamadı; Otomatik kullanılır.'}
        </p>
      </div>
    )
  }

  function renderClaudeModelSelect() {
    return (
      <div className="field-grow">
        <label htmlFor="claude-model">Claude modeli</label>
        <select id="claude-model" value={claudeModel} disabled={isLoading || !claudeStatus.runnable} onChange={(event) => setClaudeModel(event.target.value)}>
          <option value="">{`Sunucu varsayılanı (${claudeStatus.model ?? 'SDK varsayılanı'})`}</option>
          {claudeModels.filter((item) => item.value !== 'default').map((item) => (
            <option key={item.value} value={item.value}>
              {item.displayName}{item.resolvedModel ? ` · ${item.resolvedModel}` : ''}
            </option>
          ))}
        </select>
        <p className="helper">
          {!claudeStatus.runnable
            ? 'Claude yapılandırıldığında modeller listelenir.'
            : claudeModelsNote || 'Liste kurulu Claude Agent SDK/CLI’den gelir. Model fiyatları farklıdır; çağrılar Anthropic API hesabınızdan ücretlendirilir.'}
        </p>
      </div>
    )
  }

  function renderPlayground() {
    return (
      <div className="page-stack">
        <section className="panel">
          <SectionHeading
            eyebrow="SAĞLAYICI / ÇALIŞMA ZAMANI KARŞILAŞTIRMASI"
            title="Copilot ve Claude Karşılaştırması"
            text="Aynı görevi iki farklı agent çalışma zamanında çalıştırın; kullanılan gerçek modeli, token tüketimini, süreyi ve sağlayıcıya özgü maliyet metriklerini karşılaştırın."
          />
          <details className="explanation-details">
            <summary>Bu ekranda ne karşılaştırılıyor?</summary>
            <div className="explanation-columns">
              <div>
                <strong>GitHub Copilot</strong>
                <ul>
                  <li>Bir AI geliştirme platformu ve agent çalışma zamanıdır.</li>
                  <li>Copilot SDK isteği yönetir; Auto modu gerçek modeli çalışma zamanında seçer.</li>
                  <li>Kullanım, GitHub AI Credit ve SDK metrikleriyle ölçülür.</li>
                </ul>
              </div>
              <div>
                <strong>Claude</strong>
                <ul>
                  <li>Anthropic Claude, Claude Agent SDK üzerinden doğrudan çalıştırılır.</li>
                  <li>GitHub Copilot katmanı kullanılmaz.</li>
                  <li>Kullanım token ve sağlayıcı API maliyetiyle ölçülür.</li>
                </ul>
              </div>
            </div>
          </details>
          <details className="explanation-details">
            <summary>Bu araç nasıl çalışıyor?</summary>
            <div className="execution-flow">
              <p><strong>Copilot:</strong> Görev <span>→</span> GitHub Copilot SDK <span>→</span> Auto yönlendirme <span>→</span> gerçek model <span>→</span> yanıt + AI Credit</p>
              <p><strong>Claude:</strong> Görev <span>→</span> Claude Agent SDK <span>→</span> Claude modeli <span>→</span> yanıt + token/API maliyeti</p>
            </div>
          </details>
          <form className="stack-form" onSubmit={(event) => event.preventDefault()}>
            <label htmlFor="prompt">Ortak görev</label>
            <textarea
              id="prompt"
              value={prompt}
              maxLength={12_000}
              rows={5}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="İki sağlayıcıya da gönderilecek görevi yazın…"
              required
              disabled={isLoading}
            />
            <div className="form-meta"><span>En fazla 12.000 karakter</span><span>{prompt.length} / 12.000</span></div>
            <div className="inline-fields">
              <div className="field-grow">
                <label htmlFor="strategy">Copilot çalıştırma yöntemi</label>
                <select id="strategy" value={strategy} onChange={(event) => setStrategy(event.target.value as Strategy)}>
                  {strategies.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select>
                <p className="helper">{strategies.find((item) => item.id === strategy)?.hint}</p>
              </div>
              <div className="limit-field">
                <label htmlFor="credit-limit">Copilot maksimum AI Credit limiti</label>
                <input
                  id="credit-limit"
                  type="number"
                  min="0.000001"
                  step="any"
                  value={maxAiCreditLimit}
                  onChange={(event) => setMaxAiCreditLimit(event.target.value)}
                  placeholder="İsteğe bağlı"
                />
              </div>
            </div>
            <div className="inline-fields">
              {renderCopilotModelSelect()}
              {renderClaudeModelSelect()}
            </div>
            {strategy === 'skill' && <InfoNote title="Copilot Skill">Yalnızca Copilot tarafında etkinleştirilir ve SDK'nın gerçek skill olaylarıyla ölçülür.</InfoNote>}
            {strategy === 'subagents' && <InfoNote title="Copilot alt ajanları">Yalnızca Copilot tarafında etkinleştirilir; gerçek SDK olayları raporlanır.</InfoNote>}
            {strategy === 'fleet' && <InfoNote title="Deneysel Copilot Fleet">Fleet yalnızca seçildiğinde çalıştırılır; runtime desteği yoksa hata gösterilir.</InfoNote>}
            <div className="provider-controls">
              <button type="button" className="secondary-button" disabled={isLoading || !prompt.trim()} onClick={() => void runProviderComparison(['github-copilot'])}>
                Yalnızca Copilot
              </button>
              <button type="button" className="secondary-button" disabled={isLoading || !prompt.trim()} onClick={() => void runProviderComparison(['claude'])}>
                Yalnızca Claude
              </button>
              <button type="button" className="primary-button" disabled={isLoading || !prompt.trim()} onClick={() => void runProviderComparison(['github-copilot', 'claude'])}>
                {isLoading ? 'Çalıştırmalar sürüyor…' : 'İkisini Karşılaştır'}
              </button>
            </div>
            <p className="helper">Copilot AI Credit ve Claude API maliyeti farklı faturalandırma birimleridir; doğrudan sayısal olarak karşılaştırılmaz. Claude Agent SDK dosya, terminal ve harici araç erişimi olmadan çalıştırılır.</p>
          </form>
          {error && <p className="error-box" role="alert">{error}</p>}
        </section>
        <section className="provider-results">
          <ProviderResultCard
            provider="github-copilot"
            execution={providerExecutions.find((item) => item.provider === 'github-copilot')}
            isLoading={isLoading && requestedProviders.includes('github-copilot')}
            claudeStatus={claudeStatus}
            selectedModelLabel={copilotModelLabel()}
          />
          <ProviderResultCard
            provider="claude"
            execution={providerExecutions.find((item) => item.provider === 'claude')}
            isLoading={isLoading && requestedProviders.includes('claude')}
            claudeStatus={claudeStatus}
            selectedModelLabel={claudeModelLabel()}
          />
        </section>
        {comparisonSummary &&
          providerExecutions.length === 2 &&
          providerExecutions.every((item) => !item.error) &&
          <ComparisonSummaryCard summary={comparisonSummary} />}
      </div>
    )
  }

  function renderUsage() {
    const filteredHistory = historyProvider === 'all'
      ? history
      : history.filter((item) => item.provider === historyProvider)
    const recent = history.filter(isCopilotHistory)[0]
    const quotaEntries = isRecord(quota?.quotas) ? Object.entries(quota.quotas) : []
    return (
      <div className="page-stack">
        <section className="panel">
          <SectionHeading eyebrow="SDK OTURUM VERİSİ" title="Kullanım analizi" text="Son yerel oturumların gerçek SDK ölçümleri. Tam istek ve yanıt tutulmaz; en fazla 80 karakterlik görev etiketi saklanır." />
          {historyError && <p className="helper warning">{historyError}</p>}
          {recent ? (
            <>
              <div className="metric-grid">
                <Metric label="İstenen model" value={formatModelLabel(recent.requestedModel)} />
                <Metric label="Gerçekleşen model" value={recent.model ?? 'Kullanılamıyor'} />
                <Metric label="Model çağrısı" value={formatNumber(recent.usage.modelCalls)} />
                <Metric label="Girdi token" value={formatNumber(recent.usage.inputTokens)} />
                <Metric label="Çıktı token" value={formatNumber(recent.usage.outputTokens)} />
                <Metric label="Toplam token" value={formatNumber(recent.usage.inputTokens + recent.usage.outputTokens)} />
                <Metric label="AI Credit" value={formatCredits(recent.usage.aiCredits)} note="nano-AIU / 10⁹" />
                <Metric label="Süre" value={`${(recent.usage.durationMs / 1000).toFixed(2)} sn`} />
                <Metric label="Araç çağrısı" value={formatNumber(recent.usage.toolCalls)} />
              </div>
              <div className="split-panels">
                <div className="subpanel">
                  <h3>Model kırılımı</h3>
                  {recent.usage.modelMetrics.length ? recent.usage.modelMetrics.map((model) => (
                    <div className="breakdown-row" key={model.id}>
                      <span>{model.id}</span><span>{formatNumber(model.inputTokens + model.outputTokens)} token</span>
                      <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.min(100, (model.inputTokens + model.outputTokens) / Math.max(1, recent.usage.inputTokens + recent.usage.outputTokens) * 100)}%` }} /></div>
                    </div>
                  )) : <p className="helper">Bu oturum için SDK model kırılımı sağlamadı.</p>}
                </div>
                <div className="subpanel">
                  <h3>Bağlam penceresi</h3>
                  {recent.usage.context ? (
                    <>
                      <div className="context-meter"><div style={{ width: `${Math.min(100, recent.usage.context.percentage ?? 0)}%` }} /></div>
                      <p>{formatNumber(recent.usage.context.currentTokens)} / {formatNumber(recent.usage.context.tokenLimit)} token</p>
                    </>
                  ) : <p className="helper">SDK bu oturumda bağlam kullanım olayı bildirmedi.</p>}
                </div>
              </div>
              <div className="subpanel timeline">
                <h3>Ajan ve araç etkinliği</h3>
                {recent.events?.length ? recent.events.map((event) => (
                  <div className="timeline-row" key={event.id}><span className="timeline-dot" /><span>{event.label}{event.details && <small className="event-details">{eventDetailText(event.details)}</small>}</span><time>{new Date(event.timestamp).toLocaleTimeString('tr-TR')}</time></div>
                )) : <p className="helper">SDK etkinlik kaydı bildirmedi.</p>}
              </div>
            </>
          ) : <EmptyState title="Kullanım geçmişi boş" text="Playground'da bir istek çalıştırdığınızda gerçek SDK ölçümleri burada listelenir." />}
        </section>
        <section className="panel">
          <SectionHeading eyebrow="HESAP DURUMU" title="Copilot kotası" text="Kota bilgisi deneysel SDK hesap RPC'sinden istenir. Bu alan premium request konseptini AI Credit ile karıştırmaz." />
          {quotaStatus && <p className="helper">{quotaStatus}</p>}
          {quotaEntries.length ? <div className="metric-grid">
            {quotaEntries.map(([name, value]) => {
              const item = isRecord(value) ? value : {}
              const remaining = typeof item.remainingPercentage === 'number' ? item.remainingPercentage : undefined
                const label = name === 'premium_interactions'
                  ? 'Eski premium request kotası · uyumluluk'
                  : name.replaceAll('_', ' ')
                const usageNote =
                  typeof item.usedRequests === 'number' &&
                  typeof item.entitlementRequests === 'number'
                    ? `Kullanım: ${formatNumber(item.usedRequests)} / ${formatNumber(item.entitlementRequests)}`
                    : typeof item.resetDate === 'string'
                      ? `Yenilenme: ${item.resetDate}`
                      : 'Yenilenme tarihi sunulmadı'
                return <Metric key={name} label={label} value={item.isUnlimitedEntitlement === true ? 'Sınırsız' : `${formatNumber(remaining)}% kalan`} note={usageNote} />
            })}
          </div> : <EmptyState title="Kota verisi kullanılamıyor" text="Bu hesap veya SDK sürümü kota bilgisini sunmadı; dashboard çalışmaya devam eder." />}
        </section>
        <section className="panel">
          <SectionHeading eyebrow="SON OTURUMLAR" title="Çalıştırma geçmişi" text={historyStorage === 'sqlite'
            ? 'Son 30 çalıştırma gösterilir. Kayıtlar yerel SQLite veritabanında kalıcı olarak tutulur; sunucu yeniden başlatıldığında kaybolmaz.'
            : historyStorage === 'memory'
              ? 'Veritabanı kullanılamıyor: kayıtlar yalnızca sunucu belleğinde tutulur ve yeniden başlatmada kaybolur.'
              : 'Son 30 çalıştırma gösterilir.'} />
          <label className="history-filter" htmlFor="history-provider">Sağlayıcı filtresi</label>
          <select id="history-provider" value={historyProvider} onChange={(event) => setHistoryProvider(event.target.value as 'all' | ProviderId)}>
            <option value="all">Tüm sağlayıcılar</option>
            <option value="github-copilot">GitHub Copilot</option>
            <option value="claude">Claude</option>
          </select>
          {filteredHistory.length ? <div className="table-wrap"><table><thead><tr><th>Görev etiketi</th><th>Sağlayıcı</th><th>Karşılaştırma</th><th>Gerçekleşen model</th><th>Toplam token</th><th>Sağlayıcı maliyeti</th><th>Süre</th><th>Durum</th></tr></thead><tbody>
            {filteredHistory.map((item) => {
              const inputTokens = item.usage?.inputTokens ?? item.metrics?.inputTokens
              const outputTokens = item.usage?.outputTokens ?? item.metrics?.outputTokens
              const totalTokens = inputTokens !== undefined && outputTokens !== undefined
                ? formatNumber(inputTokens + outputTokens)
                : 'Kullanılamıyor'
              const cost = item.usage?.aiCredits ?? item.metrics?.providerCost
              const costUnit = item.usage?.aiCredits !== undefined
                ? 'AI Credit'
                : item.metrics?.providerCostUnit
              const duration = item.usage?.durationMs ?? item.metrics?.durationMs
              return <tr key={item.id}>
                <td>{item.label}</td>
                <td>{providerLabel(item.provider)}</td>
                <td title={item.comparisonId}>{item.comparisonId.slice(0, 8)}</td>
                <td>{item.actualModel ?? item.model ?? 'Kullanılamıyor'}</td>
                <td>{totalTokens}</td>
                <td>{cost === undefined || !costUnit ? 'Kullanılamıyor' : `${formatNumber(cost)} ${costUnit}`}</td>
                <td>{duration === undefined ? 'Kullanılamıyor' : `${(duration / 1000).toFixed(2)} sn`}</td>
                <td title={item.error}>{item.error ? `Başarısız${item.errorCode ? ` · ${item.errorCode}` : ''}` : 'Tamamlandı'}</td>
              </tr>
            })}
          </tbody></table></div> : <EmptyState title="Geçmiş boş" text="Çalıştırmalar tamamlandıkça burada görünür." />}
        </section>
      </div>
    )
  }

  function renderAdvisor() {
    const questions: Array<[string, string]> = [
      ['needsFileChanges', 'Dosyalarda değişiklik yapılması gerekiyor mu?'],
      ['needsTerminal', 'Terminal, test veya başka araçlar gerekiyor mu?'],
      ['multipleDomains', 'Birden fazla bağımsız uzmanlık alanı var mı?'],
      ['parallelizable', 'Alt işler gerçekten paralel yürütülebilir mi?'],
      ['sequentialDependencies', 'Alt işler arasında sıralı bağımlılıklar var mı?'],
      ['reusableInstructions', 'Tekrarlanabilir uzmanlık yönergeleri gerekiyor mu?'],
      ['externalService', 'Harici servis/API/veri kaynağı gerekiyor mu?'],
      ['deterministicChecks', 'Belirli yaşam döngüsü noktalarında otomatik kontrol gerekiyor mu?'],
    ]
    return (
      <div className="content-grid">
        <section className="panel">
          <SectionHeading eyebrow="KURAL TABANLI · EK MODEL ÇAĞRISI YOK" title="Mod danışmanı" text="Öneri yerel karar kurallarıyla hesaplanır; danışmanlık için AI Credit harcanmaz." />
          <form className="stack-form" onSubmit={handleAdvisor}>
            <label htmlFor="advisor-task">Görev açıklaması</label>
            <textarea id="advisor-task" rows={4} required value={advisorTask} onChange={(event) => setAdvisorTask(event.target.value)} placeholder="Örn. Ön yüzü, API'yi ve veritabanı geçişini ayrı ayrı incele…" />
            <label htmlFor="complexity">Görev boyutu</label>
            <select id="complexity" onChange={(event) => setAdvisorAnswers((current) => ({ ...current, complexity: event.target.value }))}>
              <option value="small">Küçük</option><option value="medium">Orta</option><option value="large">Büyük</option>
            </select>
            <div className="question-grid">{questions.map(([key, question]) => <label className="check-row" key={key}><input type="checkbox" checked={advisorAnswers[key] === true} onChange={(event) => setAdvisorAnswers((current) => ({ ...current, [key]: event.target.checked }))} />{question}</label>)}</div>
            <button className="primary-button" disabled={!advisorTask.trim()}>Öneri oluştur</button>
          </form>
        </section>
        <section className="panel">
          <SectionHeading eyebrow="SONUÇ" title="Önerilen yaklaşım" />
          {recommendation ? <RecommendationCard recommendation={recommendation} /> : <EmptyState title="Henüz öneri yok" text="Görev ve gereksinimleri girerek yerel kural tabanlı öneri alın." />}
        </section>
      </div>
    )
  }

  function renderComparison() {
    return (
      <section className="panel">
        <SectionHeading eyebrow="GERÇEK ÇALIŞTIRMALAR" title="Karşılaştırma laboratuvarı" text="Aynı görev seçilen stratejilerle ayrı ayrı çalıştırılır. Birden fazla çalıştırma öncesinde onay istenir." />
        <form className="stack-form" onSubmit={handleComparison}>
          <label htmlFor="comparison-task">Karşılaştırılacak tek görev</label>
          <textarea id="comparison-task" rows={4} required value={comparisonTask} onChange={(event) => setComparisonTask(event.target.value)} placeholder="Tüm seçilen yöntemlere aynı görev gönderilir." />
          <div className="inline-fields">{renderCopilotModelSelect()}</div>
          <div className="question-grid">{strategies.map((item) => <label className="check-row" key={item.id}><input type="checkbox" checked={comparisonStrategies.includes(item.id)} onChange={() => toggleStrategy(item.id)} />{item.title} <span className="helper">{item.hint}</span></label>)}</div>
          {comparisonStrategies.includes('fleet') && <p className="helper warning">Fleet deneysel SDK özelliğidir; yalnızca kullanıcı çalıştırdığında çağrılır.</p>}
          <button className="primary-button" disabled={isLoading || !comparisonStrategies.length}>{isLoading ? 'Çalıştırmalar sürüyor…' : 'Seçilen yöntemleri çalıştır'}</button>
        </form>
        {error && <p className="error-box" role="alert">{error}</p>}
        {comparisonResults.length > 0 && <ComparisonTable results={comparisonResults} />}
      </section>
    )
  }

  function renderLicensing() {
    const planName = licensePlan === 'pro' ? 'Copilot Pro' : licensePlan === 'pro-plus' ? 'Copilot Pro+' : licensePlan === 'max' ? 'Copilot Max' : licensePlan === 'business' ? 'Copilot Business' : 'Copilot Enterprise'
    return (
      <div className="content-grid">
        <section className="panel">
          <SectionHeading eyebrow="KAYNAK VERİSİ + AÇIK VARSAYIMLAR" title="Lisans ve maliyet" text="Plan koltuk ücreti ile AI Credit kullanım maliyetini ayrı hesaplar. 1 AI Credit = 0,01 ABD doları." />
          <form className="stack-form" onSubmit={handleLicense}>
            <label htmlFor="license-plan">Plan</label>
            <select id="license-plan" value={licensePlan} onChange={(event) => handlePlanChange(event.target.value)}>
              <optgroup label="Bireysel">{licensePlans.filter((item) => item.accountType === 'individual').map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup>
              <optgroup label="Kuruluş">{licensePlans.filter((item) => item.accountType === 'organization').map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup>
            </select>
            <label htmlFor="seat-count">{licensePlan === 'business' || licensePlan === 'enterprise' ? 'Geliştirici / koltuk sayısı' : 'Kullanıcı sayısı'}</label>
            <input id="seat-count" type="number" min="1" max="100000" value={seats} onChange={(event) => setSeats(Number(event.target.value))} required />
            <label htmlFor="expected-credits">Beklenen AI Credit / kullanıcı / ay</label>
            <input id="expected-credits" type="number" min="0" step="any" value={expectedCredits} onChange={(event) => setExpectedCredits(Number(event.target.value))} required />
            <label htmlFor="runs-per-month">Son ölçülen oturum üzerinden aylık çalıştırma varsayımı</label>
            <div className="inline-fields">
              <input id="runs-per-month" type="number" min="0" step="1" value={runsPerMonth} onChange={(event) => setRunsPerMonth(Number(event.target.value))} />
              <button className="secondary-button" type="button" onClick={() => {
                const measuredCredits = history.filter(isCopilotHistory)[0]?.usage.aiCredits
                if (measuredCredits === undefined) {
                  setLicenseError('Geçmişte AI Credit ölçümü bulunan bir oturum yok.')
                  return
                }
                setLicenseError('')
                setExpectedCredits(measuredCredits * runsPerMonth)
              }}>Gerçek oturum ölçümünden hesapla</button>
            </div>
            <p className="helper">Ölçülen son oturumun AI Credit değerini aylık çalıştırma sayısıyla çarpar. Bu hesap, son oturumun kullanıcı başına temsili olduğunu varsayar.</p>
            {licensePlan === 'enterprise' && <>
              <label htmlFor="enterprise-price">Enterprise koltuk fiyatı / ay · teklif fiyatı</label>
              <input id="enterprise-price" type="number" min="0" step="any" value={enterpriseSeatPrice} onChange={(event) => setEnterpriseSeatPrice(event.target.value)} placeholder="Teklifinizi girin" />
            </>}
            <label htmlFor="included-credits">Dahil edilen AI Credit / kullanıcı / ay</label>
            <input id="included-credits" type="number" min="0" step="any" value={includedCredits} onChange={(event) => setIncludedCredits(event.target.value)} required />
            <InfoNote title="Resmî plan tahsisi">Kredi tahsisatları GitHub’un bireysel ve kuruluş faturalandırma belgelerinden yüklenir. Enterprise koltuk fiyatı teklife göre değişir; kendi fiyatınızı girin.</InfoNote>
            <button className="primary-button">Maliyeti hesapla</button>
          </form>
          {licenseError && <p className="error-box">{licenseError}</p>}
        </section>
        <section className="panel">
          <SectionHeading eyebrow="HESAPLAMA" title={planName} />
          {licenseResult ? <LicenseSummary result={licenseResult} /> : <EmptyState title="Hesaplama bekleniyor" text="Kullanıcı sayısı ve beklenen aylık AI Credit miktarını girin." />}
          <div className="source-note">Fiyatlandırma bilgileri değişebilir. Son doğrulama: 15.10.2026 · Resmî kaynaklar: <a href="https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing" target="_blank" rel="noreferrer">bireysel planlar</a> ve <a href="https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing" target="_blank" rel="noreferrer">kuruluş planları</a>.</div>
        </section>
      </div>
    )
  }

  function renderFeatures() {
    return <div className="feature-grid">{featureCards.map((feature) => <article className="panel feature-card" key={feature.title}><span className="feature-mark">✳</span><h2>{feature.title}</h2><p>{feature.what}</p><dl><dt>Ne zaman kullanılır?</dt><dd>{feature.when}</dd><dt>Ne zaman kullanılmamalı?</dt><dd>{feature.avoid}</dd><dt>Kullanım etkisi</dt><dd>{feature.cost}</dd></dl></article>)}</div>
  }

  const currentSection = sections.find((item) => item.id === activeSection)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setActiveSection('playground') }}>
          <span className="brand-icon">✳</span><span><strong>Copilot Usage</strong><small>STRATEGY ANALYZER</small></span>
        </a>
        <p className="nav-caption">ÇALIŞMA ALANI</p>
        <nav aria-label="Ana gezinme">
          {sections.map((item) => <button key={item.id} className={`nav-item ${activeSection === item.id ? 'active' : ''}`} onClick={() => { setActiveSection(item.id); setError('') }}><span>{item.icon}</span>{item.title}</button>)}
        </nav>
        <div className="sidebar-foot"><span className="live-dot" />Copilot SDK bağlı<br /><small>Yerel geliştirme oturumu</small></div>
      </aside>
      <main className="main-area">
        <header className="topbar"><div><p className="eyebrow">AI SAĞLAYICI KARŞILAŞTIRMASI</p><h1>{activeSection === 'playground' ? 'Copilot ve Claude Karşılaştırması' : currentSection?.title}</h1></div><div className="topbar-badge">GERÇEK ÖLÇÜMLER</div></header>
        <div className="page-content">
          {activeSection === 'playground' && renderPlayground()}
          {activeSection === 'usage' && renderUsage()}
          {activeSection === 'advisor' && renderAdvisor()}
          {activeSection === 'comparison' && renderComparison()}
          {activeSection === 'licensing' && renderLicensing()}
          {activeSection === 'features' && renderFeatures()}
        </div>
      </main>
    </div>
  )
}

function ProviderResultCard({
  provider,
  execution,
  isLoading,
  claudeStatus,
  selectedModelLabel,
}: {
  provider: ProviderId
  execution?: ProviderExecution
  isLoading: boolean
  claudeStatus: ClaudeStatus
  selectedModelLabel: string
}) {
  const isCopilot = provider === 'github-copilot'
  const providerCostLabel = execution?.providerCostUnit === 'AI Credit'
    ? 'AI Credit'
    : execution?.providerCostUnit === 'USD'
      ? 'Claude API maliyeti (USD)'
      : 'Sağlayıcı maliyeti'

  const metrics: Array<[string, string]> = [
    ['Girdi token', metricValue(execution?.inputTokens)],
    ['Çıktı token', metricValue(execution?.outputTokens)],
    ['Önbellek token', metricValue(execution?.cachedTokens)],
    ...(execution?.cacheCreationTokens !== undefined
      ? [['Önbellek yazma tokenı', formatNumber(execution.cacheCreationTokens)] as [string, string]]
      : []),
    ['Akıl yürütme token', metricValue(execution?.reasoningTokens)],
    ...(!isCopilot && execution?.numTurns !== undefined
      ? [['Tur sayısı', formatNumber(execution.numTurns)] as [string, string]]
      : []),
    ['Model çağrısı', metricValue(execution?.modelCalls)],
    ['Araç çağrısı', metricValue(execution?.toolCalls)],
    ['Süre', execution?.durationMs === undefined ? 'Kullanılamıyor' : `${(execution.durationMs / 1000).toFixed(2)} sn`],
    [providerCostLabel, execution?.providerCost === undefined || !execution.providerCostUnit
      ? 'Kullanılamıyor'
      : `${formatNumber(execution.providerCost)} ${execution.providerCostUnit}`],
    ...(isCopilot
      ? [
          ['Bağlam kullanımı', execution?.contextUtilization === undefined ? 'Kullanılamıyor' : `%${execution.contextUtilization.toFixed(1)}`] as [string, string],
          ['Kullanılan Skills', execution?.skillsUsed?.join(', ') || (execution ? 'Yok' : 'Kullanılamıyor')] as [string, string],
          ['Alt ajan', execution?.subagentsUsed === undefined ? 'Kullanılamıyor' : formatNumber(execution.subagentsUsed)] as [string, string],
        ]
      : []),
  ]

  return (
    <article className={`panel provider-card ${isCopilot ? 'provider-copilot' : 'provider-claude'}`}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SAĞLAYICI ÇALIŞTIRMA SONUCU</p>
          <h2>{providerLabel(provider)}</h2>
          <p>{isCopilot ? 'GitHub Copilot SDK' : 'Claude Agent SDK'}</p>
        </div>
        <span className={`status-pill ${!isCopilot && !claudeStatus.runnable ? 'status-unavailable' : ''}`}>
          {isCopilot ? 'Otomatik yönlendirme' : claudeStatus.message}
        </span>
      </div>
      <div className="model-resolution">
        <div><span>Platform</span><strong>{isCopilot ? 'GitHub Copilot' : 'Anthropic Claude'}</strong></div>
        <div><span>Çalışma zamanı</span><strong>{isCopilot ? 'Copilot SDK' : 'Claude Agent SDK'}</strong></div>
        <div><span>Model seçimi</span><strong>{selectedModelLabel}</strong></div>
        <div>
          <span>{isCopilot ? 'Copilot tarafından seçilen gerçek model' : 'Gerçek kullanılan model'}</span>
          <strong>{execution?.actualModel ?? (execution ? 'Kullanılamıyor' : 'Çalıştırma sonrasında gösterilir')}</strong>
        </div>
      </div>
      {isLoading && <div className="loading-state"><span className="spinner" />{providerLabel(provider)} yanıtı bekleniyor…</div>}
      {!execution && !isLoading && (
        !isCopilot && !claudeStatus.runnable
          ? <ClaudeSetupNotice status={claudeStatus} />
          : <EmptyState
              title="Henüz çalıştırma yok"
              text={isCopilot
                ? 'İşlemden sonra SDK’nın ölçtüğü gerçek model ve kullanım burada görünür.'
                : 'Claude yanıtı ve Agent SDK’nın bildirdiği ölçümler burada görünür. Her çalıştırma Anthropic API hesabınızdan ücretlendirilir.'}
            />
      )}
      {execution?.error && (
        !isCopilot && !claudeStatus.runnable
          ? <ClaudeSetupNotice status={claudeStatus} />
          : <div className="provider-unavailable">
              <strong>{execution.error}</strong>
              {execution.errorCode && <small>Hata kodu: {execution.errorCode}</small>}
              {execution.setupHint && <p>{execution.setupHint}</p>}
            </div>
      )}
      {execution && !execution.error && (
        <>
          {isCopilot && <p className="helper model-explanation">GitHub Copilot tek bir yapay zekâ modeli değildir. Auto modu görev için uygun modeli çalışma zamanında seçer.</p>}
          <div className="response-copy">
            <p className="eyebrow">YANIT</p>
            <p>{execution.response || 'Yanıt metni kullanılamıyor.'}</p>
          </div>
          <div className="provider-metrics">
            {metrics.map(([label, value]) => <Metric key={label} label={label} value={value} />)}
          </div>
          {execution.providerCostSource && <p className="helper">{execution.providerCostSource}. Maliyet tahmini fatura değildir.</p>}
          <p className="helper">{isCopilot ? 'Metrik kaynağı: SDK tarafından ölçüldü.' : 'Token ve maliyet kaynağı: Claude Agent SDK ve sağlayıcı API ölçümü.'}</p>
          {execution.events.length > 0 && (
            <div className="event-list">
              <h3>Ajan ve araç etkinliği</h3>
              {execution.events.map((item, index) => (
                <div className="timeline-row" key={`${item.type}-${index}`}>
                  <span className="timeline-dot" /><span>{item.label}</span>
                  {item.timestamp && <time>{new Date(item.timestamp).toLocaleTimeString('tr-TR')}</time>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </article>
  )
}

function ClaudeSetupNotice({ status }: { status: ClaudeStatus }) {
  if (status.state === 'checking') {
    return <div className="loading-state"><span className="spinner" />Claude bağlantı durumu denetleniyor…</div>
  }
  const heading = status.state === 'invalid_key_format'
    ? 'Claude anahtar türü uygun değil'
    : status.state === 'sdk_unavailable'
      ? 'Claude SDK kullanılamıyor'
      : 'Claude yapılandırılmamış'
  const setupText = status.state === 'sdk_unavailable'
    ? 'Claude SDK yüklemesini ve API sunucusunu kontrol edin.'
    : status.state === 'invalid_key_format'
      ? 'ANTHROPIC_API_KEY bir OAuth veya Admin anahtarı içeriyor; Claude için Console API anahtarı gerekir.'
      : 'Claude çalıştırmak için sunucu ortamına ANTHROPIC_API_KEY eklenmelidir.'

  return (
    <div className="provider-unavailable claude-setup">
      <strong>{heading}</strong>
      <p>{setupText}</p>
      {status.state !== 'sdk_unavailable' && (
        <ol>
          <li>Anthropic Console'dan API anahtarı oluşturun.</li>
          <li>Proje kökünde <code>.env</code> dosyası oluşturun.</li>
          <li><code>ANTHROPIC_API_KEY=...</code> satırını ekleyin.</li>
          <li><code>npm run dev</code> komutuyla uygulamayı yeniden başlatın.</li>
        </ol>
      )}
      {status.setupHint && <small>{status.setupHint}</small>}
    </div>
  )
}

function ComparisonSummaryCard({ summary }: { summary: ComparisonSummary }) {
  return (
    <section className="panel comparison-summary">
      <SectionHeading
        eyebrow="ORTAK ÖLÇÜTLER"
        title="Sonuçların özeti"
        text="Yalnızca iki sağlayıcıda da ölçülen metrikler karşılaştırılır. Yanıt kalitesi veya en iyi model hakkında hüküm verilmez."
      />
      <div className="summary-metrics">
        {[
          ['Daha hızlı', summary.faster],
          ['Daha az girdi tokenı', summary.fewerInputTokens],
          ['Daha az çıktı tokenı', summary.fewerOutputTokens],
          ['Daha az toplam token', summary.fewerTotalTokens],
          ['Daha az araç çağrısı', summary.fewerToolCalls],
        ].map(([label, value]) => (
          <Metric key={String(label)} label={String(label)} value={providerValueLabel(value as ProviderId | 'tie' | undefined)} />
        ))}
      </div>
      <h3>Sağlayıcı maliyetleri · farklı birimler</h3>
      <p className="helper">AI Credit ve Claude API maliyeti farklı faturalandırma birimleridir; doğrudan sayısal olarak karşılaştırılmaz.</p>
      <div className="summary-costs">
        {summary.costs.map((item) => (
          <Metric key={item.provider} label={providerLabel(item.provider)} value={`${formatNumber(item.amount)} ${item.unit}`} />
        ))}
        {!summary.costs.length && <p className="helper">Sağlayıcı maliyet ölçümü kullanılamıyor.</p>}
      </div>
    </section>
  )
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  const descriptions: Record<string, string> = {
    'Girdi token': 'Modele gönderilen metin ve bağlam miktarı.',
    'Çıktı token': 'Modelin ürettiği yanıt miktarı.',
    'Önbellek token': 'Sağlayıcının önbellek üzerinden yeniden kullandığı bağlam.',
    'Önbellek yazma tokenı': 'Sağlayıcının önbelleğe yazdığı bağlam miktarı.',
    'Akıl yürütme token': 'Model destekliyorsa akıl yürütme için raporlanan kullanım.',
    'Model çağrısı': 'Modelden yanıt üretmek için yapılan gerçek çağrı sayısı.',
    'Tur sayısı': 'Claude Agent SDK sonucunun bildirdiği konuşma turu sayısı (num_turns).',
    'Araç çağrısı': "Agent'ın terminal, dosya veya başka araçları kullanma sayısı.",
    'Bağlam kullanımı': 'Modelin bağlam penceresi kapasitesinin ne kadarının kullanıldığını gösterir.',
    'AI Credit': 'GitHub Copilot kullanımının GitHub tarafından raporlanan tüketim birimi.',
    'Claude API maliyeti (USD)': 'Claude token kullanımına göre SDK tarafından bildirilen sağlayıcı maliyeti.',
  }
  const description = descriptions[label]
  return (
    <div className="metric-card">
      <span className="metric-label" title={description}>
        {label}{description && <abbr aria-label="Açıklama" title={description}>i</abbr>}
      </span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  )
}

function SectionHeading({ eyebrow, title, text }: { eyebrow: string; title: string; text?: string }) {
  return <div className="section-heading">{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2>{text && <p>{text}</p>}</div>
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span>◌</span><strong>{title}</strong><p>{text}</p></div>
}

function InfoNote({ title, children }: { title: string; children: ReactNode }) {
  return <aside className="info-note"><strong>{title}</strong><p>{children}</p></aside>
}

function RecommendationCard({ recommendation }: { recommendation: Record<string, unknown> }) {
  const supporting = Array.isArray(recommendation.supporting) ? recommendation.supporting : []
  const warnings = Array.isArray(recommendation.warnings) ? recommendation.warnings : []
  return <div className="recommendation"><span className="recommendation-badge">ÖNERİ</span><h3>{String(recommendation.primary ?? '—')}</h3><p>{String(recommendation.explanation ?? '')}</p><Metric label="Göreli kullanım kategorisi · tahmin değil" value={String(recommendation.costCategory ?? '—')} /><h4>Destekleyici yetenekler</h4><div className="tag-list">{supporting.length ? supporting.map((item) => <span key={String(item)}>{String(item)}</span>) : <span>Ek yetenek gerekmiyor</span>}</div><h4>Neden daha karmaşık değil?</h4><p>{String(recommendation.whyNotMore ?? '')}</p>{warnings.map((warning) => <p className="helper warning" key={String(warning)}>{String(warning)}</p>)}</div>
}

function ComparisonTable({ results }: { results: ComparisonRow[] }) {
  const successful = results.flatMap((row) => row.execution ? [row.execution] : [])
  const totals = successful.map((result) => result.usage)
  const fastest = totals.length ? Math.min(...totals.map((usage) => usage.durationMs)) : undefined
  const lowestCredits = totals.filter((usage) => usage.aiCredits !== undefined).length
    ? Math.min(...totals.map((usage) => usage.aiCredits ?? Number.POSITIVE_INFINITY))
    : undefined
  return <div className="comparison-output"><h3>Gerçek çalıştırma sonuçları</h3><div className="table-wrap"><table><thead><tr><th>Yöntem</th><th>İstenen model</th><th>Gerçekleşen model(ler)</th><th>Süre</th><th>Model çağrısı</th><th>Girdi</th><th>Çıktı</th><th>Toplam token</th><th>AI Credit</th><th>Araç</th><th>Alt ajan</th><th>Skill</th><th>Sonuç</th></tr></thead><tbody>{results.map((row) => { const result = row.execution; return <tr key={row.strategy}><td>{strategyLabel(row.strategy)}</td>{result ? <><td>{formatModelLabel(result.requestedModel)}</td><td>{result.usage.modelMetrics.map((item) => item.id).join(', ') || result.model}</td><td>{(result.usage.durationMs / 1000).toFixed(2)} sn {result.usage.durationMs === fastest && '⚡'}</td><td>{formatNumber(result.usage.modelCalls)}</td><td>{formatNumber(result.usage.inputTokens)}</td><td>{formatNumber(result.usage.outputTokens)}</td><td>{formatNumber(result.usage.inputTokens + result.usage.outputTokens)}</td><td>{formatCredits(result.usage.aiCredits)} {result.usage.aiCredits === lowestCredits && lowestCredits !== undefined && '↓'}</td><td>{formatNumber(result.usage.toolCalls)}</td><td>{formatNumber(result.usage.subagentCalls)}</td><td>{result.usage.skillsInvoked.join(', ') || '—'}</td><td>Başarılı</td></> : <td colSpan={12} className="error-text">Başarısız: {row.error}</td>}</tr> })}</tbody></table></div><p className="helper">Daha hızlı / daha az AI Credit / daha az token işaretleri yalnızca gözlenen ölçümü karşılaştırır; yanıt kalitesini ölçmez.</p></div>
}

function LicenseSummary({ result }: { result: Record<string, unknown> }) {
  const display = (key: string) => typeof result[key] === 'number' ? `$${Number(result[key]).toFixed(2)} USD` : 'Fiyat bilgisi belirtilmedi'
  return <div className="license-summary"><div className="metric-grid"><Metric label="Aylık abonelik" value={display('monthlySubscriptionUsd')} /><Metric label="Yıllık abonelik" value={display('annualSubscriptionUsd')} /><Metric label="Dahil AI Credit / ay" value={formatNumber(typeof result.includedMonthlyAiCredits === 'number' ? result.includedMonthlyAiCredits : undefined)} /><Metric label="Beklenen AI Credit" value={formatNumber(typeof result.expectedMonthlyAiCredits === 'number' ? result.expectedMonthlyAiCredits : undefined)} /><Metric label="Ek kullanım tahmini" value={display('estimatedAdditionalUsageUsd')} /><Metric label="Tahmini aylık toplam" value={display('estimatedMonthlyTotalUsd')} /></div><p className="helper">{String(result.includedCreditsNote ?? '')}</p><p className="helper">AI Credit birim fiyatı: $0,01. Yıllık görünüm yalnızca abonelik koltuk ücretini yıllıklandırır; kullanım tahmini aylık ölçekte kalır.</p></div>
}

export default App
