import { useCallback, useEffect, useState } from 'react'
import { Alert, DataTag, EmptyState, LoadingState, Metric, SectionHeading } from '../components/ui'
import { completedItems, knownLimitations, nextSteps, type BacklogItem } from '../content/backlog'
import { errorText, isRecord, requestJson } from '../lib/api'
import {
  formatCredits,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatUsd,
  providerLabel,
} from '../lib/format'
import type { MetricAggregate, ProviderReport, UsageReport } from '../types'

function coverage(aggregate: MetricAggregate, successes: number) {
  return `${formatNumber(aggregate.reported)} / ${formatNumber(successes)} başarılı çalıştırmada bildirildi`
}

function totalOrUnknown(aggregate: MetricAggregate) {
  return aggregate.reported ? aggregate.total : undefined
}

export function ReportsSection({ refreshKey }: { refreshKey: number }) {
  const [report, setReport] = useState<UsageReport>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await requestJson('/api/usage/summary')
      if (!isRecord(payload) || !Array.isArray(payload.providers)) throw new Error('Rapor yanıtı beklenen biçimde değil.')
      setReport(payload as unknown as UsageReport)
      setError('')
    } catch (caught) {
      setError(errorText(caught, 'Kullanım raporu alınamadı.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Rapor, kayıtlı geçmiş değiştiğinde API'den yeniden hesaplanır.
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
  }, [load, refreshKey])

  return (
    <div className="page-stack">
      <section className="panel" aria-labelledby="report-heading">
        <div id="report-heading">
          <SectionHeading
            eyebrow="KULLANIM VE MALİYET RAPORU"
            title="Kayıtlı çalıştırmaların özeti"
            tags={<><DataTag kind="real">kayıtlı geçmişten</DataTag><DataTag kind="estimate">Claude USD</DataTag></>}
            text="Rapor yalnızca bu uygulamada gerçekten yapılmış ve kaydedilmiş çalıştırmalardan hesaplanır. Sağlayıcının bildirmediği değerler toplamlara sıfır olarak eklenmez; her metrikte kaç çalıştırmanın bu değeri bildirdiği gösterilir."
          />
        </div>
        <div className="toolbar-actions">
          <button type="button" className="secondary-button" onClick={() => void load()} disabled={loading}>Raporu yenile</button>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        {loading && !report && <LoadingState>Rapor hazırlanıyor…</LoadingState>}
        {report && (
          <>
            {!report.persistent && (
              <Alert tone="warning" title="Geçmiş kalıcı değil">Veritabanı kullanılamadığı için rapor yalnızca bu sunucu oturumundaki kayıtları içerir.</Alert>
            )}
            <div className="metric-grid">
              <Metric label="Kayıtlı çalıştırma" value={formatNumber(report.totalRuns)} />
              <Metric label="İlk kayıt" value={report.firstRunAt ? formatDateTime(report.firstRunAt) : '—'} />
              <Metric label="Son kayıt" value={report.lastRunAt ? formatDateTime(report.lastRunAt) : '—'} />
              <Metric label="Rapor zamanı" value={formatDateTime(report.generatedAt)} />
            </div>
            {report.providers.length ? (
              <div className="report-grid">
                {report.providers.map((item) => <ProviderReportCard key={item.provider} report={item} />)}
              </div>
            ) : (
              <EmptyState title="Henüz veri yok" text="Bir çalıştırma yaptığınızda rapor gerçek ölçümlerle dolar." />
            )}
            {report.observations.length > 0 && (
              <div className="subpanel">
                <h3>Verilerden çıkan gözlemler</h3>
                <ul className="observation-list">
                  {report.observations.map((item) => (
                    <li key={item.text} className={`observation-${item.level}`}>{item.text}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="helper">
              AI Credit (Copilot) ve tahmini USD (Claude) farklı birimlerdir; birbirine dönüştürülmez ve toplanmaz. Gerçek fatura tutarları için GitHub ve Anthropic faturalandırma sayfalarına bakın.
            </p>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="backlog-heading">
        <div id="backlog-heading">
          <SectionHeading
            eyebrow="KULLANIM ANALİZİ VE İYİLEŞTİRME BACKLOG’U"
            title="Durum, sınırlamalar ve sonraki adımlar"
            tags={<DataTag kind="info">proje notları</DataTag>}
            text="Bu liste uygulamanın mevcut durumunu ve bilinen sınırlamalarını özetler; ayrı bir proje yönetim aracı değildir. Aynı içerik README’de de yer alır."
          />
        </div>
        <div className="backlog-grid">
          <BacklogColumn title="Tamamlananlar" tone="done" items={completedItems} />
          <BacklogColumn title="Bilinen sınırlamalar" tone="limit" items={knownLimitations} />
          <BacklogColumn title="Sonraki geliştirme önerileri" tone="next" items={nextSteps} />
        </div>
      </section>
    </div>
  )
}

function ProviderReportCard({ report }: { report: ProviderReport }) {
  const isCopilot = report.provider === 'github-copilot'
  const averageDuration = report.durationMs.reported ? report.durationMs.total / report.durationMs.reported : undefined
  return (
    <article className={`subpanel report-card ${isCopilot ? 'provider-copilot' : 'provider-claude'}`}>
      <h3>{providerLabel(report.provider)}</h3>
      <p className="helper">
        {`${formatNumber(report.runs)} çalıştırma · ${formatNumber(report.successes)} başarılı · ${formatNumber(report.failures)} başarısız`}
      </p>
      <div className="metric-grid compact">
        <Metric label="Girdi token" value={formatNumber(totalOrUnknown(report.inputTokens))} note={coverage(report.inputTokens, report.successes)} />
        <Metric label="Çıktı token" value={formatNumber(totalOrUnknown(report.outputTokens))} note={coverage(report.outputTokens, report.successes)} />
        <Metric label="Model çağrısı" value={formatNumber(totalOrUnknown(report.modelCalls))} note={coverage(report.modelCalls, report.successes)} />
        {!isCopilot && <Metric label="Tur sayısı" value={formatNumber(totalOrUnknown(report.numTurns))} note={coverage(report.numTurns, report.successes)} />}
        <Metric label="Süre" value={formatDuration(averageDuration)} note="ortalama" />
        {isCopilot
          ? <Metric label="AI Credit" value={formatCredits(totalOrUnknown(report.aiCredits))} note={`SDK ölçümü · ${coverage(report.aiCredits, report.successes)}`} />
          : <Metric label="Tahmini maliyet (USD)" value={formatUsd(totalOrUnknown(report.estimatedCostUsd))} note={`SDK tahmini, fatura değil · ${coverage(report.estimatedCostUsd, report.successes)}`} />}
      </div>
      {report.models.length > 0 && (
        <>
          <h4>Gerçekleşen modeller</h4>
          <ul className="plain-list">
            {report.models.map((item) => <li key={item.model}><code>{item.model}</code> · {formatNumber(item.runs)} çalıştırma</li>)}
          </ul>
        </>
      )}
      {report.errorCodes.length > 0 && (
        <>
          <h4>Hata kodları</h4>
          <ul className="plain-list">
            {report.errorCodes.map((item) => <li key={item.code}><code>{item.code}</code> · {formatNumber(item.count)}</li>)}
          </ul>
        </>
      )}
    </article>
  )
}

function BacklogColumn({ title, tone, items }: { title: string; tone: 'done' | 'limit' | 'next'; items: BacklogItem[] }) {
  return (
    <div className={`backlog-column backlog-${tone}`}>
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item.title}>
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
