package com.flux.music

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Bilinen her şarkı ve kullanıcının listeleri. Hepsi telefonda, tek bir JSON
 * dosyasında: internet olmadan da arama, liste düzenleme, sıraya ekleme çalışır.
 *
 * Şarkı kimlikleri: "yt:<videoId>" (YouTube) ya da "local:<mediaStoreId>".
 */
data class Song(
    val id: String,
    val title: String,
    val artist: String,
    val durationSec: Long,
    /** Uzak kapak adresi (YouTube). Yerel şarkılarda boş. */
    val thumb: String,
    /** İndirilmiş dosyanın yolu (yt) ya da content:// adresi (yerel). */
    val file: String? = null,
    val addedAt: Long = System.currentTimeMillis(),
    val liked: Boolean = false,
    /** Son çalınma (geçmiş için). */
    val playedAt: Long = 0,
    /** Kaç kez çalındı (ana sayfa: çok dinlenenler, unutulan favoriler). */
    val plays: Int = 0,
) {
    val isYt get() = id.startsWith("yt:")
    val isLocal get() = id.startsWith("local:")
    val videoId get() = id.removePrefix("yt:")

    /** İnternetsiz çalınabilir mi? */
    val offline: Boolean
        get() = isLocal || (file != null && File(file).exists())

    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("title", title)
        .put("artist", artist)
        .put("dur", durationSec)
        .put("thumb", thumb)
        .put("file", file ?: JSONObject.NULL)
        .put("addedAt", addedAt)
        .put("liked", liked)
        .put("playedAt", playedAt)
        .put("plays", plays)

    /** Arayüze giden hali: dosya yolu yerine "çevrimdışı çalar mı?" bilgisi. */
    fun uiJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("title", title)
        .put("artist", artist)
        .put("dur", durationSec)
        .put("thumb", thumb)
        .put("dl", offline)
        .put("av", thumb.hashCode())
        .put("local", isLocal)
        .put("liked", liked)
        .put("addedAt", addedAt)
        .put("playedAt", playedAt)
        .put("plays", plays)

    companion object {
        fun fromJson(o: JSONObject) = Song(
            id = o.getString("id"),
            title = o.optString("title", "?"),
            artist = o.optString("artist", ""),
            durationSec = o.optLong("dur", 0),
            thumb = o.optString("thumb", ""),
            file = if (o.isNull("file")) null else o.optString("file").ifEmpty { null },
            addedAt = o.optLong("addedAt", System.currentTimeMillis()),
            liked = o.optBoolean("liked", false),
            playedAt = o.optLong("playedAt", 0),
            plays = o.optInt("plays", 0),
        )
    }
}

/** src: YouTube hesabından eşitlenen listelerde "yt:<listeId>" (yeniden eşitlemede bulunur). */
data class Playlist(
    val id: String,
    val name: String,
    val songs: MutableList<String>,
    val createdAt: Long,
    val src: String? = null,
    /** YouTube'daki liste kapağı (uzak adres). Kendi seçtiğin resim covers/<id>.jpg. */
    val thumb: String? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("name", name).put("songs", JSONArray(songs)).put("createdAt", createdAt)
        .put("src", src ?: JSONObject.NULL)
        .put("thumb", thumb ?: JSONObject.NULL)

    companion object {
        fun fromJson(o: JSONObject): Playlist {
            val arr = o.optJSONArray("songs") ?: JSONArray()
            return Playlist(
                o.getString("id"), o.optString("name", "liste"),
                MutableList(arr.length()) { arr.getString(it) }, o.optLong("createdAt"),
                if (o.isNull("src")) null else o.optString("src").ifEmpty { null },
                if (o.isNull("thumb")) null else o.optString("thumb").ifEmpty { null },
            )
        }
    }
}

object Library {
    private val songs = LinkedHashMap<String, Song>()
    private val lists = LinkedHashMap<String, Playlist>()
    private lateinit var store: File
    lateinit var musicDir: File
        private set
    lateinit var artDir: File
        private set
    lateinit var coverDir: File
        private set
    private val writer = Executors.newSingleThreadExecutor()

    /** Her değişiklikte artar; arayüz yeniden çizmesi gerekip gerekmediğini buradan anlar. */
    @Volatile var rev = 0L
        private set

