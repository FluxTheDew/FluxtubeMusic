package com.flux.music

import android.content.Context
import android.content.SharedPreferences
import android.webkit.CookieManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest

/**
 * YouTube Music hesabı: Google'ın kendi giriş sayfasından (LoginActivity)
 * alınan oturum çerezleriyle music.youtube.com'un kendi API'sine (InnerTube,
 * WEB_REMIX) istek atar. Şifre uygulamaya hiç gelmez; çerezler sadece bu
 * telefonda, uygulamanın özel alanında durur.
 *
 * Şimdilik okuma: kitaplıktaki listeler + beğenilen şarkılar → yerel listeler.
 */
object YtAccount {
    private const val ORIGIN = "https://music.youtube.com"
    private const val FALLBACK_VERSION = "1.20251110.01.00"

    private lateinit var sp: SharedPreferences

    @Volatile var rev = 0L
        private set

    fun init(ctx: Context) {
        sp = ctx.getSharedPreferences("account", Context.MODE_PRIVATE)
    }

    private val cookie get() = sp.getString("cookie", "") ?: ""
    val loggedIn get() = sapisid() != null

    fun save(cookie: String) {
        sp.edit().putString("cookie", cookie).apply()
        rev++
        Logbook.add("SYS", "YouTube hesabına giriş yapıldı")
    }

    fun logout() {
        sp.edit().clear().apply()
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        rev++
        Logbook.add("SYS", "YouTube hesabından çıkış yapıldı")
    }

    fun json(): JSONObject = JSONObject()
        .put("loggedIn", loggedIn)
        .put("name", sp.getString("name", "") ?: "")
        .put("handle", sp.getString("handle", "") ?: "")
        .put("photo", sp.getString("photo", "") ?: "")
        .put("syncedAt", sp.getLong("syncedAt", 0))

    // --- istek -------------------------------------------------------------------------

    private fun sapisid(): String? = cookie.split(';').map { it.trim() }.let { parts ->
        (parts.firstOrNull { it.startsWith("SAPISID=") } ?: parts.firstOrNull { it.startsWith("__Secure-3PAPISID=") })
            ?.substringAfter('=')?.takeIf { it.isNotEmpty() }
    }

    private fun sha1(s: String): String =
        MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    private fun auth(): String {
        val id = sapisid() ?: throw IOException("giriş yapılmamış")
        val ts = System.currentTimeMillis() / 1000
        return "SAPISIDHASH ${ts}_${sha1("$ts $id $ORIGIN")}"
    }

    @Volatile private var clientVersion: String? = null

    /** Sitenin şu anki istemci sürümü (eskisi reddedilebiliyor). */
    private fun version(): String {
        clientVersion?.let { return it }
        val v = runCatching {
            Net.client.newCall(
                okhttp3.Request.Builder().url("$ORIGIN/").header("User-Agent", Net.UA)
                    .apply { if (loggedIn) header("Cookie", cookie) }.build()
            ).execute().use { r ->
                Regex("\"INNERTUBE_CLIENT_VERSION\":\"([^\"]+)\"").find(r.body?.string() ?: "")?.groupValues?.get(1)
            }
        }.getOrNull() ?: FALLBACK_VERSION
        clientVersion = v
        return v
    }

    private fun post(endpoint: String, body: JSONObject, query: String = ""): JSONObject {
        val ver = version()
        body.put(
            "context", JSONObject()
                .put("client", JSONObject().put("clientName", "WEB_REMIX").put("clientVersion", ver).put("hl", "tr").put("gl", "TR"))
                .put("user", JSONObject())
        )
        val b = okhttp3.Request.Builder()
            .url("$ORIGIN/youtubei/v1/$endpoint?prettyPrint=false$query")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .header("User-Agent", Net.UA)
            .header("Origin", ORIGIN)
            .header("X-Origin", ORIGIN)
            .header("Referer", "$ORIGIN/")
            .header("X-YouTube-Client-Name", "67")
            .header("X-YouTube-Client-Version", ver)
        // Girişsiz de çalışsın (genel ana sayfa, herkese açık listeler).
        if (loggedIn) b.header("Cookie", cookie).header("Authorization", auth()).header("X-Goog-AuthUser", "0")
        val req = b.build()
        Net.client.newCall(req).execute().use { r ->
            if (r.code == 401 || r.code == 403) throw IOException("oturum geçersiz — yeniden giriş yap (HTTP ${r.code})")
            if (!r.isSuccessful) throw IOException("YouTube HTTP ${r.code}")
            return JSONObject(r.body?.string() ?: "{}")
        }
    }

    // --- JSON gezinme ------------------------------------------------------------------------

