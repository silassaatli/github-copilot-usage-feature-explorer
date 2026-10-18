import {
  formatCredits,
  formatDecimal,
  formatDuration,
  formatModelLabel,
  formatNumber,
  formatUsd,
  providerLabel,
  sumIfKnown,
  UNKNOWN,
} from '../lib/format'
import { strategyLabel } from '../content/strategies'
import type { ClaudeStatus, ComparisonSummary, Execution, ProviderExecution, ProviderId, Strategy } from '../types'
import { Alert, DataTag, EmptyState, LoadingState, Metric, SectionHeading } from './ui'

function providerValueLabel(value: ProviderId | 'tie' | undefined) {
  if (!value) return 'Karşılaştırılamıyor'
  if (value === 'tie') return 'Eşit'
  return providerLabel(value)
}

export function ProviderResultCard({
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
  const metrics: Array<[string, string]> = [
    ['Girdi token', formatNumber(execution?.inputTokens)],
    ['Çıktı token', formatNumber(execution?.outputTokens)],
    ['Önbellek token', formatNumber(execution?.cachedTokens)],
    ...(execution?.cacheCreationTokens !== undefined
      ? [['Önbellek yazma tokenı', formatNumber(execution.cacheCreationTokens)] as [string, string]]
      : []),
    ['Akıl yürütme token', formatNumber(execution?.reasoningTokens)],
    ...(!isCopilot ? [['Tur sayısı', formatNumber(execution?.numTurns)] as [string, string]] : []),
    ['Model çağrısı', formatNumber(execution?.modelCalls)],
    ['Araç çağrısı', formatNumber(execution?.toolCalls)],
    ['Süre', formatDuration(execution?.durationMs)],
    isCopilot
      ? ['AI Credit', formatCredits(execution?.providerCostUnit === 'AI Credit' ? execution.providerCost : undefined)]
      : ['Tahmini maliyet (USD)', formatUsd(execution?.providerCostUnit === 'USD' ? execution.providerCost : undefined)],
    ...(isCopilot
      ? [
          ['Bağlam kullanımı', execution?.contextUtilization === undefined ? UNKNOWN : `%${execution.contextUtilization.toFixed(1)}`] as [string, string],
          ['Kullanılan Skills', execution?.skillsUsed?.join(', ') || 'Yok'] as [string, string],
          ['Alt ajan', formatNumber(execution?.subagentsUsed)] as [string, string],
        ]
      : []),
  ]
  const claudeBlocked = !isCopilot && !claudeStatus.runnable

  return (
    <article className={`panel provider-card ${isCopilot ? 'provider-copilot' : 'provider-claude'}`} aria-live="polite" aria-busy={isLoading}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SAĞLAYICI ÇALIŞTIRMA SONUCU</p>
          <h2>{providerLabel(provider)}</h2>
          <p>{isCopilot ? 'GitHub Copilot SDK' : 'Claude Agent SDK'}</p>
        </div>
        <span className={`status-pill ${claudeBlocked ? 'status-unavailable' : !isCopilot && !claudeStatus.verified ? 'status-pill-pending' : ''}`}>
          {isCopilot ? 'Copilot çalışma zamanı' : claudeStatus.message}
        </span>
      </div>
      <div className="model-resolution">
        <div><span>Model seçimi</span><strong>{selectedModelLabel}</strong></div>
        <div>
          <span>{isCopilot ? 'Copilot’un gerçekte kullandığı model' : 'Gerçekte kullanılan model'}</span>
          <strong>{execution?.actualModel ?? (execution && !execution.error ? UNKNOWN : 'Çalıştırma sonrasında gösterilir')}</strong>
        </div>
      </div>
      {isLoading && <LoadingState>{providerLabel(provider)} yanıtı bekleniyor…</LoadingState>}
      {!execution && !isLoading && (
        claudeBlocked
          ? <ClaudeSetupNotice status={claudeStatus} />
          : <EmptyState
              title="Henüz çalıştırma yok"
              text={isCopilot
                ? 'Çalıştırdığınızda SDK’nın ölçtüğü gerçek model ve kullanım burada görünür. Copilot kullanımı AI Credit tüketebilir.'
                : 'Çalıştırdığınızda Claude yanıtı ve Agent SDK ölçümleri burada görünür. Her çalıştırma Anthropic API hesabınızdan ücretlendirilir.'}
            />
      )}
      {execution?.error && (
        claudeBlocked
          ? <ClaudeSetupNotice status={claudeStatus} />
          : (
            <div className="provider-unavailable" role="alert">
              <strong>{execution.error}</strong>
              {execution.errorCode && <small>Hata kodu: {execution.errorCode}</small>}
              {execution.setupHint && <p>{execution.setupHint}</p>}
            </div>
          )
      )}
      {execution && !execution.error && (
        <>
          <div className="tag-row">
            <DataTag kind="real">SDK ölçümü</DataTag>
            {!isCopilot && execution.providerCost !== undefined && <DataTag kind="estimate">USD maliyet</DataTag>}
          </div>
          {isCopilot && <p className="helper model-explanation">GitHub Copilot tek bir model değildir; Otomatik (auto) seçiminde uygun modeli çalışma zamanı seçer.</p>}
          <div className="response-copy">
            <p className="eyebrow">YANIT</p>
            <p>{execution.response || 'Yanıt metni bildirilmedi.'}</p>
          </div>
          <div className="provider-metrics">
            {metrics.map(([label, value]) => <Metric key={label} label={label} value={value} />)}
          </div>
          {execution.providerCostSource && <p className="helper">{execution.providerCostSource}. Maliyet tahminidir, fatura değildir.</p>}
          {execution.events.length > 0 && (
            <div className="event-list">
              <h3>Ajan ve araç etkinliği</h3>
              {execution.events.map((item, index) => (
                <div className="timeline-row" key={`${item.type}-${index}`}>
                  <span className="timeline-dot" aria-hidden="true" /><span>{item.label}</span>
                  {item.timestamp && <time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleTimeString('tr-TR')}</time>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </article>
  )
}

export function ClaudeSetupNotice({ status }: { status: ClaudeStatus }) {
  if (status.state === 'checking') return <LoadingState>Claude bağlantı durumu denetleniyor…</LoadingState>
  if (status.state === 'unreachable') {
    return <Alert tone="error" title="API sunucusuna ulaşılamıyor">Claude durumu alınamadı. Sunucunun çalıştığını kontrol edin.</Alert>
  }
  const heading = status.state === 'invalid_key_format'
    ? 'Claude anahtar türü uygun değil'
    : status.state === 'sdk_unavailable'
      ? 'Claude Agent SDK kullanılamıyor'
      : 'Claude yapılandırılmamış'
  const setupText = status.state === 'sdk_unavailable'
    ? 'Claude Agent SDK yüklemesini ve API sunucusunu kontrol edin.'
    : status.state === 'invalid_key_format'
      ? 'ANTHROPIC_API_KEY bir OAuth veya Admin anahtarı içeriyor; Claude için Anthropic Console API anahtarı gerekir.'
      : 'Claude’u çalıştırmak için sunucu tarafındaki .env dosyasına ANTHROPIC_API_KEY eklenmelidir.'
  return (
    <div className="provider-unavailable claude-setup">
      <strong>{heading}</strong>
      <p>{setupText}</p>
      {status.state !== 'sdk_unavailable' && (
        <ol>
          <li>Anthropic Console’da (API Keys) bir API anahtarı oluşturun.</li>
          <li>Proje kökünde <code>.env.example</code> dosyasını <code>.env</code> olarak kopyalayın.</li>
          <li><code>ANTHROPIC_API_KEY=...</code> satırına anahtarı yazın; anahtar yalnızca sunucuda kalır.</li>
          <li><code>npm run dev</code> ile uygulamayı yeniden başlatın.</li>
        </ol>
      )}
      {status.setupHint && <small>{status.setupHint}</small>}
    </div>
  )
}

export function ComparisonSummaryCard({ summary }: { summary: ComparisonSummary }) {
  const rows: Array<[string, ProviderId | 'tie' | undefined]> = [
    ['Daha hızlı', summary.faster],
    ['Daha az girdi tokenı', summary.fewerInputTokens],
    ['Daha az çıktı tokenı', summary.fewerOutputTokens],
    ['Daha az toplam token', summary.fewerTotalTokens],
    ['Daha az model çağrısı', summary.fewerModelCalls],
    ['Daha az araç çağrısı', summary.fewerToolCalls],
  ]
  return (
    <section className="panel comparison-summary">
      <SectionHeading
        eyebrow="ORTAK ÖLÇÜTLER"
        title="Sonuçların özeti"
        tags={<DataTag kind="real">iki tarafta da ölçülenler</DataTag>}
        text="Yalnızca iki sağlayıcının da bildirdiği metrikler karşılaştırılır; biri eksikse “Karşılaştırılamıyor” yazar. Yanıt kalitesi hakkında hüküm verilmez."
      />
      <div className="summary-metrics">
        {rows.map(([label, value]) => <Metric key={label} label={label} value={providerValueLabel(value)} />)}
      </div>
      <h3>Sağlayıcı kullanımı · farklı birimler</h3>
      <p className="helper">Copilot AI Credit (SDK ölçümü) ile Claude USD (SDK tahmini) farklı birimlerdir; birbirine dönüştürülmez ve karşılaştırılmaz.</p>
      <div className="summary-costs">
        {summary.costs.map((item) => (
          <Metric
            key={item.provider}
            label={providerLabel(item.provider)}
            value={item.unit === 'USD' ? `${formatUsd(item.amount)} (tahmin)` : formatCredits(item.amount)}
          />
        ))}
        {!summary.costs.length && <p className="helper">Sağlayıcılar kullanım/maliyet ölçümü bildirmedi.</p>}
      </div>
    </section>
  )
}

export interface ComparisonRow {
  strategy: Strategy
  execution?: Execution
  error?: string
}

export function ComparisonTable({ results }: { results: ComparisonRow[] }) {
  const successful = results.flatMap((row) => (row.execution ? [row.execution.usage] : []))
  const fastest = successful.length ? Math.min(...successful.map((usage) => usage.durationMs)) : undefined
  const knownCredits = successful.flatMap((usage) => (usage.aiCredits === undefined ? [] : [usage.aiCredits]))
  const lowestCredits = knownCredits.length ? Math.min(...knownCredits) : undefined
  return (
    <div className="comparison-output">
      <h3>Gerçek çalıştırma sonuçları <DataTag kind="real">SDK ölçümü</DataTag></h3>
      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">Strateji karşılaştırma sonuçları</caption>
          <thead>
            <tr>
              <th scope="col">Yöntem</th><th scope="col">İstenen model</th><th scope="col">Gerçekleşen model(ler)</th>
              <th scope="col">Süre</th><th scope="col">Model çağrısı</th><th scope="col">Girdi</th><th scope="col">Çıktı</th>
              <th scope="col">Toplam token</th><th scope="col">AI Credit</th><th scope="col">Araç</th><th scope="col">Alt ajan</th>
              <th scope="col">Skill</th><th scope="col">Sonuç</th>
            </tr>
          </thead>
          <tbody>
            {results.map((row) => {
              const result = row.execution
              return (
                <tr key={row.strategy}>
                  <td>{strategyLabel(row.strategy)}</td>
                  {result ? (
                    <>
                      <td>{formatModelLabel(result.requestedModel)}</td>
                      <td>{result.usage.modelMetrics.map((item) => item.id).join(', ') || result.model}</td>
                      <td>{formatDuration(result.usage.durationMs)} {result.usage.durationMs === fastest && <span title="En hızlı">⚡</span>}</td>
                      <td>{formatNumber(result.usage.modelCalls)}</td>
                      <td>{formatNumber(result.usage.inputTokens)}</td>
                      <td>{formatNumber(result.usage.outputTokens)}</td>
                      <td>{formatNumber(sumIfKnown(result.usage.inputTokens, result.usage.outputTokens))}</td>
                      <td>
                        {result.usage.aiCredits === undefined ? UNKNOWN : formatDecimal(result.usage.aiCredits)}
                        {lowestCredits !== undefined && result.usage.aiCredits === lowestCredits && <span title="En az AI Credit"> ↓</span>}
                      </td>
                      <td>{formatNumber(result.usage.toolCalls)}</td>
                      <td>{formatNumber(result.usage.subagentCalls)}</td>
                      <td>{result.usage.skillsInvoked.join(', ') || '—'}</td>
                      <td className="status-text-ok">Başarılı</td>
                    </>
                  ) : <td colSpan={12} className="error-text">Başarısız: {row.error}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="helper">⚡ en hızlı, ↓ en az AI Credit. İşaretler yalnızca gözlenen ölçümü karşılaştırır; yanıt kalitesini ölçmez.</p>
    </div>
  )
}

export interface Recommendation {
  primary: string
  supporting: string[]
  explanation: string
  costCategory: string
  whyNotMore: string
  warnings: string[]
}

export function RecommendationCard({ recommendation }: { recommendation: Recommendation }) {
  return (
    <div className="recommendation">
      <span className="recommendation-badge">ÖNERİ</span>
      <h3>{recommendation.primary}</h3>
      <p>{recommendation.explanation}</p>
      <Metric label="Göreli kullanım kategorisi · tahmin değil" value={recommendation.costCategory} />
      <h4>Destekleyici yetenekler</h4>
      <div className="tag-list">
        {recommendation.supporting.length
          ? recommendation.supporting.map((item) => <span key={item}>{item}</span>)
          : <span>Ek yetenek gerekmiyor</span>}
      </div>
      <h4>Neden daha karmaşık değil?</h4>
      <p>{recommendation.whyNotMore}</p>
      {recommendation.warnings.map((warning) => <p className="helper warning" key={warning}>{warning}</p>)}
    </div>
  )
}

export interface LicenseResult {
  plan: string
  seats: number
  monthlySeatPriceUsd?: number
  seatPriceSource?: 'plan-data' | 'user' | 'missing'
  includedCreditsSource?: 'plan-data' | 'user'
  monthlySubscriptionUsd?: number
  annualSubscriptionUsd?: number
  includedMonthlyAiCredits?: number
  expectedMonthlyAiCredits?: number
  additionalAiCredits?: number
  estimatedAdditionalUsageUsd?: number
  estimatedMonthlyTotalUsd?: number
  perSeatMonthlyAverageUsd?: number
  aiCreditUsd?: number
  includedCreditsNote?: string
}

const sourceLabels: Record<string, string> = {
  'plan-data': 'plan verisi (belgeden)',
  user: 'sizin girdiğiniz değer',
  missing: 'fiyat girilmedi',
}

export function LicenseSummary({ result, lastVerified }: { result: LicenseResult; lastVerified?: string }) {
  const usd = (value: number | undefined) => (value === undefined ? 'Fiyat girilmedi' : formatUsd(value, 2))
  return (
    <div className="license-summary">
      <div className="tag-row"><DataTag kind="estimate">hesaplama</DataTag></div>
      <div className="metric-grid">
        <Metric label="Koltuk fiyatı / ay" value={usd(result.monthlySeatPriceUsd)} note={sourceLabels[result.seatPriceSource ?? 'missing']} />
        <Metric label="Aylık abonelik" value={usd(result.monthlySubscriptionUsd)} />
        <Metric label="Yıllık abonelik" value={usd(result.annualSubscriptionUsd)} note="yalnızca koltuk ücreti × 12" />
        <Metric label="Dahil AI Credit / ay" value={formatNumber(result.includedMonthlyAiCredits)} note={sourceLabels[result.includedCreditsSource ?? 'plan-data']} />
        <Metric label="Beklenen AI Credit / ay" value={formatNumber(result.expectedMonthlyAiCredits)} note="sizin varsayımınız" />
        <Metric label="Ek AI Credit" value={formatNumber(result.additionalAiCredits)} />
        <Metric label="Ek kullanım tahmini" value={usd(result.estimatedAdditionalUsageUsd)} />
        <Metric label="Tahmini aylık toplam" value={usd(result.estimatedMonthlyTotalUsd)} />
      </div>
      <p className="helper">{result.includedCreditsNote}</p>
      <p className="helper">
        {`AI Credit birim fiyatı plan verisinde ${formatUsd(result.aiCreditUsd, 2)} olarak tanımlıdır${lastVerified ? ` (son doğrulama: ${lastVerified})` : ''}. Bu bir tahmindir; güncel fiyatlar için resmî kaynakları kontrol edin. Gerçek oturum ölçümleri bu hesaba yalnızca “Gerçek oturum ölçümünden hesapla” ile siz aktardığınızda girer.`}
      </p>
    </div>
  )
}
