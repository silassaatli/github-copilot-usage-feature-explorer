// UYARI: Bu betik gerçek bir Copilot oturumu açıp mesaj gönderir ve Copilot
// kullanımı (AI Credit) tüketir. Otomatik test paketine dahil değildir.
import { CopilotClient } from '@github/copilot-sdk'
import {
  closeCopilotSession,
  createSessionWorkspace,
  removeSessionWorkspace,
} from '../server/services/copilot-runtime.ts'
import { safeSessionConfig } from '../server/services/copilot-runner.ts'

const client = new CopilotClient({ useLoggedInUser: true })

try {
  await client.start()
  const workspace = await createSessionWorkspace()
  // Uygulamayla aynı güvenli yapılandırma: geçici dizin, oturum içi araçlar, izinler reddedilir.
  const session = await client.createSession(safeSessionConfig(workspace, { model: 'auto' }))

  try {
    const response = await session.sendAndWait({
      prompt: 'Merhaba, tek cümleyle kendini tanıt.',
    })

    if (!response) {
      throw new Error('Copilot yanıt döndürmedi.')
    }

    console.log(response.data.content)
  } finally {
    await closeCopilotSession(client, session)
    await removeSessionWorkspace(workspace)
  }
} finally {
  await client.stop()
}
