import { CopilotClient } from '@github/copilot-sdk'

const client = new CopilotClient({ useLoggedInUser: true })

try {
  await client.start()
  const session = await client.createSession({ model: 'auto' })

  try {
    const response = await session.sendAndWait({
      prompt: 'Merhaba, tek cümleyle kendini tanıt.',
    })

    if (!response) {
      throw new Error('Copilot yanıt döndürmedi.')
    }

    console.log(response.data.content)
  } finally {
    await session.disconnect()
  }
} finally {
  await client.stop()
}
