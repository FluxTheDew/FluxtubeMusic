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
                okhttp3.Request.Builder().url("$ORIGIN/").header("User-Agent", Net.UA).header("Cookie", cookie).build()
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
        val req = okhttp3.Request.Builder()
            .url("$ORIGIN/youtubei/v1/$endpoint?prettyPrint=false$query")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .header("User-Agent", Net.UA)
            .header("Cookie", cookie)
            .header("Authorization", auth())
            .header("Origin", ORIGIN)
            .header("X-Origin", ORIGIN)
            .header("Referer", "$ORIGIN/")
            .header("X-Goog-AuthUser", "0")
            .header("X-YouTube-Client-Name", "67")
            .header("X-YouTube-Client-Version", ver)
            .build()
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

    data class YtList(val id: String, val name: String)

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
                out[id] = YtList(id, text(it.optJSONObject("title")).ifBlank { "liste" })
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
    fun playlistSongs(id: String, limit: Int = 5000): List<Song> {
        val out = LinkedHashMap<String, Song>()
        val r0 = post("browse", JSONObject().put("browseId", "VL$id"))
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
        return out.values.take(limit)
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
            thumb = lastThumb(r.optJSONObject("thumbnail")).ifEmpty { "https://i.ytimg.com/vi/$vid/hqdefault.jpg" },
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
                songs += syncOne(l.id, l.name)
            }
        } finally {
            syncing = ""
        }
        sp.edit().putLong("syncedAt", System.currentTimeMillis()).apply()
        rev++
        Logbook.add("SYS", "YouTube eşitlendi: ${lists.size} liste, $songs şarkı")
        return JSONObject().put("lists", lists.size).put("songs", songs)
    }

    fun syncOne(listId: String, name: String?): Int {
        val songs = playlistSongs(listId)
        Library.upsertAll(songs)
        Library.syncPlaylist("yt:$listId", name, songs.map { it.id })
        return songs.size
    }
}
