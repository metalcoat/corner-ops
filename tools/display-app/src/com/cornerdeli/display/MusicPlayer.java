package com.cornerdeli.display;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Background music from YouTube's TV site, signed in to the store's own YouTube account (paired once
 * with a code at youtube.com/activate), so YouTube Premium applies and no ads play. It sits behind
 * the page; the page drives it through window.CornerDeliTv (playMusic / pauseMusic / resumeMusic).
 * Setup mode brings it to the front so the remote can reach YouTube's "Sign in" screen.
 */
final class MusicPlayer {
    /** YouTube only serves its TV site to TVs, so it identifies as the Fire TV YouTube app (Cobalt). */
    private static final String TV_AGENT = "Mozilla/5.0 (Linux; Android 11; AFTOLCBC82) AppleWebKit/537.36 (KHTML, like Gecko) "
        + "Cobalt/25.lts.30.1034943-gold (unlike Gecko) v8/8.8.278.17-jit gles Starboard/15, "
        + "Amazon_ATV_mediatek8695_2025/RS8133 (Amazon, AFTOLCBC82, Wireless) com.amazon.firetv.youtube/25.30.00";
    private static final String VOLUME_JS = "(function(){var v=document.querySelector('video');if(v){v.volume=%s;}})()";

    final WebView view;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String playlist = "";
    private double volume = 0.35;
    private boolean paused = false;

    @SuppressLint("SetJavaScriptEnabled")
    MusicPlayer(Context context) {
        view = new WebView(context);
        view.setBackgroundColor(Color.BLACK);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(TV_AGENT);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        view.setWebViewClient(new WebViewClient());
        view.setVisibility(View.INVISIBLE);
        // Keep the volume where the store wants it and the music in the state the page asked for.
        handler.postDelayed(new Runnable() {
            @Override public void run() {
                if (!playlist.isEmpty() && view.getVisibility() != View.VISIBLE) { // hands off while pairing
                    view.evaluateJavascript(String.format(VOLUME_JS, volume), null);
                    view.evaluateJavascript(paused
                        ? "(function(){var v=document.querySelector('video');if(v&&!v.paused)v.pause();})()"
                        : "(function(){var v=document.querySelector('video');if(v&&v.paused&&v.readyState>2)v.play();})()", null);
                }
                handler.postDelayed(this, 3_000);
            }
        }, 3_000);
    }

    void play(String list, double vol) {
        volume = Math.max(0, Math.min(1, vol));
        paused = false;
        if (list == null || list.isEmpty() || list.equals(playlist)) return;
        playlist = list;
        view.loadUrl("https://www.youtube.com/tv#/watch?list=" + list);
    }

    void pause() {
        paused = true;
        view.evaluateJavascript("(function(){var v=document.querySelector('video');if(v)v.pause();})()", null);
    }

    void resume() {
        paused = false;
        view.evaluateJavascript("(function(){var v=document.querySelector('video');if(v)v.play();})()", null);
    }

    /** Setup: show YouTube full screen so the remote can sign in; done: hide it again. */
    void setup(boolean show) {
        if (show && view.getUrl() == null) view.loadUrl("https://www.youtube.com/tv");
        view.setVisibility(show ? View.VISIBLE : View.INVISIBLE);
        if (show) { view.bringToFront(); view.requestFocus(); }
        else {
            CookieManager.getInstance().flush();
            if (!playlist.isEmpty()) view.loadUrl("https://www.youtube.com/tv#/watch?list=" + playlist); // back to the music, now signed in
        }
    }

    void destroy() {
        handler.removeCallbacksAndMessages(null);
        view.destroy();
    }

    /** What the page can call as window.CornerDeliTv. */
    final class Bridge {
        @JavascriptInterface public void playMusic(String list, double vol) { handler.post(() -> play(list, vol)); }
        @JavascriptInterface public void pauseMusic() { handler.post(MusicPlayer.this::pause); }
        @JavascriptInterface public void resumeMusic() { handler.post(MusicPlayer.this::resume); }
    }
}