    private fun findAll(node: Any?, key: String, out: MutableList<JSONObject>) {
        when (node) {
            is JSONObject -> for (k in node.keys()) {
                val v = node.opt(k)
                if (k == key && v is JSONObject) out.add(v) else findAll(v, key, out)
            }
            is JSONArray -> for (i in 0 until node.length()) findAll(node.opt(i), key, out)
        }
    }

    private fun all(node: Any?, key: String) = ArrayList<JSONObject>().also { findAll(node, key, it) }

    private fun first(node: Any?, key: String): JSONObject? {
        when (node) {
            is JSONObject -> for (k in node.keys()) {
                val v = node.opt(k)
                if (k == key && v is JSONObject) return v
                first(v, key)?.let { return it }
            }
            is JSONArray -> for (i in 0 until node.length()) first(node.opt(i), key)?.let { return it }
        }
        return null
    }

    private fun text(o: JSONObject?): String {
        if (o == null) return ""
        o.optJSONArray("runs")?.let { runs ->
            return (0 until runs.length()).joinToString("") { runs.optJSONObject(it)?.optString("text") ?: "" }
        }
        return o.optString("simpleText", "")
    }

    private fun lastThumb(o: JSONObject?): String {
        val arr = findThumbs(o) ?: return ""
        return Yt.upscale(arr.optJSONObject(arr.length() - 1)?.optString("url") ?: "")
    }

    private fun findThumbs(node: Any?): JSONArray? {
        when (node) {
            is JSONObject -> for (k in node.keys()) {
                val v = node.opt(k)
                if (k == "thumbnails" && v is JSONArray && v.length() > 0) return v
                findThumbs(v)?.let { return it }
            }
            is JSONArray -> for (i in 0 until node.length()) findThumbs(node.opt(i))?.let { return it }
        }
        return null
    }

    // --- hesap bilgisi -------------------------------------------------------------------------

    fun fetchInfo() {
        val r = post("account/account_menu", JSONObject())
        val h = first(r, "activeAccountHeaderRenderer") ?: return
        sp.edit()
            .putString("name", text(h.optJSONObject("accountName")))
            .putString("handle", text(h.optJSONObject("channelHandle")))
            .putString("photo", lastThumb(h.optJSONObject("accountPhoto")))
            .apply()
        rev++
    }

    // --- listeler ------------------------------------------------------------------------------

    data class YtList(val id: String, val name: String, val thumb: String = "")

    /** Kitaplıktaki listeler (kendi oluşturdukların + kaydettiklerin) ve beğenilenler. */
    fun playlists(): List<YtList> {
        val out = LinkedHashMap<String, YtList>()
        var r = post("browse", JSONObject().put("browseId", "FEmusic_liked_playlists"))
        var pages = 0
        while (true) {
            for (it in all(r, "musicTwoRowItemRenderer")) {
                val bid = first(it.optJSONObject("navigationEndpoint"), "browseEndpoint")?.optString("browseId") ?: continue
                if (!bid.startsWith("VL")) continue
                val id = bid.removePrefix("VL")
                out[id] = YtList(id, text(it.optJSONObject("title")).ifBlank { "liste" }, lastThumb(it.optJSONObject("thumbnailRenderer")))
            }
            val token = first(r, "continuationCommand")?.optString("token")?.ifEmpty { null }
                ?: first(r, "nextContinuationData")?.optString("continuation")?.ifEmpty { null }
            if (token == null || ++pages > 20) break
            r = post("browse", JSONObject().put("continuation", token), "&ctoken=$token&continuation=$token&type=next")
        }
        if ("LM" !in out) out["LM"] = YtList("LM", "Beğenilen müzikler")
        return out.values.toList()
    }

    /** Bir listedeki tüm şarkılar (sayfa sayfa). */
    fun playlistSongs(id: String, limit: Int = 5000): List<Song> = playlistPage(id, limit).second

    /** (liste adı, şarkılar). */
    fun playlistPage(id: String, limit: Int = 5000): Pair<String?, List<Song>> {
        val out = LinkedHashMap<String, Song>()
        val r0 = post("browse", JSONObject().put("browseId", "VL$id"))
        val head = first(r0, "musicResponsiveHeaderRenderer") ?: first(r0, "musicDetailHeaderRenderer")
            ?: first(r0, "musicEditablePlaylistDetailHeaderRenderer")
        val name = text(head?.optJSONObject("title")).ifBlank { null }
            ?: text(first(head, "title")).ifBlank { null }
        // Öneriler rafı karışmasın: önce listenin kendi rafı.
        val shelf: Any = first(r0, "musicPlaylistShelfRenderer") ?: first(r0, "musicShelfRenderer") ?: r0
        var r: Any = shelf
        var pages = 0
        while (true) {
            for (it in all(r, "musicResponsiveListItemRenderer")) song(it)?.let { s -> out.putIfAbsent(s.id, s) }
            if (out.size >= limit) break
            val token = first(r, "continuationCommand")?.optString("token")?.ifEmpty { null }
                ?: first(r, "nextContinuationData")?.optString("continuation")?.ifEmpty { null }
            if (token == null || ++pages > 100) break
            r = post("browse", JSONObject().put("continuation", token), "&ctoken=$token&continuation=$token&type=next")
        }
        return name to out.values.take(limit)
    }

