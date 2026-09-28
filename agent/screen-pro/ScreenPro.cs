// S-remote Screen Pro agent - push-mode remote desktop.
// stdin : JSONL commands  {op:config|click|down|up|move|scroll|type|key|ping|quit}
// stdout: [u32le len][u8 type][payload]   len = 1 + payload length
//   'J' = JSON text   (ready / info / err)
//   'F' = tile frame  [u16 outW][u16 outH][u16 tile][u16 count]
//                     then per tile: [u16 x][u16 y][u16 w][u16 h][u32 jlen][jpeg bytes]
// Capture: DXGI Desktop Duplication (event-driven, primary monitor) with
// GDI BitBlt fallback (whole virtual screen). Only changed 64px tiles are
// jpeg-encoded and pushed; cursor is drawn into the frame.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;

// ---------- DXGI / D3D11 via raw vtable delegates (no COM interop interfaces) ----------
[StructLayout(LayoutKind.Sequential)]
public struct DXGI_OUTDUPL_FRAME_INFO { public long LastPresentTime; public long LastMouseUpdateTime; public uint AccumulatedFrames; public int RectsCoalesced; public int ProtectedContentMaskedOut; public POINT2 PointerPosition; public int TotalMetadataBufferSize; public int PointerShapeBufferSize; }
[StructLayout(LayoutKind.Sequential)] public struct POINT2 { public int x; public int y; }
[StructLayout(LayoutKind.Sequential)]
public struct D3D11_TEXTURE2D_DESC { public uint Width, Height, MipLevels, ArraySize; public int Format; public uint SampleCount, SampleQuality; public uint Usage, BindFlags, CPUAccessFlags, MiscFlags; }
[StructLayout(LayoutKind.Sequential)] public struct D3D11_MAPPED_SUBRESOURCE { public IntPtr pData; public uint RowPitch; public uint DepthPitch; }

class Dxgi : IDisposable {
  [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int dt, IntPtr sw, uint flags, IntPtr levels, int n, uint ver, out IntPtr dev, out int lvl, out IntPtr ctx);
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr f);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int QID(IntPtr s, ref Guid iid, out IntPtr o);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdaptD(IntPtr s, uint i, out IntPtr o);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DupOutD(IntPtr s, IntPtr dev, out IntPtr o);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int AcquireD(IntPtr s, uint ms, out DXGI_OUTDUPL_FRAME_INFO fi, out IntPtr res);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SimpleD(IntPtr s);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexD(IntPtr s, ref D3D11_TEXTURE2D_DESC d, IntPtr data, out IntPtr t);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapD(IntPtr s, IntPtr res, uint sub, int map, uint flags, out D3D11_MAPPED_SUBRESOURCE m);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int UnmapD(IntPtr s, IntPtr res, uint sub);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CopyResD(IntPtr s, IntPtr dst, IntPtr src);

  static T M<T>(IntPtr obj, int slot) {
    IntPtr fn = Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(fn, typeof(T));
  }
  static int Rel(IntPtr p) { return p == IntPtr.Zero ? 0 : M<SimpleD>(p, 2)(p); }

  IntPtr dev, ctx, dup, staging;

  public int W, H;
  public Dxgi() {
    IntPtr d, c; int lvl;
    int hr = D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0, IntPtr.Zero, 0, 7, out d, out lvl, out c);
    if (hr != 0) throw new Exception("D3D11CreateDevice " + hr.ToString("X8"));
    dev = d; ctx = c;
    Guid f1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IntPtr fp; hr = CreateDXGIFactory1(ref f1, out fp);
    if (hr != 0) throw new Exception("factory " + hr.ToString("X8"));
    IntPtr ap; hr = M<EnumAdaptD>(fp, 12)(fp, 0, out ap);          // IDXGIFactory1::EnumAdapters1
    Rel(fp);
    if (hr != 0) throw new Exception("adapter " + hr.ToString("X8"));
    IntPtr o0; hr = M<EnumAdaptD>(ap, 7)(ap, 0, out o0);           // IDXGIAdapter::EnumOutputs
    Rel(ap);
    if (hr != 0) throw new Exception("output " + hr.ToString("X8"));
    Guid o1iid = new Guid("00cddea8-939b-4b83-a340-a685226666cc"); // IID_IDXGIOutput1
    IntPtr o1; hr = M<QID>(o0, 0)(o0, ref o1iid, out o1);
    Rel(o0);
    if (hr != 0) throw new Exception("output1 " + hr.ToString("X8"));
    IntPtr dp; hr = M<DupOutD>(o1, 22)(o1, dev, out dp);           // IDXGIOutput1::DuplicateOutput
    Rel(o1);
    if (hr != 0) throw new Exception("dup " + hr.ToString("X8"));
    dup = dp;
    W = Screen.PrimaryScreen.Bounds.Width; H = Screen.PrimaryScreen.Bounds.Height;
    var sd = new D3D11_TEXTURE2D_DESC();
    sd.Width = (uint)W; sd.Height = (uint)H; sd.MipLevels = 1; sd.ArraySize = 1;
    sd.Format = 87; sd.SampleCount = 1; sd.Usage = 3; sd.BindFlags = 0; sd.CPUAccessFlags = 0x20000; sd.MiscFlags = 0;
    hr = M<CreateTexD>(dev, 5)(dev, ref sd, IntPtr.Zero, out staging);   // ID3D11Device::CreateTexture2D
    if (hr != 0) throw new Exception("staging " + hr.ToString("X8"));
  }
  public bool Acquire(uint timeoutMs, Bitmap dst) {
    DXGI_OUTDUPL_FRAME_INFO fi; IntPtr res;
    int hr = M<AcquireD>(dup, 8)(dup, timeoutMs, out fi, out res);       // AcquireNextFrame
    if (hr == unchecked((int)0x887A0027)) return false;                  // WAIT_TIMEOUT
    if (hr != 0) throw new Exception("acquire " + hr.ToString("X8"));
    try {
      M<CopyResD>(ctx, 47)(ctx, staging, res);                           // CopyResource
      D3D11_MAPPED_SUBRESOURCE map;
      hr = M<MapD>(ctx, 14)(ctx, staging, 0, 1, 0, out map);             // Map READ
      if (hr == 0) {
        var bd = dst.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        unsafe {
          byte* s = (byte*)map.pData, d2 = (byte*)bd.Scan0;
          int rb = W * 4;
          for (int y = 0; y < H; y++) Buffer.MemoryCopy(s + (long)y * map.RowPitch, d2 + (long)y * bd.Stride, rb, rb);
        }
        dst.UnlockBits(bd);
        M<UnmapD>(ctx, 15)(ctx, staging, 0);                             // Unmap
      }
    } finally { M<SimpleD>(dup, 14)(dup); Rel(res); }                    // ReleaseFrame + release res
    return true;
  }
  public void Dispose() { try { Rel(staging); Rel(dup); Rel(ctx); Rel(dev); } catch { } }
}
// ---------- end DXGI ----------

