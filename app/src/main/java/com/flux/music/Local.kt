package com.flux.music

import android.content.ContentUris
import android.content.Context
import android.provider.MediaStore

/** Telefondaki müzik dosyaları (MediaStore). İzni MainActivity alıyor. */
object Local {
    fun scan(ctx: Context): List<Song> {
        val out = ArrayList<Song>()
        val uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val cols = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.DATE_ADDED,
        )
        ctx.contentResolver.query(uri, cols, "${MediaStore.Audio.Media.IS_MUSIC} != 0", null, null)?.use { c ->
            val iId = c.getColumnIndexOrThrow(cols[0])
            val iTitle = c.getColumnIndexOrThrow(cols[1])
            val iArtist = c.getColumnIndexOrThrow(cols[2])
            val iDur = c.getColumnIndexOrThrow(cols[3])
            val iAdded = c.getColumnIndexOrThrow(cols[4])
            while (c.moveToNext()) {
                val id = c.getLong(iId)
                val artist = c.getString(iArtist)?.takeIf { it != "<unknown>" } ?: ""
                out.add(
                    Song(
                        id = "local:$id",
                        title = c.getString(iTitle) ?: "?",
                        artist = artist,
                        durationSec = c.getLong(iDur) / 1000,
                        thumb = "",
                        file = ContentUris.withAppendedId(uri, id).toString(),
                        addedAt = c.getLong(iAdded) * 1000,
                    )
                )
            }
        }
        return out
    }
}
