package com.sremote.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;

import java.util.List;

public final class Notify {
    public static final String CH_MONITOR = "monitor";   // persistent, low importance
    public static final String CH_QUESTION = "question"; // session waiting for input — heads-up
    public static final String CH_DONE = "done";         // task finished — heads-up
    public static final String CH_EVENTS = "events";     // session created / ended

    static final String EXTRA_HOST = "host", EXTRA_SID = "sid", EXTRA_SNAME = "sname",
            EXTRA_DATA = "data", EXTRA_NID = "nid";
    static final String KEY_REPLY = "reply";
    private static final int ACCENT = 0xFF6C7BD9;

    public static void ensureChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(
                CH_MONITOR, "Background monitor", NotificationManager.IMPORTANCE_MIN));
        NotificationChannel q = new NotificationChannel(
                CH_QUESTION, "Waiting for input", NotificationManager.IMPORTANCE_HIGH);
        q.setDescription("A session asks a question (y/n, menu, password…) — reply from the notification");
        nm.createNotificationChannel(q);
        NotificationChannel d = new NotificationChannel(
                CH_DONE, "Task finished", NotificationManager.IMPORTANCE_HIGH);
        d.setDescription("A command or agent finished and the session is back at the prompt");
        nm.createNotificationChannel(d);
        nm.createNotificationChannel(new NotificationChannel(
                CH_EVENTS, "Session started / ended", NotificationManager.IMPORTANCE_DEFAULT));
    }

    static int nid(Host h, String tag) { return ("sev:" + h.id + ":" + tag).hashCode(); }

    public static PendingIntent openHostIntent(Context c, Host h) {
        Intent i = new Intent(c, HostActivity.class);
        i.putExtra(HostActivity.EXTRA_HOST_ID, h.id);
        i.putExtra(HostActivity.EXTRA_NAME, h.name);
        i.putExtra(HostActivity.EXTRA_URL, h.url);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, h.id.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static Intent replyIntent(Context c, Host h, String sid, String sname, int nid) {
        return new Intent(c, ReplyReceiver.class)
                .putExtra(EXTRA_HOST, h.id).putExtra(EXTRA_SID, sid)
                .putExtra(EXTRA_SNAME, sname).putExtra(EXTRA_NID, nid);
    }

    /** free-text reply action (RemoteInput needs a mutable PendingIntent) */
    private static Notification.Action replyAction(Context c, Host h, String sid, String sname,
                                                   int nid, String label, String hint) {
        PendingIntent pi = PendingIntent.getBroadcast(c, nid * 31 + 7,
                replyIntent(c, h, sid, sname, nid),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        RemoteInput ri = new RemoteInput.Builder(KEY_REPLY).setLabel(hint).build();
        return new Notification.Action.Builder(
                Icon.createWithResource(c, R.drawable.ic_reply), label, pi)
                .addRemoteInput(ri).setAllowGeneratedReplies(false).build();
    }

    /** fixed-answer action: sends `data` verbatim */
    private static Notification.Action answerAction(Context c, Host h, String sid, String sname,
                                                    int nid, int idx, Detector.Answer a) {
        PendingIntent pi = PendingIntent.getBroadcast(c, nid * 31 + idx,
                replyIntent(c, h, sid, sname, nid).putExtra(EXTRA_DATA, a.data),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Action.Builder(
                Icon.createWithResource(c, R.drawable.ic_check), a.label, pi).build();
    }

    private static Notification.Builder base(Context c, String ch, Host h, String title, String text) {
        return new Notification.Builder(c, ch)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(ACCENT)
                .setContentTitle(title)
                .setContentText(text)
                .setSubText(h.name)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(openHostIntent(c, h))
                .setGroup("host:" + h.id)
                .setAutoCancel(true)
                .setShowWhen(true);
    }

    static void question(Context c, Host h, String sid, String sname, String text, List<Detector.Answer> answers) {
        ensureChannels(c);
        int id = nid(h, "q:" + sid);
        Notification.Builder b = base(c, CH_QUESTION, h, sname + " needs your input", text)
                .setCategory(Notification.CATEGORY_REMINDER);
        int i = 0;
        for (Detector.Answer a : answers) if (i < 2) b.addAction(answerAction(c, h, sid, sname, id, i++, a));
        b.addAction(replyAction(c, h, sid, sname, id, "Reply", "Answer for " + sname));
        c.getSystemService(NotificationManager.class).notify(id, b.build());
    }

    static void done(Context c, Host h, String sid, String sname, String title, String text) {
        ensureChannels(c);
        int id = nid(h, "d:" + sid);
        cancel(c, h, "q:" + sid);
        Notification.Builder b = base(c, CH_DONE, h, title, text)
                .setCategory(Notification.CATEGORY_STATUS)
                .addAction(replyAction(c, h, sid, sname, id, "Run command", "Command for " + sname));
        c.getSystemService(NotificationManager.class).notify(id, b.build());
    }

    static void session(Context c, Host h, String tag, String title, String text) {
        ensureChannels(c);
        Notification n = base(c, CH_EVENTS, h, title, text).build();
        c.getSystemService(NotificationManager.class).notify(nid(h, tag), n);
    }

    static void cancel(Context c, Host h, String tag) {
        c.getSystemService(NotificationManager.class).cancel(nid(h, tag));
    }

    static void test(Context c) {
        ensureChannels(c);
        Host demo = new Host("demo", "S-remote", "http://127.0.0.1:2209", true);
        Notification n = base(c, CH_DONE, demo, "Notifications work", "You'll be alerted when a task finishes or a session needs input.")
                .setContentIntent(PendingIntent.getActivity(c, 1, new Intent(c, MainActivity.class),
                        PendingIntent.FLAG_IMMUTABLE))
                .build();
        c.getSystemService(NotificationManager.class).notify(0x7e57, n);
    }
}
