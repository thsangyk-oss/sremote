package com.sremote.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Enumeration;

public final class Tailscale {
    public static final String PKG = "com.tailscale.ipn";
    public static final String PLAY_URL =
            "https://play.google.com/store/apps/details?id=" + PKG;

    public static boolean installed(Context c) {
        try {
            c.getPackageManager().getPackageInfo(PKG, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /**
     * Tailnet IPv4 seen on this device, else null.
     * Primary path: ConnectivityManager VPN transports — the only reliable way
     * on Android 10+, where NetworkInterface enumeration hides VPN interfaces.
     */
    public static String tailnetIp(Context c) {
        try {
            ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
            if (cm != null) {
                for (Network n : cm.getAllNetworks()) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                    if (caps == null
                            || !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
                        continue;
                    LinkProperties lp = cm.getLinkProperties(n);
                    if (lp == null) continue;
                    String v6 = null;
                    for (LinkAddress la : lp.getLinkAddresses()) {
                        InetAddress a = la.getAddress();
                        String ip = a.getHostAddress();
                        if (a instanceof Inet4Address && isTailscaleV4(ip)) return ip;
                        if (ip != null && ip.startsWith("fd7a:115c:a1e0:")) v6 = ip;
                    }
                    if (v6 != null) return v6; // v6-only tailnet still counts
                }
            }
        } catch (Throwable ignored) {}

        // fallback: raw interface scan (older Android)
        try {
            Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces();
            while (en != null && en.hasMoreElements()) {
                NetworkInterface ni = en.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!(a instanceof Inet4Address)) continue;
                    String ip = a.getHostAddress();
                    if (isTailscaleV4(ip)) return ip;
                }
            }
        } catch (Throwable ignored) {}
        return null;
    }

    /** any VPN transport is up (Tailscale or other) — useful when link addresses are redacted */
    public static boolean vpnUp(Context c) {
        try {
            ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
            if (cm == null) return false;
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
                    return true;
            }
        } catch (Throwable ignored) {}
        return false;
    }

    public static boolean isTailscaleV4(String ip) {
        String[] p = ip.split("\\.");
        if (p.length != 4) return false;
        try {
            int a = Integer.parseInt(p[0]), b = Integer.parseInt(p[1]);
            return a == 100 && b >= 64 && b <= 127; // 100.64.0.0/10
        } catch (NumberFormatException e) { return false; }
    }

    /** opens Play Store page, falls back to the web URL */
    public static void openPlayStore(Context c) {
        try {
            c.startActivity(new Intent(Intent.ACTION_VIEW,
                    Uri.parse("market://details?id=" + PKG)));
        } catch (ActivityNotFoundException e) {
            c.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(PLAY_URL)));
        }
    }

    /** launches the Tailscale app; returns false if it can't be launched */
    public static boolean openApp(Context c) {
        Intent i = c.getPackageManager().getLaunchIntentForPackage(PKG);
        if (i == null) return false;
        c.startActivity(i);
        return true;
    }
}
