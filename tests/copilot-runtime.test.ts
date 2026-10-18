import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  closeCopilotSession,
  CopilotRunError,
  createCopilotConnection,
  createSessionWorkspace,
  denyAllPermissions,
  describeCopilotError,
  getSessionToolAllowlist,
  parseTimeoutMs,
  removeSessionWorkspace,
  runWithDeadline,
  toCopilotRunError,
} from '../server/services/copilot-runtime.ts'

const silent = () => undefined

test('upstream session errors map to safe codes without leaking raw messages', () => {
  const raw = new Error('token ghp_secret at C:\\internal\\path failed')
  const cases: Array<[Parameters<typeof toCopilotRunError>[1], string]> = [
    [{ errorType: 'authentication' }, 'COPILOT_AUTH_REQUIRED'],
    [{ errorType: 'policy' }, 'COPILOT_FORBIDDEN'],
    [{ errorType: 'quota', errorCode: 'quota_exceeded' }, 'COPILOT_QUOTA_EXCEEDED'],
    [{ errorType: 'rate_limit' }, 'COPILOT_RATE_LIMITED'],
    [{ errorType: 'context_limit' }, 'COPILOT_CONTEXT_LIMIT'],
    [{ errorType: 'query', statusCode: 401 }, 'COPILOT_AUTH_REQUIRED'],
    [undefined, 'COPILOT_REQUEST_FAILED'],
  ]
  for (const [upstream, code] of cases) {
    const result = toCopilotRunError(raw, upstream)
    assert.equal(result.code, code)
    assert.doesNotMatch(result.message, /ghp_secret|internal/)
  }
})

test('SDK wait timeouts are classified as timeouts and coded errors pass through', () => {
  assert.equal(
    toCopilotRunError(new Error('Timeout after 60000ms waiting for session.idle')).code,
    'COPILOT_TIMEOUT',
  )
  const original = new CopilotRunError('UNSUPPORTED_FEATURE', 'Fleet yok.')
  assert.equal(toCopilotRunError(original), original)
})

test('error descriptions carry HTTP status and only use the fallback for generic failures', () => {
  assert.deepEqual(describeCopilotError(new Error('x'), 'Fleet tamamlanamadı.'), {
    status: 502,
    code: 'COPILOT_REQUEST_FAILED',
    message: 'Fleet tamamlanamadı.',
  })
  const limit = describeCopilotError(new CopilotRunError('SESSION_LIMIT_REACHED'), 'yok sayılır')
  assert.equal(limit.status, 429)
  assert.match(limit.message, /AI Credit sınırına/)
  assert.equal(describeCopilotError(new CopilotRunError('COPILOT_UNAVAILABLE')).status, 503)
})

test('session tools exclude file, shell, network and MCP access', () => {
  const tools = getSessionToolAllowlist()
  assert.ok(tools.includes('builtin:task'))
  assert.ok(tools.includes('builtin:skill'))
  assert.ok(tools.every((tool) => tool.startsWith('builtin:')))
  for (const forbidden of ['bash', 'powershell', 'shell', 'edit', 'create', 'view', 'web_fetch', 'mcp']) {
    assert.ok(!tools.some((tool) => tool === `builtin:${forbidden}`), forbidden)
  }
})

test('permission requests are rejected by default', async () => {
  const result = await denyAllPermissions(
    { kind: 'shell' } as unknown as Parameters<typeof denyAllPermissions>[0],
    { sessionId: 's-1' },
  )
  assert.equal(result.kind, 'reject')
})

test('session cleanup deletes session data even when disconnect fails and never throws', async () => {
  const calls: string[] = []
  const clean = await closeCopilotSession(
    { deleteSession: async (id: string) => { calls.push(`delete:${id}`) } },
    {
      sessionId: 's-1',
      disconnect: async () => {
        calls.push('disconnect')
        throw new Error('connection lost')
      },
    },
    silent,
  )
  assert.equal(clean, false)
  assert.deepEqual(calls, ['disconnect', 'delete:s-1'])

  const deleteFails = await closeCopilotSession(
    { deleteSession: async () => { throw new Error('locked') } },
    { sessionId: 's-2', disconnect: async () => undefined },
    silent,
  )
  assert.equal(deleteFails, false)
})

test('deadline returns results and interrupts work on timeout', async () => {
  assert.equal(
    await runWithDeadline(async () => 'ok', { timeoutMs: 1_000, onInterrupt: async () => undefined }),
    'ok',
  )

  let interrupted = false
  await assert.rejects(
    runWithDeadline(() => new Promise(() => undefined), {
      timeoutMs: 20,
      onInterrupt: async () => { interrupted = true },
    }),
    (error: unknown) => error instanceof CopilotRunError && error.code === 'COPILOT_TIMEOUT',
  )
  assert.equal(interrupted, true)
})

