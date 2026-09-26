package com.sremote.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class Notify {
    public static final String CH_MONITOR = "monitor"; // persistent, low importance
    public static final String CH_EVENTS = "events";   // session events, heads-up

    public static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(
                CH_MONITOR, "S-remote monitor", NotificationManager.IMPORTANCE_MIN));
        nm.createNotificationChannel(new NotificationChannel(
                CH_EVENTS, "Session events", NotificationManager.IMPORTANCE_HIGH));
    }

    public static PendingIntent openHostIntent(Context c, Host h) {
        Intent i = new Intent(c, HostActivity.class);
        i.putExtra(HostActivity.EXTRA_HOST_ID, h.id);
        i.putExtra(HostActivity.EXTRA_NAME, h.name);
        i.putExtra(HostActivity.EXTRA_URL, h.url);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, h.id.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** posts an event notification tagged per (host, session, kind) so repeats update in place */
    public static void event(Context c, Host h, String tag, String title, String text) {
        ensureChannels(c);
        Notification n = new Notification.Builder(c, CH_EVENTS)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(openHostIntent(c, h))
                .setAutoCancel(true)
                .setShowWhen(true)
                .build();
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.notify(("sev:" + h.id + ":" + tag).hashCode(), n);
    }
}
