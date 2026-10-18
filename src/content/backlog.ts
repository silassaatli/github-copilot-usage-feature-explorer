/**
 * Kullanım analizi ve iyileştirme backlog'u. README'deki "Backlog" bölümüyle
 * aynı içeriği taşır; bu bir proje yönetim sistemi değildir.
 */
export interface BacklogItem {
  title: string
  detail: string
}

export const completedItems: BacklogItem[] = [
  {
    title: 'Copilot ve Claude yan yana çalıştırma',
    detail: 'Aynı görev iki sağlayıcıda bağımsız çalışır; birinin hatası diğerinin sonucunu etkilemez.',
  },
  {
    title: 'Gerçek SDK ölçümleri',
    detail: 'Token, süre, model/tur çağrısı, AI Credit ve Claude USD tahmini yalnızca sağlayıcı bildirdiğinde gösterilir.',
  },
  {
    title: 'Model seçimi',
    detail: 'Copilot hesap kataloğu ve Claude Agent SDK model listesi gerçek uç noktalardan alınır; seçim isteğe aktarılır.',
  },
  {
    title: 'Kalıcı kullanım geçmişi',
    detail: 'SQLite ile saklanır; filtrelenebilir, ayrıntısı açılabilir ve onayla temizlenebilir. Tam istem/yanıt saklanmaz.',
  },
  {
    title: 'Güvenli çalışma ortamı',
    detail: 'Copilot oturumları geçici dizinde, dosya/shell/ağ araçları kapalı ve izinler reddedilerek açılır; Claude alt süreci yalıtılır.',
  },
  {
    title: 'Dayanıklı başlatma',
    detail: 'Copilot CLI veya veritabanı kullanılamasa da uygulama açılır ve durumu açıkça bildirir.',
  },
]

export const knownLimitations: BacklogItem[] = [
  {
    title: 'Copilot model kataloğu hesaba bağlı',
    detail: 'Bazı hesaplar yalnızca Otomatik (auto) seçeneğini sunar; bu durumda model Copilot tarafından seçilir.',
  },
  {
    title: 'Claude maliyeti tahminidir',
    detail: 'Gösterilen USD tutarı Agent SDK tahminidir; gerçek fatura Anthropic Console’dadır.',
  },
  {
    title: 'Plan fiyatları elle girilmiş veridir',
    detail: 'Lisans hesaplayıcısındaki koltuk fiyatı ve kredi tahsisatları belgeden alınmıştır, değişmiş olabilir; değerleri kendiniz girebilirsiniz.',
  },
  {
    title: 'Kota bilgisi anlık ve deneyseldir',
    detail: 'Copilot kotası deneysel SDK RPC’sinden istek anında alınır; gerçek zamanlı izleme yapılmaz.',
  },
  {
    title: 'Deneysel bileşenler',
    detail: 'Fleet ve kota RPC’leri ile Node’un node:sqlite modülü deneysel olarak işaretlidir.',
  },
  {
    title: 'Yerel tek kullanıcı',
    detail: 'Sunucu yalnızca 127.0.0.1 üzerinde çalışır; çok kullanıcılı kimlik doğrulama yoktur.',
  },
]

export const nextSteps: BacklogItem[] = [
  {
    title: 'Zaman serisi grafikleri',
    detail: 'Geçmişteki gerçek ölçümlerden günlük/haftalık token ve AI Credit eğilimleri.',
  },
  {
    title: 'Claude model kırılımı',
    detail: 'Claude için model başına token ayrıntısını da model_usage tablosuna yazmak.',
  },
  {
    title: 'Dışa aktarma',
    detail: 'Geçmiş ve raporları CSV/JSON olarak indirme.',
  },
  {
    title: 'Kota anlık görüntüleri',
    detail: 'Kullanıcı istediğinde alınan kota değerlerini tarihçeli saklamak (mevcut migration düzeniyle).',
  },
  {
    title: 'Fiyat kaynağı doğrulaması',
    detail: 'Plan fiyatlarını belge kaynağıyla periyodik olarak karşılaştıran bir kontrol listesi.',
  },
]
