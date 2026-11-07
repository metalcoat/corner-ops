package com.cornerdeli.display;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Corner Deli's TV display: one full-screen web page (a menu board or the greeter) and nothing else.
 * The page address is set once from the store server and remembered:
 *   adb shell am start -n com.cornerdeli.display/.MainActivity -d http://192.168.1.237:3000/pos/menu-board?tv=1
 * Sound plays without a tap, the screen stays on, it opens when the TV starts, and if the page
 * can't load (server or Wi-Fi down) it tries again every 15 seconds. No microphone or camera access.
 * The greeter's music plays from YouTube behind the page (MusicPlayer). Pair it with the store's
 * YouTube account once:  adb shell am start -n com.cornerdeli.display/.MainActivity --ez music_setup true
 * (sign in on YouTube's screen with the remote), then the same with --ez music_setup false.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "display";
    private static final String KEY_URL = "url";
    private static final long RETRY_MS = 15_000;

    /** True while the display is on screen (KeeperService brings it back when it isn't). */
    static volatile boolean visible = false;
    private WebView web;
    private MusicPlayer music;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable retry = () -> { if (web != null) web.loadUrl(savedUrl()); };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        // Lets the store server inspect the pages over adb (chrome://inspect) when something misbehaves.
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    view.loadData("<html><body style='background:#000'></body></html>", "text/html", "utf-8");
                    handler.removeCallbacks(retry);
                    handler.postDelayed(retry, RETRY_MS);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false; // stay in this app for everything the page opens
            }
        });
        music = new MusicPlayer(this);
        web.addJavascriptInterface(music.new Bridge(), "CornerDeliTv");
        FrameLayout root = new FrameLayout(this);
        root.addView(music.view, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        hideSystemBars();
        takeUrl(getIntent());
        takeSetup(getIntent());
        takeKeep(getIntent());
        startForegroundService(new Intent(this, KeeperService.class));
        web.loadUrl(savedUrl());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (takeUrl(intent)) web.loadUrl(savedUrl());
        takeSetup(intent);
        takeKeep(intent);
    }

    /** --ez music_setup true shows YouTube for pairing; false hides it and brings the page back. */
    private void takeSetup(Intent intent) {
        if (intent == null || !intent.hasExtra("music_setup")) return;
        boolean show = intent.getBooleanExtra("music_setup", false);
        settingUp = show;
        music.setup(show);
        if (!show) { web.bringToFront(); web.requestFocus(); }
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemBars();
        web.onResume();
    }

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;
    }

    @Override
    protected void onStop() {
        visible = false;
        if (!settingUp) KeeperService.displayLeft(this);
        super.onStop();
    }

    /** --ez keep false lets the TV be used normally for maintenance; --ez keep true turns keeping back on. */
    private void takeKeep(Intent intent) {
        if (intent == null || !intent.hasExtra("keep")) return;
        getSharedPreferences(KeeperService.PREFS, MODE_PRIVATE).edit().putBoolean(KeeperService.KEY_KEEP, intent.getBooleanExtra("keep", true)).apply();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(retry);
        music.destroy();
        web.destroy();
        super.onDestroy();
    }

    private boolean settingUp = false;

    /** Back does nothing (except inside YouTube while pairing), so a stray press can't leave the menu. */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && !settingUp) return true;
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (settingUp && music.view.canGoBack()) music.view.goBack();
    }

    private boolean takeUrl(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null) return false;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, data.toString()).apply();
        return true;
    }

    private String savedUrl() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        return prefs.getString(KEY_URL, "http://192.168.1.237:3000/pos/menu-board?tv=1");
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
}
