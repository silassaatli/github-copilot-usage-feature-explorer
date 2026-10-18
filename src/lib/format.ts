import type { ProviderId } from '../types'

/** Sağlayıcının bildirmediği değerler için tek tip etiket. */
export const UNKNOWN = 'Bilinmiyor'

export function formatNumber(value: number | undefined) {
  return value === undefined ? UNKNOWN : new Intl.NumberFormat('tr-TR').format(value)
}

export function formatDecimal(value: number | undefined, maximumFractionDigits = 6) {
  return value === undefined ? UNKNOWN : new Intl.NumberFormat('tr-TR', { maximumFractionDigits }).format(value)
}

/** Copilot AI Credit tüketimi (para birimi değildir). */
export function formatCredits(value: number | undefined) {
  return value === undefined ? UNKNOWN : `${formatDecimal(value)} AI Credit`
}

/** USD tutarı; Claude için SDK tahminidir. */
export function formatUsd(value: number | undefined, maximumFractionDigits = 6) {
  return value === undefined
    ? UNKNOWN
    : `$${new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits }).format(value)}`
}

export function formatDuration(ms: number | undefined) {
  if (ms === undefined) return UNKNOWN
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} sn`
}

export function formatDateTime(value: string | undefined) {
  if (!value) return UNKNOWN
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? UNKNOWN
    : date.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' })
}

export function formatModelLabel(model: string | undefined) {
  if (!model) return UNKNOWN
  return model === 'auto' ? 'Otomatik (auto)' : model
}

export function providerLabel(provider: ProviderId) {
  return provider === 'github-copilot' ? 'GitHub Copilot' : 'Claude'
}

export function sumIfKnown(left: number | undefined, right: number | undefined) {
  return left === undefined || right === undefined ? undefined : left + right
}
