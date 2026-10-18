import { useId, type ReactNode } from 'react'

/** Kavramların kısa Türkçe açıklamaları (bilgi simgesinde ve ekran okuyucuda gösterilir). */
const metricDescriptions: Record<string, string> = {
  'Girdi token': 'Token: metnin model tarafından işlenen küçük parçaları. Girdi token, modele gönderilen istem ve bağlam miktarıdır.',
  'Çıktı token': 'Modelin ürettiği yanıtın token cinsinden uzunluğu.',
  'Toplam token': 'Girdi ve çıktı tokenlarının toplamı; ikisinden biri bilinmiyorsa hesaplanmaz.',
  'Önbellek token': 'Sağlayıcının önbellekten (cache) yeniden kullandığı bağlam; genellikle daha düşük ücretlidir.',
  'Önbellek yazma tokenı': 'Sağlayıcının sonraki istekler için önbelleğe yazdığı bağlam miktarı.',
  'Akıl yürütme token': 'Model destekliyorsa yanıt öncesi düşünme (reasoning) için raporlanan token kullanımı.',
  'Model çağrısı': 'Yanıt üretmek için modele yapılan gerçek istek sayısı.',
  'Tur sayısı': 'Claude Agent SDK sonucunun bildirdiği konuşma turu (num_turns).',
  'Araç çağrısı': 'Ajanın araç (tool) kullanma sayısı. Bu uygulamada dosya/terminal araçları kapalıdır.',
  'Süre': 'İsteğin başlangıcından sonuca kadar ölçülen süre.',
  'Bağlam kullanımı': 'Modelin bağlam penceresinin (context window) ne kadarının dolu olduğu.',
  'AI Credit': 'GitHub Copilot’un kullanım birimi. SDK nano-AIU olarak bildirir; 10⁹ nano-AIU = 1 AI Credit. Para birimi değildir.',
  'Tahmini maliyet (USD)': 'Claude Agent SDK’nın token fiyat tablosuna göre hesapladığı tahmin. Fatura değildir.',
  'İstenen model': 'İstekle gönderilen model seçimi.',
  'Gerçekleşen model': 'Sağlayıcının gerçekte kullandığını bildirdiği model.',
  'Alt ajan': 'Ana ajanın görevi devrettiği uzman ajan (subagent) sayısı.',
  'Kullanılan Skills': 'Çalıştırmada SDK olayıyla doğrulanan Skill (yeniden kullanılabilir yönerge) çağrıları.',
}

export function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  const description = metricDescriptions[label]
  const descriptionId = useId()
  return (
    <div className="metric-card">
      <span className="metric-label">
        {label}
        {description && (
          <span className="metric-info" tabIndex={0} title={description} aria-describedby={descriptionId}>
            <span aria-hidden="true">i</span>
            <span className="visually-hidden">Açıklama</span>
          </span>
        )}
      </span>
      {description && <span id={descriptionId} className="visually-hidden">{description}</span>}
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  )
}

export type DataKind = 'real' | 'estimate' | 'example' | 'info' | 'rules'

const dataKindLabels: Record<DataKind, string> = {
  real: 'Gerçek ölçüm',
  estimate: 'Tahmin',
  example: 'Örnek / varsayım',
  info: 'Bilgilendirme',
  rules: 'Kural tabanlı',
}

/** Gösterilen verinin türünü (gerçek / tahmin / örnek) açıkça etiketler. */
export function DataTag({ kind, children }: { kind: DataKind; children?: ReactNode }) {
  return (
    <span className={`data-tag data-tag-${kind}`}>
      {dataKindLabels[kind]}
      {children && <span className="data-tag-detail"> · {children}</span>}
    </span>
  )
}

export function SectionHeading({
  eyebrow,
  title,
  text,
  tags,
}: {
  eyebrow?: string
  title: string
  text?: string
  tags?: ReactNode
}) {
  return (
    <div className="section-heading">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
      {tags && <div className="tag-row">{tags}</div>}
      {text && <p>{text}</p>}
    </div>
  )
}

export function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state" role="status">
      <span aria-hidden="true">◌</span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  )
}

export function InfoNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="info-note">
      <strong>{title}</strong>
      <p>{children}</p>
    </aside>
  )
}

export function Alert({
  tone,
  children,
  title,
}: {
  tone: 'error' | 'warning' | 'success' | 'info'
  children: ReactNode
  title?: string
}) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  )
}

export function LoadingState({ children }: { children: ReactNode }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {children}
    </div>
  )
}

export type StatusTone = 'ok' | 'pending' | 'warning' | 'error' | 'neutral'

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`status-badge status-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  )
}
