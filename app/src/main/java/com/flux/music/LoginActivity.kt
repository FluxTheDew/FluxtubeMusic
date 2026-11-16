package com.flux.music

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import kotlin.concurrent.thread

/**
 * Google'ın kendi giriş sayfası. Şifreyi Google alır; biz sadece giriş
 * bittikten sonra music.youtube.com çerezlerini okuyup saklıyoruz.
 */
class LoginActivity : Activity() {
    private lateinit var web: WebView
    private var done = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // Google, gömülü tarayıcı işaretini ("; wv") görünce girişi reddedebiliyor.
            settings.userAgentString = settings.userAgentString.replace("; wv", "")
            cm.setAcceptThirdPartyCookies(this, true)
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    if (done || !url.startsWith("https://music.youtube.com")) return
                    val c = cm.getCookie("https://music.youtube.com") ?: return
                    if (!c.contains("SAPISID=")) return
                    done = true
                    cm.flush()
                    YtAccount.save(c)
                    thread(isDaemon = true) { runCatching { YtAccount.fetchInfo() } }
                    setResult(RESULT_OK)
                    finish()
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
        web.loadUrl(
            "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&passive=true" +
                "&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F"
        )
    }

    @Deprecated("Activity API")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
