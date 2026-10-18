import type { DatabaseSync } from 'node:sqlite'

export interface StoredVerification {
  /** Anahtarın kısaltılmış SHA-256 özeti; anahtarın kendisi saklanmaz. */
  keyFingerprint: string
  ok: boolean
  code?: string
  at: string
}

/** Sağlayıcı başına son gerçek bağlantı sonucunu saklar. */
export function createVerificationRepository(db: DatabaseSync) {
  const select = db.prepare(
    'SELECT key_fingerprint, ok, error_code, checked_at FROM provider_verifications WHERE provider = ?',
  )
  const upsert = db.prepare(`
    INSERT INTO provider_verifications (provider, key_fingerprint, ok, error_code, checked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (provider) DO UPDATE SET
      key_fingerprint = excluded.key_fingerprint,
      ok = excluded.ok,
      error_code = excluded.error_code,
      checked_at = excluded.checked_at
  `)
  return {
    load(provider: string): StoredVerification | undefined {
      const row = select.get(provider) as
        | { key_fingerprint: string; ok: number; error_code: string | null; checked_at: string }
        | undefined
      if (!row) return undefined
      return {
        keyFingerprint: row.key_fingerprint,
        ok: row.ok === 1,
        ...(row.error_code ? { code: row.error_code } : {}),
        at: row.checked_at,
      }
    },
    save(provider: string, outcome: StoredVerification) {
      upsert.run(provider, outcome.keyFingerprint, outcome.ok ? 1 : 0, outcome.code ?? null, outcome.at)
    },
  }
}
