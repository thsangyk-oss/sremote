// S-remote tray host - runs node server.js hidden, exposes a tray icon
// with start/stop/autostart controls. Compiled to /target:winexe so no
// console window ever appears (like AnyDesk's tray agent).
// Build: csc /nologo /target:winexe /out:SremoteTray.exe
//        /r:System.Drawing.dll /r:System.Windows.Forms.dll SremoteTray.cs
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.NetworkInformation;
using System.Threading;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;
using Microsoft.Win32;

class SremoteTray : Form {
  const int Port = 2209;
  const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
  const string RunName = "S-remote";

  NotifyIcon tray;
  ContextMenu menu;
  MenuItem miStatus, miOpen, miStart, miStop, miAuto;
  Process child;
  string root, exe;
  Icon iconRun, iconStop;
  Timer poll;

  static int Main() {
    bool first;
    using (var mx = new Mutex(true, "SremoteTraySingle", out first)) {
      if (!first) return 0;                          // already in tray
      Application.Run(new SremoteTray());
    }
    return 0;
  }

  public SremoteTray() {
    ShowInTaskbar = false; WindowState = FormWindowState.Minimized; Visible = false;
    exe = Application.ExecutablePath;
    root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(exe), @"..\.."));

    iconRun = MakeIcon(Color.FromArgb(30, 150, 80));
    iconStop = MakeIcon(Color.FromArgb(110, 110, 110));

    menu = new ContextMenu();
    menu.MenuItems.Add(miStatus = new MenuItem("S-remote"));
    menu.MenuItems.Add("-");
    menu.MenuItems.Add(miOpen = new MenuItem("Open Web UI", (s, e) => OpenUi()));
    menu.MenuItems.Add(miStart = new MenuItem("Start server", (s, e) => Start()));
    menu.MenuItems.Add(miStop = new MenuItem("Stop server", (s, e) => Stop()));
    menu.MenuItems.Add("-");
    menu.MenuItems.Add(miAuto = new MenuItem("Start with Windows", (s, e) => ToggleAuto()));
    menu.MenuItems.Add("-");
    menu.MenuItems.Add("Exit", (s, e) => Exit());
    miStatus.Enabled = false;

    tray = new NotifyIcon();
    tray.Text = "S-remote";
    tray.ContextMenu = menu;
    tray.Icon = iconStop;
    tray.Visible = true;
    tray.BalloonTipClicked += (s, e) => { if (Running()) OpenUi(); };
    tray.DoubleClick += (s, e) => { if (Running()) OpenUi(); };

    poll = new Timer(); poll.Interval = 2000;
    poll.Tick += (s, e) => RefreshState();
    poll.Start();

    Start();                                          // tray launch = server up
    RefreshState();
  }

  // ---------- icon: drawn, no .ico asset needed ----------
  static Icon MakeIcon(Color c) {
    var bmp = new Bitmap(16, 16);
    using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
      g.Clear(c);
      using (var f = new Font("Segoe UI", 9f, FontStyle.Bold, GraphicsUnit.Pixel))
      using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
        g.DrawString("S", f, Brushes.White, new RectangleF(0, 0, 16, 16), sf);
    }
    IntPtr h = bmp.GetHicon();
    var ic = Icon.FromHandle(h);
    return (Icon)ic.Clone();                          // clone so we own it; GetHicon icon would leak/die
  }

  // ---------- server lifecycle ----------
  bool Running() { return OwnerPid() != 0; }
  int OwnerPid() {
    try {
      foreach (var p in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
        if (p.Port == Port) {
          // endpoint found; map to pid via netstat (no managed api gives pid)
          return NetstatPid();
        }
    } catch { }
    return 0;
  }
  static int NetstatPid() {
    try {
      var psi = new ProcessStartInfo("netstat", "-ano -p tcp") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
      var pr = Process.Start(psi);
      string line;
      while ((line = pr.StandardOutput.ReadLine()) != null) {
        var t = line.Trim();
        if (t.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
        var parts = t.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 5 && parts[1].EndsWith(":" + Port)) return int.Parse(parts[4]);
      }
    } catch { }
    return 0;
  }
  string NodeExe() {
    var p = Path.Combine(root, "node", "node.exe");   // portable node from installer
    return File.Exists(p) ? p : "node";               // else system PATH
  }
  void Start() {
    if (Running()) { RefreshState(); return; }
    try {
      var psi = new ProcessStartInfo(NodeExe(), "server.js") {
        WorkingDirectory = root, UseShellExecute = false,
        CreateNoWindow = true, RedirectStandardOutput = false, RedirectStandardError = false
      };
      child = Process.Start(psi);
    } catch (Exception ex) {
      tray.ShowBalloonTip(3000, "S-remote", "start failed: " + ex.Message, ToolTipIcon.Error);
    }
    RefreshState();
  }
  void Stop() {
    try {
      if (child != null && !child.HasExited) child.Kill();
      else { int pid = OwnerPid(); if (pid != 0) Process.GetProcessById(pid).Kill(); }
    } catch { }
    child = null;
    RefreshState();
  }
  void OpenUi() {
    try { Process.Start("http://localhost:" + Port); } catch { }
  }
  void ToggleAuto() {
    try {
      var k = Registry.CurrentUser.OpenSubKey(RunKey, true);
      if (miAuto.Checked) k.DeleteValue(RunName, false);
      else k.SetValue(RunName, "\"" + exe + "\"");
      miAuto.Checked = !miAuto.Checked;
    } catch (Exception ex) {
      tray.ShowBalloonTip(3000, "S-remote", "autostart: " + ex.Message, ToolTipIcon.Error);
    }
  }
  void RefreshState() {
    bool run = Running();
    miStatus.Text = run ? "S-remote — running on :" + Port : "S-remote — stopped";
    miOpen.Enabled = run;
    miStart.Enabled = !run;
    miStop.Enabled = run;
    tray.Icon = run ? iconRun : iconStop;
    tray.Text = run ? "S-remote (running :2209)" : "S-remote (stopped)";
    try {
      var k = Registry.CurrentUser.OpenSubKey(RunKey, false);
      miAuto.Checked = k != null && k.GetValue(RunName) != null;
    } catch { }
  }
  void Exit() {
    if (child != null && !child.HasExited) {
      var r = MessageBox.Show("Stop the S-remote server too?", "S-remote",
        MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
      if (r == DialogResult.Cancel) return;
      if (r == DialogResult.Yes) Stop();
    }
    tray.Visible = false;
    Application.Exit();
  }
  protected override void SetVisibleCore(bool v) { base.SetVisibleCore(false); }  // never show the form
}
