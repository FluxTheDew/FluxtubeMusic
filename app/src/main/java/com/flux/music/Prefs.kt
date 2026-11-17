package com.flux.music

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/** Kullanıcı ayarları. Anahtarlar arayüzdeki data-key'lerle aynı. */
object Prefs {
    private lateinit var sp: SharedPreferences

    private val defaults = mapOf(
        "quality" to "high",      // high | low
        "autoDl" to "off",        // off | wifi | always — sıraya/listeye eklenenleri indir
        "tap" to "now",           // now | next | end — şarkıya dokununca
        "skipOffline" to "true",  // internet yokken indirilmemişleri atla
        "dlWifiOnly" to "false",  // elle indirmeleri de sadece Wi-Fi'de yap
        "radio" to "false",       // sıra bitmeden benzer şarkılar ekle
    )

    fun init(ctx: Context) {
        sp = ctx.getSharedPreferences("prefs", Context.MODE_PRIVATE)
    }

    fun get(key: String): String = sp.getString(key, null) ?: defaults[key] ?: ""
    fun set(key: String, value: String) {
        if (key in defaults) sp.edit().putString(key, value).apply()
    }

    val high get() = get("quality") != "low"
    val skipOffline get() = get("skipOffline") == "true"

    // Dikkat: apply{} içinde get() JSONObject.get'e gider (boşken hata atar). Açıkça Prefs.get.
    fun json(): JSONObject {
        val o = JSONObject()
        for (k in defaults.keys) o.put(k, this.get(k))
        return o
    }
}
