# GitHub Copilot Kullanım ve Ajan Stratejisi Analizörü

Türkçe yerel demo uygulaması. GitHub Copilot SDK ve Anthropic Claude Agent SDK çalışma zamanlarında aynı görevi çalıştırıp sağlayıcıların gerçek kullanım ölçümlerini yan yana gösterir; ayrıca Copilot kullanım analizi, danışmanı, lisans hesaplayıcısı ve özellik rehberi içerir.

## Mimari

```text
React
  ↓ /api/... (Vite geliştirme proxy'si)
Express API
  ├── GitHub Copilot SDK (yalnızca sunucuda)
  │     ├── Kota, Skills, alt ajanlar ve Fleet
  │     └── Oturum/token/AI Credit ölçümleri
  └── Claude Agent SDK (yalnızca sunucuda)
        ├── API key: ANTHROPIC_API_KEY
        ├── Araçlar kapalı, geçici çalışma dizini
        └── Token/düşünme/USD maliyet tahmini
```

## Gereksinimler

- Node.js `^20.19.0` veya `>=22.12.0`
- npm
- GitHub Copilot CLI kurulumu ve mevcut GitHub hesabıyla oturum açılmış olması
- Copilot planı/model kataloğu ve ilgili özellikler için hesap erişimi

SDK, oturum açılmış kullanıcıyı kullanır (`useLoggedInUser: true`). Token veya API anahtarı kaynak kodda tutulmaz. `@github/copilot-sdk` React uygulamasına dahil edilmez.

Claude Agent SDK, Anthropic'in güncel resmi `@anthropic-ai/claude-agent-sdk` paketini kullanır; eski `@anthropic-ai/claude-code` paketi kullanılmaz. Resmî [Agent SDK genel bakışı](https://code.claude.com/docs/en/agent-sdk/overview) üçüncü taraf ürünlerde claude.ai oturum açma/kota sunulmasına izin verilmediğini belirtir; bu uygulama sunucu ortamındaki Anthropic Console API anahtarını (`ANTHROPIC_API_KEY`) kullanır. Claude anahtarı tarayıcıya veya API yanıtlarına gönderilmez.

Claude bağlantısını açmak için proje kökünde `.env.example` dosyasını `.env` olarak kopyalayın ve Anthropic Console'da oluşturduğunuz anahtarı yalnızca sunucunun kullanacağı bu dosyaya ekleyin:

```env
ANTHROPIC_API_KEY=...
```

Sunucu, kök dizindeki `.env` dosyasını `dotenv/config` ile yükler. `.env` ve diğer `.env.*` dosyaları Git tarafından yok sayılır; gerçek anahtarı kaynak koduna veya istemciye koymayın. Anahtar yoksa uygulama normal çalışır, Claude paneli kurulum adımlarını gösterir ve Copilot kullanılabilir kalır. Anahtarın geçerliliği ilk açık Claude çalıştırmasında sınanır; sayfa yüklenirken Claude isteği gönderilmez.

## Kurulum ve çalıştırma

```sh
npm install
npm run dev
```

`npm run dev`, Express API'yi `127.0.0.1:3001` ve Vite uygulamasını `localhost:5173` üzerinde birlikte çalıştırır. Vite `/api` isteklerini Express'e iletir.

```sh
npm run build
npm run lint
npm run typecheck
npm run test:unit
npm run test:copilot-sdk
```

`npm run start` Express API'yi tek başına başlatır. Üretim ön yüzünü statik dosya sunucusuyla ayrıca sunun ve `/api` isteklerini bu API'ye yönlendirin.

## Özellikler

### Oyun alanı

