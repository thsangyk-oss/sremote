package com.sremote.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public class MainActivity extends Activity {
    private static final int REQ_NOTIF = 42;
    private static final long RESCAN_MS = 30_000;

    private HostStore store;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS).build();

    private TextView tsTitle, tsSub;
    private View tsDot;
    private Button tsBtn;
    private LinearLayout hostRows, machineRows;
    private TextView machinesStatus, empty;
    private Switch monitorSw;
    private final List<Host> hosts = new ArrayList<>();
    private final List<JSONObject> machines = new ArrayList<>();
    private long lastScan = 0;
    private boolean scanning = false;

    // ---------- helpers ----------
    private int dp(float v) { return (int) (v * getResources().getDisplayMetrics().density + .5f); }
    private int col(int res) { return getColor(res); }

    private GradientDrawable round(int color, float r) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color); g.setCornerRadius(dp(r));
        return g;
    }

    private TextView tv(String s, float sp, int color, int style) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextSize(sp); t.setTextColor(color); t.setTypeface(Typeface.DEFAULT, style);
        return t;
    }

    private TextView sectionLabel(String s) {
        TextView t = tv(s, 11, col(R.color.dim), Typeface.BOLD);
        t.setPadding(dp(2), dp(18), 0, dp(6));
        return t;
    }

    private Button btn(String s) {
        Button b = new Button(this);
        b.setText(s); b.setAllCaps(false); b.setTextColor(col(R.color.fg));
        b.setBackground(round(col(R.color.line), 9));
        b.setMinHeight(0); b.setMinimumHeight(0);
        b.setPadding(dp(14), dp(8), dp(14), dp(8));
        return b;
    }

    // ---------- lifecycle ----------
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        store = new HostStore(this);
        Window w = getWindow();
        w.setStatusBarColor(col(R.color.bg));
        w.setNavigationBarColor(col(R.color.bg));
        buildUi();
        reload();
    }

    @Override protected void onResume() {
        super.onResume();
        refreshTailscale();
        reload();
        if (store.monitorEnabled()) {
            ensureNotifPermission();
            MonitorService.start(this);
        }
        monitorSw.setOnCheckedChangeListener(null);
        monitorSw.setChecked(store.monitorEnabled());
        monitorSw.setOnCheckedChangeListener((v, on) -> {
            store.setMonitorEnabled(on);
            if (on) { ensureNotifPermission(); MonitorService.start(this); }
            else MonitorService.stop(this);
        });
    }

    // ---------- UI ----------
    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(14), dp(18), dp(10));
        root.setBackgroundColor(col(R.color.bg));

        // brand
        LinearLayout brand = new LinearLayout(this);
        TextView logo = tv("S-remote", 26, col(R.color.fg), Typeface.BOLD);
        brand.addView(logo);
        TextView tag = tv(" · direct over tailscale", 13, col(R.color.dim), Typeface.NORMAL);
        tag.setGravity(Gravity.BOTTOM);
        tag.setPadding(0, 0, 0, dp(4));
        brand.addView(tag);
        root.addView(brand);

        // tailscale status card
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(14), dp(12), dp(12), dp(12));
        card.setBackground(round(col(R.color.panel), 14));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.setMargins(0, dp(12), 0, 0);
        root.addView(card, clp);

        tsDot = new View(this);
        GradientDrawable dot = new GradientDrawable();
        dot.setShape(GradientDrawable.OVAL); dot.setColor(col(R.color.dim));
        tsDot.setBackground(dot);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(10), dp(10));
        dlp.setMargins(0, 0, dp(10), 0);
        card.addView(tsDot, dlp);

        LinearLayout tsCol = new LinearLayout(this);
        tsCol.setOrientation(LinearLayout.VERTICAL);
        tsTitle = tv("Tailscale", 14, col(R.color.fg), Typeface.BOLD);
        tsSub = tv("checking…", 12, col(R.color.dim), Typeface.NORMAL);
        tsCol.addView(tsTitle); tsCol.addView(tsSub);
        card.addView(tsCol, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        tsBtn = btn("Open");
        tsBtn.setVisibility(View.GONE);
        card.addView(tsBtn);

        // scrollable body: hosts + discovered machines
        ScrollView sv = new ScrollView(this);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        sv.addView(body);

        LinearLayout hl = new LinearLayout(this);
        hl.setGravity(Gravity.CENTER_VERTICAL);
        TextView hlText = tv("HOSTS", 11, col(R.color.dim), Typeface.BOLD);
        hl.addView(hlText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        hl.setPadding(dp(2), dp(18), 0, dp(6));
        body.addView(hl);

        hostRows = new LinearLayout(this);
        hostRows.setOrientation(LinearLayout.VERTICAL);
        body.addView(hostRows);
        empty = tv("No hosts yet.\nTap “Add host” and enter a machine's\nTailscale IP, e.g. 100.64.1.2:2209",
                14, col(R.color.dim), Typeface.NORMAL);
        empty.setGravity(Gravity.CENTER);
        empty.setLineSpacing(dp(4), 1);
        empty.setPadding(0, dp(24), 0, 0);
        body.addView(empty);

        // machines on tailnet (discovered via any saved host's /api/peers)
        LinearLayout ml = new LinearLayout(this);
        ml.setGravity(Gravity.CENTER_VERTICAL);
        ml.setPadding(dp(2), dp(18), 0, dp(6));
        TextView mlText = tv("MACHINES ON TAILNET", 11, col(R.color.dim), Typeface.BOLD);
        ml.addView(mlText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        machinesStatus = tv("", 11, col(R.color.dim), Typeface.NORMAL);
        ml.addView(machinesStatus);
        TextView rescan = tv(" ⟳", 15, col(R.color.dim), Typeface.BOLD);
        rescan.setPadding(dp(10), 0, dp(4), 0);
        rescan.setOnClickListener(v -> scanTailnet(true));
        ml.addView(rescan);
        body.addView(ml);

        machineRows = new LinearLayout(this);
        machineRows.setOrientation(LinearLayout.VERTICAL);
        body.addView(machineRows);

        root.addView(sv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        // footer: add + monitor switch
        LinearLayout foot = new LinearLayout(this);
        foot.setGravity(Gravity.CENTER_VERTICAL);
        foot.setPadding(0, dp(10), 0, dp(4));
        Button add = btn("+ Add host");
        add.setTextColor(col(R.color.bg));
        add.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        add.setBackground(round(col(R.color.accent), 10));
        add.setOnClickListener(v -> hostDialog(null));
        foot.addView(add);

        LinearLayout swCol = new LinearLayout(this);
        swCol.setOrientation(LinearLayout.HORIZONTAL);
        swCol.setGravity(Gravity.CENTER_VERTICAL | Gravity.RIGHT);
        TextView swLabel = tv("Session notifications", 12, col(R.color.dim), Typeface.NORMAL);
        swLabel.setPadding(0, 0, dp(6), 0);
        swCol.addView(swLabel);
        monitorSw = new Switch(this);
        swCol.addView(monitorSw);
        foot.addView(swCol, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        root.addView(foot);

        setContentView(root);
    }

    private LinearLayout row(String title, String sub, String badge, int badgeColor) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(dp(14), dp(12), dp(14), dp(12));
        r.setBackground(round(col(R.color.panel), 12));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, 0, 0, dp(8));
        r.setLayoutParams(lp);

        LinearLayout colTxt = new LinearLayout(this);
        colTxt.setOrientation(LinearLayout.VERTICAL);
        colTxt.addView(tv(title, 15, col(R.color.fg), Typeface.BOLD));
        colTxt.addView(tv(sub, 12, col(R.color.dim), Typeface.NORMAL));
        r.addView(colTxt, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        if (badge != null) r.addView(tv(badge, 11, badgeColor, Typeface.NORMAL));
        TextView chev = tv("›", 22, col(R.color.dim), Typeface.NORMAL);
        chev.setPadding(dp(8), 0, 0, 0);
        r.addView(chev);
        return r;
    }

    private void reload() {
        hosts.clear();
        hosts.addAll(store.list());
        renderHosts();
    }

    private void renderHosts() {
        hostRows.removeAllViews();
        empty.setVisibility(hosts.isEmpty() ? View.VISIBLE : View.GONE);
        for (Host h : hosts) {
            View r = row(h.name, h.hostPort(), h.notify ? null : "muted", col(R.color.warn));
            r.setOnClickListener(v -> openHost(h));
            r.setOnLongClickListener(v -> { hostMenu(h); return true; });
            hostRows.addView(r);
        }
    }

    private void renderMachines() {
        machineRows.removeAllViews();
        for (JSONObject p : machines) {
            String ip = p.optString("ip");
            String nm = p.optString("hostname");
            if (nm.isEmpty()) nm = p.optString("dnsName", ip);
            String os = p.optString("os");
            boolean agent = !p.isNull("sremote");
            Host known = findHostByIp(ip);
            String badge = known != null ? "saved" : agent ? "S-remote" : "no agent";
            int bc = known != null ? col(R.color.dim) : agent ? col(R.color.accent) : col(R.color.dim);
            View r = row(nm, ip + (os.isEmpty() ? "" : " · " + os), badge, bc);
            if (!agent && known == null) r.setAlpha(0.6f);
            r.setOnClickListener(v -> machineTap(p, known));
            machineRows.addView(r);
        }
    }

    private Host findHostByIp(String ip) {
        for (Host h : hosts) if (h.url.contains(ip)) return h;
        return null;
    }

    private void machineTap(JSONObject p, Host known) {
        if (known != null) { openHost(known); return; }
        String ip = p.optString("ip");
        String nm = p.optString("hostname", ip);
        boolean agent = !p.isNull("sremote");
        if (!agent) {
            new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                    .setTitle(nm)
                    .setMessage("Online but no S-remote agent on :2209.\nAdd it anyway?")
                    .setPositiveButton("Add anyway", (d, w) -> { store.add(nm, "http://" + ip + ":2209"); reload(); resyncMonitor(); })
                    .setNegativeButton("Cancel", null).show();
            return;
        }
        Host h = store.add(nm, "http://" + ip + ":2209");
        reload(); resyncMonitor();
        toast("Added " + nm);
        openHost(h);
    }

    // ---------- tailnet discovery ----------
    private void scanTailnet(boolean force) {
        if (scanning) return;
        if (hosts.isEmpty()) {
            machines.clear();
            machinesStatus.setText("add a host first");
            renderMachines();
            return;
        }
        scanning = true;
        lastScan = System.currentTimeMillis();
        machinesStatus.setText("scanning…");
        List<Host> hs = new ArrayList<>(hosts);
        new Thread(() -> {
            Map<String, JSONObject> found = new LinkedHashMap<>();
            for (Host h : hs) {
                try (Response r = http.newCall(new Request.Builder()
                        .url(h.url + "/api/peers").build()).execute()) {
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
            ui.post(() -> {
                machines.clear(); machines.addAll(out);
                scanning = false;
                machinesStatus.setText(out.isEmpty() ? "none found" : out.size() + " online");
                renderMachines();
            });
        }).start();
    }

    // ---------- tailscale ----------
    private void refreshTailscale() {
        GradientDrawable dot = (GradientDrawable) tsDot.getBackground().mutate();
        if (!Tailscale.installed(this)) {
            dot.setColor(col(R.color.danger));
            tsTitle.setText("Tailscale not installed");
            tsSub.setText("Required — S-remote talks over your tailnet");
            tsBtn.setText("Get on Play Store");
            tsBtn.setOnClickListener(v -> Tailscale.openPlayStore(this));
            tsBtn.setVisibility(View.VISIBLE);
        } else {
            String ip = Tailscale.tailnetIp(this);
            boolean up = Tailscale.vpnUp(this);
            if (ip != null) {
                dot.setColor(col(R.color.accent));
                tsTitle.setText("Tailscale connected");
                tsSub.setText(ip);
                tsBtn.setVisibility(View.GONE);
            } else if (up) {
                dot.setColor(col(R.color.accent));
                tsTitle.setText("Tailscale VPN up");
                tsSub.setText("Connected — tailnet IP not visible to apps");
                tsBtn.setVisibility(View.GONE);
            } else {
                dot.setColor(col(R.color.warn));
                tsTitle.setText("Tailscale not connected");
                tsSub.setText("Open Tailscale and connect to your tailnet");
                tsBtn.setText("Open Tailscale");
                tsBtn.setOnClickListener(v -> Tailscale.openApp(this));
                tsBtn.setVisibility(View.VISIBLE);
            }
            if (up && !scanning && System.currentTimeMillis() - lastScan > RESCAN_MS)
                scanTailnet(false);
        }
    }

    // ---------- host CRUD ----------
    private void openHost(Host h) {
        if (Tailscale.tailnetIp(this) == null && !Tailscale.vpnUp(this)) {
            new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                    .setTitle("Tailscale seems off")
                    .setMessage("No VPN/tailnet connection detected. Open " + h.name + " anyway?")
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
        String[] items = {"Open", mute, "Edit", "Remove"};
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle(h.name)
                .setItems(items, (d, w) -> {
                    switch (w) {
                        case 0: openHost(h); break;
                        case 1: h.notify = !h.notify; store.update(h); reload(); resyncMonitor(); break;
                        case 2: hostDialog(h); break;
                        case 3: confirmRemove(h); break;
                    }
                }).show();
    }

    private void confirmRemove(Host h) {
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Remove " + h.name + "?")
                .setPositiveButton("Remove", (d, w) -> { store.remove(h.id); reload(); resyncMonitor(); })
                .setNegativeButton("Cancel", null).show();
    }

    private void resyncMonitor() {
        if (store.monitorEnabled()) MonitorService.start(this); // onStartCommand re-syncs
    }

    private void hostDialog(Host edit) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(10), dp(20), 0);

        EditText name = new EditText(this);
        name.setHint("Name (optional)");
        name.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS);
        box.addView(name);

        EditText addr = new EditText(this);
        addr.setHint("Tailscale address, e.g. 100.64.1.2:2209");
        addr.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        box.addView(addr);

        TextView status = tv("", 12, col(R.color.dim), Typeface.NORMAL);
        status.setPadding(0, dp(8), 0, 0);
        box.addView(status);

        if (edit != null) {
            name.setText(edit.name);
            addr.setText(edit.url);
        }

        AlertDialog d = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
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
            if (url == null) { status.setTextColor(col(R.color.danger)); status.setText("Invalid address"); return; }
            final String fUrl = url;
            status.setTextColor(col(R.color.dim));
            status.setText("Checking " + fUrl + " …");
            new Thread(() -> {
                String hostname = probe(fUrl);
                ui.post(() -> {
                    if (hostname != null) {
                        String n = nm.isEmpty() ? hostname : nm;
                        save(d, edit, n, fUrl);
                    } else {
                        status.setTextColor(col(R.color.warn));
                        status.setText("Unreachable — wrong address or host/Tailscale off. “Save anyway” to keep it.");
                        d.getButton(AlertDialog.BUTTON_NEUTRAL).setVisibility(View.VISIBLE);
                    }
                });
            }).start();
        });
        d.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> {
            String url = Host.normalizeUrl(addr.getText().toString());
            if (url == null) { status.setTextColor(col(R.color.danger)); status.setText("Invalid address"); return; }
            String n = name.getText().toString().trim();
            if (n.isEmpty()) n = url.replaceFirst("^[a-z]+://", "").split("[/:]")[0];
            save(d, edit, n, url);
        });
    }

    private void save(AlertDialog d, Host edit, String name, String url) {
        if (edit != null) { edit.name = name; edit.url = url; store.update(edit); }
        else store.add(name, url);
        reload(); resyncMonitor(); d.dismiss();
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

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }

    private void ensureNotifPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }
}
