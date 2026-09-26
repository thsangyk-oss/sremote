package com.sremote.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Foreground service holding one websocket per watched S-remote host.
 * Posts phone notifications for: new session (request), session exit,
 * terminal bell (\x07 — the standard "command finished" signal), and
 * a busy→quiet idle edge.
 */
public class MonitorService extends Service {
    private static final int FG_ID = 0x5e11;

    private static final long IDLE_MS = 45_000;       // quiet this long after activity → notify
    private static final long IDLE_MIN_BYTES = 400;   // need this much output to count as "busy"
    private static final long BELL_THROTTLE = 60_000; // min gap between bell notifs per session
    private static final long RECONNECT_MIN = 3_000, RECONNECT_MAX = 60_000;

    private static final char BEL = 7, ESC = 27;
    private static final String OSC9 = "" + ESC + "]9;";
    private static final String OSC777 = "" + ESC + "]777;";

    private OkHttpClient client;
    private Handler handler;
    private HostStore store;
    private final Map<String, Conn> conns = new HashMap<>();
    private boolean destroyed = false;

    private final Runnable idleTicker = new Runnable() {
        @Override public void run() {
            long now = System.currentTimeMillis();
            for (Conn c : conns.values()) c.checkIdle(now);
            handler.postDelayed(this, 10_000);
        }
    };

    public static void start(Context c) {
        Intent i = new Intent(c, MonitorService.class);
        try { c.startForegroundService(i); } catch (Exception ignored) {}
    }
    public static void stop(Context c) {
        c.stopService(new Intent(c, MonitorService.class));
    }

    @Override public void onCreate() {
        super.onCreate();
        store = new HostStore(this);
        handler = new Handler(Looper.getMainLooper());
        client = new OkHttpClient.Builder()
                .pingInterval(20, TimeUnit.SECONDS) // WS keepalive through NAT/tailnet
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();
        Notify.ensureChannels(this);
        Notification n0 = statusNotification();
        if (Build.VERSION.SDK_INT >= 29)
            startForeground(FG_ID, n0, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else
            startForeground(FG_ID, n0);
        handler.postDelayed(idleTicker, 10_000);
        resync();
    }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        resync();
        return START_STICKY;
    }

    @Override public void onDestroy() {
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        for (Conn c : conns.values()) c.close();
        conns.clear();
        if (client != null) client.dispatcher().executorService().shutdown();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent i) { return null; }

    /** converge live connections with the stored host list */
    synchronized void resync() {
        Map<String, Host> want = new HashMap<>();
        for (Host h : store.list()) if (h.notify) want.put(h.id, h);
        for (String id : new HashSet<>(conns.keySet()))
            if (!want.containsKey(id)) { conns.get(id).close(); conns.remove(id); }
        for (Host h : want.values()) {
            Conn c = conns.get(h.id);
            if (c == null) { c = new Conn(h); conns.put(h.id, c); c.connect(); }
            else if (!c.host.url.equals(h.url)) { c.close(); c = new Conn(h); conns.put(h.id, c); c.connect(); }
            else c.host = h; // pick up renames
        }
        refreshStatus();
    }

