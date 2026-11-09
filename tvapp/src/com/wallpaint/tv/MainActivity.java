package com.wallpaint.tv;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * Black fullscreen "wall". Runs its own small web server (WallServer), so phones
 * on the same Wi-Fi open http://<tv-ip>:8765/ and draw; no computer needed.
 * OK on the remote shows / hides the address for new people.
 */
public class MainActivity extends Activity {
    static final int PORT = 8765;

    private WebView web;
    private TextView status;
    private WallServer server;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setFocusable(false);
        web.setWebViewClient(new WebViewClient());
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        status = new TextView(this);
        status.setTextColor(Color.parseColor("#888888"));
        status.setTextSize(22);
        status.setGravity(Gravity.CENTER);
        status.setBackgroundColor(Color.BLACK);
        status.setText("Запуск…");
        root.addView(status, new FrameLayout.LayoutParams(-1, -1));

        setContentView(root);
        hideSystemUi();
        startServer();
    }

    private void startServer() {
        server = new WallServer(this, PORT);
        new Thread(new Runnable() {
            @Override public void run() {
                Exception err = null;
                for (int i = 0; i < 10; i++) {
                    try { server.start(); err = null; break; }
                    catch (Exception e) { err = e; try { Thread.sleep(500); } catch (InterruptedException ignored) { } }
                }
                final Exception fe = err;
                ui.post(new Runnable() {
                    @Override public void run() {
                        if (fe != null) {
                            status.setText("Не удалось запустить сервер на порту " + PORT + ":\n" + fe.getMessage());
                            return;
                        }
                        status.setVisibility(View.GONE);
                        web.loadUrl("http://127.0.0.1:" + PORT + "/tv");
                    }
                });
            }
        }, "wp-start").start();
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_MENU) {
            web.evaluateJavascript("window.WPtoggleHint && WPtoggleHint()", null);
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (server != null) server.stop();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
