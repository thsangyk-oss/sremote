package com.sremote.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.DownloadListener;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/** Full-screen S-remote UI: a hardened WebView onto http://host:2209 */
public class HostActivity extends Activity {
    public static final String EXTRA_HOST_ID = "host_id";
    public static final String EXTRA_NAME = "name";
    public static final String EXTRA_URL = "url";

    private static final int REQ_FILE = 77;

    private WebView web;
    private View errView, root, statusDot;
    private TextView errDetail, titleView, statusView;
    private String url, name, hostId;
    private ValueCallback<Uri[]> fileCb;
    private Uri cameraUri;
    private int lastKb = 0;
    private Ui ui;
    private final Runnable onState = this::renderStatus;

    private int dp(float v) { return ui.dp(v); }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        url = getIntent().getStringExtra(EXTRA_URL);
        name = getIntent().getStringExtra(EXTRA_NAME);
        hostId = getIntent().getStringExtra(EXTRA_HOST_ID);
        if (url == null) { finish(); return; }
        ui = new Ui(this);
        ui.applyWindow(this, ui.container);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(ui.surface);

        // slim toolbar: back · name + live status · reload
        LinearLayout bar = ui.hrow();
        bar.setPadding(dp(2), 0, dp(2), 0);
        bar.setMinimumHeight(dp(52));
        bar.setBackgroundColor(ui.container);
        ImageView back = ui.iconButton(R.drawable.ic_back, ui.onSurface);
        back.setContentDescription("Back");
        back.setOnClickListener(v -> finish());
        bar.addView(back);

        LinearLayout tc = ui.vcol();
        titleView = ui.oneLine(ui.text(name, 16, ui.onSurface, true));
        LinearLayout st = ui.hrow();
        statusDot = ui.dot(ui.outline, 7);
        st.addView(statusDot);
        statusView = ui.oneLine(ui.text("", 12, ui.onSurfaceVariant, false));
        statusView.setPadding(dp(6), 0, 0, 0);
        st.addView(statusView);
        tc.addView(titleView); tc.addView(st);
        LinearLayout.LayoutParams tlp = Ui.weight1();
        tlp.setMargins(dp(4), 0, 0, 0);
        bar.addView(tc, tlp);

        ImageView reload = ui.iconButton(R.drawable.ic_refresh, ui.onSurfaceVariant);
        reload.setContentDescription("Reload");
        reload.setOnClickListener(v -> { errView.setVisibility(View.GONE); web.reload(); });
        bar.addView(reload);
        root.addView(bar);

        // content: webview + error overlay
        FrameLayout fl = new FrameLayout(this);
        web = new WebView(this);
        fl.addView(web);