- Ortak görev tek `/api/compare` isteğiyle seçilen sağlayıcılara ayrı ayrı gönderilir. İki sağlayıcı çalıştırılmadan önce açık kullanıcı onayı gerekir; sağlayıcı hataları birbirinden bağımsız yakalanır.
- Copilot model kataloğu sunucuda tutulur; Playground'da anlamsız tek seçenekli model menüsü yoktur. Copilot isteği `auto` kipini kullanır, SDK'nın gerçek model ölçümü sonuçta gösterilir.
- Claude Agent SDK model seçimi göndermez; kurulu SDK/CLI'nin varsayılan modelini kullanır. SDK, bu pakette hesap model kataloğu API'si sağlamaz.
- Claude çalıştırması `tools: []`, `permissionMode: 'dontAsk'`, boş ayar kaynakları, kalıcı olmayan oturum ve sistem geçici diziniyle sınırlandırılır; proje dosyalarına, shell'e, MCP'ye veya Skills'e araç erişimi verilmez.
- Copilot AI Credit ile Claude USD maliyet tahmini farklı birimler olarak gösterilir ve birbirleriyle kıyaslanmaz. Hız ve token özeti yalnızca iki tarafta da ölçülen alanları karşılaştırır; yanıt kalitesi hakkında iddia üretmez.
- `POST /api/copilot/chat` ve deneysel Fleet dahil mevcut Copilot yolları korunur.
- `POST /api/copilot/chat` modeli sunucu tarafında doğrular ve her istek için bir oturum açar.
- `normal`, `skill` ve `subagents` stratejileri oturum ayarlarını değiştirir. Skill/alt ajan kullanımı yalnızca SDK olayı gelirse gerçekleşmiş sayılır.
- İsteğe bağlı AI Credit sınırı SDK `sessionLimits.maxAiCredits` alanına aktarılır.
- Yanıt, model çağrıları, tokenlar, süre, bağlam, araç/skill/alt ajan olayları ve AI Credit kullanımı gösterilir.

### Kullanım analizi

- `assistant.usage` olayları model başına çağrı ve token bilgilerini verir.
- `session.usage_info` bağlam tokenlarını ve token sınırını bildirir.
- `session.rpc.usage.getMetrics()` oturum toplamlarını ve model kırılımını sağlar.
- `totalNanoAiu`, SDK'nın nano-AIU ölçeğinden AI Credit'e `1.000.000.000` böleniyle çevrilir. Dönüştürme değeri SDK runtime'ının kullandığı AIU ölçeğiyle uyumludur.
- Kullanım geçmişi bellekte en fazla 30 çalıştırma tutar. Tam istek ve Copilot yanıtı history endpoint'inde saklanıp sunulmaz; en fazla 80 karakterlik görev etiketi ve ölçüm özeti tutulur.
- Geçmiş sağlayıcıyı ve iki çalıştırmayı aynı karşılaştırma ID'siyle ilişkilendirir; Claude geçmişine prompt veya yanıt yazılmaz.
- Kota `client.rpc.account.getQuota({})` üzerinden istenir. Bu SDK RPC'si deneysel; desteklenmeyen hesap/runtime için kullanılabilir değil durumu gösterilir.
- Premium request alanları varsa yalnızca eski uyumluluk tanısı olarak ele alınır; güncel faturalandırma hesabında kullanılmaz.

### Mod danışmanı

Yerel, deterministik kurallar görev boyutunu ve iş akışı gereksinimlerini değerlendirir. Bu özellik öneri üretmek için Copilot çağrısı yapmaz. Göreli düşük/orta/yüksek sınıfları maliyet tahmini değildir.

### Karşılaştırma

Aynı görev Copilot veya Claude'da tek başına ya da açık onay sonrası ikisinde çalıştırılabilir. Farklı sağlayıcı hataları diğer sonucun kaybolmasına yol açmaz. Ayrı Karşılaştırma Laboratuvarı Copilot Normal/Skill/alt ajan/Fleet stratejilerini kullanmaya devam eder.

### Lisans ve maliyet

Plan koltuk ücretleri ve AI Credit tahsisatları tek merkezi veri modülündedir. Son doğrulama: **15 Ekim 2026**.

