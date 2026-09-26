package com.sremote.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;

/** minimal content provider so the camera app can write into cacheDir/cam/ */
public class MiniFileProvider extends ContentProvider {
    public static final String AUTH = "com.sremote.app.fileprovider";

    public static Uri uri(Context c, File f) {
        return new Uri.Builder().scheme("content").authority(AUTH)
                .encodedPath("/cam/" + Uri.encode(f.getName())).build();
    }

    private File base() { return new File(getContext().getCacheDir(), "cam"); }

    private File resolve(Uri u) {
        String name = u.getLastPathSegment();
        if (name == null || name.contains("..")) return null;
        return new File(base(), name);
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri u, String mode) throws FileNotFoundException {
        File f = resolve(u);
        if (f == null || !f.exists()) throw new FileNotFoundException(String.valueOf(u));
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Cursor query(Uri u, String[] proj, String sel, String[] selArgs, String order) {
        File f = resolve(u);
        MatrixCursor c = new MatrixCursor(new String[]{
                OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        if (f != null && f.exists()) c.addRow(new Object[]{f.getName(), f.length()});
        return c;
    }

    @Override public String getType(Uri u) {
        File f = resolve(u);
        String ext = f != null ? MimeTypeMap.getFileExtensionFromUrl(f.getName()) : "";
        String t = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return t != null ? t : "application/octet-stream";
    }

    @Override public String[] getStreamTypes(Uri u, String filter) {
        return new String[]{getType(u)};
    }

    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
    @Override public int delete(Uri u, String s, String[] a) {
        File f = resolve(u);
        return f != null && f.delete() ? 1 : 0;
    }
}
