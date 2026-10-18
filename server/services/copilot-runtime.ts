import { BuiltInTools, ToolSet } from '@github/copilot-sdk'
import type { CopilotClient, CopilotSession, PermissionHandler } from '@github/copilot-sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export type CopilotErrorCode =
  | 'COPILOT_UNAVAILABLE'
  | 'COPILOT_AUTH_REQUIRED'
  | 'COPILOT_FORBIDDEN'
  | 'COPILOT_QUOTA_EXCEEDED'
  | 'COPILOT_RATE_LIMITED'
  | 'COPILOT_CONTEXT_LIMIT'
  | 'COPILOT_TIMEOUT'
  | 'REQUEST_CANCELLED'
  | 'SESSION_LIMIT_REACHED'
  | 'UNSUPPORTED_FEATURE'
  | 'UNSUPPORTED_MODEL'
  | 'COPILOT_REQUEST_FAILED'

const errorCatalog: Record<CopilotErrorCode, { status: number; message: string }> = {
  COPILOT_UNAVAILABLE: {
    status: 503,
    message: 'GitHub Copilot bağlantısı şu anda kullanılamıyor. Copilot CLI kurulumunu ve oturum açma durumunu kontrol edin.',
  },
  COPILOT_AUTH_REQUIRED: {
    status: 401,
    message: 'GitHub Copilot kimlik doğrulaması gerekli. Copilot CLI ile oturum açıp tekrar deneyin.',
  },
  COPILOT_FORBIDDEN: {
    status: 403,
    message: 'Bu Copilot hesabının veya kuruluş politikasının bu işleme izni yok.',
  },
  COPILOT_QUOTA_EXCEEDED: {
    status: 429,
    message: 'Copilot kullanım kotası veya faturalandırma sınırı nedeniyle istek tamamlanamadı.',
  },
  COPILOT_RATE_LIMITED: {
    status: 429,
    message: 'Copilot hız sınırına ulaşıldı. Bir süre bekleyip tekrar deneyin.',
  },
  COPILOT_CONTEXT_LIMIT: {
    status: 413,
    message: 'Görev, modelin bağlam penceresi sınırını aşıyor. Daha kısa bir görevle deneyin.',
  },
  COPILOT_TIMEOUT: {
    status: 504,
    message: 'Copilot yanıtı zaman sınırı içinde tamamlanmadı; çalıştırma durduruldu.',
  },
  REQUEST_CANCELLED: {
    status: 499,
    message: 'İstek iptal edildi; Copilot çalıştırması durduruldu.',
  },
  SESSION_LIMIT_REACHED: {
    status: 429,
    message: 'Oturum AI Credit sınırına ulaştı; isteği güvenli biçimde durdurduk.',
  },
  UNSUPPORTED_FEATURE: {
    status: 501,
    message: 'Bu özellik kurulu SDK/CLI sürümünde kullanılamıyor.',
  },
  UNSUPPORTED_MODEL: {
    status: 400,
    message: 'Seçilen model bu Copilot hesabında kullanılamıyor.',
  },
  COPILOT_REQUEST_FAILED: {
    status: 502,
    message: 'Copilot isteği tamamlanamadı.',
  },
}

/** Kullanıcıya gösterilmesi güvenli, sabit Türkçe mesaj taşıyan Copilot hatası. */
export class CopilotRunError extends Error {
  readonly code: CopilotErrorCode

  constructor(code: CopilotErrorCode, message?: string) {
    super(message ?? errorCatalog[code].message)
    this.name = 'CopilotRunError'
    this.code = code
  }
}

/** `session.error` olayından alınan, sınıflandırma için gereken alanlar. */
export interface UpstreamErrorInfo {
  errorType?: string
  errorCode?: string
  statusCode?: number
}

export interface CopilotErrorDescription {
  status: number
  code: CopilotErrorCode
  message: string
}

/**
 * Herhangi bir hatayı kullanıcıya güvenli bir koda ve mesaja çevirir.
 * Ham SDK/CLI mesajları (yol, yığın izi, istek kimliği) yanıta hiçbir zaman eklenmez.
 */
