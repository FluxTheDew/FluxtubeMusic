package com.flux.music

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        Library.init(this)
        Downloads.init(this)
        YtAccount.init(this)
        Yt.init()
    }
}
