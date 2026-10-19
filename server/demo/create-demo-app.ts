import { createApp } from '../app.js'
import type { DatabaseHealth } from '../db/init.js'
import { createFakeClaudeQueryFn, createFakeCopilotService, demoAnthropicApiKey } from './fake-providers.js'

/**
 * Herkese açık demo dağıtımları (örn. Vercel) için uygulama örneği.
 * Gerçek Copilot/Claude çağrısı yapmaz, kalıcı veri tutmaz (bellek içi geçmiş)
 * ve Host/Origin kısıtlamasını kaldırır — çünkü gerçek bir sağlayıcı anahtarı
 * veya hesabı yok, dolayısıyla uzak bir sitenin ücretli çağrı tetikleme riski yok.
 */
export function createDemoApp() {
  const demoDatabaseHealth: DatabaseHealth = {
    state: 'ready',
    storage: 'memory',
    persistent: false,
    retention: 100,
    message: 'Demo modu: geçmiş bellekte tutulur, kalıcı değildir ve yeniden başlatmada sıfırlanır.',
  }

  return createApp({
    copilot: createFakeCopilotService(),
    env: { ANTHROPIC_API_KEY: demoAnthropicApiKey },
    persistence: { health: () => demoDatabaseHealth },
    claudeTimeoutMs: 15_000,
    claudeQueryFn: createFakeClaudeQueryFn(),
    trustedHosts: 'any',
  })
}
