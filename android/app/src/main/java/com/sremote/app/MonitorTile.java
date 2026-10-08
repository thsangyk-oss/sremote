package com.sremote.app;

import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/** Quick Settings tile: toggle background monitoring without opening the app. */
public class MonitorTile extends TileService {
    @Override public void onStartListening() { render(); }

    @Override public void onClick() {
        HostStore s = new HostStore(this);
        boolean on = !s.monitorEnabled();
        s.setMonitorEnabled(on);
        if (on) MonitorService.start(this); else MonitorService.stop(this);
        render();
    }

    private void render() {
        Tile t = getQsTile();
        if (t == null) return;
        boolean on = new HostStore(this).monitorEnabled();
        t.setState(on ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        t.setLabel("S-remote");
        if (android.os.Build.VERSION.SDK_INT >= 29) t.setSubtitle(on ? "Monitoring" : "Off");
        t.updateTile();
    }
}
