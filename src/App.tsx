import { useCallback, useEffect, useState, type FormEvent } from 'react'
import './App.css'
import {
  ComparisonSummaryCard,
  ComparisonTable,
  LicenseSummary,
  ProviderResultCard,
  RecommendationCard,
  type ComparisonRow,
  type LicenseResult,
  type Recommendation,
} from './components/results'
import {
  Alert,
  DataTag,
  EmptyState,
  InfoNote,
  LoadingState,
  Metric,
  SectionHeading,
  StatusBadge,
  type StatusTone,
} from './components/ui'
import { featureCards } from './content/features'
import { strategies } from './content/strategies'
import { useHealth } from './hooks/useHealth'
import { errorText, isRecord, postJson, requestJson } from './lib/api'
import {
  formatCredits,
  formatDateTime,
  formatDuration,
  formatModelLabel,
  formatNumber,
  sumIfKnown,
  UNKNOWN,
} from './lib/format'
import { HistoryPanel } from './sections/HistoryPanel'
import { ReportsSection } from './sections/ReportsSection'
import type {
  ClaudeModelOption,
  ClaudeStatus,
  ComparisonSummary,
  CopilotModelOption,
  Execution,
  HealthSnapshot,
  LicensePlan,
  PricingMetadata,
  ProviderExecution,
  ProviderId,
  SectionId,
  Strategy,
  UsageHistoryRecord,
} from './types'

const sections: Array<{ id: SectionId; slug: string; title: string; icon: string; badge: string }> = [
  { id: 'playground', slug: 'oyun-alani', title: 'Oyun Alanı', icon: '✳', badge: 'GERÇEK ÇALIŞTIRMA · ÜCRETLİ OLABİLİR' },
  { id: 'usage', slug: 'kullanim', title: 'Kullanım Analizi', icon: '◫', badge: 'GERÇEK ÖLÇÜMLER' },
  { id: 'advisor', slug: 'danisman', title: 'Mod Danışmanı', icon: '⌁', badge: 'KURAL TABANLI · ÜCRETSİZ' },
  { id: 'comparison', slug: 'laboratuvar', title: 'Karşılaştırma Laboratuvarı', icon: '⇄', badge: 'GERÇEK ÇALIŞTIRMA · ÜCRETLİ OLABİLİR' },
  { id: 'licensing', slug: 'lisans', title: 'Lisans ve Maliyet', icon: '◇', badge: 'TAHMİN / HESAPLAMA' },
  { id: 'reports', slug: 'raporlar', title: 'Raporlar ve Backlog', icon: '▦', badge: 'KAYITLI VERİDEN' },
  { id: 'features', slug: 'rehber', title: 'Özellik Rehberi', icon: '▤', badge: 'BİLGİLENDİRME' },
]

/** Adres çubuğundaki #bölüm bağlantısından bölümü bulur (paylaşılabilir bağlantı, geri tuşu). */
function sectionFromHash(): SectionId | undefined {
  const slug = typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1))
  return sections.find((item) => item.slug === slug)?.id
}

const advisorQuestions: Array<[string, string]> = [
  ['needsFileChanges', 'Dosyalarda değişiklik yapılması gerekiyor mu?'],
  ['needsTerminal', 'Terminal, test veya başka araçlar gerekiyor mu?'],
  ['multipleDomains', 'Birden fazla bağımsız uzmanlık alanı var mı?'],
  ['parallelizable', 'Alt işler gerçekten paralel yürütülebilir mi?'],
  ['sequentialDependencies', 'Alt işler arasında sıralı bağımlılıklar var mı?'],
  ['reusableInstructions', 'Tekrarlanabilir uzmanlık yönergeleri gerekiyor mu?'],
  ['externalService', 'Harici servis/API/veri kaynağı gerekiyor mu?'],
  ['deterministicChecks', 'Belirli yaşam döngüsü noktalarında otomatik kontrol gerekiyor mu?'],
]

const checkingClaude: ClaudeStatus = {
  state: 'checking',
  configured: false,
  verified: false,
  runnable: false,
  message: 'Denetleniyor',
}

const unreachableClaude: ClaudeStatus = {
  state: 'unreachable',
  configured: false,
  verified: false,
  runnable: false,
  message: 'API sunucusuna ulaşılamıyor',
}

function copilotStatus(health: HealthSnapshot | undefined, error: string): [StatusTone, string] {
  if (error && !health) return ['error', 'API sunucusuna ulaşılamıyor']
  if (!health) return ['pending', 'Denetleniyor']
  const copilot = health.copilot
  if (copilot.state === 'starting') return ['pending', 'Başlatılıyor']
  if (copilot.state === 'unreachable') return ['error', 'Yanıt vermiyor']
  if (copilot.state === 'unavailable') return ['error', 'Kullanılamıyor']
  return copilot.authenticated ? ['ok', 'Bağlı'] : ['warning', 'Oturum açılmamış']
}

function claudeTone(status: ClaudeStatus): [StatusTone, string] {
  switch (status.state) {
    case 'verified': return ['ok', 'Doğrulandı']
    case 'unverified': return ['pending', 'Yapılandırıldı · doğrulanmadı']
    case 'missing_key': return ['neutral', 'Yapılandırılmamış']
    case 'invalid_key_format': return ['error', 'Anahtar türü uygun değil']
    case 'sdk_unavailable': return ['error', 'Kullanılamıyor']
    case 'auth_failed': return ['error', 'Kimlik doğrulama başarısız']
    case 'error': return ['warning', 'Son çalıştırma başarısız']
    case 'unreachable': return ['error', 'API sunucusuna ulaşılamıyor']
    default: return ['pending', 'Denetleniyor']
  }
}

/** Opus/Fable sınıfı modeller daha yüksek token fiyatına sahiptir; kullanıcı uyarılır. */
function isPremiumClaudeModel(model: string | undefined) {
  return !model || /opus|fable|mythos/i.test(model)
}

