package com.sremote.app;

import android.app.NotificationManager;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

/** Notification actions: quick answers (y/n, menu digit) and free-text replies → session input. */
public class ReplyReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        String hostId = i.getStringExtra(Notify.EXTRA_HOST);
        String sid = i.getStringExtra(Notify.EXTRA_SID);
        String sname = i.getStringExtra(Notify.EXTRA_SNAME);
        String data = i.getStringExtra(Notify.EXTRA_DATA);
        if (data == null) {
            Bundle r = RemoteInput.getResultsFromIntent(i);
            CharSequence typed = r == null ? null : r.getCharSequence(Notify.KEY_REPLY);
            if (typed == null) return;
            data = typed.toString() + "\r";
        }
        if (hostId == null || sid == null) return;
        MonitorService.sendInput(c, hostId, sid, data);
        c.getSystemService(NotificationManager.class).cancel(i.getIntExtra(Notify.EXTRA_NID, 0));
        String shown = data.replace("\r", "⏎");
        Toast.makeText(c, "Sent " + shown + " → " + (sname == null ? "session" : sname), Toast.LENGTH_SHORT).show();
    }
}
