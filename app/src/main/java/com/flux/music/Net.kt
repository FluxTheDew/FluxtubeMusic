package com.flux.music

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Ortak HTTP istemcisi ve "internet var mı?" soruları. */
object Net {
    const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"

    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** YouTube akış adresleri bu başlıklarla daha az 403 veriyor. */
    val streamHeaders = mapOf(
        "Origin" to "https://www.youtube.com",
        "Referer" to "https://www.youtube.com/",
    )

    private fun caps(ctx: Context): NetworkCapabilities? {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return null
        return cm.getNetworkCapabilities(cm.activeNetwork ?: return null)
    }

    fun online(ctx: Context): Boolean =
        caps(ctx)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true

    /** Wi-Fi ya da kotasız ağ. */
    fun unmetered(ctx: Context): Boolean =
        caps(ctx)?.let {
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                (it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                    it.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
                    it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
        } == true
}
