import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrate, migrations, openDatabase } from '../server/db/database.ts'
import { createVerificationRepository } from '../server/db/provider-verifications.ts'
import {
  createMemoryHistoryStore,
  createSqliteHistoryStore,
  type ExecutionRecord,
  type ProviderHistoryRecord,
} from '../server/services/usage-history.ts'

const copilotUsage: ExecutionRecord['usage'] = {
  status: 'available',
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 10,
  reasoningTokens: 4,
  aiCredits: 0.25,
  nanoAiu: 250_000_000,
  modelCalls: 2,
  durationMs: 1500,
  context: { currentTokens: 900, tokenLimit: 128_000, percentage: 0.7 },
  modelMetrics: [
    { id: 'model-a', requests: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 3, reasoningTokens: 4, nanoAiu: 250_000_000 },
  ],
  calls: [{ model: 'model-a', inputTokens: 50, outputTokens: 10, timestamp: '2026-10-18T10:00:00.000Z' }],
  toolCalls: 1,
  subagentCalls: 0,
  skillsInvoked: ['code-review'],
  aiCreditsStatus: 'complete',
}

function copilotRecord(id: string, createdAt: string): ProviderHistoryRecord {
  return {
    id,
    label: 'Kısa görev etiketi',
    strategy: 'skill',
    createdAt,
    provider: 'github-copilot',
    comparisonId: `cmp-${id}`,
    requestedModel: 'auto',
    actualModel: 'model-a',
    model: 'model-a',
    usage: copilotUsage,
    events: [
      { id: 'e1', type: 'model', label: 'model-a · model çağrısı', timestamp: createdAt },
      { id: 'e2', type: 'subagent', label: 'Alt ajan', timestamp: createdAt, details: { model: 'model-a', tokens: 12 } },
    ],
  }
}

const claudeRecord: ProviderHistoryRecord = {
  id: 'claude-1',
  label: 'Merhaba',
  strategy: 'normal',
  createdAt: '2026-10-18T10:05:00.000Z',
  provider: 'claude',
  comparisonId: 'cmp-claude',
  requestedModel: 'haiku',
  actualModel: 'claude-haiku-5-5',
  model: 'claude-haiku-5-5',
  metrics: {
    inputTokens: 431,
    outputTokens: 7,
    cachedTokens: 0,
    numTurns: 1,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1230,
    providerCost: 0.0000466,
    providerCostUnit: 'USD',
    providerCostSource: 'SDK tarafından ölçüldü',
  },
  events: [],
}

const failedRecord: ProviderHistoryRecord = {
  id: 'claude-err',
  label: 'Hata',
  strategy: 'normal',
  createdAt: '2026-10-18T10:06:00.000Z',
  provider: 'claude',
  comparisonId: 'cmp-err',
  metrics: {},
  error: 'Claude API hız sınırına ulaşıldı.',
  errorCode: 'CLAUDE_RATE_LIMITED',
  events: [],
}

test('migrations create the schema once and are idempotent', () => {
  const { db, schemaVersion } = openDatabase(':memory:')
  assert.equal(schemaVersion, migrations.at(-1)?.version)
  assert.equal(migrate(db), schemaVersion)
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name)
  for (const table of ['executions', 'model_usage', 'execution_events', 'provider_verifications', 'schema_migrations']) {
    assert.ok(tables.includes(table), table)
  }
  const applied = db.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get() as { total: number }
  assert.equal(applied.total, migrations.length)
  db.close()
})

test('Copilot, Claude and failed records round-trip with the API shape', () => {
  const { db } = openDatabase(':memory:')
  const store = createSqliteHistoryStore(db)
  store.add(copilotRecord('copilot-1', '2026-10-18T10:00:00.000Z'))
  store.add(claudeRecord)
  store.add(failedRecord)

  const [failed, claude, copilot] = store.list()
  assert.deepEqual(copilot, copilotRecord('copilot-1', '2026-10-18T10:00:00.000Z'))
  assert.deepEqual(claude, claudeRecord)
  assert.equal(failed.error, failedRecord.error)
  assert.equal(failed.errorCode, 'CLAUDE_RATE_LIMITED')
  assert.equal(store.list({ provider: 'claude' }).length, 2)
  assert.equal(store.list({ limit: 1 }).length, 1)

  const usageRows = db.prepare('SELECT model_id, cache_write_tokens FROM model_usage').all()
  assert.deepEqual(usageRows.map((row) => ({ ...row })), [{ model_id: 'model-a', cache_write_tokens: 3 }])
  const summary = db.prepare("SELECT status, cost_unit, cost_amount FROM executions WHERE id = 'copilot-1'").get()
  assert.deepEqual({ ...summary }, { status: 'success', cost_unit: 'AI Credit', cost_amount: 0.25 })
  db.close()
})

