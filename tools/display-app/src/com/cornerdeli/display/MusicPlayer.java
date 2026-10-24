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
    /**
     * Each new song starts at full volume, and YouTube sets the volume itself when a song starts. Setting it
     * back from a media event still let about half a second through at full volume, so the page's volume
     * control is replaced: whatever YouTube asks for, the video plays at the store's level, and a video is
     * turned down before it starts. Runs when each page starts loading and again every 3 seconds.
     */
    private static final String VOLUME_JS = "(function(vol){window.__cdVolume=vol;"
        + "var P=HTMLMediaElement.prototype;if(!window.__cdVolumeHook){window.__cdVolumeHook=true;"
        + "var d=Object.getOwnPropertyDescriptor(P,'volume');window.__cdSet=d.set;"
        + "Object.defineProperty(P,'volume',{configurable:true,get:function(){return this.__cdAsked===undefined?1:this.__cdAsked;},"
        + "set:function(x){this.__cdAsked=x;d.set.call(this,window.__cdVolume);}});"
        + "var play=P.play;P.play=function(){d.set.call(this,window.__cdVolume);return play.apply(this,arguments);};"
        + "['loadstart','loadedmetadata','play','playing'].forEach(function(n){"
        + "document.addEventListener(n,function(e){var v=e.target;if(v instanceof HTMLMediaElement)d.set.call(v,window.__cdVolume);},true);});}"
        + "document.querySelectorAll('video,audio').forEach(function(v){window.__cdSet.call(v,vol);});})(%s)";
    /**
     * After a restart YouTube asks "who's watching": pick the first (the store's) account, and if YouTube
     * lands on its home screen instead of the playlist, go back to the playlist.
     */
    private static final String RESUME_JS = "(function(list){var t=document.body?document.body.innerText:'';"
        + "if(t.indexOf('Watch as guest')>=0&&t.indexOf('@')>=0){var e={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true};"
        + "document.dispatchEvent(new KeyboardEvent('keydown',e));document.dispatchEvent(new KeyboardEvent('keyup',e));return;}"
        + "if(list&&location.hash.indexOf('watch')<0&&t.indexOf('Watch as guest')<0){location.hash='#/watch?list='+list;}})('%s')";

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
        view.setWebViewClient(new WebViewClient() {
            // Turn the volume down before YouTube's own scripts start a song.
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                v.evaluateJavascript(String.format(VOLUME_JS, volume), null);
            }
            @Override public void onPageCommitVisible(WebView v, String url) {
                v.evaluateJavascript(String.format(VOLUME_JS, volume), null);
            }
        });
        view.setVisibility(View.INVISIBLE);
        // Keep the volume where the store wants it and the music in the state the page asked for.
        handler.postDelayed(new Runnable() {
            @Override public void run() {
                if (!playlist.isEmpty() && view.getVisibility() != View.VISIBLE) { // hands off while pairing
                    view.evaluateJavascript(String.format(RESUME_JS, playlist), null);
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
        view.evaluateJavascript(String.format(VOLUME_JS, volume), null);
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