    private void refreshStatus() {
        int up = 0;
        for (Conn c : conns.values()) if (c.open) up++;
        String txt = conns.isEmpty() ? "No hosts watched"
                : "Watching " + conns.size() + " host" + (conns.size() > 1 ? "s" : "")
                + " · " + up + " connected";
        Notification n = new Notification.Builder(this, Notify.CH_MONITOR)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("S-remote monitor")
                .setContentText(txt)
                .setOngoing(true)
                .setContentIntent(PendingIntent.getActivity(this, 0,
                        new Intent(this, MainActivity.class),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                .build();
        getSystemService(android.app.NotificationManager.class).notify(FG_ID, n);
    }

    private Notification statusNotification() {
        return new Notification.Builder(this, Notify.CH_MONITOR)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("S-remote monitor")
                .setContentText("Starting…")
                .setOngoing(true)
                .setContentIntent(PendingIntent.getActivity(this, 0,
                        new Intent(this, MainActivity.class),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                .build();
    }

    // ---------------- per-session watch state ----------------
    private static class Watch {
        String name;
        boolean attached, attachSent, exited;
        boolean skipFirst = true;         // first "out" after attach is scrollback replay
        long lastLiveOut = 0, lastBell = 0, sinceIdle = 0;
        boolean idleNotified = true;      // don't fire until a busy period is seen
    }

    // ---------------- per-host websocket ----------------
    private class Conn extends WebSocketListener {
        Host host;
        WebSocket ws;
        final Map<String, Watch> watches = new HashMap<>();
        boolean open, gotList, everListed, dead;
        long backoff = RECONNECT_MIN;

        Conn(Host h) { host = h; }

        void connect() {
            if (dead) return;
            Request r = new Request.Builder().url(host.wsUrl()).build();
            ws = client.newWebSocket(r, this);
        }

        void close() {
            dead = true;
            try { if (ws != null) ws.close(1000, "bye"); } catch (Exception ignored) {}
        }

        void send(JSONObject o) {
            try { if (open && ws != null) ws.send(o.toString()); } catch (Exception ignored) {}
        }

        private void scheduleReconnect() {
            if (dead || destroyed) return;
            open = false;
            for (Watch w : watches.values()) { w.attached = false; w.attachSent = false; }
            gotList = false;
            handler.postDelayed(this::connect, backoff);
            backoff = Math.min(backoff * 2, RECONNECT_MAX);
            refreshStatus();
        }

        // ---- WebSocketListener ----
        @Override public void onOpen(WebSocket ws, Response r) {
            open = true;
            backoff = RECONNECT_MIN;
            try { ws.send(new JSONObject().put("type", "list").toString()); } catch (Exception ignored) {}
            handler.post(MonitorService.this::refreshStatus);
        }

        @Override public void onMessage(WebSocket ws, String text) {
            handler.post(() -> handle(text));
        }

        @Override public void onClosing(WebSocket ws, int code, String reason) {
            try { ws.close(code, reason); } catch (Exception ignored) {}
        }
        @Override public void onClosed(WebSocket ws, int code, String reason) { scheduleReconnect(); }
        @Override public void onFailure(WebSocket ws, Throwable t, Response r) { scheduleReconnect(); }

        // ---- message handling (always on main handler) ----
        private void handle(String text) {
            JSONObject m;
            try { m = new JSONObject(text); } catch (Exception e) { return; }
            String type = m.optString("type");
            switch (type) {
                case "sessions": onSessions(m.optJSONArray("list")); break;
                case "attached": {
                    Watch w = watches.get(m.optString("id"));
                    if (w != null) { w.attached = true; w.skipFirst = true; }
                    break;
                }
                case "out": onOut(m); break;
                case "exit": onExit(m.optString("id"), m.optInt("code", -1)); break;
            }
        }

        private void onSessions(JSONArray list) {
            if (list == null) return;
            HashSet<String> seen = new HashSet<>();
            for (int i = 0; i < list.length(); i++) {
                JSONObject s = list.optJSONObject(i);
                if (s == null) continue;
                String id = s.optString("id");
                if (id.isEmpty()) continue;
                seen.add(id);
                Watch w = watches.get(id);
                boolean exited = s.optBoolean("exited");
                if (w == null) {
                    w = new Watch();
                    w.name = s.optString("name", id);
                    w.exited = exited;
                    watches.put(id, w);
                    if (gotList || everListed) postEvent(host, "new:" + id,
                            host.name + " — new session", "“" + w.name + "” created");
                } else {
                    w.name = s.optString("name", w.name);
                    if (!w.exited && exited) onExit(id, -2); // caught via list diff
                    w.exited = exited;
                }
                if (!w.exited && !w.attachSent) {
                    w.attachSent = true;
                    try {
                        send(new JSONObject().put("type", "attach").put("id", id));
                    } catch (Exception ignored) {}
                }
            }
            watches.keySet().retainAll(seen);
            gotList = true;
            everListed = true;
        }

        private void onOut(JSONObject m) {
            Watch w = watches.get(m.optString("id"));
            if (w == null || w.exited) return;
            String data = m.optString("data");
            if (w.skipFirst) { w.skipFirst = false; return; } // scrollback replay — not live
            long now = System.currentTimeMillis();
            w.lastLiveOut = now;
            w.sinceIdle += data.length();
            if (w.sinceIdle >= IDLE_MIN_BYTES) w.idleNotified = false; // re-arm after real work
            if (isBell(data) && now - w.lastBell > BELL_THROTTLE) {
                w.lastBell = now;
                postEvent(host, "bell:" + m.optString("id"),
                        host.name + " — bell", "“" + w.name + "” signaled (command finished)");
            }
        }

        private void onExit(String id, int code) {
            Watch w = watches.get(id);
            if (w != null && w.exited) return; // already reported
            if (w != null) { w.exited = true; w.attached = false; w.attachSent = false; }
            String name = w != null ? w.name : id;
            String cd = code >= 0 ? " (code " + code + ")" : "";
            postEvent(host, "exit:" + id + ":" + code,
                    host.name + " — session ended", "“" + name + "” exited" + cd);
        }

        private void checkIdle(long now) {
            for (Map.Entry<String, Watch> e : watches.entrySet()) {
                Watch w = e.getValue();
                if (w.exited || w.idleNotified) continue;
                if (w.sinceIdle >= IDLE_MIN_BYTES && w.lastLiveOut > 0
                        && now - w.lastLiveOut > IDLE_MS) {
                    w.idleNotified = true;
                    w.sinceIdle = 0;
                    postEvent(host, "idle:" + e.getKey(),
                            host.name + " — quiet", "“" + w.name + "” went quiet — work likely done");
                }
            }
        }

        /** BEL, OSC 777, or OSC 9 — but NOT OSC 9;4 (taskbar progress, fires constantly) */
        private boolean isBell(String d) {
            if (d.indexOf(BEL) >= 0 || d.contains(OSC777)) return true;
            int i = 0;
            while ((i = d.indexOf(OSC9, i)) >= 0) {
                if (!d.startsWith("4;", i + OSC9.length())) return true;
                i += OSC9.length();
            }
            return false;
        }
    }

    private void postEvent(Host h, String tag, String title, String text) {
        Notify.event(this, h, tag, title, text);
    }
}
