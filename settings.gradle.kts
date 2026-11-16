pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // NewPipeExtractor (YouTube / YouTube Music arama ve akış adresleri)
        maven("https://jitpack.io")
    }
}

rootProject.name = "FluxTube-Music"
include(":app")
