import { onClaudeOutcome, restoreClaudeOutcome } from '../services/claude.js'
import {
  createMemoryHistoryStore,
  createSqliteHistoryStore,
  getHistoryStore,
  setHistoryStore,
} from '../services/usage-history.js'
import { openDatabase, type AppDatabase } from './database.js'
import { createVerificationRepository } from './provider-verifications.js'

export interface DatabaseHealth {
  state: 'ready' | 'unavailable'
  storage: 'sqlite' | 'memory'
  persistent: boolean
  message: string
  engine?: 'sqlite'
  sqliteVersion?: string
  schemaVersion?: number
  executions?: number
  retention: number
}

export interface Persistence {
  health(): DatabaseHealth
  close(): void
}

export function parseRetention(value: string | undefined) {
  const parsed = Number(value)
  if (!value?.trim() || !Number.isInteger(parsed)) return 1_000
  return Math.min(Math.max(parsed, 10), 100_000)
}

/**
 * SQLite'ı açar ve geçmiş ile Claude doğrulama durumunu ona bağlar. Açılamazsa
 * uygulama bellek deposuyla çalışmaya devam eder (geçmiş kalıcı olmaz).
 */
export function initPersistence({ path, retention }: { path: string; retention: number }): Persistence {
  let database: AppDatabase | undefined
  try {
    database = openDatabase(path)
    setHistoryStore(createSqliteHistoryStore(database.db, { retention }))
    const verifications = createVerificationRepository(database.db)
    restoreClaudeOutcome(verifications.load('claude'))
    onClaudeOutcome((outcome) => verifications.save('claude', outcome))
    console.log(`SQLite veritabanı hazır (şema v${database.schemaVersion}): ${database.location}`)
  } catch (error) {
    database = undefined
    setHistoryStore(createMemoryHistoryStore())
    onClaudeOutcome(undefined)
    console.error(
      'SQLite veritabanı açılamadı; geçmiş yalnızca bellekte tutulacak:',
      error instanceof Error ? error.message : error,
    )
  }

  return {
    health() {
      if (!database) {
        return {
          state: 'unavailable',
          storage: getHistoryStore().kind,
          persistent: false,
          retention,
          message: 'Veritabanı açılamadı; geçmiş yalnızca bellekte tutuluyor ve sunucu yeniden başlatıldığında kaybolur.',
        }
      }
      let executions: number | undefined
      try {
        executions = getHistoryStore().count()
      } catch {
        executions = undefined
      }
      return {
        state: 'ready',
        storage: 'sqlite',
        persistent: true,
        engine: 'sqlite',
        sqliteVersion: database.sqliteVersion,
        schemaVersion: database.schemaVersion,
        executions,
        retention,
        message: 'Kullanım geçmişi SQLite veritabanında kalıcı olarak tutuluyor.',
      }
    },
    close() {
      if (!database) return
      try {
        database.db.close()
      } catch (error) {
        console.error('Veritabanı kapatılamadı:', error instanceof Error ? error.message : error)
      }
      database = undefined
    },
  }
}