test('deadline cancels on abort and an abort failure does not mask the cancellation', async () => {
  const controller = new AbortController()
  const pending = runWithDeadline(() => new Promise(() => undefined), {
    timeoutMs: 5_000,
    signal: controller.signal,
    onInterrupt: async () => { throw new Error('abort failed') },
    report: silent,
  })
  controller.abort()
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CopilotRunError && error.code === 'REQUEST_CANCELLED',
  )

  let started = false
  await assert.rejects(
    runWithDeadline(async () => { started = true }, {
      timeoutMs: 1_000,
      signal: AbortSignal.abort(),
      onInterrupt: async () => undefined,
    }),
    (error: unknown) => error instanceof CopilotRunError && error.code === 'REQUEST_CANCELLED',
  )
  assert.equal(started, false)
})

test('task errors propagate unchanged without interrupting', async () => {
  let interrupted = false
  await assert.rejects(
    runWithDeadline(async () => { throw new Error('upstream') }, {
      timeoutMs: 1_000,
      onInterrupt: async () => { interrupted = true },
    }),
    /upstream/,
  )
  assert.equal(interrupted, false)
})

function fakeClient(options: { startFails: boolean; authenticated?: boolean }) {
  let starts = 0
  let stops = 0
  return {
    get starts() { return starts },
    get stops() { return stops },
    start: async () => {
      starts += 1
      if (options.startFails) throw new Error('copilot CLI not found')
    },
    stop: async () => {
      stops += 1
      return []
    },
    getStatus: async () => ({ version: '1.2.3', protocolVersion: 3 }),
    getAuthStatus: async () => ({
      isAuthenticated: options.authenticated ?? true,
      authType: 'user' as const,
      login: 'gizli-kullanici',
    }),
  }
}

test('a failed Copilot start enters degraded mode and retries only after the cooldown', async () => {
  let clock = 1_000
  const client = fakeClient({ startFails: true })
  const connection = createCopilotConnection(client, {
    retryCooldownMs: 30_000,
    now: () => clock,
    report: silent,
  })

  assert.equal(await connection.start(), false)
  assert.equal(connection.state, 'unavailable')
  assert.equal((await connection.getHealth()).state, 'unavailable')

  await assert.rejects(
    connection.ensureReady(),
    (error: unknown) => error instanceof CopilotRunError && error.code === 'COPILOT_UNAVAILABLE',
  )
  assert.equal(client.starts, 1)

  clock += 30_000
  await assert.rejects(connection.ensureReady())
  assert.equal(client.starts, 2)

  await connection.stop()
  assert.equal(client.stops, 0)
})

test('a ready connection reports CLI and auth status without the login name', async () => {
  const client = fakeClient({ startFails: false })
  const connection = createCopilotConnection(client, { report: silent })
  assert.equal(await connection.start(), true)
  await connection.ensureReady()

  const health = await connection.getHealth()
  assert.equal(health.state, 'ready')
  assert.equal(health.authenticated, true)
  assert.equal(health.cliVersion, '1.2.3')
  assert.doesNotMatch(JSON.stringify(health), /gizli-kullanici/)

  await connection.stop()
  assert.equal(client.stops, 1)
})

test('health reports unreachable when the runtime stops answering', async () => {
  const client = {
    ...fakeClient({ startFails: false }),
    getStatus: () => new Promise<never>(() => undefined),
  }
  const connection = createCopilotConnection(client, { healthTimeoutMs: 20, report: silent })
  await connection.start()
  assert.equal((await connection.getHealth()).state, 'unreachable')
})

test('session workspaces are created empty and only those directories can be removed', async () => {
  const workspace = await createSessionWorkspace()
  assert.ok(existsSync(workspace))
  await removeSessionWorkspace(workspace)
  assert.ok(!existsSync(workspace))

  await assert.rejects(removeSessionWorkspace(tmpdir()))
  await assert.rejects(removeSessionWorkspace(join(tmpdir(), 'unrelated-dir')))
  await assert.rejects(removeSessionWorkspace(join(workspace, '..', '..', 'copilot-explorer-x')))
})

test('timeout configuration falls back on invalid values and is capped', () => {
  assert.equal(parseTimeoutMs(undefined, 120_000), 120_000)
  assert.equal(parseTimeoutMs('abc', 120_000), 120_000)
  assert.equal(parseTimeoutMs('500', 120_000), 120_000)
  assert.equal(parseTimeoutMs('90000', 120_000), 90_000)
  assert.equal(parseTimeoutMs('99999999', 120_000), 900_000)
})
