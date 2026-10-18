import { Fragment, useCallback, useEffect, useState } from 'react'
import { Alert, DataTag, EmptyState, LoadingState, SectionHeading } from '../components/ui'
import { errorText, isRecord, postJson, requestJson } from '../lib/api'
import {
  formatCredits,
  formatDateTime,
  formatDuration,
  formatModelLabel,
  formatNumber,
  formatUsd,
  providerLabel,
  sumIfKnown,
  UNKNOWN,
} from '../lib/format'
import { recordMetrics } from '../lib/history'
import type { ProviderId, UsageHistoryRecord } from '../types'

type ProviderFilter = 'all' | ProviderId
type StatusFilter = 'all' | 'success' | 'error'

const strategyLabels: Record<string, string> = {
  normal: 'Normal oturum',
  skill: 'Skill',
  subagents: 'Alt ajanlar',
  fleet: 'Fleet (deneysel)',
}

function costText(record: UsageHistoryRecord) {
  const metrics = recordMetrics(record)
  if (metrics.aiCredits !== undefined) return formatCredits(metrics.aiCredits)
  if (metrics.estimatedUsd !== undefined) return `${formatUsd(metrics.estimatedUsd)} (tahmin)`
  return UNKNOWN
}

export function HistoryPanel({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [provider, setProvider] = useState<ProviderFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [records, setRecords] = useState<UsageHistoryRecord[]>([])
  const [total, setTotal] = useState<number>()
  const [persistent, setPersistent] = useState<boolean>()
  const [retention, setRetention] = useState<number>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState<string>()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const query = new URLSearchParams({ limit: '50' })
    if (provider !== 'all') query.set('provider', provider)
    if (status !== 'all') query.set('status', status)
    try {
      const payload = await requestJson(`/api/usage/history?${query.toString()}`)
      if (!isRecord(payload) || !Array.isArray(payload.executions)) throw new Error('Geçmiş yanıtı beklenen biçimde değil.')
      setRecords(payload.executions as UsageHistoryRecord[])
      setTotal(typeof payload.total === 'number' ? payload.total : undefined)
      setPersistent(typeof payload.persistent === 'boolean' ? payload.persistent : undefined)
      setRetention(typeof payload.retention === 'number' ? payload.retention : undefined)
      setError('')
    } catch (caught) {
      setError(errorText(caught, 'Kullanım geçmişi alınamadı.'))
    } finally {
      setLoading(false)
    }
  }, [provider, status])

  useEffect(() => {
    // Filtre veya dış yenileme sinyali değiştiğinde geçmişi API'den yeniden al.
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
  }, [load, refreshKey])

  async function clearHistory() {
    setDeleting(true)
    try {
      const payload = await postJson('/api/usage/history', { confirm: true }, 'DELETE')
      const deleted = isRecord(payload) && typeof payload.deleted === 'number' ? payload.deleted : 0
      setNotice(`${formatNumber(deleted)} kayıt kalıcı olarak silindi.`)
      setConfirming(false)
      setExpandedId(undefined)
      onChanged()
      await load()
    } catch (caught) {
      setError(errorText(caught, 'Kullanım geçmişi silinemedi.'))
    } finally {
      setDeleting(false)
    }
  }

  const filtered = provider !== 'all' || status !== 'all'
  return (
    <section className="panel" aria-labelledby="history-heading">
      <div id="history-heading">
        <SectionHeading
          eyebrow="ÇALIŞTIRMA GEÇMİŞİ"
          title="Kayıtlı çalıştırmalar"
          tags={<DataTag kind="real">SDK ölçümleri</DataTag>}
          text={persistent === false
            ? 'Veritabanı kullanılamıyor: kayıtlar yalnızca sunucu belleğinde tutuluyor ve sunucu yeniden başlatıldığında kaybolur.'
            : `Kayıtlar yerel SQLite veritabanında kalıcı olarak tutulur${retention ? ` (en fazla ${formatNumber(retention)} kayıt; eskiler otomatik silinir)` : ''}. Tam istem ve yanıt saklanmaz; yalnızca en fazla 80 karakterlik görev etiketi tutulur.`}
        />
      </div>
      {persistent === false && <Alert tone="warning" title="Geçmiş kalıcı değil">Veritabanı açılamadı. Sağlık durumunu kenar çubuğunda görebilirsiniz.</Alert>}

      <div className="history-toolbar">
        <div className="toolbar-field">
          <label htmlFor="history-provider">Sağlayıcı</label>
          <select id="history-provider" value={provider} onChange={(event) => setProvider(event.target.value as ProviderFilter)}>
            <option value="all">Tümü</option>
            <option value="github-copilot">GitHub Copilot</option>
            <option value="claude">Claude</option>
          </select>
        </div>
        <div className="toolbar-field">
          <label htmlFor="history-status">Durum</label>
          <select id="history-status" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
            <option value="all">Tümü</option>
            <option value="success">Başarılı</option>
            <option value="error">Başarısız</option>
          </select>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="secondary-button" onClick={() => void load()} disabled={loading}>Yenile</button>
          <button
            type="button"
            className="danger-button"
            onClick={() => { setConfirming(true); setNotice('') }}
            disabled={deleting || !total || filtered}
            title={filtered ? 'Temizleme tüm geçmişi siler; önce filtreleri “Tümü” yapın.' : undefined}
          >
            Geçmişi temizle
          </button>
        </div>
      </div>

      {confirming && (
        <div className="confirm-box" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-text">
          <strong id="confirm-title">Tüm geçmiş silinsin mi?</strong>
          <p id="confirm-text">{formatNumber(total)} kayıt ve bağlı olay/ölçüm satırları kalıcı olarak silinecek. Bu işlem geri alınamaz. Yedek için README’deki yedekleme adımlarına bakın.</p>
          <div className="confirm-actions">
            <button type="button" className="danger-button" onClick={() => void clearHistory()} disabled={deleting} autoFocus>
              {deleting ? 'Siliniyor…' : 'Evet, kalıcı olarak sil'}
            </button>
            <button type="button" className="secondary-button" onClick={() => setConfirming(false)} disabled={deleting}>Vazgeç</button>
          </div>
        </div>
      )}
      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      {loading && !records.length ? (
        <LoadingState>Geçmiş yükleniyor…</LoadingState>
      ) : records.length ? (
        <>
          <p className="helper">{`${formatNumber(records.length)} kayıt gösteriliyor${total !== undefined ? ` · filtreye uyan toplam ${formatNumber(total)}` : ''}.`}</p>
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Kayıtlı çalıştırmalar</caption>
              <thead>
                <tr>
                  <th scope="col">Zaman</th>
                  <th scope="col">Görev etiketi</th>
                  <th scope="col">Sağlayıcı</th>
                  <th scope="col">Gerçekleşen model</th>
                  <th scope="col">Toplam token</th>
                  <th scope="col">Kullanım / maliyet</th>
                  <th scope="col">Süre</th>
                  <th scope="col">Durum</th>
                  <th scope="col"><span className="visually-hidden">Ayrıntı</span></th>
                </tr>
              </thead>
              <tbody>
                {records.map((item) => {
                  const metrics = recordMetrics(item)
                  const expanded = expandedId === item.id
                  return (
                    <Fragment key={item.id}>
                      <tr className={item.error ? 'row-error' : undefined}>
                        <td>{formatDateTime(item.createdAt)}</td>
                        <td>{item.label}</td>
                        <td>{providerLabel(item.provider)}</td>
                        <td>{item.error ? '—' : formatModelLabel(item.actualModel ?? item.model)}</td>
                        <td>{formatNumber(sumIfKnown(metrics.inputTokens, metrics.outputTokens))}</td>
                        <td>{item.error ? '—' : costText(item)}</td>
                        <td>{formatDuration(metrics.durationMs)}</td>
                        <td>{item.error ? <span className="status-text-error">Başarısız</span> : <span className="status-text-ok">Başarılı</span>}</td>
                        <td>
                          <button
                            type="button"
                            className="link-button"
                            aria-expanded={expanded}
                            aria-controls={`history-detail-${item.id}`}
                            onClick={() => setExpandedId(expanded ? undefined : item.id)}
                          >
                            {expanded ? 'Gizle' : 'Ayrıntı'}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="detail-row">
                          <td colSpan={9} id={`history-detail-${item.id}`}>
                            <HistoryDetail record={item} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <EmptyState
          title={filtered ? 'Filtreye uyan kayıt yok' : 'Geçmiş boş'}
          text={filtered ? 'Filtreleri değiştirerek diğer kayıtları görebilirsiniz.' : 'Oyun Alanı veya Karşılaştırma Laboratuvarı’nda çalıştırma yaptığınızda kayıtlar burada listelenir.'}
        />
      )}
    </section>
  )
}

function HistoryDetail({ record }: { record: UsageHistoryRecord }) {
  const metrics = recordMetrics(record)
  const rows: Array<[string, string]> = [
    ['Kayıt kimliği', record.id],
    ['Karşılaştırma kimliği', record.comparisonId],
    ['Çalıştırma yöntemi', strategyLabels[record.strategy] ?? record.strategy],
    ['İstenen model', record.requestedModel ? formatModelLabel(record.requestedModel) : 'Sunucu/SDK varsayılanı'],
    ['Gerçekleşen model', formatModelLabel(record.actualModel ?? record.model)],
    ['Girdi token', formatNumber(metrics.inputTokens)],
    ['Çıktı token', formatNumber(metrics.outputTokens)],
    ['Önbellek token', formatNumber(metrics.cachedTokens)],
    ['Akıl yürütme token', formatNumber(metrics.reasoningTokens)],
    ['Model çağrısı', formatNumber(metrics.modelCalls)],
    ...(record.provider === 'claude' ? [['Tur sayısı', formatNumber(metrics.numTurns)] as [string, string]] : []),
    ['Araç çağrısı', formatNumber(metrics.toolCalls)],
    ['Süre', formatDuration(metrics.durationMs)],
    record.provider === 'github-copilot'
      ? ['AI Credit (SDK ölçümü)', formatCredits(metrics.aiCredits)]
      : ['Tahmini maliyet (USD, SDK tahmini)', formatUsd(metrics.estimatedUsd)],
  ]
  return (
    <div className="history-detail">
      {record.error && (
        <Alert tone="error" title="Hata">
          {record.error}{record.errorCode ? ` (Hata kodu: ${record.errorCode})` : ''}
        </Alert>
      )}
      <dl className="detail-grid">
        {rows.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
      {metrics.costSource && <p className="helper">Maliyet kaynağı: {metrics.costSource}. Tahmindir, fatura değildir.</p>}
      {record.events?.length ? (
        <div className="event-list">
          <h4>Ajan ve araç etkinliği</h4>
          {record.events.map((event) => (
            <div className="timeline-row" key={event.id}>
              <span className="timeline-dot" aria-hidden="true" />
              <span>{event.label}</span>
              <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString('tr-TR')}</time>
            </div>
          ))}
        </div>
      ) : <p className="helper">Bu kayıt için olay bildirilmedi.</p>}
    </div>
  )
}
