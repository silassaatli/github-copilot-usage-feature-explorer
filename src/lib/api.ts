export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** API'nin döndürdüğü güvenli Türkçe mesajı ve hata kodunu taşır. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly setupHint?: string

  constructor(message: string, status: number, code?: string, setupHint?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.setupHint = setupHint
  }
}

/** Hata mesajını, varsa hata koduyla birlikte kullanıcıya gösterilecek biçime getirir. */
export function errorText(caught: unknown, fallback: string) {
  if (caught instanceof ApiError) return caught.code ? `${caught.message} (Hata kodu: ${caught.code})` : caught.message
  return caught instanceof Error ? caught.message : fallback
}

export async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  let result: Response
  try {
    result = await fetch(url, init)
  } catch {
    throw new ApiError('API sunucusuna ulaşılamadı. Sunucunun çalıştığını kontrol edin (npm run dev).', 0, 'NETWORK_ERROR')
  }
  let payload: unknown
  try {
    payload = await result.json()
  } catch {
    throw new ApiError(
      result.ok
        ? 'Sunucudan okunabilir bir yanıt alınamadı.'
        : `API sunucusu beklenmeyen bir yanıt döndürdü (HTTP ${result.status}). Sunucunun çalıştığını kontrol edin.`,
      result.status,
      'INVALID_RESPONSE',
    )
  }
  if (!result.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'İstek tamamlanamadı.'
    const code = isRecord(payload) && typeof payload.code === 'string' ? payload.code : undefined
    const setupHint = isRecord(payload) && typeof payload.setupHint === 'string' ? payload.setupHint : undefined
    throw new ApiError(message, result.status, code, setupHint)
  }
  return payload
}

export function postJson(url: string, body: unknown, method: 'POST' | 'DELETE' = 'POST') {
  return requestJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