    /** Radyo / karışık (RD…): "sıradaki" panelindeki şarkılar. */
    private fun radio(id: String): Pair<String?, List<Song>> {
        val r = post("next", JSONObject().put("playlistId", id).put("isAudioOnly", true).put("enablePersistentPlaylistPanel", true))
        return text(first(r, "playlistPanelRenderer")?.optJSONObject("title")).ifBlank { null } to panelSongs(r)
    }

    /**
     * Bir şarkının radyosu + YT Music'in "sıradaki" panelindeki düğmeler (Hepsi, Tanıdık,
     * Keşfet, Sakin… en sonda dil). chip verilirse o düğmenin listesi.
     * Dönüş: {songs:[…], chips:[{title, pl, params, vid, sel}]}
     */
    fun radioPanel(videoId: String, chip: JSONObject? = null): JSONObject {
        val body = JSONObject().put("isAudioOnly", true).put("enablePersistentPlaylistPanel", true)
        if (chip != null) {
            body.put("videoId", chip.optString("vid").ifEmpty { videoId })
            body.put("playlistId", chip.optString("pl").ifEmpty { "RDAMVM$videoId" })
            chip.optString("params").takeIf { it.isNotEmpty() }?.let { body.put("params", it) }
        } else {
            body.put("videoId", videoId).put("playlistId", "RDAMVM$videoId")
        }
        val r = post("next", body)
        val chips = JSONArray()
        for (c in all(r, "chipCloudChipRenderer")) {
            val title = text(c.optJSONObject("text"))
            if (title.isBlank()) continue
            val we = first(c.optJSONObject("navigationEndpoint"), "watchEndpoint") ?: continue
            chips.put(
                JSONObject().put("title", title)
                    .put("pl", we.optString("playlistId")).put("params", we.optString("params"))
                    .put("vid", we.optString("videoId")).put("sel", c.optBoolean("isSelected"))
            )
        }
        val songs = JSONArray()
        panelSongs(r).forEach { songs.put(it.uiJson()) }
        return JSONObject().put("songs", songs).put("chips", chips)
    }

    private fun panelSongs(r: JSONObject): List<Song> {
        val out = LinkedHashMap<String, Song>()
        for (v in all(r, "playlistPanelVideoRenderer")) {
            val vid = v.optString("videoId").ifEmpty { null } ?: continue
            val by = text(v.optJSONObject("shortBylineText")).ifBlank { text(v.optJSONObject("longBylineText")) }
            out.putIfAbsent("yt:$vid", Song(
                id = "yt:$vid",
                title = text(v.optJSONObject("title")).ifBlank { "?" },
                artist = by.split(" • ").first().trim(),
                durationSec = parseDur(text(v.optJSONObject("lengthText"))),
                thumb = lastThumb(v.optJSONObject("thumbnail")).ifEmpty { Yt.videoThumb(vid) },
            ))
        }
        return out.values.toList()
    }

    /** Ana sayfadan / aramadan gelen bir listeyi aç: {name, songs}. */
    fun openList(id: String): JSONObject {
        val (name, songs) = if (id.startsWith("RD")) radio(id) else playlistPage(id)
        if (songs.isEmpty()) throw IOException("liste boş ya da açılamadı")
        val arr = JSONArray()
        songs.forEach { arr.put(it.uiJson()) }
        return JSONObject().put("name", name ?: "liste").put("songs", arr)
    }

    // --- sanatçı ------------------------------------------------------------------------------