- Bireysel: Pro, Pro+ ve Max aylık koltuk fiyatları ile base/flex ve toplam AI Credit tahsisatları.
- Kuruluş: Business ve Enterprise kullanıcı başına aylık tahsisatları; Business sabit koltuk fiyatı.
- Enterprise fiyatı teklife göre değiştiği için kullanıcının teklif fiyatı girilmeden abonelik toplamı hesaplanmaz.
- Kullanım AI Credit başına **$0,01** ile hesaplanır. Aylık ek kullanım tahmini yalnızca beklenen tüketimin dahil edilen krediyi aşan bölümü içindir.
- Copilot Free ve Student bu ücretli plan tablosuna dahil değildir; lisans ve kullanım sınırları farklıdır.
- Kaynaklar: [bireysel kullanım ve tahsisatlar](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing), [kuruluş ve enterprise tahsisatları](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing), [lisans ücretleri](https://docs.github.com/en/billing/concepts/product-billing/github-copilot-licenses).

### Özellik rehberi ve yerel Skill

Özellik rehberi Sohbet, Ajan Modu, Skills, özel ajanlar/alt ajanlar, Fleet, MCP, Hooks, oturum sınırları ve model seçimini Türkçe açıklar. `skills/code-review/SKILL.md` salt okunur, kanıta dayalı bir kod inceleme Skill'i örneğidir. Skill oturumu yalnızca bu sabit sunucu dizinini kullanır.

## API

| Yöntem | Uç nokta | Açıklama |
|---|---|---|
| GET | `/api/health` | API, Copilot (başlatılıyor/hazır/kullanılamıyor, CLI sürümü, oturum açma durumu) ve Claude yapılandırma durumu |
| GET | `/api/copilot/models` | Runtime model kataloğu ve SDK metadata |
| POST | `/api/copilot/chat` | Yeni oturumda Copilot isteği ve ölçümler |
| POST | `/api/copilot/fleet` | Deneysel Fleet RPC; destek yoksa açıklayıcı hata |
| GET | `/api/claude/status` | Kimlik bilgisi değerini açığa çıkarmadan Claude yapılandırma durumu |
| POST | `/api/claude/chat` | Araç erişimi kapalı Claude Agent SDK çalıştırması |
| POST | `/api/compare` | Sağlayıcı çalıştırmaları, bağımsız hata sonuçları ve ortak metrik özeti |
| GET | `/api/copilot/quota` | Deneysel hesap kota RPC'si |
| GET | `/api/usage/history` | Bellekteki en fazla 30 ölçüm özeti |
| POST | `/api/advisor/recommend` | Ücretsiz kural tabanlı mod önerisi |
| GET | `/api/licensing/plans` | Merkezi plan fiyatları/tahsisatları ve kaynak metadata |
| POST | `/api/licensing/calculate` | Koltuk, dahil kredi ve ek kullanım hesabı |

## Copilot oturum güvenliği ve hata yönetimi

- Her Copilot oturumu boş, geçici bir çalışma dizininde (`os.tmpdir()/copilot-explorer-*`) açılır; proje klasörü oturuma verilmez.
- Ana ajan yalnızca SDK'nın `BuiltInTools.Isolated` kümesindeki oturum içi araçları kullanabilir (alt ajan, skill, görev tamamlama). Dosya, shell, ağ ve MCP araçları kapalıdır; izin gerektiren her istek `onPermissionRequest` ile reddedilir.
- İşlem bitince oturum `disconnect` ve `deleteSession` ile kapatılır, geçici dizin silinir. Temizlik hataları yalnızca sunucu günlüğüne yazılır ve asıl hatayı örtmez.
- Çalıştırmalar `COPILOT_REQUEST_TIMEOUT_MS` (varsayılan 120000, en fazla 900000) süresiyle sınırlıdır. Süre dolarsa veya istemci bağlantıyı kapatırsa `session.abort()` çağrılır.
- Copilot CLI başlatılamazsa API çalışmaya devam eder (degraded mode). Lisans ve Mod Danışmanı çalışır; Copilot uç noktaları `503 / COPILOT_UNAVAILABLE` döndürür ve 30 saniyelik bekleme sonrasında yeniden bağlanmayı dener.
- Hata yanıtları `{ error, code }` biçimindedir. `code` sabit bir değerdir (`COPILOT_AUTH_REQUIRED`, `COPILOT_RATE_LIMITED`, `COPILOT_TIMEOUT`, `SESSION_LIMIT_REACHED` vb.); ham SDK mesajları, yollar ve istek kimlikleri kullanıcıya gönderilmez.

## Deneysel özellikler ve sınırlamalar

- Kullanım metrikleri, hesap kotası ve Fleet RPC'si kurulu SDK tiplerinde deneysel olarak işaretlenmiştir; runtime veya hesap desteklemiyorsa veri/özellik kullanılamaz durumu bildirilir.
- Skill çağrısı ile alt ajan delegasyonu model/runtime kararına bağlıdır. Ayarı açmak tek başına kullanım olduğunu kanıtlamaz; yalnızca SDK olayları gerçek çağrıyı gösterir.
- Alt ajan örnekleri dosya ve shell araçları tanımlamayan salt okunur özel ajan yapılandırmalarıdır; harici MCP sunucusu eklenmemiştir.
- Fleet çoklu ajan maliyetine yol açabileceği için varsayılan değildir ve yalnızca açık kullanıcı çalıştırmasıyla çağrılır. Güncel runtime hesabında gerçek Fleet çalıştırması ayrıca doğrulanmalıdır.
- Model token fiyatları sabitlenmez; seçilen modelin SDK kataloğunda sunduğu metadata kullanılır. Model maliyeti/model seçimi değişebilir.
- Hesap kota alanı varsa SDK'nın döndürdüğü gibi gösterilir; quota alan isimleri runtime'a göre değişebilir.
- AI Credit metrikleri API/runtime sağlayınca gösterilir; bulunmadığında sıfır veya tahmin gösterilmez.
- Claude `total_cost_usd`, Agent SDK'nın oturum için verdiği tahmindir, fatura değildir. SDK token/cost alanları veya güncel model fiyatı sağlamazsa alan kullanılamıyor gösterilir; model fiyatları elle sabitlenmez.
- Claude modeli ayrıca seçilmez; güncel Agent SDK/CLI varsayılanı kullanılır. Makinede Anthropic API anahtarı bulunmadığından canlı Claude bağlantısı bu geliştirme sırasında denenmemiştir.
- Plan fiyatlandırması USD ve aylık bazdadır. Enterprise koltuk fiyatı değişkendir. Planlar değişebileceğinden kaynak tarihini tekrar kontrol edin.

## Mentor demosu (5 dakika)

1. **Oyun Alanı:** Ortak kısa bir Türkçe görev yazın; yalnız Copilot'u çalıştırın, ardından iki sağlayıcı için uyarıyı onaylayın. Gerçek Copilot modelini ve her sağlayıcının ölçüm kaynağını gösterin.
2. **Kullanım Analizi:** Model/token/AI Credit/süre/bağlam ölçümlerine, olay zaman çizelgesine ve SDK kotası kullanılabilir değil durumuna bakın.
3. **Mod Danışmanı:** Basit soru, çok adımlı dosya işi ve birbirinden bağımsız büyük iş için kural tabanlı önerileri karşılaştırın.
4. **Skill ve özel ajanlar:** Skill çalıştırmasını açıkça başlatın; yalnızca SDK'nın `skill.invoked` veya alt ajan olaylarını gerçek yürütme kanıtı olarak gösterin. Fleet'i deneysel ve maliyetli olabileceği için isteğe bağlı bırakın.
5. **Karşılaştırma ve lisans:** Girdi/çıktı tokenı ve süre karşılaştırmasını, AI Credit ile USD birimlerinin ayrı tutulduğunu gösterin. Ardından Business koltuk sayısını ve beklenen AI Credit kullanımını değiştirin.

## Testler

`npm run test:unit` kural motoru, lisans hesabı ve sağlayıcı normalizasyonu/karşılaştırma testlerini çalıştırır. `npm run test:copilot-sdk` korunmuş SDK kanıt örneğini çalıştırır ve gerçek Copilot kullanımı tüketir. Claude canlı çağrısı ayrı ve isteğe bağlıdır; API anahtarı ile maliyet gerektirir.
