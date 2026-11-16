# FluxTube Music

YouTube Music için **çevrimdışı öncelikli** Android çalar. ULL-DPI / ULL-Bot ile aynı terminal teması (Matrix yağmuru olmadan).

## Neden?

Resmi uygulamada sıraya ekleme mobilde dağınık; internet yokken indirdiğin şarkılarla sıra bile kuramıyorsun. Burada:

- **Sıra tamamen telefonda.** İnternetsiz sıraya ekle, çıkar, ≡ tutup sürükleyerek sırala.
- **Şarkıya dokunmak sırayı silmez.** Çalan şarkının arkasına eklenir (AYAR'dan "sıradaki" ya da "sona ekle" yapılabilir).
- **"Sıradaki" art arda** eklenenler eklediğin sırayla çalar.
- **Kaldığın yerden devam:** uygulama kapanıp açılınca aynı sıra, aynı şarkı, aynı saniye.
- **İndirme:** şarkı, liste ya da albümün hepsini indir. Kapaklar da kaydedilir. İstersen sıraya/listeye eklenenler kendiliğinden iner (Wi-Fi'de ya da her zaman).
- **İnternet yokken** indirilmemiş şarkılar üstü çizili görünür, sırada gelince sessizce atlanır.
- **Kitaplıkta arama** internetsiz çalışır. YouTube Music araması: şarkı, video, albüm, liste.
- **Link ile içe aktar:** YouTube / YT Music liste veya şarkı linkini yapıştır, liste olarak kaydet.
- **Yerel müzik:** telefondaki mp3/flac/m4a dosyaları da aynı kitaplıkta.
- **Bildirim ve kilit ekranı kontrolleri**, kulaklık tuşları, kulaklık çıkınca durma.
- **AYAR → GÜNCELLEME:** yeni sürümü GitHub Releases'tan çekip mevcut uygulamanın üstüne kurar. Verilerin silinmez.

## Kurulum

1. [Releases](../../releases/latest) sayfasından `FluxTube-Music.apk` dosyasını indir.
2. Telefonda aç, "bilinmeyen kaynaklardan yükleme" izni isterse ver.
3. Sonraki sürümler için uygulamada **AYAR → GÜNCELLEMELERİ KONTROL ET**.

## Nasıl çalışıyor?

| Parça | Ne yapıyor |
| --- | --- |
| `assets/web/` | Arayüz (HTML/CSS/JS, ULL-DPI teması). `window.FM` köprüsüyle Kotlin'e bağlı. |
| `MainActivity.kt` | WebView + köprü. Kapakları `https://fm.art/<id>` üstünden telefondaki kopyadan verir. |
| `PlaybackService.kt` | ExoPlayer + MediaSession. Sıra `queue.json`'da. `ytm:<id>` adresleri çalınacağı an çözülür: indirilmişse dosya, değilse akış. |
| `Library.kt` | Şarkılar ve listeler, `library.json`. |
| `Downloads.kt` | Parça parça (Range) indirme, kaldığı yerden devam. Ön plan servisiyle arka planda sürer. |
| `Yt.kt` | [NewPipeExtractor](https://github.com/TeamNewPipe/NewPipeExtractor): arama, liste, akış adresi. Giriş gerekmez. |
| `Updater.kt` | GitHub Releases'tan güncelleme. |

Her push'ta GitHub Actions APK derler. Ana dala yapılan push yeni bir sürüm yayınlar.
İmza anahtarı `keystore/fluxtube.p12` (her sürüm aynı imzayla, güncelleme üstüne kurulsun diye).
İstersen kendi anahtarını base64 olarak `FLUX_KEYSTORE_B64` deposu sırrına koy. Ama anahtar değişirse
eski kurulumu bir kez kaldırıp yeniden kurman gerekir.

> Not: YouTube'un resmi olmayan arayüzünü kullanır; YouTube bir şeyi değiştirdiğinde arama/akış geçici olarak bozulabilir.
> Bu durumda `app/build.gradle.kts` içindeki NewPipeExtractor sürümünü yükseltmek genelde yeter. İndirilmiş şarkılar etkilenmez.
