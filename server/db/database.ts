import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Şema geçişleri. Uygulanmış bir geçiş asla değiştirilmez; yeni değişiklikler
 * yeni bir sürüm olarak eklenir.
 */
export const migrations: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'executions-and-verifications',
    sql: `
      CREATE TABLE executions (
        id                  TEXT PRIMARY KEY,
        comparison_id       TEXT NOT NULL,
        provider            TEXT NOT NULL CHECK (provider IN ('github-copilot', 'claude')),
        runtime             TEXT,
        strategy            TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('success', 'error')),
        error_code          TEXT,
        error_message       TEXT,
        label               TEXT NOT NULL CHECK (length(label) <= 80),
        requested_model     TEXT,
        requested_auto_tier TEXT,
        actual_model        TEXT,
        input_tokens        INTEGER,
        output_tokens       INTEGER,
        cache_read_tokens   INTEGER,
        cache_write_tokens  INTEGER,
        reasoning_tokens    INTEGER,
        duration_ms         INTEGER,
        num_turns           INTEGER,
        model_calls         INTEGER,
        tool_calls          INTEGER,
        subagent_calls      INTEGER,
        skills_invoked      TEXT,
        cost_amount         REAL,
        cost_unit           TEXT CHECK (cost_unit IN ('AI Credit', 'USD')),
        cost_source         TEXT,
        nano_aiu            INTEGER,
        ai_credits_status   TEXT,
        max_ai_credit_limit REAL,
        context_tokens      INTEGER,
        context_limit       INTEGER,
        usage_json          TEXT,
        created_at          TEXT NOT NULL
      );
      CREATE INDEX idx_executions_created_at ON executions (created_at DESC);
      CREATE INDEX idx_executions_comparison ON executions (comparison_id);
      CREATE INDEX idx_executions_provider_created ON executions (provider, created_at DESC);

      CREATE TABLE model_usage (
        execution_id       TEXT NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
        model_id           TEXT NOT NULL,
        requests           INTEGER,
        input_tokens       INTEGER,
        output_tokens      INTEGER,
        cache_read_tokens  INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens   INTEGER,
        nano_aiu           INTEGER,
        PRIMARY KEY (execution_id, model_id)
      );

      CREATE TABLE execution_events (
        execution_id TEXT NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        event_id     TEXT,
        type         TEXT NOT NULL,
        label        TEXT NOT NULL,
        details_json TEXT,
        occurred_at  TEXT NOT NULL,
        PRIMARY KEY (execution_id, seq)
      );

      CREATE TABLE provider_verifications (
        provider        TEXT PRIMARY KEY,
        key_fingerprint TEXT NOT NULL,
        ok              INTEGER NOT NULL CHECK (ok IN (0, 1)),
        error_code      TEXT,
        checked_at      TEXT NOT NULL
      );
    `,
  },
]

export interface AppDatabase {
  db: DatabaseSync
  /** Kullanıcıya gösterilebilecek konum (bellek içi veya mutlak yol). */
  location: string
  schemaVersion: number
  sqliteVersion: string
}

/** Veritabanını açar, bağlantı ayarlarını uygular ve bekleyen geçişleri çalıştırır. */
export function openDatabase(path: string): AppDatabase {
  const inMemory = path === ':memory:'
  const location = inMemory ? ':memory:' : resolve(path)
  if (!inMemory) mkdirSync(dirname(location), { recursive: true })

  const db = new DatabaseSync(location, { enableForeignKeyConstraints: true, timeout: 5_000 })
  try {
    if (!inMemory) db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    const schemaVersion = migrate(db)
    const { version } = db.prepare('SELECT sqlite_version() AS version').get() as { version: string }
    return { db, location, schemaVersion, sqliteVersion: version }
  } catch (error) {
    db.close()
    throw error
  }
}

export function migrate(db: DatabaseSync): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
      .map((row) => row.version),
  )
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue
    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      record.run(migration.version, migration.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const { version } = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }
  return version
}
