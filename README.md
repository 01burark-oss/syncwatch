# SyncWatch

Uzaktaki iki (ya da daha fazla) kişinin aynı diziyi/filmi senkron izlemesi ve yazışması için hafif bir uygulama.

Video dosyaları **her iki tarafta da yerelde** durur. İnternetten yalnızca "oynat / durdur / şu saniyeye sar" mesajları ve sohbet geçer, bu yüzden zayıf bağlantıda da çalışır.

## Nasıl çalışır

- **Sunucu (Go):** Tek binary. Odaları tutar, oynatma durumunu (`oynuyor mu, konum, sunucu zamanı`) ve sohbet mesajlarını odadaki herkese iletir. Web istemcisi de binary'nin içine gömülüdür.
- **İstemci (web / PWA):** Tarayıcıda açılır, telefonda ana ekrana eklenebilir. Kullanıcı kendi bilgisayarındaki dosyayı seçer.
- **Senkron:** İstemciler sunucu saatiyle aradaki farkı ölçer. Her 0,5 saniyede beklenen konumla karşılaştırır:
  - 1 saniyeden büyük fark: direkt o saniyeye atlar.
  - 0,15 – 1 saniye arası fark: oynatma hızını %5–10 değiştirerek fark edilmeden yakalar.
- **Dosya kontrolü:** İki tarafın seçtiği dosyanın süresi ve boyutu karşılaştırılır, farklıysa uyarı çıkar.
- **Altyazı:** `.srt` veya `.vtt` dosyası yerelden yüklenir.
- **iPhone:** Safari kullanıcı dokunmadan video başlatmadığı için dosya seçildikten sonra bir kez "Hazırım" butonuna basılır.
- Biri odadan çıkarsa video herkeste durur.

## Çalıştırma

```sh
go run .            # http://localhost:8080
go build -o syncwatch . && ./syncwatch -addr :8080
```

Arkadaşınla kullanmak için sunucunun internetten erişilebilir olması gerekir (ucuz bir VPS, Fly.io, Railway vb.). Telefon ve PWA özellikleri için önüne HTTPS koy (ör. Caddy: `caddy reverse-proxy --from alanadin.com --to :8080`). WebSocket otomatik olarak `wss://` kullanır.

Odaya girdikten sonra **Davet linki** butonu `?oda=...` linkini kopyalar.

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

| İstemci → sunucu | Açıklama |
|---|---|
| `{type:"play"\|"pause"\|"seek", position}` | Oynatma eylemi |
| `{type:"chat", text}` | Sohbet mesajı |
| `{type:"file", file:{name,size,duration}}` | Seçilen dosya bilgisi |
| `{type:"ping", t}` | Saat farkı ölçümü |

| Sunucu → istemci | Açıklama |
|---|---|
| `{type:"state", playing, position, serverTime, by, text}` | Oda durumu (`text` = eylem) |
| `{type:"chat", from, text, time}` | Sohbet |
| `{type:"system", text}` | Katıldı / ayrıldı bildirimi |
| `{type:"presence", members:[{name,file}]}` | Odadakiler ve dosyaları |
| `{type:"pong", t, serverTime}` | Ping cevabı |

## Yol haritası

- [x] Oda + senkron oynatma + yazılı sohbet
- [x] Sade arayüz (siyah zemin, yeşil vurgu), sürükle-bırak, davet linki
- [ ] Sunucuyu yayına alma (HTTPS)
- [ ] Sesli sohbet (WebRTC, yalnızca ses; STUN/TURN gerekir)
- [ ] Gerekirse her formatı oynatan masaüstü istemci (Tauri + mpv)