    fun init(ctx: Context) {
        store = File(ctx.filesDir, "library.json")
        musicDir = File(ctx.filesDir, "music").apply { mkdirs() }
        artDir = File(ctx.filesDir, "art").apply { mkdirs() }
        coverDir = File(ctx.filesDir, "covers").apply { mkdirs() }
        load()
    }

    @Synchronized
    private fun load() {
        if (!store.exists()) return
        try {
            val o = JSONObject(store.readText())
            o.optJSONArray("songs")?.let { a ->
                for (i in 0 until a.length()) Song.fromJson(a.getJSONObject(i)).let { s0 ->
                    // Eski sürümler 4:3 şeritli küçük resim saklıyordu: düzelt, önbelleği at.
                    val fixed = Yt.fixThumb(s0.thumb)
                    val s = if (fixed != s0.thumb) { artFile(s0.id).delete(); s0.copy(thumb = fixed) } else s0
                    songs[s.id] = s
                }
            }
            o.optJSONArray("playlists")?.let { a ->
                for (i in 0 until a.length()) Playlist.fromJson(a.getJSONObject(i)).let { lists[it.id] = it }
            }
        } catch (e: Exception) {
            Logbook.add("ERR", "kitaplık okunamadı: ${e.message}")
            store.copyTo(File(store.parentFile, "library.broken.json"), overwrite = true)
        }
    }

    private fun changed() {
        rev++
        val snapshot = synchronized(this) {
            JSONObject()
                .put("songs", JSONArray(songs.values.map { it.toJson() }))
                .put("playlists", JSONArray(lists.values.map { it.toJson() }))
                .toString()
        }
        // Yarım yazılmış dosya kalmasın: önce geçici dosya, sonra yer değiştir.
        writer.execute {
            val tmp = File(store.parentFile, "library.json.tmp")
            tmp.writeText(snapshot)
            tmp.renameTo(store)
        }
    }

    // --- şarkılar ---------------------------------------------------------------

    @Synchronized fun get(id: String): Song? = songs[id]
    @Synchronized fun all(): List<Song> = songs.values.toList()

    /**
     * Arayüzden/aramadan gelen şarkıyı kaydet. Var olanın indirme, beğeni ve
     * eklenme bilgisi korunur; sadece başlık/kapak tazelenir.
     */
    fun upsert(s: Song): Song = upsertAll(listOf(s)).first()

    /** Eskiyle birleştir; daha iyi kapak geldiyse önbellekteki eski kapağı sil. */
    private fun merge(old: Song?, s0: Song): Song {
        val s = s0.copy(thumb = Yt.fixThumb(s0.thumb))
        if (old == null) return s
        val thumb = Yt.betterThumb(old.thumb, s.thumb)
        if (thumb != old.thumb) artFile(old.id).delete()
        return old.copy(
            title = s.title.ifBlank { old.title },
            artist = s.artist.ifBlank { old.artist },
            durationSec = if (s.durationSec > 0) s.durationSec else old.durationSec,
            thumb = thumb,
            file = old.file ?: s.file,
        )
    }

    fun upsertAll(list: List<Song>): List<Song> {
        val out = synchronized(this) {
            list.map { s ->
                val merged = merge(songs[s.id], s)
                songs[s.id] = merged
                merged
            }
        }
        changed()
        return out
    }

    fun setFile(id: String, path: String?) {
        synchronized(this) { songs[id]?.let { songs[id] = it.copy(file = path) } }
        changed()
    }

    fun setLiked(id: String, liked: Boolean) {
        synchronized(this) { songs[id]?.let { songs[id] = it.copy(liked = liked) } }
        changed()
    }

    fun markPlayed(id: String) {
        synchronized(this) { songs[id]?.let { songs[id] = it.copy(playedAt = System.currentTimeMillis(), plays = it.plays + 1) } }
        changed()
    }

    /** İndirilen dosyayı sil; şarkı kitaplıkta kalır (çevrimiçi çalınabilir). */
    fun deleteDownload(id: String) {
        val s = get(id) ?: return
        if (s.isYt) {
            s.file?.let { File(it).delete() }
            setFile(id, null)
        }
    }

