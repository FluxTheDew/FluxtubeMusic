package com.flux.music

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdaterTest {
    @Test
    fun versions() {
        assertTrue(Updater.newer("v0.1.12", "0.1.9"))
        assertTrue(Updater.newer("v0.2.0", "0.1.99"))
        assertFalse(Updater.newer("v0.1.5", "0.1.5"))
        assertFalse(Updater.newer("v0.1.4", "0.1.5"))
    }

    @Test
    fun videoIds() {
        val re = Regex("(?:v=|youtu\\.be/|shorts/|embed/)([\\w-]{11})")
        assertTrue(re.find("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD")?.groupValues?.get(1) == "dQw4w9WgXcQ")
        assertTrue(re.find("https://youtu.be/dQw4w9WgXcQ")?.groupValues?.get(1) == "dQw4w9WgXcQ")
    }
}
