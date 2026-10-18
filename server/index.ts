import 'dotenv/config'
import { CopilotClient } from '@github/copilot-sdk'
import { join } from 'node:path'
import { createApp } from './app.js'
import { initPersistence, parseRetention } from './db/init.js'
import { createCopilotConnection, parseTimeoutMs } from './services/copilot-runtime.js'
import { createCopilotService } from './services/copilot-runner.js'

const port = Number(process.env.PORT ?? 3001)
// --serve-frontend: `npm run build` çıktısını (dist/) aynı sunucudan yayınlar.
const serveFrontend = process.argv.includes('--serve-frontend')

const persistence = initPersistence({
  path: process.env.DATABASE_PATH?.trim() || join(process.cwd(), 'data', 'explorer.sqlite'),
  retention: parseRetention(process.env.HISTORY_RETENTION),
})

const copilotClient = new CopilotClient({ useLoggedInUser: true })
const copilot = createCopilotService({
  client: copilotClient,
  connection: createCopilotConnection(copilotClient),
  requestTimeoutMs: parseTimeoutMs(process.env.COPILOT_REQUEST_TIMEOUT_MS, 120_000),
  skillDirectory: join(process.cwd(), 'skills'),
})

const app = createApp({
  copilot,
  env: process.env,
  persistence,
  claudeTimeoutMs: parseTimeoutMs(process.env.CLAUDE_REQUEST_TIMEOUT_MS, 120_000),
  ...(serveFrontend ? { frontendDir: join(process.cwd(), 'dist') } : {}),
})

function stopCopilot() {
  return copilot.stop().catch((stopError: unknown) => {
    console.error('Copilot istemcisi kapatılamadı:', stopError instanceof Error ? stopError.message : stopError)
    process.exitCode = 1
  })
}

const server = app.listen(port, '127.0.0.1', (error?: Error) => {
  if (error) {
    console.error('API sunucusu başlatılamadı:', error.message)
    process.exitCode = 1
    persistence.close()
    void stopCopilot()
    return
  }
  console.log(`API sunucusu http://127.0.0.1:${port} adresinde çalışıyor.`)
  if (serveFrontend) console.log(`Arayüz: http://127.0.0.1:${port}`)
})

// Copilot CLI başlatılamasa bile API dinlemeye devam eder (degraded mode);
// Copilot gerektiren uç noktalar 503 / COPILOT_UNAVAILABLE döndürür.
void copilot.start().then((ready) => {
  if (ready) console.log('Copilot istemcisi hazır.')
})

let isShuttingDown = false
function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  server.close((error) => {
    if (error) {
      console.error('API sunucusu kapatılamadı:', error.message)
      process.exitCode = 1
    }
    persistence.close()
    void stopCopilot()
  })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