    /** Sanatçı sayfası: {name, thumb, songs:[…], lists:[albüm/tekli…], all: "tüm şarkılar" liste kimliği}. */
    fun artist(id: String): JSONObject {
        val r = post("browse", JSONObject().put("browseId", id))
        val head = first(r, "musicImmersiveHeaderRenderer") ?: first(r, "musicVisualHeaderRenderer")
            ?: first(r, "musicResponsiveHeaderRenderer")
        val name = text(head?.optJSONObject("title")).ifBlank { "sanatçı" }
        val songs = JSONArray()
        var allId: String? = null
        var songsTitle = ""
        first(r, "musicShelfRenderer")?.let { shelf ->
            songsTitle = text(shelf.optJSONObject("title"))
            for (it in all(shelf, "musicResponsiveListItemRenderer")) song(it)?.let { s ->
                songs.put(s.uiJson().put("views", views(it)).put("album", albumOf(it)))
            }
            // "Tümünü göster" → tüm şarkılar listesi
            allId = first(shelf.optJSONObject("title") ?: shelf.optJSONObject("bottomEndpoint"), "browseEndpoint")
                ?.optString("browseId")?.takeIf { it.startsWith("VL") }?.removePrefix("VL")
                ?: first(shelf.optJSONObject("bottomEndpoint"), "browseEndpoint")?.optString("browseId")
                    ?.takeIf { it.startsWith("VL") }?.removePrefix("VL")
        }
        val lists = JSONArray()
        for (sh in all(r, "musicCarouselShelfRenderer")) {
            val contents = sh.optJSONArray("contents") ?: continue
            for (i in 0 until contents.length()) {
                contents.optJSONObject(i)?.optJSONObject("musicTwoRowItemRenderer")?.let { tw ->
                    card(tw)?.takeIf { it.optString("kind") == "list" }?.let { lists.put(it) }
                }
            }
        }
        val listsTitle = all(r, "musicCarouselShelfRenderer").firstOrNull()
            ?.let { text(first(it, "musicCarouselShelfBasicHeaderRenderer")?.optJSONObject("title")) } ?: ""
        return JSONObject().put("name", name).put("thumb", lastThumb(head)).put("songs", songs)
            .put("songsTitle", songsTitle).put("listsTitle", listsTitle)
            .put("lists", lists).put("all", allId ?: JSONObject.NULL)
    }

    private fun flexTexts(r: JSONObject): List<String> {
        val cols = r.optJSONArray("flexColumns") ?: return emptyList()
        return (0 until cols.length()).map { i ->
            text(cols.optJSONObject(i)?.optJSONObject("musicResponsiveListItemFlexColumnRenderer")?.optJSONObject("text"))
        }
    }

    /** "1,2 Mr oynatma" / "35 Mn görüntüleme" gibi dinlenme sayısı (varsa). */
    private fun views(r: JSONObject): String =
        flexTexts(r).drop(1).flatMap { it.split(" • ") }.map { it.trim() }
            .firstOrNull { Regex("(?i)(oynatma|görüntüleme|izlenme|dinlenme|plays?|views?)").containsMatchIn(it) } ?: ""

    /** Şarkının albümü (sanatçı sayfasındaki satırlarda son sütun). */
    private fun albumOf(r: JSONObject): String {
        val t = flexTexts(r)
        return if (t.size >= 4) t.last().trim() else ""
    }

    /** Bir şarkıya benzer şarkılar (YouTube'un otomatik karışığı). */
    fun similar(videoId: String): JSONObject = openList("RDAMVM$videoId")

    /** Eski eşitlemelerde kaydedilmemiş liste kapaklarını tek istekle doldur. */
    fun refreshThumbs() {
        if (!loggedIn) return
        for (l in playlists()) if (l.thumb.isNotEmpty()) Library.setThumbBySrc("yt:${l.id}", l.thumb)
    }

    // --- ana sayfa -----------------------------------------------------------------------------

    /**
     * YT Music ana sayfası (girişliyse sana özel: Hızlı seçim, Unutulan favoriler…).
     * [{title, rows:Boolean, items:[{kind:"song",…} | {kind:"list", list, title, artist, thumb}]}]
     */
    fun home(): JSONArray {
        val out = JSONArray()
        var r = post("browse", JSONObject().put("browseId", "FEmusic_home"))
        var pages = 0
        while (true) {
            for (sh in all(r, "musicCarouselShelfRenderer")) {
                val head = first(sh, "musicCarouselShelfBasicHeaderRenderer")
                val title = text(head?.optJSONObject("title"))
                if (title.isBlank()) continue
                val items = JSONArray()
                var rows = 0
                val contents = sh.optJSONArray("contents") ?: continue
                for (i in 0 until contents.length()) {
                    val c = contents.optJSONObject(i) ?: continue
                    c.optJSONObject("musicResponsiveListItemRenderer")?.let { li ->
                        song(li)?.let { items.put(it.uiJson().put("kind", "song")); rows++ }
                    }
                    c.optJSONObject("musicTwoRowItemRenderer")?.let { tw -> card(tw)?.let { items.put(it) } }
                }
                if (items.length() > 0) out.put(
                    JSONObject().put("title", title)
                        .put("strap", text(head?.optJSONObject("strapline")))
                        .put("rows", rows * 2 > items.length())
                        .put("items", items)
                )
            }
            val token = first(r, "nextContinuationData")?.optString("continuation")?.ifEmpty { null }
                ?: first(r, "continuationCommand")?.optString("token")?.ifEmpty { null }
            if (token == null || ++pages >= 4) break
            r = post("browse", JSONObject().put("continuation", token), "&ctoken=$token&continuation=$token&type=next")
        }
        return out
    }

