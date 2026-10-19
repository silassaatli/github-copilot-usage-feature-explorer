# GitHub Copilot Kullanım ve Özellik Gezgini

*(GitHub Copilot Usage & Feature Explorer)*

Şirketlerin GitHub Copilot'ı nasıl kullanabileceğini gösteren, Türkçe arayüzlü yerel bir demo uygulaması. Aynı görevi **GitHub Copilot SDK** ve **Claude Agent SDK** ile çalıştırır. Sağlayıcıların bildirdiği gerçek kullanım metriklerini (model, token, süre, AI Credit, Claude USD tahmini) yan yana gösterir. Ayrıca şunları içerir:

- kalıcı kullanım geçmişi ve raporlar
- kural tabanlı mod danışmanı
- lisans/maliyet hesaplayıcısı
- Copilot özellik rehberi

Uygulama yerel makinede (`127.0.0.1`) tek kullanıcı için çalışır. **Sayfa açıldığında hiçbir ücretli model çağrısı yapılmaz.** Model çalıştırmaları yalnızca siz butona bastığınızda başlar.

## İçindekiler

1. [Özellikler](#özellikler)
2. [Mimari ve teknolojiler](#mimari-ve-teknolojiler)
3. [Gereksinimler](#gereksinimler)
4. [Kurulum](#kurulum)
5. [`.env` ve yapılandırma](#env-ve-yapılandırma)
6. [API anahtarlarının güvenli yönetimi](#api-anahtarlarının-güvenli-yönetimi)
7. [Çalıştırma: geliştirme ve production](#çalıştırma-geliştirme-ve-production)
8. [Ücretsiz yerel testler](#ücretsiz-yerel-testler)
9. [SQLite geçmişi, yedekleme ve sıfırlama](#sqlite-geçmişi-yedekleme-ve-sıfırlama)
10. [Gerçek ölçümler ve tahminler](#gerçek-ölçümler-ve-tahminler)
11. [Copilot model kataloğu sınırlamaları](#copilot-model-kataloğu-sınırlamaları)
12. [Claude kullanımı ve olası ücretler](#claude-kullanımı-ve-olası-ücretler)
13. [Güvenlik ve hata yönetimi](#güvenlik-ve-hata-yönetimi)
14. [API uç noktaları](#api-uç-noktaları)
15. [Bilinen sınırlamalar ve backlog](#bilinen-sınırlamalar-ve-backlog)

## Özellikler

| Bölüm | Ne yapar | Veri türü |
|---|---|---|
| **Oyun Alanı** | Bir görevi yalnızca Copilot'ta, yalnızca Claude'da veya (onaydan sonra) ikisinde birden çalıştırır. Gerçekte kullanılan modeli ve metrikleri gösterir. Ortak metrikleri karşılaştırır. Copilot için çalıştırma yöntemi, model ve AI Credit sınırı; Claude için model seçilebilir. | Gerçek ölçüm (SDK); Claude USD tahmindir |
| **Kullanım Analizi** | Son Copilot çalıştırmasının ayrıntıları (model kırılımı, bağlam penceresi, olay zaman çizelgesi), anlık Copilot kotası ve kalıcı çalıştırma geçmişi. Geçmiş sağlayıcıya ve duruma göre filtrelenebilir, kayıt ayrıntıları açılabilir, onayla temizlenebilir. | Gerçek ölçüm; kota deneysel ve anlık |
| **Mod Danışmanı** | Görev gereksinimlerine göre Sohbet / Ajan / Skill / MCP / Fleet önerisi verir. Model çağırmaz. | Kural tabanlı |
| **Karşılaştırma Laboratuvarı** | Aynı görevi Copilot'un Normal, Skill, Alt ajan ve Fleet yöntemleriyle ayrı oturumlarda çalıştırıp tabloda karşılaştırır. | Gerçek ölçüm |
| **Lisans ve Maliyet** | Koltuk ücreti ile AI Credit kullanımını ayrı hesaplar. Beklenen kullanımı isterseniz son gerçek ölçümden türetir. | Tahmin; plan fiyatları belgeden elle girilmiştir |
| **Raporlar ve Backlog** | Kayıtlı geçmişten sağlayıcı bazında rapor üretir (her metrikte kaç çalıştırmanın değeri bildirdiği gösterilir) ve iyileştirme backlog'unu listeler. | Kayıtlı gerçek veriden |
| **Özellik Rehberi** | Sohbet, Ajan Modu, Skills, alt ajanlar, Fleet, MCP, Hooks, oturum sınırları ve model seçimini açıklar. | Bilgilendirme |

Her bölüm ve kart, verinin türünü bir etiketle açıkça belirtir: *Gerçek ölçüm*, *Tahmin*, *Örnek / varsayım*, *Kural tabanlı* veya *Bilgilendirme*. Kenar çubuğu Copilot, Claude ve veritabanı durumlarını gerçek `/api/health` yanıtından 30 saniyede bir okur.

## Mimari ve teknolojiler

```text
Tarayıcı (React 19 + TypeScript, Vite 8)
   │  /api/...  (geliştirmede Vite proxy → 127.0.0.1:3001)
   ▼
Express 5 API — yalnızca 127.0.0.1, yerel Host/Origin denetimi
   ├── GitHub Copilot SDK (@github/copilot-sdk) ── copilot-runtime alt süreci
   │      oturum başına geçici dizin, yalnızca oturum içi araçlar, izinler reddedilir
   ├── Claude Agent SDK (@anthropic-ai/claude-agent-sdk) ── Claude Code alt süreci
   │      araçsız, yalıtılmış ortam ve yapılandırma dizini, yalnızca .env anahtarı
   └── SQLite (Node'un yerleşik node:sqlite modülü) ── data/explorer.sqlite
```

| Katman | Dosyalar |
|---|---|
| Sunucu girişi | `server/index.ts` (ortam, kalıcılık, Copilot istemcisi, dinleme, kapanış) |
| HTTP uygulaması | `server/app.ts` (`createApp`: rotalar, doğrulama, hata yanıtları; testlerde sahte sağlayıcılarla kullanılır) |
| Copilot | `server/services/copilot-runner.ts` (çalıştırma, katalog, kota), `copilot-runtime.ts` (güvenlik, zaman aşımı, bağlantı, hata kodları) |
| Claude | `server/services/claude.ts` (çalıştırma, model listesi, durum, yalıtım, hata kodları) |
| Geçmiş ve rapor | `server/services/usage-history.ts`, `usage-report.ts`, `server/db/*.ts` |
| Diğer | `advisor.ts`, `licensing.ts`, `provider-comparison.ts`, `server/data/copilot-plans.ts` |
| Ön yüz | `src/App.tsx`, `src/sections/*`, `src/components/*`, `src/content/*`, `src/lib/*` |
| Testler | `tests/*.test.ts` (Node test runner; gerçek sağlayıcı çağrısı yok) |

Yeni bir çalışma zamanı bağımlılığı eklenmedi. SQLite için Node'un yerleşik modülü kullanılıyor.

## Gereksinimler

- **Node.js `>=22.13.0`** (yerleşik `node:sqlite` için; Node 24 önerilir) ve npm.
- **GitHub Copilot erişimi:** Copilot SDK, makinede GitHub hesabınızla oturum açmış kullanıcıyı kullanır (`useLoggedInUser: true`). Copilot CLI ile oturum açmış olmanız gerekir. Kullanılabilir modeller ve özellikler planınıza ve kuruluş politikalarına bağlıdır. Copilot kullanılamazsa uygulama yine açılır ve durumu bildirir.
- **Claude için (isteğe bağlı):** Anthropic Console API anahtarı ve Console hesabında kredi/faturalandırma (bkz. [Claude kullanımı](#claude-kullanımı-ve-olası-ücretler)).

## Kurulum

```sh
cd copilot-usage-dashboard
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

Ardından `.env` dosyasını düzenleyin (bir sonraki bölüm) ve [çalıştırma](#çalıştırma-geliştirme-ve-production) adımına geçin.

## `.env` ve yapılandırma

Sunucu, proje kökündeki `.env` dosyasını başlangıçta (`dotenv`) okur. Değişiklikten sonra sunucuyu yeniden başlatın. `.env.example` yalnızca boş değerler ve yorumlar içerir.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude için Anthropic Console API anahtarı (genellikle `sk-ant-api…`). Boşsa Claude "Yapılandırılmamış" görünür. OAuth (`sk-ant-oat…`) ve Admin (`sk-ant-admin…`) anahtarları reddedilir. |
| `CLAUDE_AGENT_MODEL` | SDK varsayılanı | Arayüzde seçim yapılmadığında kullanılacak Claude modeli: takma ad (`haiku`, `sonnet`, `opus`, `fable`) veya tam kimlik. |
| `CLAUDE_AGENT_EFFORT` | model varsayılanı | `low`, `medium`, `high`, `xhigh`, `max`. |
| `CLAUDE_REQUEST_TIMEOUT_MS` | `120000` | Claude çalıştırma süre sınırı (1000–900000). |
| `COPILOT_REQUEST_TIMEOUT_MS` | `120000` | Copilot çalıştırma süre sınırı (1000–900000). |
| `PORT` | `3001` | API portu. Geliştirme proxy'si `3001`'i beklediği için değiştirirseniz `vite.config.ts`'i de güncelleyin. |
| `DATABASE_PATH` | `data/explorer.sqlite` | SQLite dosyası. Klasör yoksa oluşturulur. |
| `HISTORY_RETENTION` | `1000` | Saklanacak en fazla çalıştırma sayısı (10–100000). |

## API anahtarlarının güvenli yönetimi

- Anahtar **yalnızca sunucu tarafındaki `.env`** dosyasından okunur. Tarayıcıya, API yanıtlarına, sunucu günlüklerine ve veritabanına yazılmaz. Otomatik testler bunu sahte bir anahtarla doğrular.
- `.env`, `.env.*` (`.env.example` hariç), `data/`, `*.sqlite*`, `node_modules/` ve `dist/` Git tarafından yok sayılır. Gerçek anahtarı commit etmeyin. Bir anahtar yanlışlıkla paylaşıldıysa Console'da iptal edip yenisini oluşturun.
- Veritabanında Claude doğrulama durumu için anahtarın yalnızca **kısaltılmış SHA-256 özeti** tutulur. Bu özetten anahtar geri elde edilemez; anahtar değiştiğinde eski doğrulama geçersiz sayılır.
- Claude alt sürecine üst süreçten gelen `CLAUDE_*` / `ANTHROPIC_*` değişkenleri (iç içe Claude Code oturumu işaretleri, OAuth token'ları, Bedrock/Vertex yönlendirmeleri) ve GitHub token'ları aktarılmaz. `CLAUDE_CONFIG_DIR` geçici bir dizine yönlendirildiği için makinedeki claude.ai oturumu ve `~/.claude` ayarları kullanılmaz. SDK'nın bildirdiği kimlik kaynağı `ANTHROPIC_API_KEY` değilse çalıştırma durdurulur (`CLAUDE_CREDENTIAL_SOURCE`).

## Çalıştırma: geliştirme ve production

| Komut | Ne yapar |
|---|---|
| `npm run dev` | API'yi (`127.0.0.1:3001`, dosya değişince yeniden başlar) ve Vite arayüzünü (`http://localhost:5173`) birlikte başlatır. Tarayıcıda **http://localhost:5173** adresini açın. |
| `npm run build` | Ön yüz, sunucu ve testler için TypeScript kontrolü ve `dist/` altına production derlemesi. |
| `npm run serve` | Derlenmiş arayüzü ve API'yi tek sunucudan yayınlar: **http://127.0.0.1:3001** (önce `npm run build`). |
| `npm start` | Yalnızca API'yi başlatır (arayüz sunmaz). |
| `npm run preview` | Vite önizleme sunucusu (yalnızca statik arayüz; API'yi ayrıca çalıştırın). |

Sunucu `Ctrl+C` ile kapatılır. Geliştirme sunucusu `node --watch --import tsx` ile çalışır. `tsx watch`, Windows'ta `concurrently` altında Claude SDK yüklenirken sunucuyu kilitlediği için kullanılmıyor.

## Vercel'de demo dağıtımı

Uygulama yerel bir GitHub hesabı oturumu (Copilot) ve kalıcı dosya sistemi (SQLite) gerektirdiği için, Vercel'in sunucusuz ortamında **gerçek** Copilot/Claude çağrıları ve kalıcı geçmişle çalışamaz. Bunun yerine `vercel.json` + `api/[...slug].ts`, **sahte sağlayıcılarla** (`server/demo/`) çalışan bir vitrin modu yayınlar:

- `server/demo/fake-providers.ts`: gerçek hesap/anahtar gerektirmeyen, örnek metrikler üreten sahte Copilot servisi ve Claude `queryFn`'i (testlerdeki sahte sağlayıcılarla aynı desen, bkz. `tests/api.test.ts`).
- `server/demo/create-demo-app.ts`: bu sahte sağlayıcılarla `createApp`'i kurar, geçmişi bellekte tutar (kalıcı değildir) ve `trustedHosts: 'any'` ile yerel-host kısıtlamasını kaldırır — gerçek bir anahtar/hesap olmadığı için bunun bir güvenlik riski yoktur.
- `api/[...slug].ts`: tüm `/api/*` isteklerini tek bir Vercel fonksiyonunda bu demo app'e yönlendirir.

Dağıtım: Vercel projesini bu dizine (`copilot-usage-dashboard`) kök (root) olarak işaret edip "Deploy" demeniz yeterli; `vercel.json` build komutunu (`npm run build`) ve çıkış dizinini (`dist`) zaten tanımlar. Ortam değişkeni veya API anahtarı gerekmez. Demo modunda her yanıtın başında/olaylarında "Demo modu" ibaresi bulunur ve üretilen veriler gerçek bir model çalıştırmasını temsil etmez.

Gerçek sağlayıcı çağrılarıyla bir cloud dağıtımı isterseniz mimarinin değişmesi gerekir (Copilot SDK'nın yerel oturum gereksinimi çözülemeyebilir; Claude için API anahtarı tabanlı ayrı bir backend; kalıcılık için harici bir veritabanı).

## Ücretsiz yerel testler

| Komut | Kapsam |
|---|---|
| `npm run test:unit` | 74 otomatik test: API uç noktaları (geçerli/hatalı istekler, model seçiminin aktarımı, sağlık durumu, sağlayıcı hatalarının bağımsızlığı, geçmiş filtreleme/silme, rapor, yerel erişim koruması, veritabanı olmadan başlatma, production statik sunum, anahtarın yanıt ve günlüklere düşmemesi), Copilot oturum güvenliği, Claude entegrasyonu, SQLite geçişleri ve kalıcılık, rapor, lisans, danışman. |
| `npm run typecheck` | Ön yüz, sunucu, testler ve betikler için TypeScript kontrolü. |
| `npm run lint` | ESLint. |
| `npm run build` | Production derlemesi. |

Bu testler **ağ çağrısı yapmaz ve API anahtarı gerektirmez**. Copilot ve Claude, sahte servis ve sahte SDK sorgularıyla test edilir.

> ⚠️ `npm run test:copilot-sdk`, gerçek bir Copilot oturumu açıp mesaj gönderir ve **Copilot kullanımı (AI Credit) tüketir**. Otomatik test paketinin parçası değildir; yalnızca bilerek çalıştırın. Gerçek Claude çağrısı yapan otomatik test yoktur.

## SQLite geçmişi, yedekleme ve sıfırlama

- **Konum:** varsayılan olarak `copilot-usage-dashboard/data/explorer.sqlite`. WAL kipi nedeniyle yanında `explorer.sqlite-wal` ve `explorer.sqlite-shm` dosyaları da bulunabilir. Konumu `DATABASE_PATH` ile değiştirebilirsiniz.
- **Ne saklanır:** sağlayıcı, strateji, durum ve hata kodu, istenen ve gerçek model, token değerleri, süre, tur/model/araç çağrısı sayıları, AI Credit veya USD tahmini (birimiyle ayrı), bağlam kullanımı, olay zaman çizelgesi ve en fazla 80 karakterlik görev etiketi.
- **Ne saklanmaz:** tam istem, tam yanıt, API anahtarı ve ortam değişkenleri.
- **Tablolar:**
  - `executions`: çalıştırma başına bir kayıt
  - `model_usage`: Copilot model kırılımı
  - `execution_events`: olay zaman çizelgesi
  - `provider_verifications`: Claude doğrulama durumu (anahtar özetiyle)
  - `schema_migrations`: uygulanmış şema sürümleri

  Geçişler başlangıçta transaction içinde otomatik uygulanır.
- **Saklama:** en yeni `HISTORY_RETENTION` (varsayılan 1000) kayıt tutulur; eskileri bağlı satırlarıyla birlikte silinir.
- **Arayüzden temizleme:** Kullanım Analizi → *Geçmişi temizle* → onay. API düzeyinde `DELETE /api/usage/history` isteği `{ "confirm": true }` gövdesi olmadan reddedilir.
- **Yedekleme:** sunucuyu durdurun ve `data/` klasörünü (üç dosya birlikte) kopyalayın. Sunucu çalışırken yedek almak isterseniz `sqlite3 data/explorer.sqlite ".backup yedek.sqlite"` komutunu kullanın (sqlite3 aracı gerekir).
- **Sıfırlama:** sunucuyu durdurup `data/` klasörünü silin. İlk başlatmada şema yeniden oluşturulur.
- **Veritabanı açılamazsa** (izin, kilit, bozuk yol) sunucu kapanmaz. Geçmiş bellekte tutulur ve yeniden başlatmada kaybolur. Kenar çubuğu ve sayfanın üstü "Kullanım geçmişi kalıcı kaydedilemiyor" uyarısı gösterir; `/api/health` → `services.database.persistent` değeri `false` olur.
- Node 24'te `node:sqlite` deneysel olarak işaretlidir ve başlangıçta bir `ExperimentalWarning` yazdırır; bu beklenen bir uyarıdır.

## Gerçek ölçümler ve tahminler

| Değer | Kaynak | Anlamı |
|---|---|---|
| Token, model/tur çağrısı, süre, gerçekte kullanılan model | Sağlayıcı SDK'sı | **Gerçek ölçüm.** Sağlayıcı bir değeri bildirmezse "Bilinmiyor" gösterilir ve toplamlara sıfır olarak eklenmez. Raporlarda her metrik için "X / Y başarılı çalıştırmada bildirildi" yazar. |
| **AI Credit** (Copilot) | Copilot SDK `totalNanoAiu` (10⁹ nano-AIU = 1 AI Credit) | **SDK'nın ölçtüğü tüketim.** Para birimi değildir. |
| **Tahmini maliyet (USD)** (Claude) | Claude Agent SDK `total_cost_usd` | **Tahmin.** SDK'nın fiyat tablosuyla hesaplanır, fatura değildir. Gerçek tutar Anthropic Console > Usage/Billing sayfasındadır. |
| Lisans hesaplayıcısı | `server/data/copilot-plans.ts` (GitHub belgelerinden elle girilmiş, son doğrulama tarihiyle) ve sizin girdileriniz | **Tahmin.** Koltuk fiyatı, dahil krediler ve beklenen kullanım düzenlenebilir. Sonuçta her değerin kaynağı (plan verisi / sizin değeriniz) belirtilir. |
| Copilot kotası | Deneysel SDK hesap RPC'si | **Anlık değer.** İstek anında alınır; gerçek zamanlı izleme yapılmaz. |

AI Credit ile USD birbirine **dönüştürülmez ve toplanmaz.** Karşılaştırma özetinde ve raporlarda ayrı birimlerle gösterilir. Bu uygulamada gerçek fatura tutarı gösterilmez.

## Copilot model kataloğu sınırlamaları

- Model listesi hesabın kataloğundan ve oturum kataloğundan gelir (`/api/copilot/models`). Liste alınırken bir Copilot oturumu açılıp kapatılır; modele mesaj gönderilmez.
- Bazı hesaplar/planlar **yalnızca Otomatik (`auto`)** seçeneğini sunar. Bu durumda arayüz bunu açıkça yazar ve başka model göstermez. Modeli Copilot çalışma zamanı seçer; gerçekte kullanılan model sonuç kartında gösterilir. Uygulama desteklenmeyen modelleri uydurmaz. Sunucu, hesapta olmayan bir model istenirse `UNSUPPORTED_MODEL` döndürür.
- Politika nedeniyle kapalı modeller seçilemez. Katalog çarpan (multiplier) bildiriyorsa gösterilir; token fiyatı sabitlenmez.
- Otomatik yönlendirme profilleri yalnızca hesap sunuyorsa listelenir.

## Claude kullanımı ve olası ücretler

- Claude çağrıları **Anthropic API (Console) hesabından, kullanılan modelin token fiyatına göre ücretlendirilir.** Claude Pro/Max aboneliği veya Claude Code erişimi bu API kullanımını kapsamaz ya da ücretsiz yapmaz. Console hesabında kredi bakiyesi veya faturalandırma tanımlı olmalıdır.
- Model listesi `/api/claude/models` uç noktasından gelir. Bu uç nokta kurulu Agent SDK'nın `supportedModels()` sonucunu, modele mesaj göndermeden alır ve 10 dakika önbellekte tutar.
- **Varsayılan model yüksek maliyetli olabilir.** SDK varsayılanı (`default`) bir Opus sınıfı modele çözümlenebilir. Arayüz bunu belirtir ve demo için daha düşük maliyetli bir model (ör. Haiku) seçebileceğinizi hatırlatır. Uygulama modeli kendiliğinden değiştirmez.
- Claude Code çalışma zamanı kendi sistem talimatını eklediği için kısa bir istem bile birkaç yüz girdi tokenı kullanabilir.
- Maliyeti sınırlamak için Console'da çalışma alanı harcama limiti tanımlamanız önerilir. İptal veya zaman aşımında çalıştırma durdurulur, ancak o ana kadar üretilen tokenlar ücretlendirilebilir.
- **Bağlantı durumları:**
  - `missing_key`: yapılandırılmamış
  - `invalid_key_format`: anahtar türü uygun değil
  - `sdk_unavailable`: Agent SDK kullanılamıyor
  - `unverified`: anahtar var ama doğrulanmadı
  - `verified`: aynı anahtarla gerçek bir çalıştırma başarılı oldu
  - `auth_failed` / `error`: son gerçek çalıştırma başarısız oldu

  Yalnızca anahtarın varlığı "doğrulandı" sayılmaz.

## Güvenlik ve hata yönetimi

- **Yerel erişim:** API yalnızca `127.0.0.1` üzerinde dinler. `Host` başlığı ve (varsa) `Origin` başlığı yerel değilse istek `403` ile reddedilir. Böylece başka bir web sitesi (DNS rebinding veya çapraz kaynak form gönderimiyle) kullanıcıdan habersiz model çağrısı başlatamaz.
- **Copilot oturumları:**
  - Her oturum boş, geçici bir dizinde açılır.
  - Ana ajan yalnızca SDK'nın `BuiltInTools.Isolated` kümesindeki oturum içi araçları kullanabilir (alt ajan, skill, görev tamamlama). Dosya, shell, ağ ve MCP araçları kapalıdır.
  - İzin gerektiren her istek reddedilir.
  - İşlem bitince oturum `disconnect` + `deleteSession` ile kapatılır ve geçici dizin silinir. Temizlik hatası asıl hatayı örtmez.
  - Süre aşımında veya istemci bağlantıyı kapattığında `session.abort()` çağrılır.
- **Claude oturumları:** Claude araçsız (`tools: []`), tek turlu, kalıcı olmayan oturumla, geçici çalışma dizininde ve yalıtılmış ortamda çalışır. Süre aşımı veya iptal `abortController` ile uygulanır.
- **Sağlayıcı bağımsızlığı:** Copilot veya Claude'un hatası diğerinin sonucunu, geçmiş kaydını ya da uygulamanın geri kalanını etkilemez. Copilot CLI başlatılamazsa API çalışmaya devam eder; Copilot uç noktaları `503 / COPILOT_UNAVAILABLE` döndürür ve 30 saniye bekledikten sonra yeniden bağlanmayı dener.
- **Hata yanıtları:** `{ error, code, setupHint? }` biçimindedir. Kodlar sabittir: `COPILOT_AUTH_REQUIRED`, `COPILOT_RATE_LIMITED`, `COPILOT_TIMEOUT`, `SESSION_LIMIT_REACHED`, `CLAUDE_NOT_CONFIGURED`, `CLAUDE_AUTH_FAILED`, `CLAUDE_BILLING`, `CLAUDE_RATE_LIMITED`, `REQUEST_CANCELLED`, `FORBIDDEN_ORIGIN`, `CONFIRMATION_REQUIRED`, `NOT_FOUND`, `INVALID_JSON` vb. Ham SDK mesajları, dosya yolları ve istek kimlikleri kullanıcıya gönderilmez. Başarısız çalıştırmalar hata koduyla birlikte geçmişe kaydedilir.

## API uç noktaları

| Yöntem | Uç nokta | Açıklama |
|---|---|---|
| GET | `/api/health` | API, Copilot (başlatılıyor / bağlı / oturum açılmamış / kullanılamıyor), Claude ve veritabanı durumu |
| GET | `/api/copilot/models` | Copilot model kataloğu, `scope: auto-only \| named` ve otomatik yönlendirme profilleri |
| GET | `/api/copilot/quota` | Anlık kota (deneysel SDK RPC'si) |
| POST | `/api/copilot/chat` | Copilot çalıştırması (`prompt`, `model`, `autoTier`, `strategy`, `maxAiCreditLimit`) |
| POST | `/api/copilot/fleet` | Deneysel Fleet çalıştırması |
| GET | `/api/claude/status` | Claude bağlantı durumu (anahtar değeri olmadan) |
| GET | `/api/claude/models` | Claude Agent SDK model listesi (`?refresh=1`); model çağrısı yapmaz |
| POST | `/api/claude/chat` | Claude çalıştırması (`prompt`, `claudeModel`) |
| POST | `/api/compare` | Sağlayıcıları bağımsız çalıştırır (`providers`, Copilot ve Claude model seçimleri) ve ortak metrik özetini döndürür |
| GET | `/api/usage/history` | Geçmiş (`?provider=github-copilot\|claude`, `?status=success\|error`, `?limit=` en fazla 200); `storage`, `persistent`, `total` içerir |
| DELETE | `/api/usage/history` | Tüm geçmişi siler; gövde `{ "confirm": true }` zorunlu |
| GET | `/api/usage/summary` | Kayıtlı geçmişten sağlayıcı raporu ve gözlemler |
| POST | `/api/advisor/recommend` | Kural tabanlı mod önerisi |
| GET | `/api/licensing/plans` | Plan verisi, kaynaklar ve son doğrulama tarihi |
| POST | `/api/licensing/calculate` | Lisans/maliyet hesabı (`plan`, `seats`, `expectedCreditsPerSeat`, isteğe bağlı `includedCreditsPerSeat`, `seatPriceUsd`) |

## Bilinen sınırlamalar ve backlog

Bu backlog, kullanım analizi ve iyileştirme backlog'udur; ayrı bir proje yönetim sistemi değildir. Aynı içerik uygulamadaki **Raporlar ve Backlog** bölümünde de yer alır (`src/content/backlog.ts`).

**Tamamlananlar**
- Copilot ve Claude'u yan yana, birbirinden bağımsız çalıştırma ve ortak metrik karşılaştırması.
- Yalnızca sağlayıcının bildirdiği gerçek metriklerin gösterilmesi; bilinmeyen değerlerin sıfır sayılmaması.
- Gerçek uç noktalardan Copilot ve Claude model seçimi; seçimin backend isteğine aktarılması.
- SQLite ile kalıcı, filtrelenebilir, ayrıntısı açılabilir ve onayla temizlenebilir geçmiş; kayıtlı veriden rapor.
- Güvenli oturumlar (geçici dizin, araç kısıtlaması, izin reddi), zaman aşımı ve iptal, yalıtılmış Claude alt süreci, yerel erişim koruması.
- Copilot veya veritabanı kullanılamasa da dayanıklı başlatma ve açık durum bildirimi.

**Bilinen sınırlamalar**
- Copilot model kataloğu hesaba bağlıdır; bazı hesaplar yalnızca `auto` sunar.
- Claude maliyeti SDK tahminidir; gerçek fatura Anthropic Console'dadır.
- Plan fiyatları ve kredi tahsisatları belgeden elle girilmiştir (`lastVerified` tarihi) ve değişmiş olabilir.
- Kota bilgisi deneysel bir RPC'den anlık alınır; tarihçesi tutulmaz.
- Fleet, kota RPC'si ve `node:sqlite` deneysel bileşenlerdir.
- Claude için model başına token kırılımı henüz `model_usage` tablosuna yazılmıyor.
- Yerel tek kullanıcı içindir; çok kullanıcılı kimlik doğrulama yoktur.
- Ön yüz için otomatik bileşen testleri yoktur. Arayüz; derleme, API testleri ve tarayıcıda masaüstü/390 px mobil kontrolüyle doğrulandı.

**Sonraki geliştirme önerileri**
- Geçmişteki gerçek ölçümlerden zaman serisi grafikleri.
- Claude model kırılımını kaydetmek.
- Geçmiş ve raporları CSV/JSON olarak dışa aktarma.
- İsteğe bağlı kota anlık görüntülerini mevcut migration düzeniyle tarihçeli saklamak.
- Plan fiyatlarını kaynak belgelerle periyodik olarak karşılaştıran bir kontrol listesi.
- Ön yüz bileşen testleri (ek bağımlılık gerektirir).
