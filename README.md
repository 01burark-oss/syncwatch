# SyncWatch

Uzaktaki iki (ya da daha fazla) kişinin aynı diziyi/filmi senkron izlemesi ve yazışması için hafif bir uygulama.

Video dosyaları **her iki tarafta da yerelde** durur. İnternetten yalnızca "oynat / durdur / şu saniyeye sar" mesajları ve sohbet geçer, bu yüzden zayıf bağlantıda da çalışır.

## Nasıl çalışır

Her şey Cloudflare'de çalışır, ayrı bir sunucu yoktur.

- **Workers:** Arayüz dosyalarını (`web/`) sunar ve isteklere yön verir (`worker/index.ts`).
- **Durable Objects:** Her oda bir Durable Object'tir. Oynatma durumunu (`oynuyor mu, konum, sunucu zamanı`), sohbeti ve odadakileri tutar. Durum kalıcıdır; ertesi gün aynı odaya girince kaldığınız yer hatırlanır.
- **R2:** "Odaya yükle" ile paylaşılan video dosyaları burada durur. Yükleme 10 MB'lık parçalarla yapılır, yarıda kalırsa kalan parçalardan devam eder. İndirme de kesilirse kaldığı yerden sürer. Odaya yeni dosya yüklenince eskisi silinir.
- **Cihazdan cihaza:** Dosya odaya yüklenmemişse, karşı tarafın açtığı dosya doğrudan onun tarayıcısından (WebRTC) indirilebilir. Sunucu yalnızca bağlantı mesajlarını taşır.
- **Sesli sohbet:** Üstteki mikrofon butonu. WebRTC ile yalnızca ses; Opus mono, en fazla 24 kbps, sessizken veri göndermez (DTX), paket kaybına dayanıklı (FEC). Yankı ve gürültü engelleme açık. Biri konuşurken video sesi otomatik kısılır, konuşanın avatarı yanar.
- **Senkron:** İstemciler sunucu saatiyle aradaki farkı ölçer. Her 0,5 saniyede beklenen konumla karşılaştırır:
  - 1 saniyeden büyük fark: direkt o saniyeye atlar.
  - 0,15 – 1 saniye arası fark: oynatma hızını %5–10 değiştirerek fark edilmeden yakalar.
- **Dosya kontrolü:** İki tarafın dosyasının süresi farklıysa uyarı çıkar.
- **Altyazı:** `.srt` veya `.vtt` dosyası yerelden yüklenir.
- **iPhone:** Safari kullanıcı dokunmadan video başlatmadığı için dosya seçildikten sonra bir kez "Hazırım" butonuna basılır.
- Biri odadan çıkarsa video herkeste durur.

## Yerelde çalıştırma

```sh
npm install
npm run dev        # http://localhost:8787 (Durable Objects ve R2 yerelde taklit edilir)
```

## Cloudflare'de yayına alma (ücretsiz)

1. **R2'yi aç:** Cloudflare panelinde **R2 Object Storage** → **Enable**. Ücretsiz kotaya (10 GB) rağmen kart bilgisi ister; kotayı aşmadıkça ücret çıkmaz.
2. **Kova oluştur:** **Create bucket** → ad: `syncwatch-files`.
3. **Eski dosyalar kendiliğinden silinsin (önerilir):** Kovanın **Settings** → **Object lifecycle rules** → **Add rule** → "7 gün sonra sil".
4. **Repoyu bağla:** **Workers & Pages** → **Create** → **Import a repository** → `syncwatch` reposunu seç. Deploy komutu `npx wrangler deploy` olarak kalabilir. **Deploy**'a bas.
5. Birkaç dakika sonra `https://syncwatch.<hesabın>.workers.dev` adresi çalışır. Sonraki her push otomatik yayına alınır.

### Sesli sohbet ve aktarım için TURN (önerilir)

