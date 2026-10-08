package com.sremote.app;

import android.os.Handler;
import android.os.Looper;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

/** In-process live state shared by MonitorService (writer) and the UI (reader). */
final class StateBus {
    static final class Sess {
        final String id;
        String name, line = "", question;
        Detector.State state = Detector.State.IDLE;
        long since = System.currentTimeMillis();
        Sess(String id, String name) { this.id = id; this.name = name; }
    }

    private static final Map<String, Map<String, Sess>> hosts = new HashMap<>();
    private static final Map<String, Boolean> connected = new HashMap<>();
    private static final List<Runnable> listeners = new CopyOnWriteArrayList<>();
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static boolean posted;
    static volatile boolean monitorRunning;
    /** host id currently shown full-screen — its notifications are suppressed */
    static volatile String foregroundHost;

    private static final Runnable fire = () -> {
        posted = false;
        for (Runnable r : listeners) r.run();
    };

    static void listen(Runnable r) { listeners.add(r); }
    static void unlisten(Runnable r) { listeners.remove(r); }

    /** debounced change broadcast on the main thread */
    static void changed() {
        main.post(() -> { if (!posted) { posted = true; main.postDelayed(fire, 250); } });
    }

    static synchronized Sess sess(String hostId, String id, String name) {
        Map<String, Sess> m = hosts.get(hostId);
        if (m == null) { m = new LinkedHashMap<>(); hosts.put(hostId, m); }
        Sess s = m.get(id);
        if (s == null) { s = new Sess(id, name); m.put(id, s); }
        else if (name != null) s.name = name;
        return s;
    }

    static synchronized void update(String hostId, String id, String name, Detector.State st,
                                    String line, String question) {
        Sess s = sess(hostId, id, name);
        if (s.state != st) { s.state = st; s.since = System.currentTimeMillis(); }
        if (line != null && !line.isEmpty()) s.line = line;
        s.question = question;
    }

    static synchronized void retain(String hostId, Set<String> ids) {
        Map<String, Sess> m = hosts.get(hostId);
        if (m != null) m.keySet().retainAll(ids);
    }

    static synchronized void clearHost(String hostId) { hosts.remove(hostId); connected.remove(hostId); }

    static synchronized void clearAll() { hosts.clear(); connected.clear(); }

    static synchronized void setConnected(String hostId, boolean up) { connected.put(hostId, up); }

    static synchronized Boolean isConnected(String hostId) { return connected.get(hostId); }

    static synchronized List<Sess> sessions(String hostId) {
        Map<String, Sess> m = hosts.get(hostId);
        if (m == null) return Collections.emptyList();
        return new ArrayList<>(m.values());
    }
}
