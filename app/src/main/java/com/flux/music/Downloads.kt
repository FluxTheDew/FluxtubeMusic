package com.flux.music

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * İndirme kuyruğu. Ses akışını parça parça (Range) indirir, kapağı da yanına
 * kaydeder: indirilen şarkı internetsiz kapağıyla birlikte çalar.
 * İndirme sürerken ön plan servisi (DownloadService) uygulama kapansa da devam eder.
 */
object Downloads {
    class Job(val id: String, val title: String) {
        @Volatile var state = "wait" // wait | run | done | error
        @Volatile var progress = 0.0
        @Volatile var error: String? = null
        @Volatile var future: Future<*>? = null
    }

    private val jobs = LinkedHashMap<String, Job>()
    private val pool = Executors.newFixedThreadPool(2)
    private const val CHUNK = 1L shl 20 // 1 MB

    @Volatile var rev = 0L
        private set

    private lateinit var app: Context

    fun init(ctx: Context) {
        app = ctx.applicationContext
    }

    @Synchronized
    fun enqueue(ids: List<String>): Int {
        var n = 0
        for (id in ids) {
            val s = Library.get(id) ?: continue
            if (!s.isYt || s.offline) continue
            val old = jobs[id]
            if (old != null && (old.state == "wait" || old.state == "run")) continue
            val job = Job(id, s.title)
            jobs.remove(id)
            jobs[id] = job
            job.future = pool.submit { run(job) }
            n++
        }
        if (n > 0) {
            rev++
            DownloadService.start(app)
        }
        return n
    }

    @Synchronized
    fun cancelAll() {
        for (j in jobs.values) if (j.state == "wait" || j.state == "run") {
            j.future?.cancel(true)
            j.state = "error"; j.error = "iptal"
        }
        rev++
    }

    @Synchronized
    fun clearFinished() {
        jobs.values.removeAll { it.state == "done" || it.state == "error" }
        rev++
    }

    @Synchronized
    fun active(): Int = jobs.values.count { it.state == "wait" || it.state == "run" }

    @Synchronized
    fun state(id: String): String? = jobs[id]?.state

    @Synchronized
    fun json(): JSONArray {
        val a = JSONArray()
        for (j in jobs.values.toList().asReversed()) a.put(
            JSONObject().put("id", j.id).put("title", j.title).put("state", j.state)
                .put("progress", j.progress).put("error", j.error ?: JSONObject.NULL)
        )
        return a
    }

    @Synchronized
    fun summary(): Pair<Int, Int> {
        val total = jobs.values.count { it.state != "error" }
        val done = jobs.values.count { it.state == "done" }
        return done to total
    }

    private fun run(job: Job) {
        job.state = "run"; rev++
        try {
            val s = Library.get(job.id) ?: throw IOException("şarkı yok")
            if (Prefs.get("dlWifiOnly") == "true" && !Net.unmetered(app)) throw IOException("Wi-Fi bekleniyor")
            val pick = try {
                Yt.audio(s.videoId)
            } catch (e: Exception) {
                Yt.forget(s.videoId)
                Yt.audio(s.videoId)
            }
            val dest = File(Library.musicDir, "${s.videoId}.${pick.suffix}")
            val part = File(Library.musicDir, "${s.videoId}.${pick.suffix}.part")
            fetch(pick.url, part, job)
            dest.delete()
            if (!part.renameTo(dest)) throw IOException("dosya taşınamadı")
            saveArt(s)
            Library.setFile(s.id, dest.absolutePath)
            job.progress = 1.0
            job.state = "done"
            Logbook.add("DL", "${s.title} ▸ indirildi (${dest.length() / 1024} KB, ${pick.bitrate / 1000} kbps)")
        } catch (e: InterruptedException) {
            job.state = "error"; job.error = "iptal"
        } catch (e: Exception) {
            job.state = "error"
            job.error = e.message ?: e.javaClass.simpleName
            Logbook.add("ERR", "${job.title} indirilemedi: ${job.error}")
        } finally {
            rev++
        }
    }

    /** Parça parça indir; yarıda kalan .part dosyası kaldığı yerden devam eder. */
    private fun fetch(url: String, part: File, job: Job) {
        RandomAccessFile(part, "rw").use { out ->
            var pos = out.length()
            out.seek(pos)
            var total = -1L
            while (total < 0 || pos < total) {
                if (Thread.currentThread().isInterrupted) throw InterruptedException()
                val end = pos + CHUNK - 1
                val req = okhttp3.Request.Builder().url(url)
                    .header("User-Agent", Net.UA)
                    .header("Range", "bytes=$pos-$end")
                    .apply { Net.streamHeaders.forEach { (k, v) -> header(k, v) } }
                    .build()
                Net.client.newCall(req).execute().use { r ->
                    if (r.code == 416) { total = pos; return@use }
                    if (r.code != 206 && r.code != 200) throw IOException("HTTP ${r.code}")
                    if (r.code == 200 && pos > 0) {
                        // Sunucu aralığı yok saydı: baştan.
                        out.setLength(0); out.seek(0); pos = 0
                    }
                    val cr = r.header("Content-Range")
                    total = cr?.substringAfterLast('/')?.toLongOrNull()
                        ?: if (r.code == 200) (r.body?.contentLength() ?: -1L) else total
                    val body = r.body ?: throw IOException("boş yanıt")
                    body.byteStream().use { inp ->
                        val buf = ByteArray(32 * 1024)
                        while (true) {
                            val n = inp.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            pos += n
                            if (total > 0) job.progress = pos.toDouble() / total
                        }
                    }
                    if (r.code == 200) total = pos
                }
            }
        }
    }

    /** Kapağı indirilen şarkının yanına kaydet (zaten varsa dokunma). */
    fun saveArt(s: Song) {
        val f = Library.artFile(s.id)
        if (f.exists() && f.length() > 0) return
        val urls = listOf(s.thumb, "https://i.ytimg.com/vi/${s.videoId}/hqdefault.jpg").filter { it.isNotEmpty() }
        for (u in urls) try {
            Net.client.newCall(okhttp3.Request.Builder().url(u).header("User-Agent", Net.UA).build()).execute().use { r ->
                if (!r.isSuccessful) return@use
                val bytes = r.body?.bytes() ?: return@use
                if (bytes.isEmpty()) return@use
                val tmp = File(f.parentFile, f.name + ".tmp")
                tmp.writeBytes(bytes)
                tmp.renameTo(f)
                return
            }
        } catch (_: Exception) { /* sıradakini dene */ }
    }
}

/** İndirmeler sürerken uygulama arka plana atılsa da işlem ölmesin. */
class DownloadService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            if (Downloads.active() == 0) {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return
            }
            getSystemService(NotificationManager::class.java).notify(ID, build())
            handler.postDelayed(this, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(ID, n)
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, 1000)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        super.onDestroy()
    }

    private fun build(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CH) == null) {
            nm.createNotificationChannel(NotificationChannel(CH, "İndirmeler", NotificationManager.IMPORTANCE_LOW))
        }
        val (done, total) = Downloads.summary()
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("İndiriliyor")
            .setContentText("$done / $total şarkı")
            .setProgress(total.coerceAtLeast(1), done, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val CH = "downloads"
        private const val ID = 7

        fun start(ctx: Context) {
            runCatching { ctx.startForegroundService(Intent(ctx, DownloadService::class.java)) }
                .onFailure { Logbook.add("ERR", "indirme servisi başlatılamadı: ${it.message}") }
        }
    }
}
