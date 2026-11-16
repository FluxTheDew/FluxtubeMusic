package com.flux.music

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ComponentName
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FileInputStream
import java.util.Collections
import java.util.concurrent.Executors

/*
 * Arayüz ULL-DPI / ULL-Bot gibi HTML/CSS (assets/web). Bu aktivite onu bir
 * WebView'da açıp `window.FM` köprüsüyle oynatıcıya, kitaplığa ve indirmelere bağlıyor.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private val main = Handler(Looper.getMainLooper())
    private val bg = Executors.newFixedThreadPool(3)

    private var future: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val pending = ArrayList<(MediaController) -> Unit>()

    /** Arayüzün 0.5 sn'de bir okuduğu durum (ana iş parçacığında hazırlanıyor). */
    @Volatile private var snapshot = "{\"ready\":false}"
    @Volatile private var queueIds: List<String> = emptyList()
    @Volatile private var qrev = 0L

    /** "Sıradaki" ile art arda eklenenler sırayla dursun diye sayaç. */
    private var nextAdds = 0
    private var pendingScan = -1
    private val noArt = Collections.synchronizedSet(HashSet<String>())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK

        val root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#050505")) }
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#050505"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = true
            overScrollMode = View.OVER_SCROLL_NEVER
            addJavascriptInterface(Bridge(), "FM")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
                    !request.url.toString().startsWith("file:///android_asset/")

                // Kapaklar: https://fm.art/<şarkı kimliği> → telefondaki kopya (yoksa indirip sakla).
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val u = request.url
                    if (u.host != "fm.art") return null
                    val id = u.lastPathSegment?.let { Uri.decode(it) } ?: return notFound()
                    return art(id) ?: notFound()
                }
            }
        }
        root.addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.setOnApplyWindowInsetsListener { v, insets ->
            @Suppress("DEPRECATION")
            v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        setContentView(root)
        web.loadUrl("file:///android_asset/web/index.html")

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
        }
        if (Updater.phase == "idle" && Net.online(this)) Updater.check(this)
    }

    override fun onStart() {
        super.onStart()
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val f = MediaController.Builder(this, token).buildAsync()
        future = f
        f.addListener({
            val c = runCatching { f.get() }.getOrNull() ?: return@addListener
            controller = c
            c.addListener(playerListener)
            refreshQueue(c)
            pending.toList().forEach { it(c) }
            pending.clear()
            buildSnapshot()
        }, { main.post(it) })
        main.post(ticker)
    }

    override fun onStop() {
        main.removeCallbacks(ticker)
        controller?.removeListener(playerListener)
        future?.let { MediaController.releaseFuture(it) }
        future = null
        controller = null
        super.onStop()
    }

    @Deprecated("Activity API")
    override fun onBackPressed() {
        web.evaluateJavascript("window.onBack ? window.onBack() : false") { handled ->
            if (handled != "true") {
                // Geri tuşu müziği kapatmasın: sadece arka plana al.
                moveTaskToBack(true)
            }
        }
    }

    override fun onDestroy() {
        web.destroy()
        bg.shutdown()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_AUDIO && pendingScan >= 0) {
            val req = pendingScan
            pendingScan = -1
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) runScan(req)
            else reply(req, JSONObject().put("ok", false).put("error", "müzik dosyalarına erişim izni verilmedi"))
        }
    }

    // --- oynatıcı durumu --------------------------------------------------------------

    private val ticker = object : Runnable {
        override fun run() {
            buildSnapshot()
            main.postDelayed(this, 500)
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            if (events.contains(Player.EVENT_TIMELINE_CHANGED)) refreshQueue(player)
            if (events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION)) nextAdds = 0
            buildSnapshot()
        }
    }

    private fun refreshQueue(p: Player) {
        queueIds = List(p.mediaItemCount) { p.getMediaItemAt(it).mediaId }
        qrev++
    }

    private fun buildSnapshot() {
        val c = controller
        val o = JSONObject()
        if (c == null) {
            o.put("ready", false)
        } else {
            val dur = c.duration
            o.put("ready", true)
                .put("playing", c.isPlaying)
                .put("want", c.playWhenReady)
                .put("state", c.playbackState)
                .put("index", c.currentMediaItemIndex)
                .put("count", c.mediaItemCount)
                .put("pos", c.currentPosition.coerceAtLeast(0))
                .put("dur", if (dur == C.TIME_UNSET) 0 else dur)
                .put("repeat", c.repeatMode)
            val id = c.currentMediaItem?.mediaId
            o.put("cur", id?.let { Library.get(it)?.uiJson() } ?: JSONObject.NULL)
        }
        o.put("qrev", qrev)
            .put("lrev", Library.rev)
            .put("drev", Downloads.rev)
            .put("dlActive", Downloads.active())
            .put("online", Net.online(this))
            .put("arev", YtAccount.rev)
            .put("syncing", YtAccount.syncing)
            .put("update", JSONObject()
                .put("phase", Updater.phase)
                .put("current", Updater.current(this))
                .put("latest", Updater.latest)
                .put("notes", Updater.notes)
                .put("progress", Updater.progress)
                .put("error", Updater.error ?: JSONObject.NULL))
        snapshot = o.toString()
    }

    /** Denetleyici hazırsa hemen, değilse bağlanınca çalıştır (ana iş parçacığında). */
    private fun withPlayer(block: (MediaController) -> Unit) = main.post {
        val c = controller
        if (c != null) block(c) else pending.add(block)
    }

    private fun MediaController.ensurePlaying() {
        if (playbackState == Player.STATE_IDLE) prepare()
        if (playbackState == Player.STATE_ENDED) seekToDefaultPosition()
        play()
    }

    private fun items(ids: List<String>): List<MediaItem> = ids.mapNotNull { Library.mediaItem(it) }

    private fun doEnqueue(c: MediaController, ids: List<String>, mode: String, start: Int) {
        val items = items(ids)
        if (items.isEmpty()) return
        val count = c.mediaItemCount
        val cur = c.currentMediaItemIndex.coerceAtLeast(0)
        when (mode) {
            "replace" -> {
                c.setMediaItems(items, start.coerceIn(0, items.size - 1), 0)
                c.prepare(); c.play()
            }
            "shuffle" -> {
                c.setMediaItems(items.shuffled(), 0, 0)
                c.prepare(); c.play()
            }
            "now" -> if (count == 0) {
                c.setMediaItems(items); c.prepare(); c.play()
            } else {
                c.addMediaItems(cur + 1, items)
                c.seekTo(cur + 1, 0)
                c.ensurePlaying()
            }
            "next" -> if (count == 0) {
                c.setMediaItems(items); c.prepare()
                nextAdds = items.size - 1
            } else {
                val at = (cur + 1 + nextAdds).coerceAtMost(count)
                c.addMediaItems(at, items)
                nextAdds += items.size
            }
            else -> { // end
                c.addMediaItems(items)
                if (count == 0) c.prepare()
            }
        }
    }

    // --- kapaklar ---------------------------------------------------------------------

    private fun notFound() =
        WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun art(id: String): WebResourceResponse? {
        val f = Library.artFile(id)
        if (!f.exists() && id !in noArt) {
            val s = Library.get(id)
            when {
                s == null -> {}
                s.isLocal -> runCatching {
                    // use{} değil: API 29 altında AutoCloseable değil.
                    val r = MediaMetadataRetriever()
                    try {
                        r.setDataSource(this, Uri.parse(s.file))
                        r.embeddedPicture?.let { f.writeBytes(it) }
                    } finally {
                        r.release()
                    }
                }
                Net.online(this) -> Downloads.saveArt(s)
            }
            if (!f.exists()) noArt.add(id)
        }
        if (!f.exists() || f.length() == 0L) return null
        return WebResourceResponse("image/jpeg", null, 200, "OK", mapOf("Cache-Control" to "max-age=86400"), FileInputStream(f))
    }

    // --- yardımcılar ------------------------------------------------------------------

    private fun reply(req: Int, res: JSONObject) {
        val js = "window.FMcb && FMcb($req, ${JSONObject.quote(res.toString())})"
        main.post { web.evaluateJavascript(js, null) }
    }

    /** Uzun iş (ağ, tarama): arka planda yap, sonucu JS'e FMcb(req, …) ile ver. */
    private fun async(req: Int, work: () -> Any) {
        bg.execute {
            val res = try {
                JSONObject().put("ok", true).put("data", work())
            } catch (e: Throwable) {
                Logbook.add("ERR", e.message ?: e.javaClass.simpleName)
                JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
            }
            reply(req, res)
        }
    }

    private fun runScan(req: Int) = async(req) {
        val n = Library.replaceLocal(Local.scan(this))
        Logbook.add("SYS", "yerel müzik tarandı: $n şarkı")
        JSONObject().put("count", n)
    }

    /** JS'ten gelen şarkı listesi → kitaplığa kaydedilmiş Song'lar. */
    private fun parseSongs(json: String): List<Song> {
        val a = JSONArray(json)
        val list = (0 until a.length()).map { i ->
            val o = a.getJSONObject(i)
            val id = o.getString("id")
            Library.get(id) ?: Song(
                id = id,
                title = o.optString("title", "?"),
                artist = o.optString("artist", ""),
                durationSec = o.optLong("dur", 0),
                thumb = o.optString("thumb", ""),
            )
        }
        return Library.upsertAll(list)
    }

    private fun autoDownload(ids: List<String>) {
        val mode = Prefs.get("autoDl")
        if (mode == "always" || (mode == "wifi" && Net.unmetered(this))) Downloads.enqueue(ids)
    }

    private fun songsJson(list: List<Song>) = JSONArray().apply { list.forEach { put(it.uiJson()) } }

    // --- köprü ------------------------------------------------------------------------

    /** JS'ten çağrılıyor (WebView'un kendi iş parçacığında). */
    inner class Bridge {
        @JavascriptInterface fun version(): String = Updater.current(this@MainActivity)
        @JavascriptInterface fun state(): String = snapshot

        @JavascriptInterface
        fun queue(): String = JSONArray().apply {
            for (id in queueIds) put(Library.get(id)?.uiJson() ?: JSONObject().put("id", id).put("title", id).put("artist", ""))
        }.toString()

        // çalma
        @JavascriptInterface fun play() = withPlayer { it.ensurePlaying() }
        @JavascriptInterface fun pause() = withPlayer { it.pause() }
        @JavascriptInterface fun toggle() = withPlayer { if (it.playWhenReady && it.playbackState != Player.STATE_ENDED) it.pause() else it.ensurePlaying() }
        @JavascriptInterface fun next() = withPlayer { it.seekToNext(); it.ensurePlaying() }
        @JavascriptInterface fun prev() = withPlayer { it.seekToPrevious() }
        @JavascriptInterface fun seek(ms: Double) = withPlayer { it.seekTo(ms.toLong()) }
        @JavascriptInterface fun jump(index: Int) = withPlayer {
            if (index in 0 until it.mediaItemCount) { it.seekTo(index, 0); it.ensurePlaying() }
        }
        @JavascriptInterface fun repeat() = withPlayer {
            it.repeatMode = when (it.repeatMode) {
                Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
                Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
                else -> Player.REPEAT_MODE_OFF
            }
        }

        // sıra
        /** mode: now | next | end | replace | shuffle. start: replace'te başlanacak şarkı. */
        @JavascriptInterface
        fun enqueue(json: String, mode: String, start: Int): Int {
            val ids = parseSongs(json).map { it.id }
            if (mode != "replace" && mode != "shuffle") autoDownload(ids)
            withPlayer { doEnqueue(it, ids, mode, start) }
            return ids.size
        }

        @JavascriptInterface fun move(from: Int, to: Int) = withPlayer {
            if (from in 0 until it.mediaItemCount && to in 0 until it.mediaItemCount) it.moveMediaItem(from, to)
        }
        @JavascriptInterface fun remove(index: Int) = withPlayer {
            if (index in 0 until it.mediaItemCount) it.removeMediaItem(index)
        }
        @JavascriptInterface fun clearUpcoming() = withPlayer {
            val from = it.currentMediaItemIndex + 1
            if (from < it.mediaItemCount) it.removeMediaItems(from, it.mediaItemCount)
        }
        @JavascriptInterface fun clearQueue() = withPlayer { it.stop(); it.clearMediaItems() }
        @JavascriptInterface fun shuffleUpcoming() = withPlayer {
            val from = it.currentMediaItemIndex + 1
            val n = it.mediaItemCount
            if (n - from < 2) return@withPlayer
            val ids = (from until n).map { i -> it.getMediaItemAt(i).mediaId }.shuffled()
            it.replaceMediaItems(from, n, items(ids))
        }
        @JavascriptInterface fun saveQueue(name: String): String = Library.createPlaylist(name, queueIds)

        // kitaplık
        @JavascriptInterface
        fun library(): String = songsJson(Library.all().sortedByDescending { it.addedAt }).toString()

        /** Aramadan gelen şarkıları kitaplığa kaydet (beğenmeden önce). */
        @JavascriptInterface fun remember(json: String): Int = parseSongs(json).size
        @JavascriptInterface fun like(id: String, on: Boolean) = Library.setLiked(id, on)
        @JavascriptInterface fun deleteDownload(id: String) = Library.deleteDownload(id)
        @JavascriptInterface fun forget(id: String) = Library.forget(id)

        @JavascriptInterface
        fun stats(): String {
            val all = Library.all()
            return JSONObject()
                .put("songs", all.size)
                .put("downloaded", all.count { it.isYt && it.offline })
                .put("local", all.count { it.isLocal })
                .put("bytes", Library.usedBytes())
                .toString()
        }

        // listeler
        @JavascriptInterface
        fun playlists(): String = JSONArray().apply {
            for (p in Library.playlists()) {
                val songs = p.songs.mapNotNull { Library.get(it) }
                put(JSONObject().put("id", p.id).put("name", p.name).put("count", songs.size)
                    .put("yt", p.src != null)
                    .put("dl", songs.count { it.offline })
                    .put("cover", songs.firstOrNull()?.id ?: JSONObject.NULL))
            }
        }.toString()

        @JavascriptInterface
        fun playlist(id: String): String {
            val p = Library.playlist(id) ?: return "null"
            return JSONObject().put("id", p.id).put("name", p.name).put("yt", p.src != null)
                .put("songs", songsJson(p.songs.mapNotNull { Library.get(it) })).toString()
        }

        @JavascriptInterface
        fun createPlaylist(name: String, json: String): String {
            val ids = parseSongs(json).map { it.id }
            autoDownload(ids)
            return Library.createPlaylist(name, ids)
        }

        @JavascriptInterface
        fun addToPlaylist(pid: String, json: String): Int {
            val ids = parseSongs(json).map { it.id }
            autoDownload(ids)
            Library.editPlaylist(pid) { p -> p.copy(songs = (p.songs + ids).toMutableList()) }
            return ids.size
        }

        @JavascriptInterface fun plRemove(pid: String, index: Int) = Library.editPlaylist(pid) { p ->
            if (index in p.songs.indices) p.songs.removeAt(index); p
        }
        @JavascriptInterface fun plMove(pid: String, from: Int, to: Int) = Library.editPlaylist(pid) { p ->
            if (from in p.songs.indices && to in p.songs.indices) p.songs.add(to, p.songs.removeAt(from)); p
        }
        @JavascriptInterface fun plRename(pid: String, name: String) = Library.editPlaylist(pid) { p -> p.copy(name = name) }
        @JavascriptInterface fun plDelete(pid: String) = Library.editPlaylist(pid) { null }

        // indirme
        @JavascriptInterface fun download(json: String): Int = Downloads.enqueue(parseSongs(json).map { it.id })
        @JavascriptInterface fun downloads(): String = Downloads.json().toString()
        @JavascriptInterface fun dlCancel() = Downloads.cancelAll()
        @JavascriptInterface fun dlClear() = Downloads.clearFinished()

        // çevrimiçi
        @JavascriptInterface fun search(req: Int, q: String, filter: String) = async(req) { Yt.search(q, filter) }
        @JavascriptInterface fun importLink(req: Int, url: String) = async(req) { Yt.importLink(url) }
        @JavascriptInterface fun openList(req: Int, url: String) = async(req) { Yt.playlist(url) }

        /** YT liste kimliği: önce music.youtube.com API'si (gizli listeler, karışıklar), olmazsa NewPipe. */
        @JavascriptInterface
        fun openYt(req: Int, id: String) = async(req) {
            try {
                YtAccount.openList(id)
            } catch (e: Exception) {
                Logbook.add("SYS", "liste API'den açılamadı (${e.message}), NewPipe deneniyor")
                Yt.playlist("https://www.youtube.com/playlist?list=$id")
            }
        }

        @JavascriptInterface fun home(req: Int) = async(req) { YtAccount.home() }

        /** Arayüzdeki JS hataları OLAYLAR'a düşsün. */
        @JavascriptInterface fun jsError(msg: String) = Logbook.add("JS", msg.take(400))

        // yerel müzik
        @JavascriptInterface
        fun scanLocal(req: Int) = main.post {
            val perm = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO
            else Manifest.permission.READ_EXTERNAL_STORAGE
            if (checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) {
                runScan(req)
            } else {
                pendingScan = req
                requestPermissions(arrayOf(perm), REQ_AUDIO)
            }
        }

        // YouTube hesabı
        @JavascriptInterface fun account(): String = YtAccount.json().toString()
        @JavascriptInterface fun login() = main.post { startActivity(android.content.Intent(this@MainActivity, LoginActivity::class.java)) }
        @JavascriptInterface fun logout() = YtAccount.logout()
        @JavascriptInterface fun syncAccount(req: Int) = async(req) { YtAccount.syncAll() }

        /** Hesaptan gelmiş tek bir listeyi tazele. */
        @JavascriptInterface
        fun syncList(req: Int, pid: String) = async(req) {
            val p = Library.playlist(pid) ?: throw java.io.IOException("liste yok")
            val src = p.src?.removePrefix("yt:") ?: throw java.io.IOException("bu liste YouTube'dan gelmemiş")
            JSONObject().put("songs", YtAccount.syncOne(src, null))
        }

        // ayarlar
        @JavascriptInterface fun prefs(): String = Prefs.json().toString()
        @JavascriptInterface fun setPref(key: String, value: String) = Prefs.set(key, value)

        // güncelleme
        @JavascriptInterface fun checkUpdate() = Updater.check(this@MainActivity)
        @JavascriptInterface fun installUpdate() = main.post { Updater.install(this@MainActivity) }

        // olaylar
        @JavascriptInterface
        fun logs(since: Double): String = JSONArray().apply {
            for (l in Logbook.since(since.toLong())) {
                put(JSONObject().put("id", l.id).put("t", l.time).put("tag", l.tag).put("msg", l.text))
            }
        }.toString()

        @JavascriptInterface fun clearLogs() = Logbook.clear()
    }

    companion object {
        private const val REQ_NOTIF = 2
        private const val REQ_AUDIO = 3
    }
}