function App() {
  const { health, error: healthError, refresh: refreshHealth } = useHealth()
  const claudeStatus = health?.claude ?? (healthError ? unreachableClaude : checkingClaude)

  const [activeSection, setSection] = useState<SectionId>(() => sectionFromHash() ?? 'playground')
  const setActiveSection = useCallback((id: SectionId) => {
    setSection(id)
    const slug = sections.find((item) => item.id === id)?.slug
    if (slug && window.location.hash !== `#${slug}`) window.history.pushState(null, '', `#${slug}`)
  }, [])

  useEffect(() => {
    // Tanınmayan adresler (ör. "İçeriğe geç" bağlantısı) bölümü değiştirmez.
    const onHashChange = () => {
      const section = sectionFromHash()
      if (section) setSection(section)
    }
    window.addEventListener('popstate', onHashChange)
    window.addEventListener('hashchange', onHashChange)
    return () => {
      window.removeEventListener('popstate', onHashChange)
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [])
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)
  const bumpHistory = useCallback(() => setHistoryRefreshKey((value) => value + 1), [])

  // Oyun Alanı
  const [prompt, setPrompt] = useState('')
  const [strategy, setStrategy] = useState<Strategy>('normal')
  const [maxAiCreditLimit, setMaxAiCreditLimit] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [playgroundError, setPlaygroundError] = useState('')
  const [providerExecutions, setProviderExecutions] = useState<ProviderExecution[]>([])
  const [requestedProviders, setRequestedProviders] = useState<ProviderId[]>([])
  const [comparisonSummary, setComparisonSummary] = useState<ComparisonSummary>()

  // Model seçimi
  const [copilotModels, setCopilotModels] = useState<CopilotModelOption[]>([])
  const [copilotAutoTiers, setCopilotAutoTiers] = useState<Array<{ id: string; label: string }>>([])
  const [copilotCatalogState, setCopilotCatalogState] = useState<'loading' | 'auto-only' | 'named' | 'error'>('loading')
  const [copilotCatalogNote, setCopilotCatalogNote] = useState('')
  const [copilotModel, setCopilotModel] = useState('auto')
  const [copilotAutoTier, setCopilotAutoTier] = useState('')
  const [claudeModels, setClaudeModels] = useState<ClaudeModelOption[]>([])
  const [claudeModelsState, setClaudeModelsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [claudeModelsNote, setClaudeModelsNote] = useState('')
  const [claudeModel, setClaudeModel] = useState('')

  // Kullanım analizi
  const [latestCopilot, setLatestCopilot] = useState<UsageHistoryRecord>()
  const [latestCopilotLoaded, setLatestCopilotLoaded] = useState(false)
  const [quota, setQuota] = useState<Record<string, unknown>>()
  const [quotaLoading, setQuotaLoading] = useState(false)

  // Mod danışmanı
  const [advisorTask, setAdvisorTask] = useState('')
  const [advisorComplexity, setAdvisorComplexity] = useState('small')
  const [advisorAnswers, setAdvisorAnswers] = useState<Record<string, boolean>>({})
  const [recommendation, setRecommendation] = useState<Recommendation>()
  const [advisorError, setAdvisorError] = useState('')
  const [advisorLoading, setAdvisorLoading] = useState(false)

  // Karşılaştırma laboratuvarı
  const [comparisonTask, setComparisonTask] = useState('')
  const [comparisonStrategies, setComparisonStrategies] = useState<Strategy[]>(['normal', 'skill'])
  const [comparisonResults, setComparisonResults] = useState<ComparisonRow[]>([])
  const [labError, setLabError] = useState('')

  // Lisans
  const [licensePlans, setLicensePlans] = useState<LicensePlan[]>([])
  const [pricing, setPricing] = useState<PricingMetadata>()
  const [licensePlan, setLicensePlan] = useState('business')
  const [seats, setSeats] = useState('10')
  const [expectedCredits, setExpectedCredits] = useState('100')
  const [runsPerMonth, setRunsPerMonth] = useState('20')
  const [includedCredits, setIncludedCredits] = useState('')
  const [includedCreditsEdited, setIncludedCreditsEdited] = useState(false)
  const [seatPrice, setSeatPrice] = useState('')
  const [seatPriceEdited, setSeatPriceEdited] = useState(false)
  const [licenseResult, setLicenseResult] = useState<LicenseResult>()
  const [licenseError, setLicenseError] = useState('')
  const [licenseNotice, setLicenseNotice] = useState('')

  const loadCopilotModels = useCallback(async () => {
    try {
      const payload = await requestJson('/api/copilot/models')
      if (!isRecord(payload) || !Array.isArray(payload.models)) throw new Error('Copilot model kataloğu alınamadı.')
      setCopilotModels(payload.models.filter(
        (item): item is CopilotModelOption =>
          isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' && item.id !== 'auto',
      ))
      setCopilotAutoTiers(Array.isArray(payload.autoTiers)
        ? payload.autoTiers.filter((item): item is { id: string; label: string } =>
            isRecord(item) && typeof item.id === 'string' && typeof item.label === 'string')
        : [])
      setCopilotCatalogState(payload.scope === 'named' ? 'named' : 'auto-only')
      setCopilotCatalogNote(typeof payload.message === 'string' ? payload.message : '')
    } catch (caught) {
      setCopilotModels([])
      setCopilotAutoTiers([])
      setCopilotCatalogState('error')
      setCopilotCatalogNote(errorText(caught, 'Copilot model kataloğu alınamadı.'))
    }
  }, [])

  const loadClaudeModels = useCallback(async () => {
    setClaudeModelsState('loading')
    try {
      const payload = await requestJson('/api/claude/models')
      if (!isRecord(payload) || !Array.isArray(payload.models)) throw new Error('Claude model listesi alınamadı.')
      setClaudeModels(payload.models.filter(
        (item): item is ClaudeModelOption =>
          isRecord(item) && typeof item.value === 'string' && typeof item.displayName === 'string',
      ))
      setClaudeModelsState('ready')
      setClaudeModelsNote('')
    } catch (caught) {
      setClaudeModels([])
      setClaudeModelsState('error')
      setClaudeModelsNote(errorText(caught, 'Claude model listesi alınamadı.'))
    }
  }, [])

  const loadLatestCopilot = useCallback(async () => {
    try {
      const payload = await requestJson('/api/usage/history?provider=github-copilot&status=success&limit=1')
      const record = isRecord(payload) && Array.isArray(payload.executions) ? payload.executions[0] : undefined
      setLatestCopilot(isRecord(record) ? (record as unknown as UsageHistoryRecord) : undefined)
    } catch {
      setLatestCopilot(undefined)
    } finally {
      setLatestCopilotLoaded(true)
    }
  }, [])

  const loadQuota = useCallback(async () => {
    setQuotaLoading(true)
    try {
      const payload = await requestJson('/api/copilot/quota')
      setQuota(isRecord(payload) ? payload : undefined)
    } catch (caught) {
      setQuota({ status: 'unavailable', message: errorText(caught, 'Kota bilgisi alınamadı.') })
    } finally {
      setQuotaLoading(false)
    }
  }, [])

  // İlk yükleme: yalnızca ücretsiz durum ve katalog uç noktaları çağrılır; model çağrısı yapılmaz.
  useEffect(() => {
    const timer = setTimeout(() => {
      void loadCopilotModels()
      void requestJson('/api/licensing/plans')
        .then((payload) => {
          if (!isRecord(payload) || !Array.isArray(payload.plans)) throw new Error('Plan bilgileri alınamadı.')
          const plans = payload.plans.filter(isRecord) as unknown as LicensePlan[]
          setLicensePlans(plans)
          if (isRecord(payload.pricing)) setPricing(payload.pricing as unknown as PricingMetadata)
          const plan = plans.find((item) => item.id === 'business')
          if (plan) {
            setIncludedCredits(String(plan.includedAiCreditsPerSeat))
            setSeatPrice(plan.monthlySeatPriceUsd === null ? '' : String(plan.monthlySeatPriceUsd))
          }
        })
        .catch((caught) => setLicenseError(errorText(caught, 'Plan bilgileri alınamadı.')))
    }, 0)
    return () => clearTimeout(timer)
  }, [loadCopilotModels])

  // Claude model listesi yalnızca Claude çalıştırılabilir durumdaysa alınır (mesaj gönderilmez).
  useEffect(() => {
    if (!claudeStatus.runnable || claudeModelsState !== 'idle') return
    const timer = setTimeout(() => void loadClaudeModels(), 0)
    return () => clearTimeout(timer)
  }, [claudeStatus.runnable, claudeModelsState, loadClaudeModels])

  useEffect(() => {
    const timer = setTimeout(() => void loadLatestCopilot(), 0)
    return () => clearTimeout(timer)
  }, [loadLatestCopilot, historyRefreshKey])

  useEffect(() => {
    if (activeSection !== 'usage' || quota || quotaLoading) return
    const timer = setTimeout(() => void loadQuota(), 0)
    return () => clearTimeout(timer)
  }, [activeSection, quota, quotaLoading, loadQuota])

  function copilotModelPayload() {
    return {
      model: copilotModel,
      ...(copilotModel === 'auto' && copilotAutoTier ? { autoTier: copilotAutoTier } : {}),
    }
  }

  function creditLimitPayload() {
    const value = Number(maxAiCreditLimit)
    return maxAiCreditLimit.trim() && Number.isFinite(value) ? { maxAiCreditLimit: value } : {}
  }

  const defaultClaude = claudeModels.find((item) => item.value === 'default')
  const configuredClaudeModel = claudeStatus.model && claudeStatus.model !== 'SDK varsayılanı' ? claudeStatus.model : undefined
  const effectiveDefaultClaude = configuredClaudeModel ?? defaultClaude?.resolvedModel

  function copilotModelLabel() {
    if (copilotModel !== 'auto') return copilotModels.find((item) => item.id === copilotModel)?.name ?? copilotModel
    const tier = copilotAutoTiers.find((item) => item.id === copilotAutoTier)
    return tier ? `Otomatik · ${tier.label}` : 'Otomatik (auto)'
  }

  function claudeModelLabel() {
    if (!claudeModel) return `Sunucu varsayılanı${effectiveDefaultClaude ? ` (${effectiveDefaultClaude})` : ''}`
    const option = claudeModels.find((item) => item.value === claudeModel)
    return option ? `${option.displayName}${option.resolvedModel ? ` · ${option.resolvedModel}` : ''}` : claudeModel
  }

  async function runProviderComparison(providers: ProviderId[]) {
    if (!prompt.trim() || isLoading) return
    if (
      providers.length === 2 &&
      !window.confirm('Bu işlem aynı görevi iki sağlayıcıda da çalıştırır. Copilot tarafında AI Credit tüketilebilir; Claude tarafı Anthropic API hesabınızdan token başına ücretlendirilir. Devam etmek istiyor musunuz?')
    ) return

    setIsLoading(true)
    setPlaygroundError('')
    setRequestedProviders(providers)
    setProviderExecutions([])
    setComparisonSummary(undefined)
    try {
      const payload = await postJson('/api/compare', {
        prompt: prompt.trim(),
        providers,
        strategy,
        ...copilotModelPayload(),
        ...(claudeModel ? { claudeModel } : {}),
        ...creditLimitPayload(),
      })
      if (!isRecord(payload) || !Array.isArray(payload.executions)) {
        throw new Error('Sağlayıcı karşılaştırma yanıtı beklenen biçimde değil.')
      }
      setProviderExecutions(payload.executions as ProviderExecution[])
      if (payload.executions.length === 2 && isRecord(payload.summary) && Array.isArray(payload.summary.costs)) {
        setComparisonSummary(payload.summary as unknown as ComparisonSummary)
      }
    } catch (caught) {
      setPlaygroundError(errorText(caught, 'Sağlayıcı karşılaştırması başarısız oldu.'))
    } finally {
      setIsLoading(false)
      void refreshHealth()
      bumpHistory()
    }
  }

  async function runExecution(task: string, selectedStrategy: Strategy) {
    const payload = await postJson(selectedStrategy === 'fleet' ? '/api/copilot/fleet' : '/api/copilot/chat', {
      prompt: task,
      ...copilotModelPayload(),
      strategy: selectedStrategy,
      ...creditLimitPayload(),
    })
    if (!isRecord(payload) || typeof payload.id !== 'string' || !isRecord(payload.usage)) {
      throw new Error('Çalıştırma yanıtı beklenen biçimde değil.')
    }
    return payload as unknown as Execution
  }

  async function handleComparison(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!comparisonTask.trim() || !comparisonStrategies.length || isLoading) return
    if (
      comparisonStrategies.length > 1 &&
      !window.confirm(`Seçilen ${comparisonStrategies.length} yöntem ayrı ayrı çalıştırılacak. Her çalıştırma Copilot kullanımı ve AI Credit tüketebilir. Devam etmek istiyor musunuz?`)
    ) return
    setIsLoading(true)
    setLabError('')
    setComparisonResults([])
    const completed: ComparisonRow[] = []
    for (const item of comparisonStrategies) {
      try {
        completed.push({ strategy: item, execution: await runExecution(comparisonTask.trim(), item) })
      } catch (caught) {
        completed.push({ strategy: item, error: errorText(caught, 'Çalıştırma başarısız oldu.') })
      }
      setComparisonResults([...completed])
    }
    if (completed.every((row) => row.error)) setLabError('Seçilen yöntemlerin hiçbiri tamamlanamadı. Ayrıntılar tabloda.')
    setIsLoading(false)
    bumpHistory()
    void refreshHealth()
  }

  async function handleAdvisor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setRecommendation(undefined)
    setAdvisorError('')
    setAdvisorLoading(true)
    try {
      const payload = await postJson('/api/advisor/recommend', {
        task: advisorTask,
        complexity: advisorComplexity,
        ...advisorAnswers,
      })
      if (!isRecord(payload) || typeof payload.primary !== 'string') throw new Error('Öneri yanıtı beklenen biçimde değil.')
      setRecommendation({
        primary: payload.primary,
        supporting: Array.isArray(payload.supporting) ? payload.supporting.map(String) : [],
        explanation: String(payload.explanation ?? ''),
        costCategory: String(payload.costCategory ?? '—'),
        whyNotMore: String(payload.whyNotMore ?? ''),
        warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
      })
    } catch (caught) {
      setAdvisorError(errorText(caught, 'Öneri oluşturulamadı.'))
    } finally {
      setAdvisorLoading(false)
    }
  }

  async function handleLicense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLicenseError('')
    setLicenseNotice('')
    const plan = licensePlans.find((item) => item.id === licensePlan)
    const priceEntered = seatPrice.trim() !== ''
    // Değer plan verisinden farklı girildiyse "kullanıcı değeri" olarak gönderilir.
    const sendSeatPrice = priceEntered && (seatPriceEdited || plan?.monthlySeatPriceUsd === null)
    try {
      const payload = await postJson('/api/licensing/calculate', {
        plan: licensePlan,
        seats: Number(seats),
        expectedCreditsPerSeat: Number(expectedCredits),
        ...(includedCreditsEdited && includedCredits.trim() ? { includedCreditsPerSeat: Number(includedCredits) } : {}),
        ...(sendSeatPrice ? { seatPriceUsd: Number(seatPrice) } : {}),
      })
      if (!isRecord(payload)) throw new Error('Hesaplama yanıtı beklenen biçimde değil.')
      setLicenseResult(payload as unknown as LicenseResult)
    } catch (caught) {
      setLicenseResult(undefined)
      setLicenseError(errorText(caught, 'Hesaplama yapılamadı.'))
    }
  }

  function handlePlanChange(planId: string) {
    setLicensePlan(planId)
    setLicenseResult(undefined)
    const plan = licensePlans.find((item) => item.id === planId)
    if (plan) {
      setIncludedCredits(String(plan.includedAiCreditsPerSeat))
      setSeatPrice(plan.monthlySeatPriceUsd === null ? '' : String(plan.monthlySeatPriceUsd))
    }
    setIncludedCreditsEdited(false)
    setSeatPriceEdited(false)
  }

  function applyMeasuredCredits() {
    const measured = latestCopilot?.usage?.aiCredits
    if (measured === undefined) {
      setLicenseError('Geçmişte AI Credit ölçümü bulunan başarılı bir Copilot çalıştırması yok. Önce Oyun Alanı’nda bir Copilot çalıştırması yapın.')
      return
    }
    const runs = Number(runsPerMonth)
    if (!Number.isFinite(runs) || runs < 0) {
      setLicenseError('Aylık çalıştırma sayısı sıfır veya pozitif olmalıdır.')
      return
    }
    setLicenseError('')
    setExpectedCredits(String(Number((measured * runs).toFixed(6))))
    setLicenseNotice(`Son ölçülen Copilot çalıştırması (${formatCredits(measured)}) × ${formatNumber(runs)} çalıştırma kullanıldı. Sonuç bu varsayıma dayalı bir tahmindir.`)
  }

  function renderCopilotModelSelect(idPrefix: string) {
    const selectId = `${idPrefix}-copilot-model`
    return (
      <div className="field-grow">
        <label htmlFor={selectId}>Copilot modeli</label>
        <select id={selectId} value={copilotModel} disabled={isLoading} onChange={(event) => setCopilotModel(event.target.value)} aria-describedby={`${selectId}-help`}>
          <option value="auto">Otomatik (auto) · Copilot seçer</option>
          {copilotModels.map((item) => (
            <option key={item.id} value={item.id} disabled={item.policy?.state === 'disabled'}>
              {item.name}
              {typeof item.billing?.multiplier === 'number' ? ` · ${formatNumber(item.billing.multiplier)}x çarpan` : ''}
              {item.policy?.state === 'disabled' ? ' · politika nedeniyle kapalı' : ''}
            </option>
          ))}
        </select>
        {copilotModel === 'auto' && copilotAutoTiers.length > 0 && (
          <>
            <label htmlFor={`${selectId}-tier`}>Otomatik yönlendirme profili</label>
            <select id={`${selectId}-tier`} value={copilotAutoTier} disabled={isLoading} onChange={(event) => setCopilotAutoTier(event.target.value)}>
              <option value="">Varsayılan</option>
              {copilotAutoTiers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </>
        )}
        <p className={`helper ${copilotCatalogState === 'error' ? 'warning' : ''}`} id={`${selectId}-help`}>
          {copilotCatalogState === 'loading' && 'Copilot model kataloğu yükleniyor…'}
          {copilotCatalogState === 'named' && 'Liste Copilot hesabınızın kataloğundan gelir. Çarpan, AI Credit tüketimini temel orana göre gösterir.'}
          {copilotCatalogState === 'auto-only' && (copilotCatalogNote || 'Bu hesap yalnızca Otomatik (auto) seçeneğini sunuyor.')}
          {copilotCatalogState === 'error' && `${copilotCatalogNote} Yalnızca Otomatik seçilebilir.`}
        </p>
      </div>
    )
  }

  function renderClaudeModelSelect() {
    const selected = claudeModels.find((item) => item.value === claudeModel)
    const premium = claudeStatus.runnable && isPremiumClaudeModel(selected?.resolvedModel ?? selected?.value ?? effectiveDefaultClaude)
    return (
      <div className="field-grow">
        <label htmlFor="claude-model">Claude modeli</label>
        <select
          id="claude-model"
          value={claudeModel}
          disabled={isLoading || !claudeStatus.runnable || claudeModelsState === 'loading'}
          onChange={(event) => setClaudeModel(event.target.value)}
          aria-describedby="claude-model-help"
        >
          <option value="">{`Sunucu varsayılanı${effectiveDefaultClaude ? ` (${effectiveDefaultClaude})` : ''}`}</option>
          {claudeModels.filter((item) => item.value !== 'default').map((item) => (
            <option key={item.value} value={item.value}>
              {item.displayName}{item.resolvedModel ? ` · ${item.resolvedModel}` : ''}
            </option>
          ))}
        </select>
        <p className={`helper ${claudeModelsState === 'error' ? 'warning' : ''}`} id="claude-model-help">
          {!claudeStatus.runnable && 'Claude yapılandırıldığında kurulu Agent SDK’nın kabul ettiği modeller listelenir.'}
          {claudeStatus.runnable && claudeModelsState === 'loading' && 'Claude model listesi alınıyor (modele mesaj gönderilmez)…'}
          {claudeStatus.runnable && claudeModelsState === 'error' && `${claudeModelsNote} Sunucu varsayılanı kullanılabilir.`}
          {claudeStatus.runnable && claudeModelsState === 'ready' && 'Liste kurulu Claude Agent SDK/CLI’den gelir. Çağrılar Anthropic API hesabınızdan ücretlendirilir.'}
        </p>
        {premium && (
          <p className="helper warning">
            {claudeModel
              ? 'Seçtiğiniz model yüksek maliyetli model ailesindendir (Opus/Fable).'
              : `Seçim yapmazsanız ${effectiveDefaultClaude ?? 'SDK varsayılan modeli'} kullanılır; bu, yüksek maliyetli model ailesinden olabilir.`}
            {' '}Demo için daha düşük maliyetli bir model (ör. Haiku) seçebilirsiniz; model kendiliğinden değiştirilmez.
          </p>
        )}
      </div>
    )
  }

  function renderPlayground() {
    return (
      <div className="page-stack">
        <section className="panel">
          <SectionHeading
            eyebrow="SAĞLAYICI / ÇALIŞMA ZAMANI KARŞILAŞTIRMASI"
            title="Copilot ve Claude karşılaştırması"
            tags={<><DataTag kind="real">SDK ölçümleri</DataTag><DataTag kind="estimate">Claude USD</DataTag></>}
            text="Aynı görevi iki farklı ajan çalışma zamanında çalıştırın; gerçekte kullanılan modeli, token tüketimini, süreyi ve sağlayıcıya özgü kullanım metriklerini karşılaştırın. Sayfa açıldığında hiçbir model çağrısı yapılmaz; çalıştırma yalnızca butonlara bastığınızda başlar."
          />
          <details className="explanation-details">
            <summary>Bu ekranda ne karşılaştırılıyor?</summary>
            <div className="explanation-columns">
              <div>
                <strong>GitHub Copilot</strong>
                <ul>
                  <li>Bir yapay zekâ geliştirme platformu ve ajan çalışma zamanıdır.</li>
                  <li>Copilot SDK isteği yönetir; Otomatik (auto) modunda gerçek modeli çalışma zamanı seçer.</li>
                  <li>Kullanım GitHub AI Credit ve SDK metrikleriyle ölçülür.</li>
                </ul>
              </div>
              <div>
                <strong>Claude</strong>
                <ul>
                  <li>Anthropic Claude, Claude Agent SDK üzerinden doğrudan çalıştırılır.</li>
                  <li>GitHub Copilot katmanı kullanılmaz.</li>
                  <li>Kullanım token ve SDK’nın USD maliyet tahminiyle ölçülür.</li>
                </ul>
              </div>
            </div>
          </details>
          <details className="explanation-details">
            <summary>Bu araç nasıl çalışıyor?</summary>
            <div className="execution-flow">
              <p><strong>Copilot:</strong> Görev <span>→</span> GitHub Copilot SDK <span>→</span> model seçimi <span>→</span> gerçek model <span>→</span> yanıt + AI Credit</p>
              <p><strong>Claude:</strong> Görev <span>→</span> Claude Agent SDK <span>→</span> Claude modeli <span>→</span> yanıt + token / USD tahmini</p>
              <p>Her iki tarafta da dosya, terminal, ağ ve MCP araçları kapalıdır.</p>
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
              aria-describedby="prompt-meta"
            />
            <div className="form-meta" id="prompt-meta"><span>En fazla 12.000 karakter · tam metin kaydedilmez</span><span>{formatNumber(prompt.length)} / 12.000</span></div>
            <div className="inline-fields">
              <div className="field-grow">
                <label htmlFor="strategy">Copilot çalıştırma yöntemi</label>
                <select id="strategy" value={strategy} disabled={isLoading} onChange={(event) => setStrategy(event.target.value as Strategy)}>
                  {strategies.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select>
                <p className="helper">{strategies.find((item) => item.id === strategy)?.hint}</p>
              </div>
              <div className="limit-field">
                <label htmlFor="credit-limit">Copilot en fazla AI Credit</label>
                <input
                  id="credit-limit"
                  type="number"
                  min="0.000001"
                  step="any"
                  value={maxAiCreditLimit}
                  disabled={isLoading}
                  onChange={(event) => setMaxAiCreditLimit(event.target.value)}
                  placeholder="İsteğe bağlı"
                  aria-describedby="credit-limit-help"
                />
                <p className="helper" id="credit-limit-help">Sınırı SDK uygular; aşılırsa çalıştırma durdurulur.</p>
              </div>
            </div>
            <div className="inline-fields">
              {renderCopilotModelSelect('playground')}
              {renderClaudeModelSelect()}
            </div>
            {strategy === 'skill' && <InfoNote title="Copilot Skill">Yalnızca Copilot tarafında etkinleştirilir; kullanıldığı yalnızca SDK’nın skill olayıyla doğrulanır.</InfoNote>}
            {strategy === 'subagents' && <InfoNote title="Copilot alt ajanları">Yalnızca Copilot tarafında etkinleştirilir; gerçek SDK olayları raporlanır.</InfoNote>}
            {strategy === 'fleet' && <InfoNote title="Deneysel Copilot Fleet">Fleet yalnızca seçildiğinde çalıştırılır; çalışma zamanı desteklemiyorsa açıklayıcı hata gösterilir.</InfoNote>}
            <div className="provider-controls">
              <button type="button" className="secondary-button" disabled={isLoading || !prompt.trim()} onClick={() => void runProviderComparison(['github-copilot'])}>
                Yalnızca Copilot
              </button>
              <button type="button" className="secondary-button" disabled={isLoading || !prompt.trim()} onClick={() => void runProviderComparison(['claude'])}>
                Yalnızca Claude
              </button>
              <button type="button" className="primary-button" disabled={isLoading || !prompt.trim()} onClick={() => void runProviderComparison(['github-copilot', 'claude'])}>
                {isLoading ? 'Çalıştırmalar sürüyor…' : 'İkisini karşılaştır'}
              </button>
            </div>
            <p className="helper">Copilot AI Credit ve Claude USD tahmini farklı birimlerdir; doğrudan sayısal olarak karşılaştırılmaz.</p>
          </form>
          {playgroundError && <Alert tone="error">{playgroundError}</Alert>}
        </section>
        <section className="provider-results" aria-label="Sağlayıcı sonuçları">
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
    const usage = latestCopilot?.usage
    const quotaEntries = isRecord(quota?.quotas) ? Object.entries(quota.quotas) : []
    return (
      <div className="page-stack">
        <section className="panel">
          <SectionHeading
            eyebrow="SON COPILOT OTURUMU"
            title="Kullanım analizi"
            tags={<DataTag kind="real">SDK ölçümü</DataTag>}
            text="Son başarılı Copilot çalıştırmasının SDK ölçümleri. Bildirilmeyen metrikler “Bilinmiyor” olarak gösterilir. Tüm sağlayıcıların kayıtları aşağıdaki geçmişte yer alır."
          />
          {!latestCopilotLoaded ? <LoadingState>Son ölçüm yükleniyor…</LoadingState> : latestCopilot && usage ? (
            <>
              <p className="helper">{`Kayıt zamanı: ${formatDateTime(latestCopilot.createdAt)} · görev: “${latestCopilot.label}”`}</p>
              <div className="metric-grid">
                <Metric label="İstenen model" value={formatModelLabel(latestCopilot.requestedModel)} />
                <Metric label="Gerçekleşen model" value={formatModelLabel(latestCopilot.actualModel ?? latestCopilot.model)} />
                <Metric label="Model çağrısı" value={formatNumber(usage.modelCalls)} />
                <Metric label="Girdi token" value={formatNumber(usage.inputTokens)} />
                <Metric label="Çıktı token" value={formatNumber(usage.outputTokens)} />
                <Metric label="Toplam token" value={formatNumber(sumIfKnown(usage.inputTokens, usage.outputTokens))} />
                <Metric label="AI Credit" value={formatCredits(usage.aiCredits)} note="nano-AIU ÷ 10⁹" />
                <Metric label="Süre" value={formatDuration(usage.durationMs)} />
                <Metric label="Araç çağrısı" value={formatNumber(usage.toolCalls)} />
              </div>
              <div className="split-panels">
                <div className="subpanel">
                  <h3>Model kırılımı</h3>
                  {usage.modelMetrics.length ? usage.modelMetrics.map((model) => {
                    const total = model.inputTokens + model.outputTokens
                    const overall = sumIfKnown(usage.inputTokens, usage.outputTokens)
                    return (
                      <div className="breakdown-row" key={model.id}>
                        <span>{model.id}</span><span>{formatNumber(total)} token</span>
                        <div className="bar-track" aria-hidden="true"><div className="bar-fill" style={{ width: `${overall ? Math.min(100, (total / Math.max(1, overall)) * 100) : 0}%` }} /></div>
                      </div>
                    )
                  }) : <p className="helper">Bu çalıştırma için SDK model kırılımı bildirmedi.</p>}
                </div>
                <div className="subpanel">
                  <h3>Bağlam penceresi</h3>
                  {usage.context ? (
                    <>
                      <div className="context-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.context.percentage ?? 0)} aria-label="Bağlam kullanımı">
                        <div style={{ width: `${Math.min(100, usage.context.percentage ?? 0)}%` }} />
                      </div>
                      <p>{formatNumber(usage.context.currentTokens)} / {formatNumber(usage.context.tokenLimit)} token</p>
                    </>
                  ) : <p className="helper">SDK bu çalıştırmada bağlam kullanım olayı bildirmedi.</p>}
                </div>
              </div>
              <div className="subpanel timeline">
                <h3>Ajan ve araç etkinliği</h3>
                {latestCopilot.events?.length ? latestCopilot.events.map((event) => (
                  <div className="timeline-row" key={event.id}>
                    <span className="timeline-dot" aria-hidden="true" />
                    <span>{event.label}</span>
                    <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString('tr-TR')}</time>
                  </div>
                )) : <p className="helper">SDK etkinlik kaydı bildirmedi.</p>}
              </div>
            </>
          ) : <EmptyState title="Henüz Copilot ölçümü yok" text="Oyun Alanı’nda bir Copilot çalıştırması yaptığınızda gerçek SDK ölçümleri burada görünür." />}
        </section>

        <section className="panel">
          <SectionHeading
            eyebrow="HESAP DURUMU"
            title="Copilot kotası"
            tags={<><DataTag kind="real">anlık değer</DataTag><DataTag kind="info">deneysel SDK RPC</DataTag></>}
            text="Kota, istek anında deneysel Copilot SDK hesap RPC’sinden alınır. Sürekli/gerçek zamanlı izleme yapılmaz; güncel değer için yenileyin."
          />
          <div className="toolbar-actions">
            <button type="button" className="secondary-button" onClick={() => void loadQuota()} disabled={quotaLoading}>
              {quotaLoading ? 'Alınıyor…' : 'Kotayı yenile'}
            </button>
            {typeof quota?.fetchedAt === 'string' && <span className="helper">Son alınma: {formatDateTime(quota.fetchedAt)}</span>}
          </div>
          {quotaLoading && !quota ? <LoadingState>Kota bilgisi alınıyor…</LoadingState> : quotaEntries.length ? (
            <div className="metric-grid">
              {quotaEntries.map(([name, value]) => {
                const item = isRecord(value) ? value : {}
                const remaining = typeof item.remainingPercentage === 'number' ? item.remainingPercentage : undefined
                const label = name === 'premium_interactions' ? 'Eski premium istek kotası (uyumluluk)' : `Kota: ${name.replaceAll('_', ' ')}`
                const note = typeof item.usedRequests === 'number' && typeof item.entitlementRequests === 'number'
                  ? `Kullanım: ${formatNumber(item.usedRequests)} / ${formatNumber(item.entitlementRequests)}`
                  : typeof item.resetDate === 'string' ? `Yenilenme: ${formatDateTime(item.resetDate)}` : 'Yenilenme tarihi bildirilmedi'
                return (
                  <Metric
                    key={name}
                    label={label}
                    value={item.isUnlimitedEntitlement === true ? 'Sınırsız' : remaining === undefined ? UNKNOWN : `%${formatNumber(remaining)} kaldı`}
                    note={note}
                  />
                )
              })}
            </div>
          ) : (
            <EmptyState
              title="Kota verisi kullanılamıyor"
              text={typeof quota?.message === 'string' ? quota.message : 'Bu hesap veya SDK sürümü kota bilgisini sunmadı; uygulamanın geri kalanı çalışmaya devam eder.'}
            />
          )}
        </section>

        <HistoryPanel refreshKey={historyRefreshKey} onChanged={bumpHistory} />
      </div>
    )
  }

  function renderAdvisor() {
    return (
      <div className="content-grid">
        <section className="panel">
          <SectionHeading
            eyebrow="KURAL TABANLI · MODEL ÇAĞRISI YOK"
            title="Mod danışmanı"
            tags={<DataTag kind="rules">yerel karar kuralları</DataTag>}
            text="Öneri yerel karar kurallarıyla hesaplanır; danışmanlık için model çağrılmaz ve AI Credit harcanmaz."
          />
          <form className="stack-form" onSubmit={handleAdvisor}>
            <label htmlFor="advisor-task">Görev açıklaması</label>
            <textarea id="advisor-task" rows={4} required value={advisorTask} onChange={(event) => setAdvisorTask(event.target.value)} placeholder="Örn. Ön yüzü, API'yi ve veritabanı geçişini ayrı ayrı incele…" />
            <label htmlFor="complexity">Görev boyutu</label>
            <select id="complexity" value={advisorComplexity} onChange={(event) => setAdvisorComplexity(event.target.value)}>
              <option value="small">Küçük</option><option value="medium">Orta</option><option value="large">Büyük</option>
            </select>
            <fieldset className="question-grid">
              <legend className="visually-hidden">Görev gereksinimleri</legend>
              {advisorQuestions.map(([key, question]) => (
                <label className="check-row" key={key}>
                  <input
                    type="checkbox"
                    checked={advisorAnswers[key] === true}
                    onChange={(event) => setAdvisorAnswers((current) => ({ ...current, [key]: event.target.checked }))}
                  />
                  {question}
                </label>
              ))}
            </fieldset>
            <button className="primary-button" disabled={!advisorTask.trim() || advisorLoading}>{advisorLoading ? 'Hesaplanıyor…' : 'Öneri oluştur'}</button>
          </form>
          {advisorError && <Alert tone="error">{advisorError}</Alert>}
        </section>
        <section className="panel" aria-live="polite">
          <SectionHeading eyebrow="SONUÇ" title="Önerilen yaklaşım" />
          {recommendation
            ? <RecommendationCard recommendation={recommendation} />
            : <EmptyState title="Henüz öneri yok" text="Görev ve gereksinimleri girerek yerel, kural tabanlı öneri alın." />}
        </section>
      </div>
    )
  }

  function renderComparison() {
    return (
      <section className="panel">
        <SectionHeading
          eyebrow="GERÇEK ÇALIŞTIRMALAR"
          title="Karşılaştırma laboratuvarı"
          tags={<DataTag kind="real">SDK ölçümleri</DataTag>}
          text="Aynı görev seçilen Copilot yöntemleriyle sırayla, ayrı oturumlarda çalıştırılır. Birden fazla yöntem seçildiğinde başlamadan önce onay istenir."
        />
        <form className="stack-form" onSubmit={handleComparison}>
          <label htmlFor="comparison-task">Karşılaştırılacak görev</label>
          <textarea id="comparison-task" rows={4} required value={comparisonTask} onChange={(event) => setComparisonTask(event.target.value)} placeholder="Seçilen tüm yöntemlere aynı görev gönderilir." disabled={isLoading} />
          <div className="inline-fields">{renderCopilotModelSelect('lab')}</div>
          <fieldset className="question-grid">
            <legend className="visually-hidden">Çalıştırma yöntemleri</legend>
            {strategies.map((item) => (
              <label className="check-row" key={item.id}>
                <input
                  type="checkbox"
                  checked={comparisonStrategies.includes(item.id)}
                  onChange={() => setComparisonStrategies((current) =>
                    current.includes(item.id) ? current.filter((entry) => entry !== item.id) : [...current, item.id])}
                  disabled={isLoading}
                />
                {item.title} <span className="helper">{item.hint}</span>
              </label>
            ))}
          </fieldset>
          {comparisonStrategies.includes('fleet') && <p className="helper warning">Fleet deneysel bir SDK özelliğidir; yalnızca siz çalıştırdığınızda çağrılır.</p>}
          <button className="primary-button" disabled={isLoading || !comparisonStrategies.length || !comparisonTask.trim()}>
            {isLoading ? 'Çalıştırmalar sürüyor…' : `Seçilen ${comparisonStrategies.length} yöntemi çalıştır`}
          </button>
        </form>
        {isLoading && <LoadingState>{`Çalıştırılıyor: ${comparisonResults.length + 1} / ${comparisonStrategies.length}`}</LoadingState>}
        {labError && <Alert tone="error">{labError}</Alert>}
        {comparisonResults.length > 0 && <ComparisonTable results={comparisonResults} />}
      </section>
    )
  }

  function renderLicensing() {
    const plan = licensePlans.find((item) => item.id === licensePlan)
    const organization = plan?.accountType === 'organization'
    return (
      <div className="content-grid">
        <section className="panel">
          <SectionHeading
            eyebrow="PLAN VERİSİ + AÇIK VARSAYIMLAR"
            title="Lisans ve maliyet"
            tags={<><DataTag kind="estimate">hesaplama</DataTag><DataTag kind="example">plan fiyatları belgeden</DataTag></>}
            text="Koltuk ücreti ile AI Credit kullanımını ayrı hesaplar. Plan fiyatları ve tahsisatlar GitHub belgelerinden elle girilmiştir ve değişmiş olabilir; tüm değerleri kendi teklifinize göre düzenleyebilirsiniz."
          />
          <form className="stack-form" onSubmit={handleLicense}>
            <label htmlFor="license-plan">Plan</label>
            <select id="license-plan" value={licensePlan} onChange={(event) => handlePlanChange(event.target.value)} disabled={!licensePlans.length}>
              <optgroup label="Bireysel">{licensePlans.filter((item) => item.accountType === 'individual').map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup>
              <optgroup label="Kuruluş">{licensePlans.filter((item) => item.accountType === 'organization').map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup>
            </select>
            <label htmlFor="seat-count">{organization ? 'Geliştirici / koltuk sayısı' : 'Kullanıcı sayısı'}</label>
            <input id="seat-count" type="number" min="1" max="100000" step="1" value={seats} onChange={(event) => setSeats(event.target.value)} required />
            <label htmlFor="seat-price">Koltuk fiyatı (USD / kullanıcı / ay)</label>
            <input
              id="seat-price"
              type="number"
              min="0"
              step="any"
              value={seatPrice}
              onChange={(event) => { setSeatPrice(event.target.value); setSeatPriceEdited(true) }}
              placeholder={plan?.monthlySeatPriceUsd === null ? 'Teklif fiyatınızı girin' : undefined}
              aria-describedby="seat-price-help"
            />
            <p className="helper" id="seat-price-help">
              {plan?.monthlySeatPriceUsd === null
                ? 'Bu planın fiyatı teklife göre değişir; fiyat girilmezse abonelik toplamı hesaplanmaz.'
                : seatPriceEdited ? 'Sizin girdiğiniz değer kullanılacak.' : 'Plan verisindeki değer; değiştirebilirsiniz.'}
            </p>
            <label htmlFor="included-credits">Dahil AI Credit / kullanıcı / ay</label>
            <input
              id="included-credits"
              type="number"
              min="0"
              step="any"
              value={includedCredits}
              onChange={(event) => { setIncludedCredits(event.target.value); setIncludedCreditsEdited(true) }}
              required
            />
            <label htmlFor="expected-credits">Beklenen AI Credit / kullanıcı / ay</label>
            <input id="expected-credits" type="number" min="0" step="any" value={expectedCredits} onChange={(event) => setExpectedCredits(event.target.value)} required />
            <fieldset className="measured-fieldset">
              <legend>Gerçek ölçümden tahmin <DataTag kind="real">son Copilot çalıştırması</DataTag></legend>
              <label htmlFor="runs-per-month">Kullanıcı başına aylık çalıştırma varsayımı</label>
              <div className="inline-fields">
                <input id="runs-per-month" type="number" min="0" step="1" value={runsPerMonth} onChange={(event) => setRunsPerMonth(event.target.value)} />
                <button className="secondary-button" type="button" onClick={applyMeasuredCredits}>Gerçek oturum ölçümünden hesapla</button>
              </div>
              <p className="helper">
                {latestCopilot?.usage?.aiCredits !== undefined
                  ? `Son ölçüm: ${formatCredits(latestCopilot.usage.aiCredits)} (${formatDateTime(latestCopilot.createdAt)}). Bu değeri aylık çalıştırma sayısıyla çarpar; son çalıştırmanın temsili olduğu varsayılır.`
                  : 'Henüz AI Credit ölçümü olan bir Copilot çalıştırması yok.'}
              </p>
            </fieldset>
            <button className="primary-button" disabled={!licensePlans.length}>Maliyeti hesapla</button>
          </form>
          {licenseNotice && <Alert tone="info">{licenseNotice}</Alert>}
          {licenseError && <Alert tone="error">{licenseError}</Alert>}
        </section>
        <section className="panel" aria-live="polite">
          <SectionHeading eyebrow="HESAPLAMA" title={plan?.name ?? 'Plan'} />
          {licenseResult
            ? <LicenseSummary result={licenseResult} lastVerified={pricing?.lastVerified} />
            : <EmptyState title="Hesaplama bekleniyor" text="Kullanıcı sayısını ve beklenen aylık AI Credit miktarını girip hesaplayın." />}
          {pricing && (
            <div className="source-note">
              Plan verisinin son doğrulama tarihi: <strong>{pricing.lastVerified}</strong>. Fiyatlar değişebilir; resmî kaynaklar:{' '}
              {pricing.sources.map((source, index) => (
                <span key={source}>{index > 0 && ', '}<a href={source} target="_blank" rel="noreferrer">kaynak {index + 1}</a></span>
              ))}.
            </div>
          )}
        </section>
      </div>
    )
  }

  function renderFeatures() {
    return (
      <div className="page-stack">
        <div className="tag-row"><DataTag kind="info">genel açıklamalar; ölçüm verisi değildir</DataTag></div>
        <div className="feature-grid">
          {featureCards.map((feature) => (
            <article className="panel feature-card" key={feature.title}>
              <span className="feature-mark" aria-hidden="true">✳</span>
              <h2>{feature.title}</h2>
              <p>{feature.what}</p>
              <dl>
                <dt>Ne zaman kullanılır?</dt><dd>{feature.when}</dd>
                <dt>Ne zaman kullanılmamalı?</dt><dd>{feature.avoid}</dd>
                <dt>Kullanım etkisi</dt><dd>{feature.cost}</dd>
              </dl>
            </article>
          ))}
        </div>
      </div>
    )
  }

  const currentSection = sections.find((item) => item.id === activeSection) ?? sections[0]
  const [copilotTone, copilotText] = copilotStatus(health, healthError)
  const [claudeStatusTone, claudeStatusText] = claudeTone(claudeStatus)
  const databaseTone: StatusTone = !health ? (healthError ? 'error' : 'pending') : health.database.persistent ? 'ok' : 'warning'
  const databaseText = !health ? (healthError ? 'Bilinmiyor' : 'Denetleniyor') : health.database.persistent ? 'Kalıcı (SQLite)' : 'Kalıcı değil (bellek)'

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">İçeriğe geç</a>
      <aside className="sidebar">
        <a className="brand" href="#oyun-alani" onClick={(event) => { event.preventDefault(); setActiveSection('playground') }}>
          <span className="brand-icon" aria-hidden="true">✳</span>
          <span><strong>Copilot Kullanım Gezgini</strong><small>USAGE & FEATURE EXPLORER</small></span>
        </a>
        <p className="nav-caption">ÇALIŞMA ALANI</p>
        <nav aria-label="Ana gezinme">
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${activeSection === item.id ? 'active' : ''}`}
              aria-current={activeSection === item.id ? 'page' : undefined}
              onClick={() => setActiveSection(item.id)}
            >
              <span aria-hidden="true">{item.icon}</span>{item.title}
            </button>
          ))}
        </nav>
        <div className="sidebar-status" aria-live="polite">
          <p className="nav-caption">BAĞLANTI DURUMU</p>
          <div className="sidebar-status-row"><span>GitHub Copilot</span><StatusBadge tone={copilotTone}>{copilotText}</StatusBadge></div>
          <div className="sidebar-status-row"><span>Claude</span><StatusBadge tone={claudeStatusTone}>{claudeStatusText}</StatusBadge></div>
          <div className="sidebar-status-row"><span>Geçmiş</span><StatusBadge tone={databaseTone}>{databaseText}</StatusBadge></div>
          <button type="button" className="sidebar-refresh" onClick={() => void refreshHealth()}>Durumu yenile</button>
          <small>{health ? `Son kontrol: ${new Date(health.checkedAt).toLocaleTimeString('tr-TR')}` : healthError || 'Denetleniyor…'}</small>
        </div>
      </aside>
      <main className="main-area" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <div>
            <p className="eyebrow">GITHUB COPILOT KULLANIM VE ÖZELLİK GEZGİNİ</p>
            <h1>{currentSection.title}</h1>
          </div>
          <div className="topbar-badge">{currentSection.badge}</div>
        </header>
        {healthError && !health && (
          <div className="page-alert"><Alert tone="error" title="API sunucusuna ulaşılamıyor">{healthError}</Alert></div>
        )}
        {health && !health.database.persistent && (
          <div className="page-alert"><Alert tone="warning" title="Kullanım geçmişi kalıcı kaydedilemiyor">{health.database.message}</Alert></div>
        )}
        <div className="page-content">
          {activeSection === 'playground' && renderPlayground()}
          {activeSection === 'usage' && renderUsage()}
          {activeSection === 'advisor' && renderAdvisor()}
          {activeSection === 'comparison' && renderComparison()}
          {activeSection === 'licensing' && renderLicensing()}
          {activeSection === 'reports' && <ReportsSection refreshKey={historyRefreshKey} />}
          {activeSection === 'features' && renderFeatures()}
        </div>
      </main>
    </div>
  )
}

export default App