    private fun card(it: JSONObject): JSONObject? {
        val title = text(it.optJSONObject("title")).ifBlank { return null }
        val sub = text(it.optJSONObject("subtitle"))
        val thumb = lastThumb(it.optJSONObject("thumbnailRenderer"))
        val nav = it.optJSONObject("navigationEndpoint")
        val parts = sub.split(" • ").map { s -> s.trim() }.filter { s -> s.isNotEmpty() }
        nav?.optJSONObject("watchEndpoint")?.optString("videoId")?.ifEmpty { null }?.let { vid ->
            return Song(
                id = "yt:$vid", title = title,
                artist = (if (parts.size > 1) parts[1] else parts.firstOrNull() ?: "").removeSuffix(" - Topic"),
                durationSec = 0, thumb = thumb.ifEmpty { Yt.videoThumb(vid) },
            ).uiJson().put("kind", "song")
        }
        val bid = nav?.optJSONObject("browseEndpoint")?.optString("browseId") ?: ""
        val list = when {
            bid.startsWith("VL") -> bid.removePrefix("VL")
            else -> nav?.optJSONObject("watchPlaylistEndpoint")?.optString("playlistId")?.ifEmpty { null }
                ?: first(it, "watchPlaylistEndpoint")?.optString("playlistId")?.ifEmpty { null }
        } ?: return null // sanatçı sayfaları vb. şimdilik yok
        return JSONObject().put("kind", "list").put("list", list).put("title", title)
            .put("artist", sub).put("thumb", thumb)
    }

    private fun song(r: JSONObject): Song? {
        if (r.optString("musicItemRendererDisplayPolicy").contains("GREY_OUT")) return null
        val vid = r.optJSONObject("playlistItemData")?.optString("videoId")?.ifEmpty { null }
            ?: first(r, "watchEndpoint")?.optString("videoId")?.ifEmpty { null }
            ?: return null
        val cols = r.optJSONArray("flexColumns")
        fun col(i: Int) = cols?.optJSONObject(i)?.optJSONObject("musicResponsiveListItemFlexColumnRenderer")?.optJSONObject("text")
        val dur = text(
            r.optJSONArray("fixedColumns")?.optJSONObject(0)
                ?.optJSONObject("musicResponsiveListItemFixedColumnRenderer")?.optJSONObject("text")
        )
        return Song(
            id = "yt:$vid",
            title = text(col(0)).ifBlank { "?" },
            artist = text(col(1)).split(" • ").first().removeSuffix(" - Topic").trim(),
            durationSec = parseDur(dur),
            thumb = lastThumb(r.optJSONObject("thumbnail")).ifEmpty { Yt.videoThumb(vid) },
        )
    }

    private fun parseDur(s: String): Long =
        s.split(':').mapNotNull { it.trim().toLongOrNull() }.fold(0L) { acc, n -> acc * 60 + n }

    // --- eşitleme ------------------------------------------------------------------------------

    @Volatile var syncing = ""
        private set

    /** Hesaptaki tüm listeleri yerel listelere çek (tekrar çalıştırınca günceller, kopyalamaz). */
    fun syncAll(): JSONObject {
        if (!loggedIn) throw IOException("önce giriş yap")
        var songs = 0
        val lists = playlists()
        try {
            for ((i, l) in lists.withIndex()) {
                syncing = "${i + 1}/${lists.size} · ${l.name}"
                songs += syncOne(l.id, l.name, l.thumb.ifEmpty { null })
            }
        } finally {
            syncing = ""
        }
        sp.edit().putLong("syncedAt", System.currentTimeMillis()).apply()
        rev++
        Logbook.add("SYS", "YouTube eşitlendi: ${lists.size} liste, $songs şarkı")
        return JSONObject().put("lists", lists.size).put("songs", songs)
    }

    fun syncOne(listId: String, name: String?, thumb: String? = null): Int {
        val songs = playlistSongs(listId)
        Library.upsertAll(songs)
        Library.syncPlaylist("yt:$listId", name, songs.map { it.id }, thumb)
        return songs.size
    }
}
