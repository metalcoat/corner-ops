import java.util.Properties

plugins {
    id("com.android.application")
}

// Signing comes from outside the repo (build.sh passes the path); never commit the keystore.
val signing = Properties().apply {
    val file = System.getenv("TEAM_APP_SIGNING")?.let { File(it) }
    if (file != null && file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.cornerdeli.team"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.cornerdeli.team"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (signing.getProperty("storeFile") != null) {
            create("release") {
                storeFile = File(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint {
        // Sideloaded app: no Play Store target-API checks.
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.6.2")
}