    /** Şarkıyı kitaplıktan tamamen kaldır (listelerden de). */
    fun forget(id: String) {
        deleteDownload(id)
        synchronized(this) {
            songs.remove(id)
            for (p in lists.values) p.songs.removeAll { it == id }
        }
        changed()
    }

    /** Taramada artık bulunamayan yerel şarkıları temizle. */
    fun replaceLocal(found: List<Song>): Int {
        synchronized(this) {
            val ids = found.map { it.id }.toSet()
            val gone = songs.keys.filter { it.startsWith("local:") && it !in ids }
            for (g in gone) songs.remove(g)
        }
        upsertAll(found)
        return found.size
    }

    fun usedBytes(): Long = musicDir.listFiles()?.sumOf { it.length() } ?: 0L

    // --- listeler ---------------------------------------------------------------

    @Synchronized fun playlists(): List<Playlist> = lists.values.toList()
    @Synchronized fun playlist(id: String): Playlist? = lists[id]

    fun createPlaylist(name: String, ids: List<String>): String {
        val id = UUID.randomUUID().toString().take(8)
        synchronized(this) { lists[id] = Playlist(id, name.ifBlank { "liste" }, ids.toMutableList(), System.currentTimeMillis()) }
        changed()
        return id
    }

    /** Eşitlenmiş listenin YouTube kapağını sonradan doldur (eski eşitlemelerde yoktu). */
    fun setThumbBySrc(src: String, thumb: String) {
        var changedAny = false
        synchronized(this) {
            val p = lists.values.firstOrNull { it.src == src } ?: return
            if (p.thumb != thumb) { lists[p.id] = p.copy(thumb = thumb); changedAny = true }
        }
        if (changedAny) changed()
    }

    /** Kapak sürümü: kendi resmin ya da YouTube kapağı değişince WebView eskisini göstermesin. */
    fun coverVersion(p: Playlist): String {
        val f = coverFile(p.id)
        return (if (f.exists()) f.lastModified() else 0L).toString() + "-" + (p.thumb?.hashCode() ?: 0)
    }

    /** Hesaptan gelen listeyi oluştur ya da (aynı kaynaktan) güncelle. */
    fun syncPlaylist(src: String, name: String?, ids: List<String>, thumb: String? = null): String {
        val id = synchronized(this) {
            val old = lists.values.firstOrNull { it.src == src }
            if (old != null) {
                lists[old.id] = old.copy(name = name?.ifBlank { null } ?: old.name, songs = ids.toMutableList(), thumb = thumb ?: old.thumb)
                old.id
            } else {
                val nid = UUID.randomUUID().toString().take(8)
                lists[nid] = Playlist(nid, name ?: "liste", ids.toMutableList(), System.currentTimeMillis(), src, thumb)
                nid
            }
        }
        changed()
        return id
    }

    fun editPlaylist(id: String, block: (Playlist) -> Playlist?) {
        synchronized(this) {
            val p = lists[id] ?: return
            val n = block(p)
            if (n == null) lists.remove(id) else lists[id] = n
        }
        changed()
    }

    // --- oynatıcı için ----------------------------------------------------------

    /** Kendi seçtiğin liste kapağı. */
    fun coverFile(pid: String): File = File(coverDir, pid.replace('/', '_') + ".jpg")

    /** Arayüz yeniden çizsin (dosya değişti ama kayıt değişmedi). */
    fun bump() { rev++ }

    fun artFile(id: String): File = File(artDir, id.replace(':', '_').replace('/', '_') + ".jpg")

    fun mediaItem(s: Song): MediaItem {
        val uri = if (s.isYt) "ytm:${s.videoId}" else (s.file ?: "")
        val art = artFile(s.id).takeIf { it.exists() }?.let { Uri.fromFile(it) }
            ?: s.thumb.takeIf { it.isNotEmpty() }?.let { Uri.parse(it) }
        return MediaItem.Builder()
            .setMediaId(s.id)
            .setUri(uri)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(s.title)
                    .setArtist(s.artist)
                    .setArtworkUri(art)
                    .setIsPlayable(true)
                    .setIsBrowsable(false)
                    .build()
            )
            .build()
    }

    fun mediaItem(id: String): MediaItem? = get(id)?.let { mediaItem(it) }
}
