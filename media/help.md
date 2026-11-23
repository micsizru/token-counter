# Token Sayar Yardım

Token Sayar, Antigravity sohbetlerinin aktif bağlam (context) doluluğunu, mesaj başına işlenen token dağılımını ve otomatik sıkıştırma tavanını durum çubuğunda ve yan görünümde canlı olarak izler.

## Görünümler ve Alanlar

Sol etkinlik çubuğundaki **Token Sayar** simgesi altında iki yerel TreeView görünümü bulunur: **Bağlam** ve **Mesaj Akışı**.

### Bağlam görünümü (`Bağlam`)

| Alan | Açıklama |
| --- | --- |
| **Sohbet** | Görünümün en üstündeki tıklanabilir seçici satırdır. Tıklandığında çalışma alanlarına göre gruplanmış sohbet seçme listesini açar. Aktif olmayan bir sohbet inceleniyorken hemen altında **Aktif sohbete dön** satırı görünür. |
| **Doluluk** | 20 hücreli eşik işaretli doluluk çubuğu (`▰` dolu, `▱` boş, `│` sarı eşik, `┃` kırmızı eşik) ile birlikte modelin şu anda çalışma hafızasında tuttuğu token miktarını, aktif tavanı ve yüzdeyi (`Yeni Girdi + Önbellekten Okunan`) gösterir. |
| **Durum** | Doluluk oranına göre bağlamın mevcut verimlilik kademesi (`Sağlıklı`, `Dolmaya başladı`, `Dolu, sıkıştırma önerilir`, `Kritik, yeni sohbet önerilir`). |
| **Kalan** | Otomatik sıkıştırma (compaction) sınırına ulaşmadan önce kalan boş bağlam alanı ve son mesajlardaki ortalama büyümeye göre tahmini kalan mesaj sayısı (`~N mesaj`). |
| **Model** | Son adımda kullanılan aktif model. Aynı sohbette birden fazla model kullanıldıysa toplam model sayısı ile birlikte son kullanılan model gösterilir; açıldığında tüm modeller listelenir. |
| **Tur ve sıkıştırma** | Modelin yanıt verdiği adım sayısı (araç çağrıları dahil) ve sohbetin başından bu yana Antigravity tarafından kaç kez otomatik özetlenip sıkıştırıldığı. |

### Ayrıntılar alt başlıkları

| Alt Alan | Açıklama |
| --- | --- |
| **Son adım yeni girdi** | Yalnızca son model adımında sıfırdan eklenen taze token miktarı (yeni mesaj, okunan dosya, araç çıktısı). |
| **Son adım önbellekten okunan** | Önceki konuşma geçmişinden yeniden işlenmeden önbellekten (cache) okunan token miktarı. |
| **Son adım çıktısı** | Modelin son adımda ürettiği yanıt ve düşünme tokenlarının toplamı. |
| **Oturum toplamı işlenen** | Sohbet başından beri her turda kümülatif olarak işlenen toplam girdi ve önbellek okuma miktarı. |
| **Oturum toplam çıktı** | Sohbet başından beri modelin ürettiği toplam çıktı tokenı. |
| **Önbellek tasarruf oranı** | Oturum boyunca okunan toplam tokenlar içinde önbellekten (cache) karşılanan kısmın yüzdesi. |
| **Limit kaynağı** | Kullanılan tavan değerin kaynağı (`Antigravity sohbet verisi`, `Model tablosu`, `Özel model ayarı` veya `Varsayılan ayar`). |
| **Son güncelleme** | Token verisinin en son okunduğu saat (`SS:DD:SN`). |

### Mesaj Akışı görünümü (`Mesaj Akışı`)

Her kullanıcı mesajını kronolojik olarak listeler ve yalnızca son tur varsayılan olarak açık gelir. Başlık çubuğundaki **Raporu Aç** düğmesi ile aktif veya incelenen sohbetin bağlam özeti ve mesaj akışı dökümü Markdown belgesi olarak açılabilir.

Her mesaj turunun altında sırasıyla beş kronolojik adım gösterilir:

