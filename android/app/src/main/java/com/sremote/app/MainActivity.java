package com.sremote.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.StatusBarManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public class MainActivity extends Activity {
    static final String ACTION_OPEN_HOST = "com.sremote.app.OPEN_HOST";
    private static final int REQ_NOTIF = 42;
    private static final long RESCAN_MS = 30_000, POLL_MS = 10_000;
    private static final int TAB_HOSTS = 0, TAB_ACTIVITY = 1, TAB_SETTINGS = 2;

    private HostStore store;
    private Ui ui;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS).build();

    private final List<Host> hosts = new ArrayList<>();
    private final List<JSONObject> machines = new ArrayList<>();
    private final Map<String, HStat> stats = new HashMap<>();
    private long lastScan = 0;
    private boolean scanning = false, resumed = false;
    private int tab = TAB_HOSTS;
    private String activityFilter = "all";

    // views
    private FrameLayout content;
    private View fab;
    private final View[] pages = new View[3];
    private final LinearLayout[] navItems = new LinearLayout[3];
    private LinearLayout hostList, machineList, banners, activityList, activityChips, settingsBody;
    private TextView machinesStatus;

    /** polled liveness per host */
    private static final class HStat { boolean online; long ms; int live = -1, total = -1; }

    private final Runnable onBus = () -> { if (tab == TAB_HOSTS) renderHosts(); else if (tab == TAB_ACTIVITY) renderActivity(); };
    private final Runnable poller = new Runnable() {
        @Override public void run() {
            if (!resumed) return;
            pollHosts();
            main.postDelayed(this, POLL_MS);
        }
    };

    private int dp(float v) { return ui.dp(v); }
    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }

    // ---------------- lifecycle ----------------
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        store = new HostStore(this);
        ui = new Ui(this);
        ui.applyWindow(this, ui.surface);
        buildShell();
        reload();
        selectTab(TAB_HOSTS);
        handleIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        handleIntent(i);
    }

    /** launcher shortcut → open that host directly */
    private void handleIntent(Intent i) {
        if (i == null || !ACTION_OPEN_HOST.equals(i.getAction())) return;
        Host h = store.find(i.getStringExtra(HostActivity.EXTRA_HOST_ID));
        if (h != null) launch(h);
    }

    @Override protected void onStart() { super.onStart(); LockGate.onStart(); }
    @Override protected void onStop() { LockGate.onStop(); super.onStop(); }

    @Override protected void onResume() {
        super.onResume();
        LockGate.check(this);
        resumed = true;
        reload();
        if (store.monitorEnabled()) { ensureNotifPermission(); MonitorService.start(this); }
        StateBus.listen(onBus);
        main.removeCallbacks(poller);
        main.post(poller);
        if (tab == TAB_HOSTS) refreshBanners();
        if (tab == TAB_SETTINGS) buildSettings();
        if (tab == TAB_ACTIVITY) renderActivity();
    }

    @Override protected void onPause() {
        resumed = false;
        StateBus.unlisten(onBus);
        main.removeCallbacks(poller);
        super.onPause();
    }

    @Override protected void onDestroy() {
        pool.shutdownNow();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (tab != TAB_HOSTS) selectTab(TAB_HOSTS);
        else super.onBackPressed();
    }

    // ---------------- shell: pages + bottom navigation + FAB ----------------
    private void buildShell() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(ui.surface);

        LinearLayout col = ui.vcol();
        content = new FrameLayout(this);
        col.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        LinearLayout nav = ui.hrow();
        nav.setBackgroundColor(ui.container);
        nav.setPadding(0, dp(10), 0, dp(14));
        String[] labels = {"Hosts", "Activity", "Settings"};
        int[] icons = {R.drawable.ic_hosts, R.drawable.ic_bell, R.drawable.ic_tune};
        for (int i = 0; i < 3; i++) {
            final int idx = i;
            LinearLayout it = ui.vcol();
            it.setGravity(Gravity.CENTER_HORIZONTAL);
            FrameLayout pill = new FrameLayout(this);
            ImageView ic = ui.icon(icons[i], ui.onSurfaceVariant, 24);
            FrameLayout.LayoutParams ilp = new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER);
            pill.addView(ic, ilp);
            it.addView(pill, new LinearLayout.LayoutParams(dp(64), dp(32)));
            TextView lb = ui.text(labels[i], 12, ui.onSurfaceVariant, true);
            lb.setPadding(0, dp(4), 0, 0);
            it.addView(lb);
            it.setOnClickListener(v -> selectTab(idx));
            nav.addView(it, Ui.weight1());
            navItems[i] = it;
        }
        col.addView(nav);
        root.addView(col);

        pages[TAB_HOSTS] = buildHostsPage();
        pages[TAB_ACTIVITY] = buildActivityPage();
        pages[TAB_SETTINGS] = buildSettingsPage();
        for (View p : pages) content.addView(p);

        // extended FAB: Add host
        LinearLayout f = ui.hrow();
        f.setPadding(dp(16), dp(14), dp(20), dp(14));
        f.setBackground(ui.ripple(ui.round(ui.primaryContainer, 16), 16));
        f.setElevation(dp(6));
        f.addView(ui.icon(R.drawable.ic_add, ui.onPrimaryContainer, 24));
        TextView fl = ui.text("Add host", 15, ui.onPrimaryContainer, true);
        fl.setPadding(dp(10), 0, 0, 0);
        f.addView(fl);
        f.setOnClickListener(v -> hostDialog(null));
        FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        flp.setMargins(0, 0, dp(16), dp(96));
        root.addView(f, flp);
        fab = f;

        setContentView(root);
    }

    private void selectTab(int t) {
        tab = t;
        for (int i = 0; i < 3; i++) {
            boolean on = i == t;
            pages[i].setVisibility(on ? View.VISIBLE : View.GONE);
            LinearLayout it = navItems[i];
            FrameLayout pill = (FrameLayout) it.getChildAt(0);
            ImageView ic = (ImageView) pill.getChildAt(0);
            TextView lb = (TextView) it.getChildAt(1);
            pill.setBackground(on ? ui.round(ui.secondaryContainer, 16) : null);
            ic.setImageTintList(android.content.res.ColorStateList.valueOf(on ? ui.onSecondaryContainer : ui.onSurfaceVariant));
            lb.setTextColor(on ? ui.onSurface : ui.onSurfaceVariant);
        }
        fab.setVisibility(t == TAB_HOSTS ? View.VISIBLE : View.GONE);
        if (t == TAB_HOSTS) { renderHosts(); refreshBanners(); }
        else if (t == TAB_ACTIVITY) renderActivity();
        else buildSettings();
    }

    private ScrollView page(LinearLayout body) {
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        body.setPadding(dp(16), dp(12), dp(16), dp(120));
        sv.addView(body);
        return sv;
    }

    private LinearLayout header(String title, View trailing) {
        LinearLayout h = ui.hrow();
        h.setPadding(dp(4), dp(16), 0, dp(4));
        h.addView(ui.title(title), Ui.weight1());
        if (trailing != null) h.addView(trailing);
        return h;
    }

    // ================= HOSTS =================
    private View buildHostsPage() {
        LinearLayout body = ui.vcol();
        ImageView refresh = ui.iconButton(R.drawable.ic_refresh, ui.onSurfaceVariant);
        refresh.setContentDescription("Refresh");
        refresh.setOnClickListener(v -> { pollHosts(); scanTailnet(); refreshBanners(); });
        body.addView(header("S-remote", refresh));
        TextView sub = ui.text("Your terminals, over your tailnet", 14, ui.onSurfaceVariant, false);
        sub.setPadding(dp(4), 0, 0, dp(8));
        body.addView(sub);

        banners = ui.vcol();
        body.addView(banners);

        body.addView(ui.label("Hosts"));
        hostList = ui.vcol();
        body.addView(hostList);

        LinearLayout ml = ui.hrow();
        TextView mlt = ui.label("On your tailnet");
        ml.addView(mlt, Ui.weight1());
        machinesStatus = ui.text("", 12, ui.onSurfaceVariant, false);
        machinesStatus.setPadding(0, dp(12), dp(4), 0);
        ml.addView(machinesStatus);
        body.addView(ml);
        machineList = ui.vcol();
        body.addView(machineList);
        return page(body);
    }

    /** Tailscale + monitoring banners */
    private void refreshBanners() {
        banners.removeAllViews();
        if (!Tailscale.installed(this)) {
            banners.addView(banner(R.drawable.ic_shield, ui.err, ui.errContainer, "Tailscale not installed",
                    "S-remote connects to your machines through your tailnet.", "Get Tailscale",
                    v -> Tailscale.openPlayStore(this)));
        } else if (Tailscale.tailnetIp(this) == null && !Tailscale.vpnUp(this)) {
            banners.addView(banner(R.drawable.ic_shield, ui.warn, ui.warnContainer, "Tailscale is off",
                    "Connect to your tailnet to reach your hosts.", "Open Tailscale",
                    v -> Tailscale.openApp(this)));
        } else {
            if (System.currentTimeMillis() - lastScan > RESCAN_MS) scanTailnet();
        }
        if (!store.monitorEnabled() && !hosts.isEmpty()) {
            banners.addView(banner(R.drawable.ic_bell, ui.onTertiaryContainer, ui.tertiaryContainer,
                    "Get alerted when work is done",
                    "Turn on monitoring to see live session states and get notified when a task finishes or needs your input.",
                    "Turn on", v -> { setMonitor(true); refreshBanners(); renderHosts(); }));
        }
    }

    private View banner(int icon, int fg, int bg, String title, String text, String action, View.OnClickListener l) {
        LinearLayout c = ui.card(bg);
        c.setBackground(ui.round(bg, 24));
        LinearLayout r = ui.hrow();
        r.setGravity(Gravity.TOP);
        r.addView(ui.icon(icon, fg, 24));
        LinearLayout tc = ui.vcol();
        tc.setPadding(dp(14), 0, 0, 0);
        tc.addView(ui.text(title, 16, ui.onSurface, true));
        TextView t = ui.text(text, 14, ui.onSurfaceVariant, false);
        t.setPadding(0, dp(4), 0, dp(10));
        tc.addView(t);
        TextView b = ui.filledButton(action);
        b.setOnClickListener(l);
        tc.addView(b, ui.margins(0, 0, 0, 0));
        r.addView(tc, Ui.weight1());
        c.addView(r);
        return c;
    }

    private void reload() {
        hosts.clear();
        hosts.addAll(store.list());
        renderHosts();
        updateShortcuts();
    }

    private void renderHosts() {
        if (hostList == null) return;
        hostList.removeAllViews();
        if (hosts.isEmpty()) {
            LinearLayout e = ui.card(ui.container);
            e.setBackground(ui.round(ui.container, 24));
            e.setGravity(Gravity.CENTER_HORIZONTAL);
            e.setPadding(dp(24), dp(28), dp(24), dp(28));
            e.addView(ui.icon(R.drawable.ic_hosts, ui.primary, 40));
            TextView t = ui.text("No hosts yet", 18, ui.onSurface, false);
            t.setPadding(0, dp(12), 0, dp(4));
            e.addView(t);
            TextView s = ui.text("Tap “Add host” and enter a machine's Tailscale IP, e.g. 100.64.1.2 — or pick one from your tailnet below.",
                    14, ui.onSurfaceVariant, false);
            s.setGravity(Gravity.CENTER);
            e.addView(s);
            hostList.addView(e);
        }
        for (Host h : hosts) hostList.addView(hostCard(h));
        renderMachines();
    }

    private View hostCard(Host h) {
        LinearLayout card = ui.card(ui.container);
        card.setOnClickListener(v -> openHost(h));
        card.setOnLongClickListener(v -> { hostMenu(h); return true; });

        HStat st = stats.get(h.id);
        Boolean wsUp = StateBus.isConnected(h.id);
        boolean online = st != null ? st.online : wsUp != null && wsUp;

        LinearLayout top = ui.hrow();
        top.addView(ui.avatar(h.name, ui.primaryContainer, ui.onPrimaryContainer));
        LinearLayout tc = ui.vcol();
        tc.setPadding(dp(14), 0, dp(8), 0);
        tc.addView(ui.oneLine(ui.text(h.name, 17, ui.onSurface, true)));
        tc.addView(ui.oneLine(ui.text(h.hostPort(), 13, ui.onSurfaceVariant, false)));
        top.addView(tc, Ui.weight1());
        if (st == null && wsUp == null) top.addView(ui.pill("Checking…", ui.onSurfaceVariant, ui.containerHigh));
        else if (online) top.addView(ui.pill(st != null && st.ms > 0 ? st.ms + " ms" : "Online", ui.ok, ui.okContainer));
        else top.addView(ui.pill("Offline", ui.err, ui.errContainer));
        card.addView(top);

        // session states: live from the monitor, else just counts from /api/sessions
        List<StateBus.Sess> ss = new ArrayList<>();
        for (StateBus.Sess s : StateBus.sessions(h.id)) if (s.state != Detector.State.EXITED) ss.add(s);
        ss.sort((a, b) -> rank(a.state) - rank(b.state));
        LinearLayout chips = ui.hrow();
        chips.setPadding(0, dp(12), 0, 0);
        if (!ss.isEmpty()) {
            int run = 0, ask = 0, done = 0, idle = 0;
            for (StateBus.Sess s : ss) switch (s.state) {
                case RUNNING: run++; break;
                case QUESTION: ask++; break;
                case DONE: done++; break;
                default: idle++;
            }
            if (ask > 0) chips.addView(ui.pill(ask + " needs input", ui.warn, ui.warnContainer), ui.margins(0, 0, 6, 0));
            if (run > 0) chips.addView(ui.pill(run + " running", ui.onPrimaryContainer, ui.primaryContainer), ui.margins(0, 0, 6, 0));
            if (done > 0) chips.addView(ui.pill(done + " done", ui.ok, ui.okContainer), ui.margins(0, 0, 6, 0));
            if (idle > 0) chips.addView(ui.pill(idle + " idle", ui.onSurfaceVariant, ui.containerHigh), ui.margins(0, 0, 6, 0));
        } else if (st != null && st.total >= 0) {
            chips.addView(ui.pill(st.live + " live session" + (st.live == 1 ? "" : "s"), ui.onSurfaceVariant, ui.containerHigh), ui.margins(0, 0, 6, 0));
        }
        if (!h.notify) chips.addView(ui.pill("Muted", ui.onSurfaceVariant, ui.containerHigh));
        if (chips.getChildCount() > 0) card.addView(chips);

        int shown = 0;
        for (StateBus.Sess s : ss) {
            if (shown++ >= 4) break;
            card.addView(sessionRow(h, s));
        }
        if (ss.size() > 4) {
            TextView more = ui.text("+" + (ss.size() - 4) + " more", 13, ui.onSurfaceVariant, false);
            more.setPadding(dp(18), dp(6), 0, 0);
            card.addView(more);
        }
        return card;
    }

    private static int rank(Detector.State s) {
        switch (s) {
            case QUESTION: return 0;
            case RUNNING: return 1;
            case DONE: return 2;
            default: return 3;
        }
    }

    private View sessionRow(Host h, StateBus.Sess s) {
        LinearLayout r = ui.hrow();
        r.setPadding(dp(10), dp(8), dp(10), dp(8));
        r.setBackground(ui.ripple(ui.round(ui.surface, 14), 14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, dp(8), 0, 0);
        r.setLayoutParams(lp);
        r.addView(ui.dot(ui.stateColor(s.state), 9));
        LinearLayout tc = ui.vcol();
        tc.setPadding(dp(12), 0, dp(6), 0);
        LinearLayout nl = ui.hrow();
        nl.addView(ui.oneLine(ui.text(s.name, 14, ui.onSurface, true)), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 0));
        TextView sl = ui.text("  ·  " + Ui.stateLabel(s.state) + " · " + Ui.ago(s.since), 12, ui.stateColor(s.state), false);
        nl.addView(ui.oneLine(sl));
        tc.addView(nl);
        String line = s.state == Detector.State.QUESTION && s.question != null
                ? s.question.replace('\n', ' ') : s.line;
        if (line != null && !line.isEmpty()) tc.addView(ui.mono(line, 12, ui.onSurfaceVariant));
        r.addView(tc, Ui.weight1());
        if (s.state == Detector.State.QUESTION) {
            TextView ans = ui.tonalButton("Answer");
            ans.setOnClickListener(v -> answerDialog(h, s));
            r.addView(ans);
            r.setOnClickListener(v -> answerDialog(h, s));
        } else {
            r.setOnClickListener(v -> openHost(h));
        }
        return r;
    }

    /** answer a waiting session without opening the terminal */
    private void answerDialog(Host h, StateBus.Sess s) {
        LinearLayout box = ui.vcol();
        box.setPadding(dp(24), dp(8), dp(24), 0);
        TextView q = ui.text(s.question != null ? s.question : s.line, 14, ui.onSurface, false);
        q.setTypeface(android.graphics.Typeface.MONOSPACE);
        q.setPadding(dp(12), dp(10), dp(12), dp(10));
        q.setBackground(ui.round(ui.containerHigh, 12));
        box.addView(q);
        AlertDialog[] ref = new AlertDialog[1];
        List<Detector.Answer> answers = Detector.answersFor(s.question);
        if (!answers.isEmpty()) {
            LinearLayout row = ui.hrow();
            row.setPadding(0, dp(12), 0, 0);
            for (Detector.Answer a : answers) {
                TextView b = ui.tonalButton(a.label);
                b.setOnClickListener(v -> { send(h, s, a.data); if (ref[0] != null) ref[0].dismiss(); });
                row.addView(b, ui.margins(0, 0, 8, 0));
            }
            box.addView(row);
        }
        EditText in = new EditText(this);
        in.setHint("Type a reply…");
        in.setSingleLine(true);
        in.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        box.addView(in);
        ref[0] = new AlertDialog.Builder(this, ui.dialogTheme())
                .setTitle(s.name + " · " + h.name)
                .setView(box)
                .setPositiveButton("Send", (d, w) -> send(h, s, in.getText().toString() + "\r"))
                .setNeutralButton("Open terminal", (d, w) -> openHost(h))
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void send(Host h, StateBus.Sess s, String data) {
        MonitorService.sendInput(this, h.id, s.id, data);
        Notify.cancel(this, h, "q:" + s.id);
        toast("Sent to " + s.name);
    }

    // ---------- liveness polling ----------
    private void pollHosts() {
        for (Host h : new ArrayList<>(hosts)) {
            pool.execute(() -> {
                HStat st = new HStat();
                long t0 = System.nanoTime();
                try (Response r = http.newCall(new Request.Builder().url(h.url + "/api/info").build()).execute()) {
                    st.online = r.isSuccessful();
                    st.ms = (System.nanoTime() - t0) / 1_000_000;
                } catch (Exception ignored) {}
                if (st.online) {
                    try (Response r = http.newCall(new Request.Builder().url(h.url + "/api/sessions").build()).execute()) {
                        if (r.isSuccessful() && r.body() != null) {
                            JSONArray a = new JSONArray(r.body().string());
                            st.total = a.length(); st.live = 0;
                            for (int i = 0; i < a.length(); i++)
                                if (!a.getJSONObject(i).optBoolean("exited")) st.live++;
                        }
                    } catch (Exception ignored) {}
                }
                main.post(() -> {
                    stats.put(h.id, st);
                    if (tab == TAB_HOSTS) renderHosts();
                });
            });
        }
    }

    // ---------- tailnet discovery ----------
    private void renderMachines() {
        if (machineList == null) return;
        machineList.removeAllViews();
        if (machines.isEmpty()) {
            TextView t = ui.text(hosts.isEmpty() ? "Add a host first — machines are discovered through it."
                    : scanning ? "Scanning…" : "No other machines online.", 14, ui.onSurfaceVariant, false);
            t.setPadding(dp(4), 0, 0, 0);
            machineList.addView(t);
            return;
        }
        for (JSONObject p : machines) {
            String ip = p.optString("ip");
            String nm = p.optString("hostname");
            if (nm.isEmpty()) nm = p.optString("dnsName", ip);
            String os = p.optString("os");
            boolean agent = !p.isNull("sremote");
            Host known = findHostByIp(ip);
            LinearLayout r = ui.card(ui.container);
            r.setPadding(dp(16), dp(12), dp(12), dp(12));
            LinearLayout row = ui.hrow();
            row.addView(ui.icon(R.drawable.ic_hosts, agent ? ui.primary : ui.outline, 22));
            LinearLayout tc = ui.vcol();
            tc.setPadding(dp(14), 0, dp(8), 0);
            tc.addView(ui.oneLine(ui.text(nm, 15, ui.onSurface, true)));
            tc.addView(ui.oneLine(ui.text(ip + (os.isEmpty() ? "" : " · " + os), 12, ui.onSurfaceVariant, false)));
            row.addView(tc, Ui.weight1());
            if (known != null) row.addView(ui.pill("Saved", ui.onSurfaceVariant, ui.containerHigh));
            else if (agent) row.addView(ui.pill("S-remote", ui.onPrimaryContainer, ui.primaryContainer));
            else row.addView(ui.pill("No agent", ui.onSurfaceVariant, ui.containerHigh));
            r.addView(row);
            if (!agent && known == null) r.setAlpha(0.7f);
            final String fnm = nm;
            r.setOnClickListener(v -> machineTap(p, fnm, known));
            machineList.addView(r);
        }
    }

    private Host findHostByIp(String ip) {
        for (Host h : hosts) if (h.url.contains(ip)) return h;
        return null;
    }

    private void machineTap(JSONObject p, String nm, Host known) {
        if (known != null) { openHost(known); return; }
        String ip = p.optString("ip");
        if (p.isNull("sremote")) {
            new AlertDialog.Builder(this, ui.dialogTheme())
                    .setTitle(nm)
                    .setMessage("Online, but no S-remote server answers on :2209.\nAdd it anyway?")
                    .setPositiveButton("Add anyway", (d, w) -> { store.add(nm, "http://" + ip + ":2209"); reload(); resyncMonitor(); })
                    .setNegativeButton("Cancel", null).show();
            return;
        }
        Host h = store.add(nm, "http://" + ip + ":2209");
        reload(); resyncMonitor();
        toast("Added " + nm);
        openHost(h);
    }

    private void scanTailnet() {
        if (scanning) return;
        if (hosts.isEmpty()) { machines.clear(); machinesStatus.setText(""); renderMachines(); return; }
        scanning = true;
        lastScan = System.currentTimeMillis();
        machinesStatus.setText("scanning…");
        List<Host> hs = new ArrayList<>(hosts);
        pool.execute(() -> {
            Map<String, JSONObject> found = new LinkedHashMap<>();
            for (Host h : hs) {
                try (Response r = http.newCall(new Request.Builder().url(h.url + "/api/peers").build()).execute()) {
                    if (!r.isSuccessful() || r.body() == null) continue;
                    JSONArray peers = new JSONObject(r.body().string()).optJSONArray("peers");
                    if (peers == null) continue;
                    for (int i = 0; i < peers.length(); i++) {
                        JSONObject p = peers.optJSONObject(i);
                        if (p == null || !p.optBoolean("online")) continue;
                        String ip = p.optString("ip");
                        if (ip.isEmpty()) continue;
                        JSONObject prev = found.get(ip);
                        if (prev == null || (prev.isNull("sremote") && !p.isNull("sremote")))
                            found.put(ip, p); // prefer the entry that saw an agent
                    }
                } catch (Exception ignored) {}
            }
            List<JSONObject> out = new ArrayList<>(found.values());
            main.post(() -> {
                machines.clear(); machines.addAll(out);
                scanning = false;
                machinesStatus.setText(out.isEmpty() ? "" : out.size() + " online");
                renderMachines();
            });
        });
    }

    // ================= ACTIVITY =================
    private View buildActivityPage() {
        LinearLayout body = ui.vcol();
        TextView clear = ui.textButton("Clear");
        clear.setOnClickListener(v -> new AlertDialog.Builder(this, ui.dialogTheme())
                .setTitle("Clear activity history?")
                .setPositiveButton("Clear", (d, w) -> EventLog.clear(this))
                .setNegativeButton("Cancel", null).show());
        body.addView(header("Activity", clear));
        TextView sub = ui.text("Everything the monitor noticed, newest first", 14, ui.onSurfaceVariant, false);
        sub.setPadding(dp(4), 0, 0, dp(12));
        body.addView(sub);
        HorizontalScrollView hs = new HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        activityChips = ui.hrow();
        hs.addView(activityChips);
        body.addView(hs);
        activityList = ui.vcol();
        activityList.setPadding(0, dp(8), 0, 0);
        body.addView(activityList);
        return page(body);
    }

    private void renderActivity() {
        if (activityList == null) return;
        String[][] filters = {{"all", "All"}, {EventLog.K_QUESTION, "Needs input"}, {EventLog.K_DONE, "Finished"}, {"sessions", "Sessions"}};
        activityChips.removeAllViews();
        for (String[] f : filters) {
            TextView c = ui.chip(f[1], f[0].equals(activityFilter));
            c.setOnClickListener(v -> { activityFilter = f[0]; renderActivity(); });
            activityChips.addView(c, ui.margins(0, 0, 8, 0));
        }
        activityList.removeAllViews();
        String lastDay = null;
        int n = 0;
        for (JSONObject e : EventLog.list(this)) {
            String kind = e.optString("kind");
            boolean match = activityFilter.equals("all") || activityFilter.equals(kind)
                    || (activityFilter.equals("sessions") && (kind.equals(EventLog.K_NEW) || kind.equals(EventLog.K_EXIT)));
            if (!match) continue;
            long t = e.optLong("t");
            String day = dayLabel(t);
            if (!day.equals(lastDay)) {
                TextView dl = ui.text(day, 13, ui.onSurfaceVariant, true);
                dl.setPadding(dp(4), dp(n == 0 ? 4 : 16), 0, dp(8));
                activityList.addView(dl);
                lastDay = day;
            }
            activityList.addView(eventRow(e, kind, t));
            n++;
        }
        if (n == 0) {
            LinearLayout empty = ui.vcol();
            empty.setGravity(Gravity.CENTER_HORIZONTAL);
            empty.setPadding(dp(24), dp(48), dp(24), 0);
            empty.addView(ui.icon(R.drawable.ic_bell, ui.outline, 48));
            TextView t = ui.text("Nothing here yet", 18, ui.onSurface, false);
            t.setPadding(0, dp(12), 0, dp(4));
            empty.addView(t);
            TextView s = ui.text(store.monitorEnabled()
                    ? "Finished tasks, questions and session changes will show up here."
                    : "Turn on monitoring in Settings to start collecting activity.", 14, ui.onSurfaceVariant, false);
            s.setGravity(Gravity.CENTER);
            empty.addView(s);
            activityList.addView(empty);
        }
    }

    private View eventRow(JSONObject e, String kind, long t) {
        int icon, fg, bg;
        switch (kind) {
            case EventLog.K_QUESTION: icon = R.drawable.ic_help; fg = ui.warn; bg = ui.warnContainer; break;
            case EventLog.K_DONE: icon = R.drawable.ic_check; fg = ui.ok; bg = ui.okContainer; break;
            case EventLog.K_NEW: icon = R.drawable.ic_play; fg = ui.onPrimaryContainer; bg = ui.primaryContainer; break;
            default: icon = R.drawable.ic_close; fg = ui.onSurfaceVariant; bg = ui.containerHigh;
        }
        LinearLayout r = ui.hrow();
        r.setGravity(Gravity.TOP);
        r.setPadding(dp(12), dp(12), dp(12), dp(12));
        r.setBackground(ui.ripple(ui.round(ui.container, 20), 20));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, 0, 0, dp(8));
        r.setLayoutParams(lp);
        FrameLayout ic = new FrameLayout(this);
        ic.setBackground(ui.oval(bg));
        ic.addView(ui.icon(icon, fg, 20), new FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER));
        r.addView(ic, new LinearLayout.LayoutParams(dp(40), dp(40)));
        LinearLayout tc = ui.vcol();
        tc.setPadding(dp(14), 0, 0, 0);
        tc.addView(ui.oneLine(ui.text(e.optString("title"), 15, ui.onSurface, true)));
        String text = e.optString("text");
        if (!text.isEmpty()) {
            TextView tt = ui.text(text, 13, ui.onSurfaceVariant, false);
            tt.setMaxLines(3);
            tt.setEllipsize(android.text.TextUtils.TruncateAt.END);
            tt.setPadding(0, dp(2), 0, 0);
            tc.addView(tt);
        }
        TextView meta = ui.text(e.optString("hostName") + " · " + DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(t))
                + " · " + Ui.ago(t), 12, ui.outline, false);
        meta.setPadding(0, dp(4), 0, 0);
        tc.addView(meta);
        r.addView(tc, Ui.weight1());
        Host h = store.find(e.optString("host"));
        if (h != null) r.setOnClickListener(v -> openHost(h));
        return r;
    }

    private static String dayLabel(long t) {
        Calendar c = Calendar.getInstance(), now = Calendar.getInstance();
        c.setTimeInMillis(t);
        if (c.get(Calendar.YEAR) == now.get(Calendar.YEAR)) {
            int d = now.get(Calendar.DAY_OF_YEAR) - c.get(Calendar.DAY_OF_YEAR);
            if (d == 0) return "Today";
            if (d == 1) return "Yesterday";
        }
        return DateFormat.getDateInstance(DateFormat.MEDIUM).format(new Date(t));
    }

    // ================= SETTINGS =================
    private View buildSettingsPage() {
        LinearLayout body = ui.vcol();
        body.addView(header("Settings", null));
        settingsBody = ui.vcol();
        body.addView(settingsBody);
        return page(body);
    }

    private LinearLayout group() {
        LinearLayout g = ui.vcol();
        g.setBackground(ui.round(ui.container, 24));
        g.setPadding(0, dp(4), 0, dp(4));
        return g;
    }

    private View clickRow(String title, String sub, View.OnClickListener l) {
        LinearLayout r = ui.settingRow(title, sub, null);
        r.setBackground(ui.ripple(ui.round(0x00000000, 24), 24));
        r.setOnClickListener(l);
        return r;
    }

    private View switchRow(String title, String sub, boolean on, android.widget.CompoundButton.OnCheckedChangeListener l) {
        Switch sw = ui.toggle(on);
        sw.setOnCheckedChangeListener(l);
        LinearLayout r = ui.settingRow(title, sub, sw);
        r.setOnClickListener(v -> sw.toggle());
        return r;
    }

    private void buildSettings() {
        if (settingsBody == null) return;
        settingsBody.removeAllViews();

        settingsBody.addView(ui.label("Monitoring"));
        LinearLayout g1 = group();
        g1.addView(switchRow("Background monitoring", "Stay connected to your hosts to track session states and alert you",
                store.monitorEnabled(), (v, on) -> { setMonitor(on); buildSettings(); }));
        boolean mon = store.monitorEnabled();
        View q = switchRow("Needs input", "y/n prompts, menus, passwords — with reply buttons",
                store.notifyKind(HostStore.N_QUESTION), (v, on) -> store.setNotifyKind(HostStore.N_QUESTION, on));
        View d = switchRow("Task finished", "Back at the prompt, exit codes, bell, agent stopped",
                store.notifyKind(HostStore.N_DONE), (v, on) -> store.setNotifyKind(HostStore.N_DONE, on));
        View s = switchRow("Sessions started / ended", null,
                store.notifyKind(HostStore.N_SESSION), (v, on) -> store.setNotifyKind(HostStore.N_SESSION, on));
        for (View v : new View[]{q, d, s}) { v.setAlpha(mon ? 1f : 0.5f); g1.addView(v); }
        g1.addView(clickRow("Send test notification", "Check that alerts reach this phone", v -> { ensureNotifPermission(); Notify.test(this); }));
        g1.addView(clickRow("System notification settings", "Sound, vibration and pop-up per category", v -> {
            Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(i);
        }));
        if (Build.VERSION.SDK_INT >= 33) g1.addView(clickRow("Add Quick Settings tile", "Toggle monitoring from the notification shade", v -> requestTile()));
        settingsBody.addView(g1);

        settingsBody.addView(ui.label("Security"));
        LinearLayout g2 = group();
        if (LockGate.available(this)) {
            g2.addView(switchRow("App lock", "Require fingerprint, face or screen lock to open S-remote",
                    store.lockEnabled(), (v, on) -> store.setLockEnabled(on)));
        } else {
            View r = ui.settingRow("App lock", "Not available — needs Android 11+ with a fingerprint or screen lock set up", null);
            r.setAlpha(0.6f);
            g2.addView(r);
        }
        settingsBody.addView(g2);

        settingsBody.addView(ui.label("Tailscale"));
        LinearLayout g3 = group();
        String tsSub;
        TextView tsBtn;
        if (!Tailscale.installed(this)) {
            tsSub = "Not installed"; tsBtn = ui.tonalButton("Get");
            tsBtn.setOnClickListener(v -> Tailscale.openPlayStore(this));
        } else {
            String ip = Tailscale.tailnetIp(this);
            tsSub = ip != null ? "Connected · " + ip : Tailscale.vpnUp(this) ? "VPN connected" : "Not connected";
            tsBtn = ui.tonalButton("Open");
            tsBtn.setOnClickListener(v -> Tailscale.openApp(this));
        }
        g3.addView(ui.settingRow("Tailscale", tsSub, tsBtn));
        settingsBody.addView(g3);

        settingsBody.addView(ui.label("About"));
        LinearLayout g4 = group();
        String ver = "?";
        try { ver = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) {}
        g4.addView(ui.settingRow("S-remote for Android", "Version " + ver, null));
        g4.addView(clickRow("Project on GitHub", "thsangyk-oss/sremote", v -> {
            try { startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://github.com/thsangyk-oss/sremote"))); }
            catch (Exception ignored) {}
        }));
        settingsBody.addView(g4);
    }

    private void requestTile() {
        if (Build.VERSION.SDK_INT < 33) return;
        StatusBarManager sbm = getSystemService(StatusBarManager.class);
        sbm.requestAddTileService(new ComponentName(this, MonitorTile.class), "S-remote",
                Icon.createWithResource(this, R.drawable.ic_notify), getMainExecutor(), r -> {});
    }

    private void setMonitor(boolean on) {
        store.setMonitorEnabled(on);
        if (on) { ensureNotifPermission(); MonitorService.start(this); }
        else MonitorService.stop(this);
    }

    // ---------------- host CRUD + launch ----------------
    private void openHost(Host h) {
        if (Tailscale.tailnetIp(this) == null && !Tailscale.vpnUp(this)) {
            new AlertDialog.Builder(this, ui.dialogTheme())
                    .setTitle("Tailscale seems off")
                    .setMessage("No tailnet connection detected. Open " + h.name + " anyway?")
                    .setPositiveButton("Open", (d, w) -> launch(h))
                    .setNegativeButton("Cancel", null)
                    .show();
        } else launch(h);
    }

    private void launch(Host h) {
        Intent i = new Intent(this, HostActivity.class);
        i.putExtra(HostActivity.EXTRA_HOST_ID, h.id);
        i.putExtra(HostActivity.EXTRA_NAME, h.name);
        i.putExtra(HostActivity.EXTRA_URL, h.url);
        startActivity(i);
    }

    private void hostMenu(Host h) {
        String mute = h.notify ? "Mute notifications" : "Unmute notifications";
        String[] items = {"Open", mute, "Add to home screen", "Edit", "Remove"};
        new AlertDialog.Builder(this, ui.dialogTheme())
                .setTitle(h.name)
                .setItems(items, (d, w) -> {
                    switch (w) {
                        case 0: openHost(h); break;
                        case 1: h.notify = !h.notify; store.update(h); reload(); resyncMonitor(); break;
                        case 2: pinShortcut(h); break;
                        case 3: hostDialog(h); break;
                        case 4: confirmRemove(h); break;
                    }
                }).show();
    }

    private void confirmRemove(Host h) {
        new AlertDialog.Builder(this, ui.dialogTheme())
                .setTitle("Remove " + h.name + "?")
                .setPositiveButton("Remove", (d, w) -> { store.remove(h.id); stats.remove(h.id); reload(); resyncMonitor(); })
                .setNegativeButton("Cancel", null).show();
    }

    private void resyncMonitor() {
        if (store.monitorEnabled()) MonitorService.start(this); // onStartCommand re-syncs
    }

    // ---------- launcher shortcuts ----------
    private ShortcutInfo shortcutFor(Host h) {
        Intent i = new Intent(this, MainActivity.class).setAction(ACTION_OPEN_HOST)
                .putExtra(HostActivity.EXTRA_HOST_ID, h.id)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return new ShortcutInfo.Builder(this, "host-" + h.id)
                .setShortLabel(h.name.length() > 20 ? h.name.substring(0, 20) : h.name)
                .setLongLabel("Open " + h.name)
                .setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher))
                .setIntent(i).build();
    }

    private void updateShortcuts() {
        try {
            ShortcutManager sm = getSystemService(ShortcutManager.class);
            if (sm == null) return;
            List<ShortcutInfo> list = new ArrayList<>();
            int max = Math.min(4, sm.getMaxShortcutCountPerActivity());
            for (Host h : hosts) { if (list.size() >= max) break; list.add(shortcutFor(h)); }
            sm.setDynamicShortcuts(list);
        } catch (Exception ignored) {}
    }

    private void pinShortcut(Host h) {
        ShortcutManager sm = getSystemService(ShortcutManager.class);
        if (sm != null && sm.isRequestPinShortcutSupported()) sm.requestPinShortcut(shortcutFor(h), null);
        else toast("Your launcher doesn't support pinned shortcuts");
    }

    // ---------- add / edit host ----------
    private void hostDialog(Host edit) {
        LinearLayout box = ui.vcol();
        box.setPadding(dp(24), dp(8), dp(24), 0);

        EditText name = new EditText(this);
        name.setHint("Name (optional)");
        name.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS);
        box.addView(name);

        EditText addr = new EditText(this);
        addr.setHint("Tailscale address, e.g. 100.64.1.2:2209");
        addr.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        box.addView(addr);

        TextView status = ui.text("", 13, ui.onSurfaceVariant, false);
        status.setPadding(0, dp(8), 0, 0);
        box.addView(status);

        if (edit != null) { name.setText(edit.name); addr.setText(edit.url); }

        AlertDialog d = new AlertDialog.Builder(this, ui.dialogTheme())
                .setTitle(edit == null ? "Add host" : "Edit host")
                .setView(box)
                .setPositiveButton("Save", null)
                .setNeutralButton("Save anyway", null)
                .setNegativeButton("Cancel", null)
                .create();
        d.show();
        d.getButton(AlertDialog.BUTTON_NEUTRAL).setVisibility(View.GONE);
        d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String nm = name.getText().toString().trim();
            String url = Host.normalizeUrl(addr.getText().toString());
            if (url == null) { status.setTextColor(ui.err); status.setText("Invalid address"); return; }
            if (url.matches("^http://[^/:]+$")) url = url + ":2209"; // bare IP/host → default port
            final String fUrl = url;
            status.setTextColor(ui.onSurfaceVariant);
            status.setText("Checking " + fUrl + " …");
            pool.execute(() -> {
                String hostname = probe(fUrl);
                main.post(() -> {
                    if (hostname != null) {
                        save(d, edit, nm.isEmpty() ? hostname : nm, fUrl);
                    } else {
                        status.setTextColor(ui.warn);
                        status.setText("Unreachable — wrong address, or the host / Tailscale is off. “Save anyway” keeps it.");
                        d.getButton(AlertDialog.BUTTON_NEUTRAL).setVisibility(View.VISIBLE);
                    }
                });
            });
        });
        d.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> {
            String url = Host.normalizeUrl(addr.getText().toString());
            if (url == null) { status.setTextColor(ui.err); status.setText("Invalid address"); return; }
            if (url.matches("^http://[^/:]+$")) url = url + ":2209"; // bare IP/host → default port
            String n = name.getText().toString().trim();
            if (n.isEmpty()) n = url.replaceFirst("^[a-z]+://", "").split("[/:]")[0];
            save(d, edit, n, url);
        });
    }

    private void save(AlertDialog d, Host edit, String name, String url) {
        if (edit != null) { edit.name = name; edit.url = url; store.update(edit); }
        else store.add(name, url);
        reload(); resyncMonitor(); pollHosts(); d.dismiss();
        toast("Saved " + name);
    }

    /** GET /api/info → hostname, or null on failure */
    private String probe(String base) {
        try (Response r = http.newCall(new Request.Builder().url(base + "/api/info").build()).execute()) {
            if (!r.isSuccessful() || r.body() == null) return null;
            JSONObject o = new JSONObject(r.body().string());
            String hn = o.optString("hostname");
            return hn.isEmpty() ? "host" : hn;
        } catch (Exception e) { return null; }
    }

    private void ensureNotifPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }
}
