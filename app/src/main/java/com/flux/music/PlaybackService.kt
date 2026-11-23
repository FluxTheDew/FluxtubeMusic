package com.flux.music

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * Çalma servisi: ExoPlayer + MediaSession (bildirim, kilit ekranı, kulaklık tuşları).
 *
 * Sıra = oynatıcının listesi. Her değişiklikte queue.json'a yazılır; servis
 * yeniden açıldığında aynı sıra, aynı şarkı ve aynı saniyeden devam eder.
 *
 * YouTube şarkılarının adresi "ytm:<videoId>". Gerçek adres çalınacağı an
 * çözülür: indirilmişse dosya, değilse YouTube akışı. Böylece sıradayken
 * indirilen şarkı otomatik olarak dosyadan çalar.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {

    private lateinit var player: ExoPlayer
    private lateinit var session: MediaSession
    private lateinit var queueFile: File
    private val handler = Handler(Looper.getMainLooper())
    private var errorsInRow = 0
    private var retried = HashSet<String>()

    override fun onCreate() {
        super.onCreate()
        instance = this
        queueFile = File(filesDir, "queue.json")

        val http = OkHttpDataSource.Factory(Net.client)
            .setUserAgent(Net.UA)
            .setDefaultRequestProperties(Net.streamHeaders)
        val upstream = DefaultDataSource.Factory(this, http)
        val resolving = ResolvingDataSource.Factory(upstream) { spec -> resolve(spec) }

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(resolving))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player.addListener(listener)

        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player)
            .setCallback(callback)
            .setSessionActivity(open)
            .build()

        restore()
        handler.postDelayed(autosave, 10_000)
        handler.postDelayed(nearEnd, 1000)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        save()
        if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacks(autosave)
        handler.removeCallbacks(nearEnd)
        if (instance === this) instance = null
        save()
        session.release()
        player.release()
        super.onDestroy()
    }

    // --- adres çözme ------------------------------------------------------------

    /** Yükleme iş parçacığında çalışır; ağ çağrısı yapabilir. */
    private fun resolve(spec: DataSpec): DataSpec {
        val u = spec.uri
        if (u.scheme != "ytm") return spec
        val vid = u.schemeSpecificPart
        val song = Library.get("yt:$vid")
        song?.file?.let { f -> File(f).takeIf { it.exists() }?.let { return spec.withUri(Uri.fromFile(it)) } }
        if (!Net.online(this)) throw IOException("çevrimdışı ve indirilmemiş")
        val pick = Yt.audio(vid)
        return spec.withUri(Uri.parse(pick.url))
    }

    // --- olaylar ----------------------------------------------------------------

    private val listener = object : Player.Listener {
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            mediaItem?.mediaId?.let { Library.markPlayed(it) }
            save()
            continueWithSuggestions()
        }

        override fun onTimelineChanged(timeline: Timeline, reason: Int) {
            if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) {
                save()
                continueWithSuggestions()
            }
        }

        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) continueWithSuggestions()
        }

        override fun onRepeatModeChanged(repeatMode: Int) {
            continueWithSuggestions()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) { errorsInRow = 0; retried.clear() } else save()
        }

        override fun onPlayerError(error: PlaybackException) {
            val item = player.currentMediaItem
            val id = item?.mediaId ?: ""
            val song = Library.get(id)
            Logbook.add("ERR", "${song?.title ?: id}: ${error.cause?.message ?: error.errorCodeName}")
            // Kullanıcı çalmak istemiyorsa (ör. açılışta geri yükleme) kendi kendine ilerleme.
            if (!player.playWhenReady) return

            // Süresi dolmuş YouTube adresi olabilir: bir kez taze adresle dene.
            if (song?.isYt == true && !song.offline && Net.online(this@PlaybackService) && retried.add(id)) {
                Yt.forget(song.videoId)
                player.prepare()
                return
            }
            // Çalınamayanı atla, sıradakine geç (çevrimdışıyken indirilmemişler).
            errorsInRow++
            if (errorsInRow < player.mediaItemCount && player.hasNextMediaItem() && Prefs.skipOffline) {
                player.seekToNextMediaItem()
                player.prepare()
                player.play()
            } else {
                errorsInRow = 0
            }
        }
    }

    // --- öneriler: tek liste (ekrandaki ÖNERİLEN ile sıraya girenler aynı) -------------------

    /** Henüz sıraya girmemiş öneriler. Kendiliğinden yenilenmez. */
    private val pending = ArrayList<Song>()
    /** Önerilerin dayandığı şarkı: sıranın ilk YouTube şarkısı (yeni şarkı başlatınca değişir). */
    private var anchor: String? = null
    @Volatile private var suggestBusy = false

    private fun suggestOn() = Prefs.get("radio") == "true"
    private fun radioOn() = suggestOn() && player.repeatMode == Player.REPEAT_MODE_OFF
    private fun queueIds() = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }

    /** Arayüz için: bekleyen öneriler. */
    private fun publish() {
        val arr = JSONArray()
        pending.forEach { arr.put(it.uiJson().put("kind", "song")) }
        suggestJson = arr.toString()
        suggestRev++
    }

    /**
     * Sıra değişince: yeni şarkı başlatıldıysa (sıranın ilk şarkısı değiştiyse) öneriler
     * o şarkıya göre baştan; değilse aynı liste kalır, sadece sıraya girmiş olanlar düşer.
     * Öneriler açık, tekrar kapalı ve son şarkıdaysak sıra bitince sıradaki öneri girer.
     */
    private fun continueWithSuggestions() {
        if (!suggestOn()) return
        val ids = queueIds()
        val first = ids.firstOrNull { it.startsWith("yt:") }
        if (first != anchor) {
            anchor = first
            pending.clear()
            publish()
            if (first != null) fetch(first, replace = true)
            return
        }
        val have = ids.toSet()
        if (pending.removeAll { it.id in have }) publish()
        if (!radioOn() || ids.isEmpty() || player.hasNextMediaItem()) return
        if (player.playbackState == Player.STATE_ENDED) {
            if (pending.isNotEmpty()) appendOne(true) else anchor?.let { fetch(it, replace = false) }
        }
    }

    @Volatile private var wantSkip = false

    fun canSkipToSuggestion() = radioOn() && !player.hasNextMediaItem() && player.mediaItemCount > 0

    /** Son şarkıdayken ⏭: önerilerden sıradakini sıraya koy ve çal. */
    fun skipToSuggestion() {
        if (pending.isNotEmpty()) { appendOne(true); return }
        wantSkip = true
        val a = anchor
        if (a != null) fetch(a, replace = false) else refreshSuggestions()
    }

    /** Aynı şarkının farklı yüklemeleri (aynı ad + sanatçı) bir kez görünsün. */
    private fun songKey(title: String, artist: String): String {
        fun n(x: String) = x.lowercase()
            .replace(Regex("\\(.*?\\)|\\[.*?\\]"), " ")
            .replace(Regex("(?i)\\b(official|video|audio|lyrics?|music|hd|4k|klip|sözleri)\\b"), " ")
            .replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()
        return n(title) + "|" + n(artist.split(",", "&", " ve ", " feat", " ft.").first())
    }

    /** ↻: önerileri şimdi çalan şarkıya göre yenile. */
    fun refreshSuggestions() {
        val cur = player.currentMediaItem?.mediaId?.takeIf { it.startsWith("yt:") }
            ?: queueIds().firstOrNull { it.startsWith("yt:") } ?: return
        anchor = queueIds().firstOrNull { it.startsWith("yt:") }
        pending.clear()
        publish()
        fetch(cur, replace = true)
    }

    /** seed'e benzer şarkıları çek. replace=false: liste bittiyse sonuna yenilerini ekle. */
    private fun fetch(seed: String, replace: Boolean) {
        if (suggestBusy || !Net.online(this)) return
        suggestBusy = true
        val exclude = queueIds().toSet() + pending.map { it.id }
        val forAnchor = anchor
        Thread {
            try {
                val arr = YtAccount.similar(seed.removePrefix("yt:")).optJSONArray("songs") ?: JSONArray()
                val songs = (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
                    .filter { it.optString("id").startsWith("yt:") && it.optString("id") !in exclude && it.optString("id") != seed }
                    .take(25)
                    .map {
                        Song(
                            id = it.getString("id"),
                            title = it.optString("title", "?"),
                            artist = it.optString("artist", ""),
                            durationSec = it.optLong("dur", 0),
                            thumb = it.optString("thumb", ""),
                        )
                    }
                handler.post {
                    if (anchor != forAnchor) return@post // bu arada yeni şarkı başlatıldı
                    if (replace) pending.clear()
                    val ids = queueIds()
                    val have = ids.toSet()
                    // Sırada ve listede olanlarla aynı ad + sanatçı → kopya say.
                    val keys = HashSet<String>()
                    ids.forEach { id -> Library.get(id)?.let { keys.add(songKey(it.title, it.artist)) } }
                    pending.forEach { keys.add(songKey(it.title, it.artist)) }
                    for (sg in songs) {
                        if (sg.id in have || pending.any { p -> p.id == sg.id }) continue
                        if (!keys.add(songKey(sg.title, sg.artist))) continue
                        pending.add(sg)
                    }
                    publish()
                    if (wantSkip) { wantSkip = false; if (pending.isNotEmpty()) appendOne(true) }
                    else if (player.playbackState == Player.STATE_ENDED && radioOn() && !player.hasNextMediaItem()) appendOne(true)
                }
            } catch (e: Exception) {
                Logbook.add("ERR", "öneri alınamadı: ${e.message}")
            } finally {
                suggestBusy = false
            }
        }.start()
    }

    /** Listedeki ilk öneriyi sıranın sonuna koy. */
    private fun appendOne(startNow: Boolean) {
        val have = queueIds().toSet()
        pending.removeAll { it.id in have }
        val next = pending.removeFirstOrNull() ?: run { publish(); return }
        publish()
        val saved = Library.upsert(next)
        player.addMediaItem(Library.mediaItem(saved))
        if (startNow) {
            player.seekToNextMediaItem()
            player.prepare()
            player.play()
        }
    }

    /** Çalarken saniyede bir: son şarkının bitmesine 8 sn kala sıradaki öneriyi koy. */
    private val nearEnd = object : Runnable {
        override fun run() {
            handler.postDelayed(this, 1000)
            if (!player.isPlaying || !radioOn() || player.hasNextMediaItem()) return
            val dur = player.duration
            if (dur <= 0 || dur == C.TIME_UNSET) return
            if (dur - player.currentPosition > 8000) return
            if (pending.isNotEmpty()) appendOne(false)
            else anchor?.let { fetch(it, replace = false) } // liste bitti: aynı şarkıya göre devamı
        }
    }

    private val autosave = object : Runnable {
        override fun run() {
            if (player.isPlaying) save()
            handler.postDelayed(this, 10_000)
        }
    }

    // --- denetleyiciden gelen şarkılar -------------------------------------------

    /**
     * Denetleyiciden (arayüz, bildirim) gelen öğelerin adresi güvenlik gereği
     * düşürülüyor; kimlikten kitaplıktaki tam hali yeniden kuruluyor.
     */
    private val callback = object : MediaSession.Callback {
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            val out = mediaItems.mapNotNull { Library.mediaItem(it.mediaId) }.toMutableList()
            return Futures.immediateFuture(out)
        }
    }

    // --- sırayı sakla / geri yükle --------------------------------------------------

    private fun save() {
        val ids = JSONArray()
        for (i in 0 until player.mediaItemCount) ids.put(player.getMediaItemAt(i).mediaId)
        val o = JSONObject()
            .put("ids", ids)
            .put("index", player.currentMediaItemIndex)
            .put("pos", player.currentPosition.coerceAtLeast(0))
            .put("repeat", player.repeatMode)
        runCatching {
            val tmp = File(filesDir, "queue.json.tmp")
            tmp.writeText(o.toString())
            tmp.renameTo(queueFile)
        }
    }

    private fun restore() {
        if (!queueFile.exists()) return
        try {
            val o = JSONObject(queueFile.readText())
            val ids = o.optJSONArray("ids") ?: return
            var index = o.optInt("index", 0)
            val items = ArrayList<MediaItem>()
            for (i in 0 until ids.length()) {
                val item = Library.mediaItem(ids.getString(i))
                if (item == null) { if (i < index) index--; continue }
                items.add(item)
            }
            if (items.isEmpty()) return
            index = index.coerceIn(0, items.size - 1)
            player.setMediaItems(items, index, o.optLong("pos", 0))
            player.repeatMode = o.optInt("repeat", Player.REPEAT_MODE_OFF)
            player.prepare()
            Logbook.add("SYS", "sıra geri yüklendi: ${items.size} şarkı")
        } catch (e: Exception) {
            Logbook.add("ERR", "sıra okunamadı: ${e.message}")
        }
    }

    companion object {
        /** Arayüzün okuduğu öneri listesi (JSON) ve sürümü. */
        @Volatile var suggestJson = "[]"
        @Volatile var suggestRev = 0L
        @Volatile var instance: PlaybackService? = null
    }
}