1. **Senin mesajın**: Yazdığınız metnin tahmini token sayısı (yaklaşık 4 karakter = 1 token).
2. **Modele okutulan bağlam (N adım)**: O mesaj turundaki tüm adımlar boyunca modele okutulan toplam kümülatif bağlam trafiği (`önbellek · yeni`). Açıldığında `Önbellekten tekrar okunan`, `İlk kez okunan yeni girdi` ve `Adım başına ortalama okunan` alt satırlarını gösterir.
3. **Model düşünmesi (geçici)**: Modelin yanıt yazmadan önce arka planda yürüttüğü iç akıl yürütme tokenları (`gen_metadata` içindeki `f1.f4.f9` alanı). Model bu ayrımı bildirmiyorsa `—` gösterilir.
4. **Model yanıtı ve araç çağrıları**: Size yazılan görünür metin ile dosya okuma veya komut çalıştırma gibi araç çağrıları (`gen_metadata` içindeki `f1.f4.f10` alanı).
5. **Net bağlam değişimi (kalıcı)**: Tur öncesi ve sonrası aktif bağlam arasındaki net fark (`Önceki → Sonraki (+Artış)` veya otomatik sıkıştırma olduysa `Sıkıştırıldı`). Açıldığında `Önceki bağlam`, `Eklenen kullanıcı mesajı`, `Eklenen araç çıktıları ve yanıtlar`, `Yeni aktif bağlam` ve `Adım adım bağlam ilerlemesi` alt dallarını gösterir.

## Bağlam değişimi ile okunan tokenlar arasındaki fark nedir

Kısa bir mesaj yazdığınızda **Mesaj Akışı** içinde `2,14M` gibi büyük bir işlenen token görürken kalıcı bağlamın yalnızca `+19,8K` büyüdüğünü görebilirsiniz. Bu bir hata değildir; model çağrılarının çalışma biçiminden kaynaklanır.

Tek bir mesaj turunun 14 adımda şu sayıları ürettiğini düşünelim:

- **Önbellekten tekrar okunan**: `1,76M`
- **İlk kez okunan yeni girdi**: `348K`
- **Model düşünmesi (geçici)**: `10,5K`
- **Model yanıtı ve araç çağrıları**: `25,8K`
- **Net bağlam değişimi**: `137,2K → 157,0K (+19,8K)`

Bunun aritmetiği üç adımda açıklanır:

1. **Her adımda pencere yeniden okunur (`2,11M` kümülatif okuma trafiği)**: Model tek bir yanıtta dosya okuma, arama veya komut çalıştırma gibi 14 ayrı adım atabilir. Her adımda yaklaşık `150K` boyutundaki konuşma penceresi modele baştan gönderilir (`14 × ~150K ≈ 2,11M`, yani `1,76M` önbellek + `348K` yeni girdi). Bu toplam, sohbet penceresinin `2,11M` boyutuna çıktığı anlamına gelmez; yalnızca 14 kez okunan kümülatif API trafiğidir.
2. **Düşünme tokenları gelecek turlarda saklanmaz (`10,5K` geçici)**: Modelin kendi içinde kurduğu `10,5K` tokenlık akıl yürütme süreci yanıt üretildikten sonra geçmişten düşülür; sonraki turların bağlam kotasını doldurmaz.
3. **Kalıcı büyüme yalnızca saklanan parçalardan oluşur (`+19,8K`)**: Tur bittiğinde konuşma geçmişinde kalıcı olarak tutulan kısım sizin yazdığınız istem (`~456` token) ile gelecek tura aktarılan araç çıktıları ve son yanıttır (`19,3K`). Hesaplama doğrudan eşittir: `137,2K + 456 + 19,3K = 157,0K` (`+19,8K`).

## Limit nereden geliyor

Modellerin tanıtım belgelerinde yer alan `1M+` gibi teorik pencere boyutları ile sohbet sırasında gördüğünüz `512K`, `256K`, `160K` veya `128K` değerleri farklıdır. Token Sayar'da gösterilen tavan değerler, Antigravity'nin kendi **otomatik sıkıştırma (auto-compaction) bağlam bütçesidir**:

- Antigravity her sohbet için yerel veritabanında (`conversations/<uuid>.db`) bulunan `executor_metadata` tablosuna her adımda (`idx`) `f10.f2.f5` protobuf alanını yazar. Bu değer, sohbetin otomatik özetlenmeden önce ulaşabileceği gerçek bütçedir.
- Aynı sohbette birden fazla model veya kademe kullanıldığında Antigravity her adım için ayrı bir satır kaydeder ve bir sonraki turda sıkıştırma kararını **en son aktif adımın bütçesine** göre verir.
- Token Sayar veritabanını salt-okunur biçimde `ORDER BY idx DESC LIMIT 1` sorgusuyla okuyarak daima son aktif adımın tavan değerini esas alır. Tur sayısı veya `.db` dosya zamanı değiştiğinde tavan değeri otomatik güncellenir.