Telefon interneti gibi bazı ağlar cihazların doğrudan bağlanmasına izin vermez. Bu durumda ses ve cihazdan cihaza aktarım Cloudflare'in TURN sunucusu üzerinden geçer (aylık 1000 GB ücretsiz).

1. Cloudflare panelinde **Realtime** → **TURN Server** → **Create** → bir ad ver. Çıkan **Turn Token ID** ve **API Token**'ı kopyala.
2. **Workers & Pages** → `syncwatch` → **Settings** → **Variables and Secrets** → **Add**:
   - `TURN_KEY_ID` = Turn Token ID (tür: **Secret**)
   - `TURN_KEY_API_TOKEN` = API Token (tür: **Secret**)
3. Kaydet. Ayarlı olup olmadığını `https://<adres>/api/ice` sayfasında `"turn":true` yazısından görebilirsin.

Not: R2 açmak istemezsen `wrangler.jsonc` içindeki `r2_buckets` bölümünü sil; "Odaya yükle" gizlenir, cihazdan cihaza aktarım çalışmaya devam eder.

## Dosya formatı

Tarayıcılar MKV / HEVC / gömülü altyazıların çoğunu oynatmaz. En sorunsuz format MP4 (H.264 + AAC). Bir kez dönüştürmek yeterli:

```sh
ffmpeg -i bolum.mkv -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 160k -movflags +faststart bolum.mp4
# gömülü altyazıyı ayrı dosyaya çıkarmak için:
ffmpeg -i bolum.mkv -map 0:s:0 bolum.srt
```

Video zaten H.264 ise yalnızca kapsayıcıyı değiştirmek çok daha hızlıdır: `ffmpeg -i bolum.mkv -c:v copy -c:a aac bolum.mp4`

## Mesaj protokolü (WebSocket, JSON)

Bağlantı: `/ws?room=<oda>&name=<ad>`

ICE/TURN: `GET /api/ice`. Dosya uçları: `POST /api/upload/start`, `PUT /api/upload/part`, `POST /api/upload/complete`, `POST /api/upload/abort`, `GET /api/files/<key>` (Range destekli).

| İstemci → sunucu | Açıklama |
|---|---|
| `{type:"play"\|"pause"\|"seek", position}` | Oynatma eylemi |
| `{type:"chat", text}` | Sohbet mesajı |
| `{type:"file", file:{name,size,duration}}` | Seçilen dosya bilgisi |
| `{type:"ping", t}` | Saat farkı ölçümü |
| `{type:"signal", to, data}` | WebRTC mesajı (dosya aktarımı; `v-` ile başlayanlar ses) |
| `{type:"voice", on}` | Sesli sohbete katıl / ayrıl |

| Sunucu → istemci | Açıklama |
|---|---|
| `{type:"state", playing, position, serverTime, by, text}` | Oda durumu (`text` = eylem) |
| `{type:"chat", from, text, time}` | Sohbet |
| `{type:"system", text}` | Katıldı / ayrıldı bildirimi |
| `{type:"presence", members:[{name,file}]}` | Odadakiler ve dosyaları |
| `{type:"pong", t, serverTime}` | Ping cevabı |
| `{type:"welcome", id, storage, shared}` | Bağlanınca: kimliğin, depolama açık mı, odadaki dosya |
| `{type:"shared", shared:{key,name,size,by}}` | Odaya yeni dosya yüklendi |
| `{type:"signal", fromId, from, data}` | WebRTC mesajı |

## Yol haritası

- [x] Oda + senkron oynatma + yazılı sohbet
- [x] Sade arayüz (siyah zemin, yeşil vurgu), sürükle-bırak, davet linki
- [x] Cloudflare Workers + Durable Objects + R2
- [x] Dosyayı odaya yükleme / karşıdan indirme (kaldığı yerden devam)
- [x] Sesli sohbet (WebRTC, yalnızca ses, TURN destekli)
- [ ] Gerekirse her formatı oynatan masaüstü istemci (Tauri + mpv)
