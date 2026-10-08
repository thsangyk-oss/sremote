package com.sremote.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

public class HostStore {
    private static final String PREFS = "sremote";
    private static final String KEY_HOSTS = "hosts";
    private static final String KEY_MONITOR = "monitor_enabled";

    private final SharedPreferences sp;
    private int seq = 0;

    public HostStore(Context c) {
        sp = c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public synchronized List<Host> list() {
        List<Host> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(sp.getString(KEY_HOSTS, "[]"));
            for (int i = 0; i < a.length(); i++) out.add(Host.fromJson(a.getJSONObject(i)));
        } catch (Exception ignored) {}
        return out;
    }

    public synchronized Host add(String name, String url) {
        Host h = new Host("h" + Long.toString(System.currentTimeMillis(), 36) + (++seq), name, url, true);
        List<Host> l = list();
        l.add(h);
        saveAll(l);
        return h;
    }

    public synchronized void update(Host h) {
        List<Host> l = list();
        for (int i = 0; i < l.size(); i++)
            if (l.get(i).id.equals(h.id)) { l.set(i, h); break; }
        saveAll(l);
    }

    public synchronized void remove(String id) {
        List<Host> l = list();
        l.removeIf(h -> h.id.equals(id));
        saveAll(l);
    }

    public synchronized Host find(String id) {
        for (Host h : list()) if (h.id.equals(id)) return h;
        return null;
    }

    private void saveAll(List<Host> l) {
        JSONArray a = new JSONArray();
        for (Host h : l) a.put(h.toJson());
        sp.edit().putString(KEY_HOSTS, a.toString()).apply();
    }

    public boolean monitorEnabled() { return sp.getBoolean(KEY_MONITOR, false); }
    public void setMonitorEnabled(boolean v) { sp.edit().putBoolean(KEY_MONITOR, v).apply(); }

    // per-kind notification toggles + app lock
    public static final String N_QUESTION = "n_question", N_DONE = "n_done", N_SESSION = "n_session";
    private static final String KEY_LOCK = "lock_enabled";

    public boolean notifyKind(String key) { return sp.getBoolean(key, true); }
    public void setNotifyKind(String key, boolean v) { sp.edit().putBoolean(key, v).apply(); }
    public boolean lockEnabled() { return sp.getBoolean(KEY_LOCK, false); }
    public void setLockEnabled(boolean v) { sp.edit().putBoolean(KEY_LOCK, v).apply(); }
}
