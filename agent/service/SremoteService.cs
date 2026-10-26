// S-remote service host - a real Windows service (Session 0, LocalSystem)
// that keeps "node server.js" alive from boot, before any user logs on.
// AnyDesk-style: the broker is always up; a per-session user agent
// (agent/user-agent.js) supplies terminals + screen inside each logon
// session once someone signs in.
//
// Build: csc /nologo /target:exe /out:SremoteService.exe
//        /r:System.ServiceProcess.dll SremoteService.cs
// Install: sc.exe create Sremote binPath= "<exe>" start= auto
//          sc.exe failure Sremote reset= 86400 actions= restart/3000/restart/5000/restart/10000
using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

class SremoteService : ServiceBase {
  Process child;
  Thread watchdog;
  StreamWriter log;
  readonly object logLock = new object();
  volatile bool stopping;
  string root, nodeExe;

  public SremoteService() {
    // service name follows the exe filename so parallel/test installs can
    // coexist (SremoteService.exe -> "SremoteService")
    ServiceName = Path.GetFileNameWithoutExtension(
      System.Reflection.Assembly.GetExecutingAssembly().Location);
    CanStop = true;
    CanPauseAndContinue = false;
    AutoLog = true;
  }

  static int Main() {
    ServiceBase.Run(new SremoteService());
    return 0;
  }

  string NodeExe() {
    var p = Path.Combine(root, "node", "node.exe");   // portable node from installer
    return File.Exists(p) ? p : "node";               // else system PATH
  }

  void Log(string msg) {
    lock (logLock) {
      try {
        if (log == null) return;
        log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + msg);
        log.Flush();
      } catch { }
    }
  }

  void Spawn() {
    var psi = new ProcessStartInfo(nodeExe, "server.js") {
      WorkingDirectory = root,
      UseShellExecute = false,
      CreateNoWindow = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
    };
    psi.EnvironmentVariables["SREMOTE_SERVICE"] = "1";
    // optional overrides (SREMOTE_PORT, SREMOTE_AGENT_PORT, ...) — one
    // KEY=VALUE per line in data\service.env
    try {
      foreach (var line in File.ReadAllLines(Path.Combine(root, "data", "service.env"))) {
        var kv = line.IndexOf('=');
        if (kv > 0) psi.EnvironmentVariables[line.Substring(0, kv).Trim()] = line.Substring(kv + 1).Trim();
      }
    } catch { }
    child = Process.Start(psi);
    child.OutputDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
    child.ErrorDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
    child.BeginOutputReadLine();
    child.BeginErrorReadLine();
    Log("spawned node pid " + child.Id);
  }

  void Watchdog() {
    int fails = 0;
    while (!stopping) {
      Thread.Sleep(1000);
      if (stopping) break;
      try {
        if (child != null && !child.HasExited) { fails = 0; continue; }
        var when = child != null ? child.ExitTime : DateTime.MinValue;
        Log(child == null ? "node never started" : "node exited code " + child.ExitCode);
        fails++;
        if (fails >= 10) { Log("too many failures - stopping service"); Stop(); break; }
        var wait = Math.Min(15000, 1000 * fails) - (DateTime.Now - when).TotalMilliseconds;
        if (wait > 0) Thread.Sleep((int)wait);
        if (stopping) break;
        try { Spawn(); fails = 0; } catch (Exception e) { Log("spawn failed: " + e.Message); }
      } catch (Exception e) { Log("watchdog: " + e.Message); }
    }
  }

  protected override void OnStart(string[] args) {
    var exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
    root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(exe), @"..\.."));
    nodeExe = NodeExe();
    Directory.CreateDirectory(Path.Combine(root, "data"));
    var lp = Path.Combine(root, "data", "service.log");
    try {                       // keep the tail when the log outgrows 1 MB
      var fi = new FileInfo(lp);
      if (fi.Exists && fi.Length > 1024 * 1024) {
        var tail = new byte[512 * 1024];
        using (var fsr = new FileStream(lp, FileMode.Open, FileAccess.Read)) {
          fsr.Seek(-tail.Length, SeekOrigin.End);
          fsr.Read(tail, 0, tail.Length);
        }
        File.WriteAllBytes(lp, tail);
      }
    } catch { }
    log = new StreamWriter(lp, true);
    Log("=== service start, root " + root + " node " + nodeExe + " ===");
    stopping = false;
    try { Spawn(); } catch (Exception e) { Log("spawn failed: " + e.Message); }
    watchdog = new Thread(Watchdog) { IsBackground = true };
    watchdog.Start();
  }

  protected override void OnStop() {
    stopping = true;
    Log("=== service stop ===");
    try { if (child != null && !child.HasExited) child.Kill(); } catch { }
    if (watchdog != null) watchdog.Join(3000);
    lock (logLock) { try { log.Close(); } catch { } log = null; }
  }
}
