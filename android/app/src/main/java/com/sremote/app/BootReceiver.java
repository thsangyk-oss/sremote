package com.sremote.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** restarts the session monitor after reboot (best effort) */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())) return;
        if (new HostStore(c).monitorEnabled()) MonitorService.start(c);
    }
}
