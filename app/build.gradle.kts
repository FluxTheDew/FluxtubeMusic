plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.flux.music"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.flux.music"
        minSdk = 26
        targetSdk = 35
        // CI her derlemede numarayı artırıyor: yeni APK eskinin üstüne kurulur.
        val build = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionCode = build
        versionName = "0.1.$build"
    }

    signingConfigs {
        // Her sürüm AYNI anahtarla imzalanmalı, yoksa Android güncellemeyi
        // eskisinin üstüne kurmaz. Anahtar depoda değil: GitHub'daki
        // FLUX_KEYSTORE_B64 sırrından geliyor (CI onu FLUX_KEYSTORE'a yazar).
        create("fixed") {
            val ks = System.getenv("FLUX_KEYSTORE")?.let { file(it) }?.takeIf { it.exists() }
            if (ks != null) {
                storeFile = ks
                storeType = "pkcs12"
                storePassword = System.getenv("FLUX_KEYSTORE_PASSWORD") ?: "fluxtube"
                keyAlias = System.getenv("FLUX_KEY_ALIAS") ?: "fluxtube"
                keyPassword = System.getenv("FLUX_KEY_PASSWORD") ?: "fluxtube"
            }
        }
    }

    buildTypes {
        release {
            // NewPipeExtractor/Rhino yansıma kullanıyor; küçültme onları bozuyor.
            isMinifyEnabled = false
            // Sır yoksa (yerel derleme) debug anahtarı: kurulur ama güncelleme olarak değil.
            val fixed = signingConfigs.getByName("fixed")
            signingConfig = if (fixed.storeFile != null) fixed else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        // NewPipeExtractor minSdk < 33'te java.nio desugaring istiyor.
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources {
            excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/*.kotlin_module")
        }
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs_nio:2.1.4")

    implementation("com.github.teamnewpipe:NewPipeExtractor:v0.27.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-session:1.5.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.5.1")

    testImplementation("junit:junit:4.13.2")
}
