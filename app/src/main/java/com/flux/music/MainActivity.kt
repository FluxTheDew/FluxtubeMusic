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
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.view.MotionEvent
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
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
    private var pendingCover: String? = null
    private val noArt = Collections.synchronizedSet(HashSet<String>())

    // --- teşhis: arayüz açılmazsa / donarsa Android'in kendi penceresiyle göster ---
    @Volatile private var jsReady = false
    @Volatile private var jsTouches = 0
    @Volatile private var lastPong = 0L
    private var nativeTouches = 0
    private var diagShown = false

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
            webChromeClient = object : WebChromeClient() {
                // Sözdizimi hataları dahil: app.js hiç çalışmasa bile burada görünür.
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR || m.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                        Logbook.add("JS", "${m.message()} @${m.sourceId()?.substringAfterLast('/')}:${m.lineNumber()}")
                    }
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    Logbook.add("SYS", "sayfa yüklendi, WebView ${webViewVersion()}")
                    main.postDelayed(watchdog, 6000)
                }

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
        // Eski eşitlemede kapağı kaydedilmemiş YouTube listeleri varsa doldur.
        if (YtAccount.loggedIn && Net.online(this) && Library.playlists().any { it.src != null && it.thumb == null }) {
            bg.execute { runCatching { YtAccount.refreshThumbs() }.onFailure { Logbook.add("ERR", "liste kapakları alınamadı: ${it.message}") } }
        }
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

    private val cornerTaps = ArrayDeque<Long>()

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
            nativeTouches++
            // Sol üst köşeye 1 sn içinde 3 dokunuş: teşhis penceresi (arayüz tepki vermese bile).
            val d = resources.displayMetrics.density
            if (ev.x < 90 * d && ev.y < 120 * d) {
                val now = System.currentTimeMillis()
                cornerTaps.addLast(now)
                while (cornerTaps.isNotEmpty() && now - cornerTaps.first() > 1000) cornerTaps.removeFirst()
                if (cornerTaps.size >= 3) { cornerTaps.clear(); showDiag("Elle açıldı (sol üst köşe).") }
            }
            // Android dokunuşu alıyor ama arayüze hiç ulaşmıyorsa.
            main.postDelayed({
                if (nativeTouches >= 6 && jsTouches == 0) showDiag("Dokunuşlar arayüze ulaşmıyor.")
            }, 1500)
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun webViewVersion(): String =
        runCatching { WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull() ?: "?"

    /** 6 sn'de bir: arayüz hazır mı, JS yanıt veriyor mu? */
    private val watchdog = object : Runnable {
        override fun run() {
            if (isFinishing || diagShown) return
            if (!jsReady) {
                showDiag("Arayüz başlatılamadı (6 sn içinde hazır olmadı).")
                return
            }
            val sent = System.currentTimeMillis()
            web.evaluateJavascript("1") { lastPong = System.currentTimeMillis() }
            main.postDelayed({
                if (!diagShown && !isFinishing && lastPong < sent) showDiag("Arayüz donmuş (JS 4 sn'dir yanıt vermiyor).")
            }, 4000)
            main.postDelayed(this, 6000)
        }
    }

    private fun showDiag(why: String) {
        if (diagShown || isFinishing) return
        diagShown = true
        Logbook.add("ERR", why)
        val lines = Logbook.since(0).takeLast(25).joinToString("\n") { "${it.tag} ${it.text}" }
        val text = buildString {
            appendLine(why)
            appendLine()
            appendLine("sürüm: ${Updater.current(this@MainActivity)} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            appendLine("WebView: ${webViewVersion()}")
            appendLine("dokunuş: Android $nativeTouches · arayüz $jsTouches · hazır: $jsReady")
            appendLine()
            append(lines)
        }
        AlertDialog.Builder(this)
            .setTitle("FluxTube Music · teşhis")
            .setMessage(text)
            .setPositiveButton("GÜNCELLE") { _, _ ->
                Updater.check(this)
                main.postDelayed(object : Runnable {
                    override fun run() {
                        when (Updater.phase) {
                            "checking" -> main.postDelayed(this, 500)
                            "available" -> Updater.install(this@MainActivity)
                            else -> android.widget.Toast.makeText(this@MainActivity, "güncelleme: ${Updater.phase} ${Updater.error ?: ""}", android.widget.Toast.LENGTH_LONG).show()
                        }
                    }
                }, 500)
                diagShown = false
            }
            .setNeutralButton("KOPYALA") { _, _ ->
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("teşhis", text))
                android.widget.Toast.makeText(this, "kopyalandı", android.widget.Toast.LENGTH_SHORT).show()
                diagShown = false
            }
            .setNegativeButton("KAPAT") { _, _ -> diagShown = false }
            .show()
    }

    override fun onDestroy() {
        main.removeCallbacks(watchdog)
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
            .put("srev", PlaybackService.suggestRev)
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
        if (id.startsWith("pl:")) return playlistArt(id.removePrefix("pl:"))
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

    private fun fileResponse(f: java.io.File) =
        WebResourceResponse("image/jpeg", null, 200, "OK", mapOf("Cache-Control" to "max-age=86400"), FileInputStream(f))

    /** Liste kapağı: kendi seçtiğin resim → YouTube'daki kapak (bir kez indirilip saklanır) → ilk şarkının kapağı. */
    private fun playlistArt(pid: String): WebResourceResponse? {
        Library.coverFile(pid).takeIf { it.exists() && it.length() > 0 }?.let { return fileResponse(it) }
        val p = Library.playlist(pid) ?: return null
        val cached = Library.artFile("pl:$pid-${p.thumb?.hashCode() ?: 0}")
        if (!cached.exists() && !p.thumb.isNullOrEmpty() && Net.online(this)) runCatching {
            Net.client.newCall(okhttp3.Request.Builder().url(p.thumb).header("User-Agent", Net.UA).build()).execute().use { r ->
                if (r.isSuccessful) r.body?.bytes()?.takeIf { it.isNotEmpty() }?.let { cached.writeBytes(it) }
            }
        }
        if (cached.exists() && cached.length() > 0) return fileResponse(cached)
        return p.songs.firstOrNull()?.let { art(it) }
    }

    @Deprecated("Activity API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_COVER) return
        val pid = pendingCover ?: return
        pendingCover = null
        val uri = data?.data ?: return
        bg.execute {
            try {
                // Büyük fotoğrafları küçült: en fazla ~800 px, JPEG.
                val opts = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                contentResolver.openInputStream(uri)?.use { android.graphics.BitmapFactory.decodeStream(it, null, opts) }
                var sample = 1
                while (maxOf(opts.outWidth, opts.outHeight) / sample > 1000) sample *= 2
                val bmp = contentResolver.openInputStream(uri)?.use {
                    android.graphics.BitmapFactory.decodeStream(it, null, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
                } ?: throw java.io.IOException("resim okunamadı")
                val side = minOf(bmp.width, bmp.height)
                val square = android.graphics.Bitmap.createBitmap(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side)
                Library.coverFile(pid).outputStream().use { square.compress(android.graphics.Bitmap.CompressFormat.JPEG, 88, it) }
                Library.bump()
                Logbook.add("SYS", "liste kapağı değişti")
            } catch (e: Exception) {
                Logbook.add("ERR", "kapak kaydedilemedi: ${e.message}")
            }
        }
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
            // Öneriler (benzer şarkılar) kendiliğinden inmesin.
            if (mode != "replace" && mode != "shuffle" && mode != "suggest") autoDownload(ids)
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
                    .put("cover", "pl:" + p.id)
                    // Kapak değişince WebView önbelleği eskisini göstermesin.
                    .put("coverV", Library.coverVersion(p))
                    .put("custom", Library.coverFile(p.id).exists())
                    .put("src", p.src ?: JSONObject.NULL)
                    .put("ids", JSONArray(p.songs)))
            }
        }.toString()

        @JavascriptInterface
        fun playlist(id: String): String {
            val p = Library.playlist(id) ?: return "null"
            return JSONObject().put("id", p.id).put("name", p.name).put("yt", p.src != null)
                .put("cover", "pl:" + p.id)
                .put("coverV", Library.coverVersion(p))
                .put("custom", Library.coverFile(p.id).exists())
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
        @JavascriptInterface fun similar(req: Int, videoId: String) = async(req) { YtAccount.similar(videoId) }

        /** Sıranın altındaki ÖNERİLEN: çalma servisinin listesi (sıraya girenler buradan). */
        @JavascriptInterface fun suggestions(): String = PlaybackService.suggestJson
        @JavascriptInterface fun refreshSuggestions() = main.post { PlaybackService.instance?.refreshSuggestions() }
        @JavascriptInterface fun artist(req: Int, id: String) = async(req) { YtAccount.artist(id) }

        /** Liste kapağı: galeriden resim seç / kaldır. */
        @JavascriptInterface fun pickCover(pid: String) = main.post {
            pendingCover = pid
            @Suppress("DEPRECATION")
            startActivityForResult(
                android.content.Intent(android.content.Intent.ACTION_GET_CONTENT).setType("image/*")
                    .addCategory(android.content.Intent.CATEGORY_OPENABLE),
                REQ_COVER,
            )
        }
        @JavascriptInterface fun removeCover(pid: String) {
            Library.coverFile(pid).delete()
            Library.bump()
        }

        /** app.js başladı / bitti; teşhis için. */
        @JavascriptInterface fun boot(stage: String) {
            Logbook.add("SYS", "arayüz: $stage")
            if (stage == "ready") jsReady = true
        }
        @JavascriptInterface fun touch() { jsTouches++ }

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
        private const val REQ_COVER = 4
    }
}
