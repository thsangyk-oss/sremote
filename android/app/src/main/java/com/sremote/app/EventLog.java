package com.sremote.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Persistent notification history (newest first, capped). */
final class EventLog {
    private static final String PREFS = "sremote_events";
    private static final String KEY = "events";
    private static final int CAP = 300;

    static final String K_QUESTION = "question", K_DONE = "done", K_NEW = "new", K_EXIT = "exit";

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized void add(Context c, Host h, String session, String kind, String title, String text) {
        try {
            JSONArray old = new JSONArray(sp(c).getString(KEY, "[]"));
            JSONArray out = new JSONArray();
            out.put(new JSONObject()
                    .put("t", System.currentTimeMillis())
                    .put("host", h.id).put("hostName", h.name)
                    .put("session", session == null ? "" : session)
                    .put("kind", kind).put("title", title).put("text", text == null ? "" : text));
            for (int i = 0; i < old.length() && out.length() < CAP; i++) out.put(old.get(i));
            sp(c).edit().putString(KEY, out.toString()).apply();
        } catch (Exception ignored) {}
        StateBus.changed();
    }

    static synchronized List<JSONObject> list(Context c) {
        List<JSONObject> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(sp(c).getString(KEY, "[]"));
            for (int i = 0; i < a.length(); i++) out.add(a.getJSONObject(i));
        } catch (Exception ignored) {}
        return out;
    }

    static synchronized void clear(Context c) {
        sp(c).edit().remove(KEY).apply();
        StateBus.changed();
    }
}
