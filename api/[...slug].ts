import { createDemoApp } from '../server/demo/create-demo-app.js'

// Tek bir Vercel serverless fonksiyonu tüm /api/* isteklerini karşılar
// (dosya adındaki [...slug] bu yakalamayı sağlar). Express app'i Node
// isteği/yanıtı ile doğrudan uyumlu olduğu için doğrudan dışa aktarılır.
const app = createDemoApp()

export default app