export function toCopilotRunError(error: unknown, upstream?: UpstreamErrorInfo): CopilotRunError {
  if (error instanceof CopilotRunError) return error
  const errorType = upstream?.errorType
  const statusCode = upstream?.statusCode
  if (errorType === 'authentication' || statusCode === 401) {
    return new CopilotRunError('COPILOT_AUTH_REQUIRED')
  }
  if (errorType === 'authorization' || errorType === 'policy' || statusCode === 403) {
    return new CopilotRunError('COPILOT_FORBIDDEN')
  }
  if (errorType === 'quota') return new CopilotRunError('COPILOT_QUOTA_EXCEEDED')
  if (errorType === 'rate_limit' || statusCode === 429) {
    return new CopilotRunError('COPILOT_RATE_LIMITED')
  }
  if (errorType === 'context_limit') return new CopilotRunError('COPILOT_CONTEXT_LIMIT')
  if (error instanceof Error && /^Timeout after \d+ms waiting for session\.idle/.test(error.message)) {
    return new CopilotRunError('COPILOT_TIMEOUT')
  }
  return new CopilotRunError('COPILOT_REQUEST_FAILED')
}

export function describeCopilotError(
  error: unknown,
  fallbackMessage?: string,
): CopilotErrorDescription {
  const runError = toCopilotRunError(error)
  return {
    status: errorCatalog[runError.code].status,
    code: runError.code,
    message:
      runError.code === 'COPILOT_REQUEST_FAILED' && fallbackMessage
        ? fallbackMessage
        : runError.message,
  }
}

/**
 * Ana ajan için izin verilen yerleşik araçlar. `BuiltInTools.Isolated` yalnızca
 * oturum sınırları içinde çalışan araçları içerir (alt ajan, skill, görev
 * tamamlama); dosya sistemi, shell, ağ ve MCP araçları bu listede yoktur.
 */
export function getSessionToolAllowlist(): string[] {
  return new ToolSet().addBuiltIn(BuiltInTools.Isolated).toArray()
}

export const sessionPermissionFeedback =
  'Bu demo oturumunda dosya, terminal, ağ ve harici araç izinleri kapalıdır.'

/** İzin gerektiren her isteği varsayılan olarak reddeder. */
export const denyAllPermissions: PermissionHandler = () => ({
  kind: 'reject',
  feedback: sessionPermissionFeedback,
})

const workspacePrefix = 'copilot-explorer-'

/** Her oturum için boş, geçici bir çalışma dizini oluşturur. */
export function createSessionWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), workspacePrefix))
}

/** Yalnızca `createSessionWorkspace` ile oluşturulmuş dizinleri siler. */
export async function removeSessionWorkspace(directory: string): Promise<void> {
  const root = resolve(tmpdir()) + sep
  const target = resolve(directory)
  if (!target.startsWith(root + workspacePrefix) || target.slice(root.length).includes(sep)) {
    throw new Error('Geçici oturum dizini beklenen konumda değil; silinmedi.')
  }
  await rm(target, { recursive: true, force: true })
}

type ReportCleanupError = (message: string, error: unknown) => void

const defaultReport: ReportCleanupError = (message, error) => {
  console.error(message, error instanceof Error ? error.message : error)
}

/**
 * Oturumu kapatır ve diskteki oturum verisini siler. Hiçbir zaman hata
 * fırlatmaz; böylece temizlik hatası asıl çalıştırma hatasını örtmez.
 */
export async function closeCopilotSession(
  client: Pick<CopilotClient, 'deleteSession'>,
  session: Pick<CopilotSession, 'sessionId' | 'disconnect'>,
  report: ReportCleanupError = defaultReport,
): Promise<boolean> {
  const sessionId = session.sessionId
  let clean = true
  try {
    await session.disconnect()
  } catch (error) {
    clean = false
    report('Copilot oturumu kapatılamadı:', error)
  }
  try {
    await client.deleteSession(sessionId)
  } catch (error) {
    clean = false
    report('Copilot oturum verisi silinemedi:', error)
  }
  return clean
}

export interface DeadlineOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** Zaman aşımı veya iptalde çalışan işi durdurmak için çağrılır. */
  onInterrupt: () => Promise<void>
  report?: ReportCleanupError
}

/**
 * İşi zaman sınırı ve iptal sinyaliyle çalıştırır. Sınır aşılırsa veya istek
 * iptal edilirse `onInterrupt` ile iş durdurulur ve kodlu hata fırlatılır.
 */
