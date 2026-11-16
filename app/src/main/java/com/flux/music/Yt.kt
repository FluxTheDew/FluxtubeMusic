package com.flux.music

import org.json.JSONArray
import org.json.JSONObject
import org.schabi.newpipe.extractor.Image
import org.schabi.newpipe.extractor.InfoItem
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.Page
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.playlist.PlaylistInfo
import org.schabi.newpipe.extractor.playlist.PlaylistInfoItem
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * YouTube / YouTube Music: arama, liste içe aktarma, akış adresi bulma.
 * NewPipeExtractor üstünden; giriş gerektirmez, reklam yok.
 */
object Yt {
    private val yt get() = ServiceList.YouTube

    fun init() {
        NewPipe.init(NpDownloader(), Localization("tr", "TR"), ContentCountry("TR"))
    }

    // --- akış adresi --------------------------------------------------------------

    data class Pick(val url: String, val suffix: String, val bitrate: Int, val at: Long = System.currentTimeMillis())

    /** YouTube adresleri ~6 saat geçerli; 4 saat sonra yeniden çöz. */
    private const val TTL = 4L * 60 * 60 * 1000
    private val cache = ConcurrentHashMap<String, Pick>()

    fun forget(videoId: String) {
        cache.remove(videoId + ":h"); cache.remove(videoId + ":l")
    }

    /** En iyi (ya da en küçük) ses akışı. Ağ yoksa IOException. Engelleyici çağrı. */
    fun audio(videoId: String, high: Boolean = Prefs.high): Pick {
        val key = videoId + if (high) ":h" else ":l"
        cache[key]?.let { if (System.currentTimeMillis() - it.at < TTL) return it }
        val info = StreamInfo.getInfo(yt, watchUrl(videoId))
        val all = info.audioStreams.filter { it.isUrl && it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP }
        // Dublajlı / sesli betimleme izleri değil, orijinal ses.
        val original = all.filter { trackOk(it) }.ifEmpty { all }
        if (original.isEmpty()) throw IOException("ses akışı bulunamadı")
        val sorted = original.sortedBy { it.averageBitrate }
        val s = if (high) sorted.last() else sorted.first()
        val pick = Pick(s.content, s.format?.suffix ?: "m4a", s.averageBitrate)
        cache[key] = pick
        return pick
    }

    private fun trackOk(s: AudioStream): Boolean {
        val t = s.audioTrackType ?: return true
        return t == AudioTrackType.ORIGINAL
    }

    fun watchUrl(videoId: String) = "https://www.youtube.com/watch?v=$videoId"

    // --- arama ------------------------------------------------------------------

    /**
     * filter: songs | videos | albums | playlists. Şarkılar → {kind:"song"},
     * albüm ve listeler → {kind:"list", url}.
     */
    fun search(q: String, filter: String): JSONArray {
        val content = when (filter) {
            "videos" -> "music_videos"
            "albums" -> "music_albums"
            "playlists" -> "music_playlists"
            else -> "music_songs"
        }
        val ex = yt.getSearchExtractor(q, listOf(content), "")
        ex.fetchPage()
        val out = JSONArray()
        for (item in ex.initialPage.items) itemJson(item)?.let { out.put(it) }
        return out
    }

    private fun itemJson(item: InfoItem): JSONObject? = when (item) {
        is StreamInfoItem -> songFromItem(item)?.uiJson()?.put("kind", "song")
        is PlaylistInfoItem -> JSONObject()
            .put("kind", "list")
            .put("url", item.url)
            .put("title", item.name)
            .put("artist", cleanArtist(item.uploaderName ?: ""))
            .put("count", item.streamCount)
            .put("thumb", bestThumb(item.thumbnails))
        else -> null
    }

    fun songFromItem(item: StreamInfoItem): Song? {
        val id = videoId(item.url) ?: return null
        return Song(
            id = "yt:$id",
            title = item.name ?: "?",
            artist = cleanArtist(item.uploaderName ?: ""),
            durationSec = item.duration.coerceAtLeast(0),
            thumb = bestThumb(item.thumbnails).ifEmpty { "https://i.ytimg.com/vi/$id/hqdefault.jpg" },
        )
    }

    // --- link içe aktarma ---------------------------------------------------------

    /**
     * YouTube / YT Music linki: liste (list=…) ise tüm şarkılar, video ise tek şarkı.
     * Dönüş: {name, songs:[…]}
     */
    fun importLink(url: String, limit: Int = 1000): JSONObject {
        val u = url.trim()
        val listId = Regex("[?&]list=([\\w-]+)").find(u)?.groupValues?.get(1)
        if (listId != null) return playlist("https://www.youtube.com/playlist?list=$listId", limit)
        val id = videoId(u) ?: throw IOException("YouTube linki tanınmadı")
        val info = StreamInfo.getInfo(yt, watchUrl(id))
        val s = Song(
            id = "yt:$id",
            title = info.name ?: "?",
            artist = cleanArtist(info.uploaderName ?: ""),
            durationSec = info.duration,
            thumb = bestThumb(info.thumbnails).ifEmpty { "https://i.ytimg.com/vi/$id/hqdefault.jpg" },
        )
        return JSONObject().put("name", s.title).put("songs", JSONArray().put(s.uiJson()))
    }

    fun playlist(url: String, limit: Int = 1000): JSONObject {
        val info = PlaylistInfo.getInfo(yt, url)
        val songs = ArrayList<Song>()
        info.relatedItems.mapNotNullTo(songs) { songFromItem(it) }
        var page: Page? = info.nextPage
        while (Page.isValid(page) && songs.size < limit) {
            val more = PlaylistInfo.getMoreItems(yt, url, page)
            more.items.mapNotNullTo(songs) { songFromItem(it) }
            page = more.nextPage
        }
        val arr = JSONArray()
        songs.distinctBy { it.id }.take(limit).forEach { arr.put(it.uiJson()) }
        return JSONObject().put("name", info.name ?: "liste").put("songs", arr)
    }

    // --- yardımcılar ----------------------------------------------------------------

    fun videoId(url: String): String? {
        runCatching { return yt.streamLHFactory.getId(url) }
        return Regex("(?:v=|youtu\\.be/|shorts/|embed/)([\\w-]{11})").find(url)?.groupValues?.get(1)
            ?: url.takeIf { Regex("^[\\w-]{11}$").matches(it) }
    }

    private fun cleanArtist(a: String) = a.removeSuffix(" - Topic").trim()

    private fun bestThumb(list: List<Image>?): String {
        if (list.isNullOrEmpty()) return ""
        val best = list.maxByOrNull { maxOf(it.height, it.width) } ?: list.last()
        return upscale(best.url)
    }

    /** YT Music kapakları (googleusercontent) boyut parametresiyle geliyor: büyüt. */
    private fun upscale(u: String): String =
        if (u.contains("googleusercontent.com") || u.contains("ggpht.com"))
            u.replace(Regex("=w\\d+-h\\d+[^&]*$"), "=w544-h544-l90-rj")
        else u
}
