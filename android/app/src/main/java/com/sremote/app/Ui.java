package com.sremote.app;

import android.app.Activity;
import android.content.Context;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;

/** Material You palette (dynamic colors on Android 12+) + tiny code-built widget kit. */
final class Ui {
    final Context c;
    final boolean dark;
    // M3 color roles
    final int surface, onSurface, onSurfaceVariant, container, containerHigh, outline, outlineVariant;
    final int primary, onPrimary, primaryContainer, onPrimaryContainer;
    final int secondaryContainer, onSecondaryContainer, tertiaryContainer, onTertiaryContainer;
    // status roles
    final int ok, okContainer, warn, warnContainer, err, errContainer;

    Ui(Context ctx) {
        c = ctx;
        dark = (ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        if (Build.VERSION.SDK_INT >= 31) {
            if (dark) {
                surface = sys(android.R.color.system_neutral1_900);
                container = sys(android.R.color.system_neutral1_800);
                containerHigh = sys(android.R.color.system_neutral2_800);
                onSurface = sys(android.R.color.system_neutral1_100);
                onSurfaceVariant = sys(android.R.color.system_neutral2_200);
                outline = sys(android.R.color.system_neutral2_400);
                outlineVariant = sys(android.R.color.system_neutral2_700);
                primary = sys(android.R.color.system_accent1_200);
                onPrimary = sys(android.R.color.system_accent1_800);
                primaryContainer = sys(android.R.color.system_accent1_700);
                onPrimaryContainer = sys(android.R.color.system_accent1_100);
                secondaryContainer = sys(android.R.color.system_accent2_700);
                onSecondaryContainer = sys(android.R.color.system_accent2_100);
                tertiaryContainer = sys(android.R.color.system_accent3_700);
                onTertiaryContainer = sys(android.R.color.system_accent3_100);
            } else {
                surface = sys(android.R.color.system_neutral1_10);
                container = sys(android.R.color.system_neutral1_50);
                containerHigh = sys(android.R.color.system_neutral2_100);
                onSurface = sys(android.R.color.system_neutral1_900);
                onSurfaceVariant = sys(android.R.color.system_neutral2_700);
                outline = sys(android.R.color.system_neutral2_500);
                outlineVariant = sys(android.R.color.system_neutral2_200);
                primary = sys(android.R.color.system_accent1_600);
                onPrimary = sys(android.R.color.system_accent1_0);
                primaryContainer = sys(android.R.color.system_accent1_100);
                onPrimaryContainer = sys(android.R.color.system_accent1_900);
                secondaryContainer = sys(android.R.color.system_accent2_100);
                onSecondaryContainer = sys(android.R.color.system_accent2_900);
                tertiaryContainer = sys(android.R.color.system_accent3_100);
                onTertiaryContainer = sys(android.R.color.system_accent3_900);
            }
        } else if (dark) { // static M3 baseline (indigo seed)
            surface = 0xFF121318; container = 0xFF1E1F25; containerHigh = 0xFF292A2F;
            onSurface = 0xFFE3E1E9; onSurfaceVariant = 0xFFC6C5D0; outline = 0xFF90909A; outlineVariant = 0xFF45464F;
            primary = 0xFFB9C3FF; onPrimary = 0xFF1F2C61; primaryContainer = 0xFF364379; onPrimaryContainer = 0xFFDDE1FF;
            secondaryContainer = 0xFF424659; onSecondaryContainer = 0xFFDFE1F9;
            tertiaryContainer = 0xFF5B3D57; onTertiaryContainer = 0xFFFFD7F3;
        } else {
            surface = 0xFFFBF8FF; container = 0xFFEFEDF4; containerHigh = 0xFFE9E7EF;
            onSurface = 0xFF1B1B21; onSurfaceVariant = 0xFF46464F; outline = 0xFF767680; outlineVariant = 0xFFC6C5D0;
            primary = 0xFF4C5C92; onPrimary = 0xFFFFFFFF; primaryContainer = 0xFFDCE1FF; onPrimaryContainer = 0xFF04174B;
            secondaryContainer = 0xFFDFE1F9; onSecondaryContainer = 0xFF171B2C;
            tertiaryContainer = 0xFFFFD7F3; onTertiaryContainer = 0xFF2C1229;
        }
        if (dark) {
            ok = 0xFF7DDC8E; okContainer = 0xFF1C3B24;
            warn = 0xFFF5C26B; warnContainer = 0xFF45320B;
            err = 0xFFFFB4AB; errContainer = 0xFF5C1A15;
        } else {
            ok = 0xFF1E7A3A; okContainer = 0xFFCDEFD3;
            warn = 0xFF8A5A00; warnContainer = 0xFFFFE2B3;
            err = 0xFFBA1A1A; errContainer = 0xFFFFDAD6;
        }
    }

    private int sys(int res) { return c.getColor(res); }

    int dp(float v) { return (int) (v * c.getResources().getDisplayMetrics().density + .5f); }

    int dialogTheme() {
        return dark ? android.R.style.Theme_DeviceDefault_Dialog_Alert
                    : android.R.style.Theme_DeviceDefault_Light_Dialog_Alert;
    }

    /** status/nav bars match the surface; dark icons in light mode */
    void applyWindow(Activity a, int barColor) {
        Window w = a.getWindow();
        w.setStatusBarColor(barColor);
        w.setNavigationBarColor(barColor);
        View d = w.getDecorView();
        int f = d.getSystemUiVisibility();
        if (!dark) f |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        else f &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        d.setSystemUiVisibility(f);
    }

    // ---------- drawables ----------
    GradientDrawable round(int color, float r) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color); g.setCornerRadius(dp(r));
        return g;
    }

    GradientDrawable stroke(int fill, float r, int strokeColor) {
        GradientDrawable g = round(fill, r);
        g.setStroke(dp(1), strokeColor);
        return g;
    }

    GradientDrawable oval(int color) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL); g.setColor(color);
        return g;
    }

    Drawable ripple(Drawable content, float r) {
        int rc = (onSurface & 0x00FFFFFF) | 0x26000000;
        return new RippleDrawable(ColorStateList.valueOf(rc), content, round(0xFFFFFFFF, r));
    }

    // ---------- widgets ----------
    TextView text(CharSequence s, float sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s); t.setTextSize(sp); t.setTextColor(color);
        t.setTypeface(bold ? Typeface.create("sans-serif-medium", Typeface.NORMAL) : Typeface.DEFAULT);
        return t;
    }

    TextView title(CharSequence s) {
        TextView t = text(s, 30, onSurface, false);
        t.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        t.setLetterSpacing(-0.01f);
        return t;
    }

    TextView label(CharSequence s) {
        TextView t = text(s, 14, primary, true);
        t.setPadding(dp(4), dp(20), dp(4), dp(8));
        return t;
    }

    TextView oneLine(TextView t) {
        t.setSingleLine(true); t.setEllipsize(TextUtils.TruncateAt.END);
        return t;
    }

    TextView mono(CharSequence s, float sp, int color) {
        TextView t = oneLine(text(s, sp, color, false));
        t.setTypeface(Typeface.MONOSPACE);
        return t;
    }

    ImageView icon(int res, int color, float sizeDp) {
        ImageView iv = new ImageView(c);
        iv.setImageResource(res);
        iv.setImageTintList(ColorStateList.valueOf(color));
        iv.setLayoutParams(new LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp)));
        return iv;
    }

    /** 48dp round touch target with a 24dp icon */
    ImageView iconButton(int res, int color) {
        ImageView iv = icon(res, color, 48);
        iv.setPadding(dp(12), dp(12), dp(12), dp(12));
        iv.setBackground(ripple(oval(0x00000000), 24));
        return iv;
    }

    TextView filledButton(CharSequence s) {
        TextView b = text(s, 14, onPrimary, true);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(24), dp(10), dp(24), dp(10));
        b.setMinHeight(dp(40));
        b.setBackground(ripple(round(primary, 20), 20));
        return b;
    }

    TextView tonalButton(CharSequence s) {
        TextView b = text(s, 14, onSecondaryContainer, true);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(20), dp(9), dp(20), dp(9));
        b.setMinHeight(dp(40));
        b.setBackground(ripple(round(secondaryContainer, 20), 20));
        return b;
    }

    TextView textButton(CharSequence s) {
        TextView b = text(s, 14, primary, true);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(12), dp(9), dp(12), dp(9));
        b.setBackground(ripple(round(0x00000000, 20), 20));
        return b;
    }

    /** filter chip */
    TextView chip(CharSequence s, boolean selected) {
        TextView t = text(s, 13, selected ? onSecondaryContainer : onSurfaceVariant, true);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(16), dp(7), dp(16), dp(7));
        t.setBackground(ripple(selected ? round(secondaryContainer, 8) : stroke(0x00000000, 8, outlineVariant), 8));
        return t;
    }

    /** small status pill */
    TextView pill(CharSequence s, int fg, int bg) {
        TextView t = text(s, 12, fg, true);
        t.setPadding(dp(10), dp(3), dp(10), dp(3));
        t.setBackground(round(bg, 10));
        return t;
    }

    View dot(int color, float size) {
        View v = new View(c);
        v.setBackground(oval(color));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(size), dp(size));
        v.setLayoutParams(lp);
        return v;
    }

    TextView avatar(String name, int bg, int fg) {
        String l = name == null || name.isEmpty() ? "?" : name.substring(0, 1).toUpperCase();
        TextView t = text(l, 18, fg, true);
        t.setGravity(Gravity.CENTER);
        t.setBackground(oval(bg));
        t.setLayoutParams(new LinearLayout.LayoutParams(dp(42), dp(42)));
        return t;
    }

    /** rounded surface card */
    LinearLayout card(int color) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(dp(16), dp(14), dp(16), dp(14));
        l.setBackground(ripple(round(color, 24), 24));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, 0, 0, dp(10));
        l.setLayoutParams(lp);
        return l;
    }

    LinearLayout hrow() {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    LinearLayout vcol() {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    static LinearLayout.LayoutParams weight1() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
    }

    LinearLayout.LayoutParams margins(int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(l), dp(t), dp(r), dp(b));
        return lp;
    }

    Switch toggle(boolean on) {
        Switch s = new Switch(c);
        s.setChecked(on);
        int[][] st = {{android.R.attr.state_checked}, {}};
        s.setThumbTintList(new ColorStateList(st, new int[]{onPrimary, outline}));
        s.setTrackTintList(new ColorStateList(st, new int[]{primary, containerHigh}));
        return s;
    }

    /** settings-style row: title + optional subtitle + trailing view */
    LinearLayout settingRow(String title, String sub, View trailing) {
        LinearLayout r = hrow();
        r.setPadding(dp(16), dp(12), dp(12), dp(12));
        r.setMinimumHeight(dp(56));
        LinearLayout tc = vcol();
        tc.addView(text(title, 16, onSurface, false));
        if (sub != null) {
            TextView s = text(sub, 13, onSurfaceVariant, false);
            s.setPadding(0, dp(2), 0, 0);
            tc.addView(s);
        }
        r.addView(tc, weight1());
        if (trailing != null) r.addView(trailing);
        return r;
    }

    // ---------- session state presentation ----------
    int stateColor(Detector.State s) {
        switch (s) {
            case RUNNING: return primary;
            case QUESTION: return warn;
            case DONE: return ok;
            case EXITED: return outline;
            default: return onSurfaceVariant;
        }
    }

    int stateContainer(Detector.State s) {
        switch (s) {
            case RUNNING: return primaryContainer;
            case QUESTION: return warnContainer;
            case DONE: return okContainer;
            default: return containerHigh;
        }
    }

    static String stateLabel(Detector.State s) {
        switch (s) {
            case RUNNING: return "Running";
            case QUESTION: return "Needs input";
            case DONE: return "Done";
            case EXITED: return "Exited";
            default: return "Idle";
        }
    }

    static String ago(long t) {
        long s = Math.max(0, (System.currentTimeMillis() - t) / 1000);
        if (s < 45) return "just now";
        if (s < 3600) return (s / 60 == 0 ? 1 : s / 60) + "m ago";
        if (s < 86400) return s / 3600 + "h ago";
        return s / 86400 + "d ago";
    }
}