export async function runWithDeadline<T>(
  task: () => Promise<T>,
  { timeoutMs, signal, onInterrupt, report = defaultReport }: DeadlineOptions,
): Promise<T> {
  if (signal?.aborted) throw new CopilotRunError('REQUEST_CANCELLED')

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interruption = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CopilotRunError('COPILOT_TIMEOUT')), timeoutMs)
    onAbort = () => reject(new CopilotRunError('REQUEST_CANCELLED'))
    signal?.addEventListener('abort', onAbort, { once: true })
  })

  const work = task()
  try {
    return await Promise.race([work, interruption])
  } catch (error) {
    if (
      error instanceof CopilotRunError &&
      (error.code === 'COPILOT_TIMEOUT' || error.code === 'REQUEST_CANCELLED')
    ) {
      work.catch(() => undefined)
      try {
        await onInterrupt()
      } catch (interruptError) {
        report('Copilot çalıştırması durdurulamadı:', interruptError)
      }
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

export function parseTimeoutMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number(value)
  if (!value?.trim() || !Number.isInteger(parsed) || parsed < 1_000) return fallbackMs
  return Math.min(parsed, 15 * 60_000)
}

export type CopilotConnectionState = 'starting' | 'ready' | 'unavailable'

export interface CopilotHealth {
  state: CopilotConnectionState | 'unreachable'
  message: string
  cliVersion?: string
  protocolVersion?: number
  authenticated?: boolean
  authType?: string
}

type ConnectionClient = Pick<CopilotClient, 'start' | 'stop' | 'getStatus' | 'getAuthStatus'>

/**
 * Copilot CLI bağlantısını API sunucusundan bağımsız yönetir. Başlatma
 * başarısız olursa sunucu çalışmaya devam eder (degraded mode) ve bekleme
 * süresi dolduktan sonraki ilk Copilot isteğinde yeniden denenir.
 */
export function createCopilotConnection(
  client: ConnectionClient,
  {
    retryCooldownMs = 30_000,
    healthTimeoutMs = 3_000,
    now = Date.now,
    report = defaultReport,
  }: {
    retryCooldownMs?: number
    healthTimeoutMs?: number
    now?: () => number
    report?: ReportCleanupError
  } = {},
) {
  let state: CopilotConnectionState = 'starting'
  let lastFailureAt: number | undefined
  let pending: Promise<boolean> | undefined

  function start(): Promise<boolean> {
    if (state === 'ready') return Promise.resolve(true)
    pending ??= client.start().then(
      () => {
        state = 'ready'
        return true
      },
      (error: unknown) => {
        state = 'unavailable'
        lastFailureAt = now()
        report('Copilot istemcisi başlatılamadı; Copilot gerektirmeyen ekranlar çalışmaya devam ediyor:', error)
        return false
      },
    ).finally(() => {
      pending = undefined
    })
    return pending
  }

  async function ensureReady(): Promise<void> {
    if (state === 'ready') return
    if (
      state === 'unavailable' &&
      !pending &&
      lastFailureAt !== undefined &&
      now() - lastFailureAt < retryCooldownMs
    ) {
      throw new CopilotRunError('COPILOT_UNAVAILABLE')
    }
    if (!(await start())) throw new CopilotRunError('COPILOT_UNAVAILABLE')
  }

  async function getHealth(): Promise<CopilotHealth> {
    if (state === 'starting') {
      return { state, message: 'Copilot bağlantısı başlatılıyor.' }
    }
    if (state === 'unavailable') {
      return { state, message: errorCatalog.COPILOT_UNAVAILABLE.message }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('health timeout')), healthTimeoutMs)
      })
      const [status, auth] = await Promise.race([
        Promise.all([client.getStatus(), client.getAuthStatus()]),
        timeout,
      ])
      return {
        state: 'ready',
        message: auth.isAuthenticated
          ? 'Copilot bağlı'
          : 'Copilot çalışıyor ancak oturum açılmamış.',
        cliVersion: status.version,
        protocolVersion: status.protocolVersion,
        authenticated: auth.isAuthenticated,
        ...(auth.authType ? { authType: auth.authType } : {}),
      }
    } catch {
      return { state: 'unreachable', message: 'Copilot çalışma zamanına şu anda ulaşılamıyor.' }
    } finally {
      clearTimeout(timer)
    }
  }

  async function stop(): Promise<void> {
    if (state !== 'ready') return
    const errors = await client.stop()
    for (const error of errors) report('Copilot istemcisi kapatılırken hata oluştu:', error)
  }

  return {
    start,
    ensureReady,
    getHealth,
    stop,
    get state() {
      return state
    },
  }
}
