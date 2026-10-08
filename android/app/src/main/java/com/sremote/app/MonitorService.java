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
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Foreground service holding one websocket per watched S-remote host.
 * Every session's output runs through a {@link Detector}, which decides
 * RUNNING / QUESTION / DONE; transitions become notifications (with quick
 * answers + inline reply), history entries, and live UI state.
 */
public class MonitorService extends Service {
    private static final int FG_ID = 0x5e11;
    private static final long TICK_MS = 1_000;
    private static final long RECONNECT_MIN = 3_000, RECONNECT_MAX = 60_000;
    private static final long PENDING_TTL = 30_000;

    static final String ACTION_SEND = "com.sremote.app.SEND";

    private static MonitorService instance;

    private OkHttpClient client;
    private Handler handler;
    private HostStore store;
    private final Map<String, Conn> conns = new HashMap<>();
    private boolean destroyed = false;

    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            long now = System.currentTimeMillis();
            for (Conn c : conns.values()) c.tick(now);
            handler.postDelayed(this, TICK_MS);
        }
    };

    public static void start(Context c) {
        Intent i = new Intent(c, MonitorService.class);
        try { c.startForegroundService(i); } catch (Exception ignored) {}
    }
    public static void stop(Context c) {
        c.stopService(new Intent(c, MonitorService.class));
    }

    /** route input from a notification action into a session */
    static void sendInput(Context c, String hostId, String sid, String data) {
        MonitorService s = instance;
        if (s != null) { s.handler.post(() -> s.deliver(hostId, sid, data)); return; }
        Intent i = new Intent(c, MonitorService.class).setAction(ACTION_SEND)
                .putExtra(Notify.EXTRA_HOST, hostId).putExtra(Notify.EXTRA_SID, sid)
                .putExtra(Notify.EXTRA_DATA, data);
        try { c.startForegroundService(i); } catch (Exception ignored) {}
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        store = new HostStore(this);
        handler = new Handler(Looper.getMainLooper());
        client = new OkHttpClient.Builder()
                .pingInterval(20, TimeUnit.SECONDS) // WS keepalive through NAT/tailnet
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();
        Notify.ensureChannels(this);
        Notification n0 = statusNotification("Starting…");
        if (Build.VERSION.SDK_INT >= 29)
            startForeground(FG_ID, n0, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else
            startForeground(FG_ID, n0);
        StateBus.monitorRunning = true;
        handler.postDelayed(ticker, TICK_MS);
        resync();
    }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        resync();
        if (i != null && ACTION_SEND.equals(i.getAction()))
            deliver(i.getStringExtra(Notify.EXTRA_HOST), i.getStringExtra(Notify.EXTRA_SID),
                    i.getStringExtra(Notify.EXTRA_DATA));
        return START_STICKY;
    }

    @Override public void onDestroy() {
        destroyed = true;
        instance = null;
        StateBus.monitorRunning = false;
        handler.removeCallbacksAndMessages(null);
        for (Conn c : conns.values()) c.close();
        conns.clear();
        StateBus.clearAll();
        StateBus.changed();
        if (client != null) client.dispatcher().executorService().shutdown();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent i) { return null; }

    private void deliver(String hostId, String sid, String data) {
        if (hostId == null || sid == null || data == null) return;
        Conn c = conns.get(hostId);
        if (c == null) {
            Host h = store.find(hostId);
            if (h == null) return;
            c = new Conn(h); conns.put(h.id, c); c.connect();
        }
        c.input(sid, data);
    }

    /** converge live connections with the stored host list */
    synchronized void resync() {
        Map<String, Host> want = new HashMap<>();
        for (Host h : store.list()) if (h.notify) want.put(h.id, h);
        for (String id : new HashSet<>(conns.keySet()))
            if (!want.containsKey(id)) { conns.get(id).close(); conns.remove(id); StateBus.clearHost(id); }
        for (Host h : want.values()) {
            Conn c = conns.get(h.id);
            if (c == null) { c = new Conn(h); conns.put(h.id, c); c.connect(); }
            else if (!c.host.url.equals(h.url)) { c.close(); c = new Conn(h); conns.put(h.id, c); c.connect(); }
            else c.host = h; // pick up renames
        }
        refreshStatus();
    }

    private void refreshStatus() {
        int up = 0, run = 0, ask = 0;
        for (Conn c : conns.values()) {
            if (c.open) up++;
            for (Watch w : c.watches.values()) {
                Detector.State s = w.det.state();
                if (s == Detector.State.RUNNING) run++;
                else if (s == Detector.State.QUESTION) ask++;
            }
        }
        String txt;
        if (conns.isEmpty()) txt = "No hosts watched";
        else {
            txt = up + "/" + conns.size() + " host" + (conns.size() > 1 ? "s" : "") + " connected";
            if (run > 0) txt += " · " + run + " running";
            if (ask > 0) txt += " · " + ask + " waiting";
        }
        if (txt.equals(lastStatus)) return;
        getSystemService(android.app.NotificationManager.class).notify(FG_ID, statusNotification(txt));
    }

    private String lastStatus = "";

    private Notification statusNotification(String txt) {
        lastStatus = txt;
        return new Notification.Builder(this, Notify.CH_MONITOR)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("S-remote monitor")
                .setContentText(txt)
                .setOngoing(true)
                .setContentIntent(PendingIntent.getActivity(this, 0,
                        new Intent(this, MainActivity.class),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                .build();
    }

    private boolean screenOn() {
        PowerManager pm = getSystemService(PowerManager.class);
        return pm == null || pm.isInteractive();
    }

    /** user is looking at this host right now → history only, no alert */
    private boolean suppressed(Host h) {
        return h.id.equals(StateBus.foregroundHost) && screenOn();
    }

    // ---------------- per-session watch state ----------------
    private static class Watch {
        String name;
        boolean attachSent, exited;
        boolean skipFirst = true;   // first "out" after attach is scrollback replay
        final Detector det = new Detector();
        Detector.State published;
        String publishedLine = "";
    }

    // ---------------- per-host websocket ----------------
    private class Conn extends WebSocketListener {
        Host host;
        WebSocket ws;
        final Map<String, Watch> watches = new HashMap<>();
        final List<Object[]> pendingInput = new ArrayList<>(); // {sid, data, ts}
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

        void input(String sid, String data) {
            if (!open) { pendingInput.add(new Object[]{sid, data, System.currentTimeMillis()}); return; }
            try { send(new JSONObject().put("type", "in").put("id", sid).put("data", data)); } catch (Exception ignored) {}
        }

        private void flushInput() {
            long now = System.currentTimeMillis();
            for (Object[] p : pendingInput)
                if (now - (long) p[2] < PENDING_TTL) input((String) p[0], (String) p[1]);
            pendingInput.clear();
        }

        private void scheduleReconnect() {
            if (dead || destroyed) return;
            open = false;
            StateBus.setConnected(host.id, false);
            StateBus.changed();
            for (Watch w : watches.values()) { w.attachSent = false; w.skipFirst = true; }
            gotList = false;
            handler.postDelayed(this::connect, backoff);
            backoff = Math.min(backoff * 2, RECONNECT_MAX);
            refreshStatus();
        }

        // ---- WebSocketListener (okhttp threads → hop to main) ----
        @Override public void onOpen(WebSocket ws, Response r) {
            handler.post(() -> {
                open = true;
                backoff = RECONNECT_MIN;
                StateBus.setConnected(host.id, true);
                StateBus.changed();
                try { ws.send(new JSONObject().put("type", "list").toString()); } catch (Exception ignored) {}
                flushInput();
                refreshStatus();
            });
        }

        @Override public void onMessage(WebSocket ws, String text) { handler.post(() -> handle(text)); }

        @Override public void onClosing(WebSocket ws, int code, String reason) {
            try { ws.close(code, reason); } catch (Exception ignored) {}
        }
        @Override public void onClosed(WebSocket ws, int code, String reason) { handler.post(this::scheduleReconnect); }
        @Override public void onFailure(WebSocket ws, Throwable t, Response r) { handler.post(this::scheduleReconnect); }

        // ---- message handling (main thread) ----
        private void handle(String text) {
            JSONObject m;
            try { m = new JSONObject(text); } catch (Exception e) { return; }
            switch (m.optString("type")) {
                case "sessions": onSessions(m.optJSONArray("list")); break;
                case "attached": {
                    Watch w = watches.get(m.optString("id"));
                    if (w != null) w.skipFirst = true;
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
                    if (exited) w.det.exited();
                    watches.put(id, w);
                    if (gotList || everListed)
                        event(id, w, EventLog.K_NEW, "New session · " + w.name,
                                "“" + w.name + "” was created on " + host.name, null);
                } else {
                    w.name = s.optString("name", w.name);
                    if (!w.exited && exited) onExit(id, -2); // caught via list diff
                    w.exited = exited;
                }
                if (!w.exited && !w.attachSent) {
                    w.attachSent = true;
                    try { send(new JSONObject().put("type", "attach").put("id", id)); } catch (Exception ignored) {}
                }
                publish(id, w);
            }
            watches.keySet().retainAll(seen);
            StateBus.retain(host.id, seen);
            gotList = true;
            everListed = true;
            StateBus.changed();
        }

        private void onOut(JSONObject m) {
            String id = m.optString("id");
            Watch w = watches.get(id);
            if (w == null || w.exited) return;
            String data = m.optString("data");
            if (w.skipFirst) { w.skipFirst = false; w.det.seed(data); publish(id, w); return; }
            w.det.feed(data, System.currentTimeMillis());
            if (w.det.takeQuestionCleared()) Notify.cancel(MonitorService.this, host, "q:" + id);
            publish(id, w);
        }

        private void onExit(String id, int code) {
            Watch w = watches.get(id);
            if (w != null && w.exited) return; // already reported
            if (w != null) { w.exited = true; w.attachSent = false; w.det.exited(); }
            String name = w != null ? w.name : id;
            String cd = code >= 0 ? " (exit code " + code + ")" : "";
            Notify.cancel(MonitorService.this, host, "q:" + id);
            event(id, w, EventLog.K_EXIT, "Session ended · " + name, "“" + name + "” exited" + cd, null);
            if (w != null) publish(id, w);
        }

        void tick(long now) {
            for (Map.Entry<String, Watch> e : watches.entrySet()) {
                Watch w = e.getValue();
                if (w.exited) continue;
                Detector.Event ev = w.det.tick(now);
                if (ev != null) onDetect(e.getKey(), w, ev);
                publish(e.getKey(), w);
            }
        }

        private void onDetect(String id, Watch w, Detector.Event ev) {
            if (ev.kind.equals("question")) {
                event(id, w, EventLog.K_QUESTION, w.name + " needs your input", ev.text, Detector.answersFor(ev.text));
                return;
            }
            String title;
            switch (ev.reason) {
                case "exit": title = w.name + (ev.code > 0 ? " failed (exit " + ev.code + ")" : " finished"); break;
                case "stall": title = w.name + " went quiet — likely done"; break;
                case "notify": title = w.name + " · notification"; break;
                default: title = w.name + " finished";
            }
            String body = ev.text == null || ev.text.isEmpty() ? "Back at the prompt" : ev.text;
            event(id, w, EventLog.K_DONE, title, body, null);
        }

        /** push session state to the UI bus when it changes */
        private void publish(String id, Watch w) {
            Detector.State st = w.exited ? Detector.State.EXITED : w.det.state();
            String line = w.det.lastLine();
            if (st == w.published && line.equals(w.publishedLine)) return;
            boolean stateChanged = st != w.published;
            w.published = st; w.publishedLine = line;
            StateBus.update(host.id, id, w.name, st, line, w.det.question());
            StateBus.changed();
            if (stateChanged) refreshStatus();
        }

        /** history always; notification unless muted by kind or user is watching this host */
        private void event(String sid, Watch w, String kind, String title, String text, List<Detector.Answer> answers) {
            String sname = w != null ? w.name : sid;
            EventLog.add(MonitorService.this, host, sname, kind, title, text);
            if (suppressed(host)) return;
            switch (kind) {
                case EventLog.K_QUESTION:
                    if (store.notifyKind(HostStore.N_QUESTION))
                        Notify.question(MonitorService.this, host, sid, sname, text, answers);
                    break;
                case EventLog.K_DONE:
                    if (store.notifyKind(HostStore.N_DONE))
                        Notify.done(MonitorService.this, host, sid, sname, title, text);
                    break;
                default:
                    if (store.notifyKind(HostStore.N_SESSION))
                        Notify.session(MonitorService.this, host, kind + ":" + sid, title, text);
            }
        }
    }
}