test('no full prompt or response is stored and labels are capped', () => {
  const { db } = openDatabase(':memory:')
  const store = createSqliteHistoryStore(db)
  store.add({ ...claudeRecord, id: 'long', label: 'x'.repeat(200) })
  const columns = (db.prepare('PRAGMA table_info(executions)').all() as Array<{ name: string }>).map((row) => row.name)
  assert.ok(!columns.some((name) => /prompt|response/.test(name)))
  assert.equal(store.list()[0].label.length, 80)
  db.close()
})

test('retention keeps only the newest records and cascades their children', () => {
  const { db } = openDatabase(':memory:')
  const store = createSqliteHistoryStore(db, { retention: 2 })
  store.add(copilotRecord('old', '2026-10-18T09:00:00.000Z'))
  store.add(copilotRecord('mid', '2026-10-18T09:30:00.000Z'))
  store.add(copilotRecord('new', '2026-10-18T10:00:00.000Z'))

  assert.deepEqual(store.list().map((item) => item.id), ['new', 'mid'])
  assert.equal(store.count(), 2)
  const orphanEvents = db.prepare("SELECT COUNT(*) AS total FROM execution_events WHERE execution_id = 'old'").get() as { total: number }
  const orphanUsage = db.prepare("SELECT COUNT(*) AS total FROM model_usage WHERE execution_id = 'old'").get() as { total: number }
  assert.equal(orphanEvents.total, 0)
  assert.equal(orphanUsage.total, 0)
  db.close()
})

test('a failed insert rolls back without partial rows', () => {
  const { db } = openDatabase(':memory:')
  const store = createSqliteHistoryStore(db)
  store.add(copilotRecord('dup', '2026-10-18T10:00:00.000Z'))
  assert.throws(() => store.add(copilotRecord('dup', '2026-10-18T11:00:00.000Z')))
  assert.equal(store.count(), 1)
  const events = db.prepare('SELECT COUNT(*) AS total FROM execution_events').get() as { total: number }
  assert.equal(events.total, 2)
  db.close()
})

test('history and verification survive closing and reopening the database file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'explorer-db-test-'))
  const path = join(directory, 'nested', 'explorer.sqlite')
  try {
    const first = openDatabase(path)
    createSqliteHistoryStore(first.db).add(claudeRecord)
    createVerificationRepository(first.db).save('claude', {
      keyFingerprint: 'abc123',
      ok: true,
      at: '2026-10-18T10:05:00.000Z',
    })
    first.db.close()

    const second = openDatabase(path)
    assert.deepEqual(createSqliteHistoryStore(second.db).list(), [claudeRecord])
    assert.deepEqual(createVerificationRepository(second.db).load('claude'), {
      keyFingerprint: 'abc123',
      ok: true,
      at: '2026-10-18T10:05:00.000Z',
    })
    const journal = second.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    assert.equal(journal.journal_mode, 'wal')
    second.db.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('verification records are upserted per provider', () => {
  const { db } = openDatabase(':memory:')
  const repository = createVerificationRepository(db)
  assert.equal(repository.load('claude'), undefined)
  repository.save('claude', { keyFingerprint: 'k1', ok: true, at: 't1' })
  repository.save('claude', { keyFingerprint: 'k1', ok: false, code: 'CLAUDE_AUTH_FAILED', at: 't2' })
  assert.deepEqual(repository.load('claude'), { keyFingerprint: 'k1', ok: false, code: 'CLAUDE_AUTH_FAILED', at: 't2' })
  db.close()
})

test('the in-memory fallback keeps the newest records up to its limit', () => {
  const store = createMemoryHistoryStore(2)
  store.add(copilotRecord('a', '1'))
  store.add(copilotRecord('b', '2'))
  store.add(claudeRecord)
  assert.equal(store.kind, 'memory')
  assert.deepEqual(store.list().map((item) => item.id), ['claude-1', 'b'])
  assert.deepEqual(store.list({ provider: 'github-copilot' }).map((item) => item.id), ['b'])
})
