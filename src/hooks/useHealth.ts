import { useCallback, useEffect, useState } from 'react'
import { errorText, isRecord, requestJson } from '../lib/api'
import { claudeStatusStates, type ClaudeStatus, type HealthSnapshot } from '../types'

const pollIntervalMs = 30_000

function parseClaude(value: unknown): ClaudeStatus {
  const record = isRecord(value) ? value : {}
  const state = claudeStatusStates.find((item) => item === record.state) ?? 'sdk_unavailable'
  return {
    state,
    configured: record.configured === true,
    verified: record.verified === true,
    runnable: record.runnable === true,
    message: typeof record.message === 'string' ? record.message : 'Durum bilinmiyor',
    ...(typeof record.setupHint === 'string' ? { setupHint: record.setupHint } : {}),
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    ...(typeof record.lastVerifiedAt === 'string' ? { lastVerifiedAt: record.lastVerifiedAt } : {}),
    ...(typeof record.lastErrorCode === 'string' ? { lastErrorCode: record.lastErrorCode } : {}),
  }
}

/**
 * Sağlayıcı ve veritabanı durumlarını gerçek `/api/health` yanıtından okur.
 * Bu uç nokta yalnızca yerel durum bilgisini sorgular; model çağrısı yapmaz.
 */
export function useHealth() {
  const [health, setHealth] = useState<HealthSnapshot>()
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const payload = await requestJson('/api/health')
      const services = isRecord(payload) && isRecord(payload.services) ? payload.services : undefined
      if (!services || !isRecord(services.copilot) || !isRecord(services.database)) {
        throw new Error('Sağlık yanıtı beklenen biçimde değil.')
      }
      setHealth({
        checkedAt: typeof (payload as Record<string, unknown>).checkedAt === 'string'
          ? (payload as Record<string, string>).checkedAt
          : new Date().toISOString(),
        copilot: services.copilot as unknown as HealthSnapshot['copilot'],
        claude: parseClaude(services.claude),
        database: services.database as unknown as HealthSnapshot['database'],
      })
      setError('')
      return true
    } catch (caught) {
      setError(errorText(caught, 'API sunucusuna ulaşılamadı.'))
      return false
    }
  }, [])

  useEffect(() => {
    // İlk yükleme ve periyodik yenileme dış sistemle (API) eşitleme amaçlıdır.
    const initial = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => void refresh(), pollIntervalMs)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, [refresh])

  return { health, error, refresh }
}