## Renkler ve eşikler

Token Sayar'daki renk kademeleri ve `%55` / `%80` varsayılan uyarı eşikleri, uzun bağlamda model performansının düşüşünü inceleyen araştırmalara ve kodlama ajanı pratiklerine dayanır:

| Doluluk | Renk | Durum | Önerilen Adım |
| --- | --- | --- | --- |
| `< %55` | Yeşil | Sağlıklı | Odak yüksektir; normal şekilde devam edilebilir. |
| `%55 – %79,9` | Sarı | Dolmaya başladı | Dikkat dağılması ve eski adımların unutulması başlayabilir. Yeni bir alt göreve geçmeden önce özetleme değerlendirilebilir. |
| `%80 – %91,9` | Turuncu | Dolu, sıkıştırma önerilir | Belirgin bağlam yorgunluğu bölgesi. `/compact` çalıştırmak veya temiz bir yeni sohbet açmak önerilir. |
| `>= %92` | Kırmızı | Kritik, yeni sohbet önerilir | Otomatik sıkıştırma çok yakındır. Kritik kuralların kaybolmaması için yeni sohbete geçmek en güvenli yoldur. |

Dayanılan başlıca kaynaklar:

- **Liu et al. (2023 / TACL 2024)**, *"Lost in the Middle"* (`https://arxiv.org/abs/2307.03172`): Modellerin uzun bağlamda U şeklinde bir dikkat eğrisine sahip olduğunu ve ortada kalan kritik bilgilerin doğruluğunda %15–30 ve üzeri düşüş yaşandığını gösterir.
- **Hsieh et al. / NVIDIA (2024)**, *"RULER"* (`https://arxiv.org/abs/2404.06654`): Çok adımlı muhakeme ve birleştirme görevlerinde modellerin etkin bağlam uzunluğunun ilan edilen teorik pencerenin (128K–1M) belirgin biçimde altında kaldığını ortaya koyar.
- **Chroma (2025)**, *"Context Rot"* (`https://research.trychroma.com/context-rot`): 18 model üzerinde yapılan testlerde güvenilirliğin %100 sınırında aniden değil token arttıkça sürekli bozulduğunu, konuşma görevlerinde yaklaşık ~113K token sonrasında dikkat dağıtıcılarla belirginleştiğini ölçer.
- **Anthropic (2025)**, *"Effective Context Engineering for AI Agents"* (`https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents`): Bağlamın sınırlı bir dikkat bütçesi olduğunu vurgular; sıkıştırma, yapılandırılmış not alma ve alt-ajan kullanımını önerir.

`256K` bütçede `%55` eşiği yaklaşık `141K`, `512K` bütçede yaklaşık `282K` tokena denk gelir; bu aralık literatürde gözlenen bozulma eşiğiyle uyumludur.

## Ayarlar

VS Code / Antigravity ayarlarından (`tokenSayar.*`) izleme davranışını özelleştirebilirsiniz:

| Ayar | Varsayılan | Açıklama |
| --- | --- | --- |
| `tokenSayar.enabled` | `true` | Eklenti takibini açar veya kapatır. Kapalıyken tüm dosya izleyiciler ve zamanlayıcılar durdurulur. |
| `tokenSayar.warnPercent` | `55` | Sarı "Dolmaya başladı" uyarı eşiği (%). |
| `tokenSayar.dangerPercent` | `80` | Turuncu/kırmızı "Dolu" eşiği (%). |
| `tokenSayar.defaultContextLimit` | `512000` | Model veya veritabanı limiti belirlenemediğinde kullanılacak varsayılan bağlam limiti (token). |
| `tokenSayar.compactDisplay` | `false` | Durum çubuğunda daha kısa görünüm kullanır (`42,3K (%8)`). |
| `tokenSayar.statusBarClickAction` | `"openPanel"` | Durum çubuğuna tıklandığında Token Sayar görünümünü mü (`"openPanel"`) yoksa hızlı menüyü mü (`"openMenu"`) açacağını belirler. |
| `tokenSayar.notifications` | `true` | Bağlam doluluğu kırmızı eşiği (`dangerPercent`) geçtiğinde sohbet başına bir kez uyarı bildirimi gösterir. |
| `tokenSayar.modelLimits` | `{}` | İsteğe bağlı özel `model -> bağlam limiti` (token) eşleştirme nesnesi. |
