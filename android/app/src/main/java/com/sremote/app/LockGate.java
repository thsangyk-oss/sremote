package com.sremote.app;

import android.app.Activity;
import android.content.Context;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.view.View;

/**
 * Optional app lock (fingerprint / face / screen lock). Android 11+ only —
 * on older devices or without enrolled credentials the option is hidden.
 * Re-locks after the app spent more than GRACE_MS in the background.
 */
final class LockGate {
    private static final long GRACE_MS = 30_000;
    private static final int AUTH = BiometricManager.Authenticators.BIOMETRIC_WEAK
            | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private static int started;
    private static long backgroundAt;
    private static boolean unlocked, prompting;

    static boolean available(Context c) {
        if (Build.VERSION.SDK_INT < 30) return false;
        BiometricManager bm = c.getSystemService(BiometricManager.class);
        return bm != null && bm.canAuthenticate(AUTH) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    static void onStart() { started++; }

    static void onStop() {
        if (--started <= 0) { started = 0; backgroundAt = System.currentTimeMillis(); }
    }

    /** call from onResume; hides the content until unlocked, finishes the task on cancel */
    static void check(Activity a) {
        if (Build.VERSION.SDK_INT < 30 || !new HostStore(a).lockEnabled() || !available(a)) return;
        boolean need = !unlocked || (backgroundAt > 0 && System.currentTimeMillis() - backgroundAt > GRACE_MS);
        backgroundAt = 0;
        if (!need) return;
        unlocked = false;
        if (prompting) return;
        prompting = true;
        View content = a.getWindow().getDecorView();
        content.setVisibility(View.INVISIBLE);
        BiometricPrompt p = new BiometricPrompt.Builder(a)
                .setTitle("Unlock S-remote")
                .setSubtitle("Your terminals stay private")
                .setAllowedAuthenticators(AUTH)
                .build();
        p.authenticate(new CancellationSignal(), a.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                prompting = false; unlocked = true;
                content.setVisibility(View.VISIBLE);
            }
            @Override public void onAuthenticationError(int code, CharSequence msg) {
                prompting = false;
                a.finishAffinity();
            }
        });
    }
}
