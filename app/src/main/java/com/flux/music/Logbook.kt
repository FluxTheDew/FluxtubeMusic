package com.flux.music

import android.util.Log
import java.util.ArrayDeque

/** AYAR → OLAYLAR panelinde görünen kısa kayıt (son 200 satır). */
object Logbook {
    data class Line(val id: Long, val time: Long, val tag: String, val text: String)

    private val lines = ArrayDeque<Line>()
    private var next = 1L

    @Synchronized
    fun add(tag: String, text: String) {
        Log.i("FluxMusic", "$tag $text")
        lines.addLast(Line(next++, System.currentTimeMillis(), tag, text))
        while (lines.size > 200) lines.removeFirst()
    }

    @Synchronized
    fun since(id: Long): List<Line> = lines.filter { it.id > id }

    @Synchronized
    fun clear() = lines.clear()
}
