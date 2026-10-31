import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signing comes from outside the repo (build.sh passes the path); never commit the keystore.
val signing = Properties().apply {
    val file = System.getenv("CAR_TABLET_SIGNING")?.let { File(it) }
    if (file != null && file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.cornerdeli.cartablet"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.cornerdeli.cartablet"
        minSdk = 29
        targetSdk = 36
        versionCode = 6
        versionName = "1.1.1"
        buildConfigField("String", "DEFAULT_SERVER", "\"https://dev.ordercornerdeli.com\"")
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
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        // Sideloaded kiosk app: no Play Store target-API checks.
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.lifecycle:lifecycle-service:2.9.2")
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
}