class ScreenPro {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO pci);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hcur, int w, int h, int step, IntPtr brush, uint flags);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr hIcon, ref ICONINFO ii);
  struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT2 ptScreenPos; }
  struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

  static readonly JavaScriptSerializer JS = new JavaScriptSerializer();
  static Stream stdout;
  static readonly object wlock = new object();
  static volatile int outW = 1280, fps = 12, jpegQ = 70;
  static volatile bool running = true;
  // captured region (screen coords): bitblt = virtual screen, dxgi = primary
  static int capX, capY, capW, capH;

  static void Send(byte type, byte[] payload) {
    byte[] head = BitConverter.GetBytes(payload.Length + 1);
    lock (wlock) { stdout.Write(head, 0, 4); stdout.WriteByte(type); stdout.Write(payload, 0, payload.Length); stdout.Flush(); }
  }
  static void J(object o) { Send((byte)'J', Encoding.UTF8.GetBytes(JS.Serialize(o))); }
  static void InfoErr(string msg) { J(new Dictionary<string, object> { { "op", "err" }, { "msg", msg } }); }

  static void ToScreen(double fx, double fy, out int sx, out int sy) {
    sx = capX + (int)(fx * capW); sy = capY + (int)(fy * capH);
  }
  static void ClickAt(double x, double y, string btn, bool dbl, string only) {
    int sx, sy; ToScreen(x, y, out sx, out sy); SetCursorPos(sx, sy);
    uint dn, up;
    if (btn == "r") { dn = 0x08; up = 0x10; } else if (btn == "m") { dn = 0x20; up = 0x40; } else { dn = 0x02; up = 0x04; }
    if (only == "down") { mouse_event(dn, 0, 0, 0, IntPtr.Zero); return; }
    if (only == "up") { mouse_event(up, 0, 0, 0, IntPtr.Zero); return; }
    int n = dbl ? 2 : 1;
    for (int i = 0; i < n; i++) { mouse_event(dn, 0, 0, 0, IntPtr.Zero); mouse_event(up, 0, 0, 0, IntPtr.Zero); }
  }
  static void SendText(string t) {
    var sb = new StringBuilder();
    foreach (char c in t) {
      if ("+^%~(){}[]".IndexOf(c) >= 0) { sb.Append('{'); sb.Append(c); sb.Append('}'); }
      else if (c == '\r' || c == '\n') sb.Append("{ENTER}");
      else sb.Append(c);
    }
    SendKeys.SendWait(sb.ToString());
  }
  static double Num(IDictionary<string, object> m, string k, double d) { return m.ContainsKey(k) && m[k] != null ? Convert.ToDouble(m[k]) : d; }
  static string Str(IDictionary<string, object> m, string k, string d) { return m.ContainsKey(k) && m[k] != null ? Convert.ToString(m[k]) : d; }
  static bool Bool(IDictionary<string, object> m, string k) { return m.ContainsKey(k) && m[k] is bool && (bool)m[k]; }

  static void Reader() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      try {
        var m = JS.Deserialize<Dictionary<string, object>>(line);
        switch (Str(m, "op", "")) {
          case "config":
            outW = (int)Num(m, "w", outW); fps = (int)Num(m, "fps", fps); jpegQ = (int)Num(m, "q", jpegQ);
            if (outW < 320) outW = 320; if (outW > 4096) outW = 4096;
            if (fps < 1) fps = 1; if (fps > 30) fps = 30;
            if (jpegQ < 10) jpegQ = 10; if (jpegQ > 95) jpegQ = 95;
            break;
          case "click": ClickAt(Num(m, "x", 0), Num(m, "y", 0), Str(m, "btn", "l"), Bool(m, "dbl"), null); break;
          case "down": ClickAt(Num(m, "x", 0), Num(m, "y", 0), Str(m, "btn", "l"), false, "down"); break;
          case "up": ClickAt(Num(m, "x", 0), Num(m, "y", 0), Str(m, "btn", "l"), false, "up"); break;
          case "move": { int sx, sy; ToScreen(Num(m, "x", 0), Num(m, "y", 0), out sx, out sy); SetCursorPos(sx, sy); break; }
          case "scroll": { int sx, sy; ToScreen(Num(m, "x", 0), Num(m, "y", 0), out sx, out sy); SetCursorPos(sx, sy); mouse_event(0x0800, 0, 0, (uint)(int)Num(m, "d", 0), IntPtr.Zero); break; }
          case "type": SendText(Str(m, "text", "")); break;
          case "key": SendKeys.SendWait(Str(m, "k", "")); break;
          case "ping": J(new Dictionary<string, object> { { "op", "pong" } }); break;
          case "quit": running = false; return;
        }
      } catch (Exception e) { InfoErr("cmd: " + e.Message); }
    }
    running = false;
  }

  static ImageCodecInfo JpegCodec() {
    foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") return c;
    return null;
  }

  static void CaptureLoop() {
    var jpg = JpegCodec();
    var ep = new EncoderParameters(1);
    int prevQ = jpegQ;
    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)jpegQ);

    Dxgi dx = null; string src = "bitblt";
    try { dx = new Dxgi(); capX = 0; capY = 0; capW = dx.W; capH = dx.H; src = "dxgi"; }
    catch (Exception e) {
      var v = SystemInformation.VirtualScreen; capX = v.Left; capY = v.Top; capW = v.Width; capH = v.Height;
      InfoErr("dxgi off: " + e.Message);
    }
    J(new Dictionary<string, object> { { "op", "info" }, { "w", capW }, { "h", capH }, { "src", src } });

    const int TS = 64;
    int curW = 0, curH = 0;
    Bitmap outBmp = null, fullBmp = null;
    byte[] aBuf = null; uint[] aHash = null, bHash = null;
    long lastKey = 0; bool forceAll = true;

    while (running) {
      try {
        int interval = 1000 / fps;
        bool sizeChanged = (outBmp == null || curW != outW || fullBmp == null || fullBmp.Width != capW || fullBmp.Height != capH);
        if (sizeChanged && (fullBmp == null || fullBmp.Width != capW || fullBmp.Height != capH)) {
          if (fullBmp != null) fullBmp.Dispose();
          fullBmp = new Bitmap(capW, capH, PixelFormat.Format32bppArgb);
        }
        bool got;
        if (dx != null) {
          // event-driven: blocks until change or timeout
          got = dx.Acquire((uint)(sizeChanged ? 0 : interval), fullBmp);
        } else {
          using (var g = Graphics.FromImage(fullBmp))
            g.CopyFromScreen(capX, capY, 0, 0, new Size(capW, capH), CopyPixelOperation.SourceCopy);
          got = true;
          Thread.Sleep(Math.Max(5, interval));   // bitblt path is expensive; poll at ~fps
        }
        bool keyDue = (Environment.TickCount - lastKey) > 20000;
        if (!got && !sizeChanged && !keyDue) continue;

        if (sizeChanged) {
          curW = outW; curH = Math.Max(1, (int)(capH * (double)curW / capW));
          if (outBmp != null) outBmp.Dispose();
          outBmp = new Bitmap(curW, curH, PixelFormat.Format32bppArgb);
          int tiles = ((curW + TS - 1) / TS) * ((curH + TS - 1) / TS);
          aHash = new uint[tiles]; bHash = new uint[tiles];
          aBuf = new byte[curW * curH * 4];
          forceAll = true;
        }
        if (ep.Param[0] == null || prevQ != jpegQ) { ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)jpegQ); prevQ = jpegQ; }

        if (got) {
          // overlay hardware cursor (dxgi frames don't include it)
          var ci = new CURSORINFO(); ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
          if (GetCursorInfo(ref ci) && ci.flags == 1 && ci.hCursor != IntPtr.Zero) {
            var ii = new ICONINFO(); GetIconInfo(ci.hCursor, ref ii);
            using (var g = Graphics.FromImage(fullBmp)) {
              IntPtr hdc = g.GetHdc();
              DrawIconEx(hdc, ci.ptScreenPos.x - capX - ii.xHotspot, ci.ptScreenPos.y - capY - ii.yHotspot, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3);
              g.ReleaseHdc(hdc);
            }
          }
          using (var g = Graphics.FromImage(outBmp)) {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
            g.DrawImage(fullBmp, 0, 0, curW, curH);
          }
          var bd = outBmp.LockBits(new Rectangle(0, 0, curW, curH), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
          Marshal.Copy(bd.Scan0, aBuf, 0, curW * curH * 4);
          outBmp.UnlockBits(bd);
        }

        int colsT = (curW + TS - 1) / TS, rowsT = (curH + TS - 1) / TS;
        var dirty = new List<int>();
        for (int ty = 0; ty < rowsT; ty++) for (int tx = 0; tx < colsT; tx++) {
            int w = Math.Min(TS, curW - tx * TS), h = Math.Min(TS, curH - ty * TS);
            uint h1 = 2166136261u;
            for (int y = 0; y < h; y++) {
              int row = ((ty * TS + y) * curW + tx * TS) * 4;
              for (int x = 0; x < w * 4; x += 8) { h1 ^= aBuf[row + x]; h1 *= 16777619; }
            }
            int idx = ty * colsT + tx; aHash[idx] = h1;
            if (forceAll || keyDue || h1 != bHash[idx]) dirty.Add(idx);
          }
        forceAll = false;
        if (keyDue) lastKey = Environment.TickCount;
        if (dirty.Count == 0) { var t2 = aHash; aHash = bHash; bHash = t2; continue; }

        using (var ms = new MemoryStream()) {
          var bw = new BinaryWriter(ms);
          bw.Write((ushort)curW); bw.Write((ushort)curH); bw.Write((ushort)TS); bw.Write((ushort)dirty.Count);
          foreach (int idx in dirty) {
            int tx = idx % colsT, ty = idx / colsT;
            int x = tx * TS, y = ty * TS, w = Math.Min(TS, curW - x), h = Math.Min(TS, curH - y);
            using (var tile = outBmp.Clone(new Rectangle(x, y, w, h), PixelFormat.Format24bppRgb)) {
              var tms = new MemoryStream(); tile.Save(tms, jpg, ep); var tb = tms.GetBuffer(); int tl = (int)tms.Length;
              bw.Write((ushort)x); bw.Write((ushort)y); bw.Write((ushort)w); bw.Write((ushort)h); bw.Write((uint)tl); bw.Write(tb, 0, tl);
            }
          }
          bw.Flush(); Send((byte)'F', ms.ToArray());
        }
        var th = aHash; aHash = bHash; bHash = th;
      } catch (Exception e) {
        InfoErr("cap: " + e.Message);
        if (dx != null) { try { dx.Dispose(); } catch { } dx = null; var v = SystemInformation.VirtualScreen; capX = v.Left; capY = v.Top; capW = v.Width; capH = v.Height; forceAll = true; }
        Thread.Sleep(500);
      }
    }
    if (dx != null) dx.Dispose();
    if (outBmp != null) outBmp.Dispose();
    if (fullBmp != null) fullBmp.Dispose();
  }

  static int Main() {
    stdout = Console.OpenStandardOutput();
    J(new Dictionary<string, object> { { "op", "ready" } });
    var cap = new Thread(CaptureLoop); cap.IsBackground = true; cap.Start();
    Reader();
    running = false;
    cap.Join(1500);
    return 0;
  }
}
