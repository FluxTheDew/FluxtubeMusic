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

    // --- öneriler açıkken sıra bitince önerilerden devam ------------------------------------

    /** Önceden çekilmiş ama henüz sıraya konmamış öneriler. */
    private val pending = ArrayDeque<Song>()
    private var pendingSeed: String? = null
    @Volatile private var suggestBusy = false

    private fun radioOn() = Prefs.get("radio") == "true" && player.repeatMode == Player.REPEAT_MODE_OFF

    /**
     * "Benzer şarkılar öner" açık, tekrar kapalı ve son şarkıdaysak öneri adaylarını
     * önceden çek (sıraya KOYMADAN). Sıraya sadece çalacak olan girer: şarkının son
     * saniyelerinde bir tane (kesintisiz geçiş için) ya da sıra bitince.
     */
    private fun continueWithSuggestions() {
        // Sıra değişti (ör. aramadan yeni şarkı): eski şarkıya göre bekleyen önerileri at.
        val seed = queueIds().lastOrNull { it.startsWith("yt:") }
        if (seed != pendingSeed) { pending.clear(); pendingSeed = null }
        if (!radioOn() || player.mediaItemCount == 0 || player.hasNextMediaItem()) return
        if (player.playbackState == Player.STATE_ENDED && pending.isNotEmpty()) { appendOne(true); return }
        if (pending.isNotEmpty()) return
        prefetch()
    }

    private fun queueIds() = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }

    private fun prefetch() {
        if (suggestBusy || !Net.online(this)) return
        val ids = queueIds()
        val seed = ids.lastOrNull { it.startsWith("yt:") } ?: return
        if (pendingSeed == seed) return
        pendingSeed = seed
        suggestBusy = true
        val have = ids.toSet()
        Thread {
            try {
                val arr = YtAccount.similar(seed.removePrefix("yt:")).optJSONArray("songs") ?: JSONArray()
                val songs = (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
                    .filter { it.optString("id").startsWith("yt:") && it.optString("id") !in have }
                    .take(10)
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
                    if (pendingSeed != seed) return@post
                    pending.clear()
                    pending.addAll(songs)
                    // Bu arada sıra bitmişse hemen devam et.
                    if (player.playbackState == Player.STATE_ENDED && radioOn() && !player.hasNextMediaItem()) appendOne(true)
                }
            } catch (e: Exception) {
                Logbook.add("ERR", "öneri alınamadı: ${e.message}")
                handler.post { pendingSeed = null }
            } finally {
                suggestBusy = false
            }
        }.start()
    }

    /** Bekleyen önerilerden sırada olmayan ilkini sıranın sonuna ekle. */
    private fun appendOne(startNow: Boolean) {
        val have = queueIds().toSet()
        while (pending.isNotEmpty() && pending.first().id in have) pending.removeFirst()
        val next = pending.removeFirstOrNull() ?: return
        val saved = Library.upsert(next)
        player.addMediaItem(Library.mediaItem(saved))
        if (startNow) {
            player.seekToNextMediaItem()
            player.prepare()
            player.play()
        }
    }

    /** Çalarken saniyede bir: son şarkının bitmesine az kaldıysa sıradaki öneriyi koy. */
    private val nearEnd = object : Runnable {
        override fun run() {
            handler.postDelayed(this, 1000)
            if (!player.isPlaying || !radioOn() || player.hasNextMediaItem()) return
            val dur = player.duration
            if (dur <= 0 || dur == C.TIME_UNSET) return
            if (pending.isEmpty()) { prefetch(); return }
            if (dur - player.currentPosition <= 8000) appendOne(false)
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
}