        LinearLayout err = ui.vcol();
        err.setGravity(Gravity.CENTER);
        err.setPadding(dp(32), 0, dp(32), 0);
        err.setBackgroundColor(ui.surface);
        ImageView eic = ui.icon(R.drawable.ic_shield, ui.err, 48);
        err.addView(eic);
        TextView eh = ui.text("Can't reach host", 22, ui.onSurface, false);
        eh.setGravity(Gravity.CENTER);
        eh.setPadding(0, dp(16), 0, 0);
        errDetail = ui.text("", 14, ui.onSurfaceVariant, false);
        errDetail.setGravity(Gravity.CENTER);
        errDetail.setPadding(0, dp(8), 0, dp(4));
        TextView hint = ui.text("Check that Tailscale is connected and the S-remote server is running.",
                13, ui.onSurfaceVariant, false);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, 0, 0, dp(20));
        TextView retry = ui.filledButton("Retry");
        retry.setOnClickListener(v -> { errView.setVisibility(View.GONE); web.loadUrl(url); });
        TextView ts = ui.textButton("Open Tailscale");
        ts.setOnClickListener(v -> { if (!Tailscale.openApp(this)) Tailscale.openPlayStore(this); });
        err.addView(eh); err.addView(errDetail); err.addView(hint); err.addView(retry);
        err.addView(ts, ui.margins(0, 8, 0, 0));
        errView = err;
        errView.setVisibility(View.GONE);
        fl.addView(errView);
        root.addView(fl, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
        this.root = root;

        // soft keyboard: slide the whole frame up by the IME height — a translate,
        // so the WebView (and the terminal) never resizes/repaints. IME insets are
        // dispatched to the window on API 30+ even under adjustNothing; on older
        // APIs fall back to the visible-display-frame trick.
        final View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            decor.setOnApplyWindowInsetsListener((v, ins) -> {
                int kb = ins.isVisible(android.view.WindowInsets.Type.ime())
                        ? ins.getInsets(android.view.WindowInsets.Type.ime()).bottom : 0;
                setKbShift(kb);
                return v.onApplyWindowInsets(ins);
            });
        } else {
            root.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
                android.graphics.Rect r = new android.graphics.Rect();
                decor.getWindowVisibleDisplayFrame(r);
                int gap = decor.getHeight() - r.bottom; // IME (+nav) stealing the bottom
                setKbShift(gap > dp(160) ? gap : 0);    // nav bar alone is < ~60dp
            });
        }

        setupWeb();
        web.loadUrl(url);
    }

    private void setKbShift(int kb) {
        if (kb == lastKb) return;
        lastKb = kb;
        root.setTranslationY(-kb);
        // tell the page the native layer owns the shift, so its own keyboard
        // handling doesn't translate the body a second time
        if (web != null) web.evaluateJavascript("window.__nativeKb=" + kb, null);
    }

    private void setupWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setBuiltInZoomControls(false);
        // let the web UI know it's inside the app: the native layer slides the
        // frame up for the keyboard — the page must not translate itself too
        s.setUserAgentString(s.getUserAgentString() + " SRemoteApp");
        WebView.setWebContentsDebuggingEnabled(false);

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String target = u.toString();
                // S-remote download links — grab them before the WebView navigates
                if (target.startsWith(url) && target.contains("dl=1")) {
                    startDownload(target, null, null);
                    return true;
                }
                if (target.startsWith(url) || u.getHost() == null
                        || target.startsWith(u.getScheme() + "://" + u.getHost() + ":" + u.getPort())) {
                    return false; // keep S-remote UI inside
                }
                if ("http".equals(u.getScheme()) || "https".equals(u.getScheme())
                        || "market".equals(u.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) {}
                }
                return true;
            }

            @Override public void onReceivedError(WebView v, WebResourceRequest r,
                                                android.webkit.WebResourceError e) {
                if (r.isForMainFrame()) {
                    errDetail.setText(e != null ? String.valueOf(e.getDescription()) : "offline");
                    errView.setVisibility(View.VISIBLE);
                }
            }

            @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap f) {
                errView.setVisibility(View.GONE);
            }

            @Override public void onPageFinished(WebView v, String u) {
                if (lastKb > 0) v.evaluateJavascript("window.__nativeKb=" + lastKb, null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb,
                                                       FileChooserParams p) {
                if (fileCb != null) { fileCb.onReceiveValue(null); fileCb = null; }
                fileCb = cb;
                openPicker(p);
                return true;
            }
        });

        web.setDownloadListener(downloadListener);
    }

    // ---------- file picker (+ camera capture for "Take photo") ----------
    private void openPicker(WebChromeClient.FileChooserParams p) {
        List<Intent> extra = new ArrayList<>();
        boolean wantsCapture = p.isCaptureEnabled();
        String[] accepts = p.getAcceptTypes();
        boolean acceptsImage = accepts.length == 0
                || String.join(" ", accepts).contains("image");
        if ((wantsCapture || acceptsImage)
                && getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            if (cam.resolveActivity(getPackageManager()) != null) {
                File dir = new File(getCacheDir(), "cam");
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File f = new File(dir, "shot-" + System.currentTimeMillis() + ".jpg");
                cameraUri = MiniFileProvider.uri(this, f);
                cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                for (ResolveInfo ri : getPackageManager()
                        .queryIntentActivities(cam, PackageManager.MATCH_ALL)) {
                    grantUriPermission(ri.activityInfo.packageName, cameraUri,
                            Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                }
                extra.add(cam);
            }
        }

        Intent content;
        try { content = p.createIntent(); }
        catch (Exception e) {
            content = new Intent(Intent.ACTION_GET_CONTENT)
                    .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        }
        Intent chooser = Intent.createChooser(content, "Attach file");
        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extra.toArray(new Intent[0]));
        try { startActivityForResult(chooser, REQ_FILE); }
        catch (ActivityNotFoundException e) {
            fileCb.onReceiveValue(null); fileCb = null;
            Toast.makeText(this, "No file picker", Toast.LENGTH_SHORT).show();
        }
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_FILE) { super.onActivityResult(req, res, data); return; }
        if (fileCb == null) return;
        Uri[] out = null;
        if (res == RESULT_OK) {
            if (data == null || (data.getData() == null && data.getClipData() == null)) {
                if (cameraUri != null) out = new Uri[]{cameraUri}; // camera wrote to provider uri
            } else if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                out = new Uri[n];
                for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
            } else {
                out = new Uri[]{data.getData()};
            }
        }
        fileCb.onReceiveValue(out);
        fileCb = null;
        cameraUri = null;
    }

    // ---------- downloads → Downloads/ ----------
    /** real filename: S-remote passes it in ?path= (basename) or Content-Disposition */
    private static String fileNameFor(String u, String cd, String mime) {
        try {
            Uri uri = Uri.parse(u);
            for (String key : new String[]{"path", "name", "file", "filename"}) {
                String v = uri.getQueryParameter(key);
                if (v != null && !v.isEmpty()) {
                    int s = Math.max(v.lastIndexOf('/'), v.lastIndexOf('\\'));
                    String n = v.substring(s + 1).trim();
                    if (!n.isEmpty()) return n;
                }
            }
        } catch (Exception ignored) {}
        if (cd != null) {
            for (String part : cd.split(";")) {
                part = part.trim();
                if (part.regionMatches(true, 0, "filename*=", 0, 10)) {
                    String v = part.substring(10);
                    int q = v.lastIndexOf('\'');
                    if (q >= 0 && q + 1 < v.length()) v = v.substring(q + 1);
                    try { v = Uri.decode(v); } catch (Exception ignored) {}
                    if (!v.isEmpty()) return v;
                }
            }
            for (String part : cd.split(";")) {
                part = part.trim();
                if (part.regionMatches(true, 0, "filename=", 0, 9)) {
                    String v = part.substring(9).replaceAll("^\"|\"$", "").trim();
                    if (!v.isEmpty()) return v;
                }
            }
        }
        String g = URLUtil.guessFileName(u, cd, mime);
        return g == null || g.isEmpty() ? "download.bin" : g;
    }

    private void startDownload(String u, String cd, String mime) {
        try {
            String fn = fileNameFor(u, cd, mime);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(u));
            r.setTitle(fn);
            r.setDescription("S-remote");
            r.setMimeType(mime != null ? mime
                    : MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                            MimeTypeMap.getFileExtensionFromUrl(u)));
            r.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fn);
            getSystemService(DownloadManager.class).enqueue(r);
            Toast.makeText(this, "Downloading " + fn, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private final DownloadListener downloadListener =
            (u, ua, cd, mime, len) -> startDownload(u, cd, mime);

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        String u = i.getStringExtra(EXTRA_URL);
        if (u != null && !u.equals(url)) {
            url = u; name = i.getStringExtra(EXTRA_NAME);
            hostId = i.getStringExtra(EXTRA_HOST_ID);
            StateBus.foregroundHost = hostId;
            titleView.setText(name);
            renderStatus();
            errView.setVisibility(View.GONE);
            web.loadUrl(url);
        }
    }

    // ---------- lifecycle: app lock, notification suppression, live status ----------
    @Override protected void onStart() { super.onStart(); LockGate.onStart(); }
    @Override protected void onStop() { LockGate.onStop(); super.onStop(); }

    @Override protected void onResume() {
        super.onResume();
        LockGate.check(this);
        StateBus.foregroundHost = hostId;
        StateBus.listen(onState);
        renderStatus();
        // the user is looking at this host now — clear its pending alerts
        if (hostId != null) for (StateBus.Sess s : StateBus.sessions(hostId)) {
            Host h = new Host(hostId, name, url, true);
            Notify.cancel(this, h, "q:" + s.id);
            Notify.cancel(this, h, "d:" + s.id);
        }
    }

    @Override protected void onPause() {
        if (hostId != null && hostId.equals(StateBus.foregroundHost)) StateBus.foregroundHost = null;
        StateBus.unlisten(onState);
        super.onPause();
    }

    /** toolbar subtitle: connection + session states from the monitor, else the address */
    private void renderStatus() {
        String addr = url.replaceFirst("^[a-z]+://", "");
        Boolean up = hostId == null ? null : StateBus.isConnected(hostId);
        int run = 0, ask = 0, n = 0;
        if (hostId != null) for (StateBus.Sess s : StateBus.sessions(hostId)) {
            if (s.state == Detector.State.EXITED) continue;
            n++;
            if (s.state == Detector.State.RUNNING) run++;
            else if (s.state == Detector.State.QUESTION) ask++;
        }
        int dot;
        String txt;
        if (up == null) { dot = ui.outline; txt = addr; }
        else if (!up) { dot = ui.err; txt = "Reconnecting · " + addr; }
        else {
            dot = ask > 0 ? ui.warn : run > 0 ? ui.primary : ui.ok;
            StringBuilder b = new StringBuilder();
            if (ask > 0) b.append(ask).append(" need").append(ask == 1 ? "s" : "").append(" input");
            if (run > 0) b.append(b.length() > 0 ? " · " : "").append(run).append(" running");
            if (b.length() == 0) b.append(n == 0 ? "Connected" : n + " session" + (n > 1 ? "s" : "") + " idle");
            txt = b.toString();
        }
        statusDot.setBackground(ui.oval(dot));
        statusView.setText(txt);
    }

    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
