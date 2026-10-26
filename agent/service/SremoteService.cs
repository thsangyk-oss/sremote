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
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
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
    if (File.Exists(p)) return p;
    // session env blocks we build for console agents lack the user's PATH
    // additions, so resolve "node" to an absolute path from the service env
    foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
      try {
        var q = Path.Combine(d.Trim(), "node.exe");
        if (File.Exists(q)) return q;
      } catch { }
    return "node";
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
    consoleWatch = new Thread(ConsoleWatch) { IsBackground = true };
    consoleWatch.Start();
  }

  protected override void OnStop() {
    stopping = true;
    Log("=== service stop ===");
    try { if (child != null && !child.HasExited) child.Kill(); } catch { }
    try { if (consoleProc != null && !consoleProc.HasExited) consoleProc.Kill(); } catch { }
    if (watchdog != null) watchdog.Join(3000);
    if (consoleWatch != null) consoleWatch.Join(3000);
    lock (logLock) { try { log.Close(); } catch { } log = null; }
  }

  // ---------- console-session agent (AnyDesk-style) -------------------------
  // The console session exists BEFORE anyone logs in (winlogon.exe owns it).
  // Spawning agent\user-agent.js into it as SYSTEM gives the broker hands on
  // the real display: screen capture + input work at the logon screen too.
  // After the user signs in the same session becomes theirs, so the agent
  // keeps relaying the visible desktop without a handover.
  Thread consoleWatch;
  int consoleSess = -1;
  Process consoleProc;

  void ConsoleWatch() {
    while (!stopping) {
      try { EnsureConsoleAgent(); } catch (Exception e) { Log("console watch: " + e.Message); }
      Thread.Sleep(15000);
    }
  }

  void EnsureConsoleAgent() {
    uint s = WTSGetActiveConsoleSessionId();
    if (s == 0xFFFFFFFF) return;                       // no console session yet
    bool alive = consoleProc != null && !consoleProc.HasExited;
    if (alive && consoleSess == (int)s) return;
    if (alive && consoleSess != (int)s) {              // console switched (e.g. fast user switch)
      try { consoleProc.Kill(); } catch { }
    }
    int pid = SpawnInSession((int)s,
      "\"" + nodeExe + "\" \"" + Path.Combine(root, "agent", "user-agent.js") + "\"",
      root, "SREMOTE_CONSOLE=1\0SREMOTE_SESSION_ID=" + s + "\0");
    if (pid == 0) return;
    consoleSess = (int)s;
    consoleProc = Process.GetProcessById(pid);
    Log("console agent pid " + pid + " in session " + s);
  }

  // PsExec -i equivalent: duplicate our SYSTEM token into the target session
  // and CreateProcessAsUser there. Needs SE_TCB (LocalSystem has it).
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, int acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr tok, int acc, IntPtr sa, int imp, int type, out IntPtr dup);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr tok, int cls, ref int info, int len);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr tok, bool inherit);
  [DllImport("userenv.dll")] static extern bool DestroyEnvironmentBlock(IntPtr env);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessAsUser(IntPtr tok, string app, string cmd, IntPtr pa, IntPtr ta,
    bool inh, int flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  int SpawnInSession(int sessId, string cmd, string dir, string extraEnv) {
    IntPtr tok = IntPtr.Zero, dup = IntPtr.Zero, envBlk = IntPtr.Zero, envPtr = IntPtr.Zero;
    var pi = new PROCESS_INFORMATION();
    string step = "init";
    try {
      step = "OpenProcessToken";
      if (!OpenProcessToken(Process.GetCurrentProcess().Handle,
            0x0001 /*ASSIGN_PRIMARY*/ | 0x0002 /*DUPLICATE*/ | 0x0008 /*QUERY*/, out tok))
        throw new System.ComponentModel.Win32Exception();
      step = "DuplicateTokenEx";
      if (!DuplicateTokenEx(tok, 0xF01FF /*TOKEN_ALL_ACCESS*/, IntPtr.Zero,
            2 /*SecurityImpersonation*/, 1 /*TokenPrimary*/, out dup))
        throw new System.ComponentModel.Win32Exception();
      step = "SetTokenInformation";
      if (!SetTokenInformation(dup, 12 /*TokenSessionId*/, ref sessId, 4))
        throw new System.ComponentModel.Win32Exception();
      step = "CreateEnvironmentBlock";
      if (!CreateEnvironmentBlock(out envBlk, dup, false))
        throw new System.ComponentModel.Win32Exception();
      // append our vars to the double-null-terminated UNICODE block — the last
      // var's NUL is part of the terminator, so re-add one before extraEnv.
      // CreateEnvironmentBlock on a bare duplicated SYSTEM token is near-empty:
      // no PATH/SystemRoot, so inject the minimum a node child needs too.
      var bytes = new List<byte>();
      for (int i = 0; ; i += 2) {
        byte b0 = Marshal.ReadByte(envBlk, i), b1 = Marshal.ReadByte(envBlk, i + 1);
        if (b0 == 0 && b1 == 0) break;
        bytes.Add(b0); bytes.Add(b1);
      }
      var windir = Environment.GetEnvironmentVariable("WINDIR") ?? @"C:\Windows";
      var drive = Environment.GetEnvironmentVariable("SystemDrive") ?? "C:";
      var baseEnv =
        "SystemRoot=" + windir + "\0" +
        "windir=" + windir + "\0" +
        "SystemDrive=" + drive + "\0" +
        "TEMP=" + windir + "\\Temp\0TMP=" + windir + "\\Temp\0" +
        "PATH=" + windir + "\\system32;" + windir + ";" + windir + "\\system32\\Wbem;"
          + windir + "\\system32\\WindowsPowerShell\\v1.0;" + Path.GetDirectoryName(nodeExe) + "\0";
      var envBytes = System.Text.Encoding.Unicode.GetBytes(
        System.Text.Encoding.Unicode.GetString(bytes.ToArray()) + "\0" + baseEnv + extraEnv + "\0");
      envPtr = Marshal.AllocHGlobal(envBytes.Length);
      Marshal.Copy(envBytes, 0, envPtr, envBytes.Length);
      var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = "winsta0\\default" };
      step = "CreateProcessAsUser";
      if (!CreateProcessAsUser(dup, null, cmd, IntPtr.Zero, IntPtr.Zero, false,
            0x00000400 /*CREATE_UNICODE_ENVIRONMENT*/ | 0x08000000 /*CREATE_NO_WINDOW*/,
            envPtr, dir, ref si, out pi))
        throw new System.ComponentModel.Win32Exception();
      CloseHandle(pi.hThread);
      return pi.dwProcessId;
    } catch (Exception e) {
      Log("SpawnInSession(" + sessId + ") " + step + ": " + e.Message);
      return 0;
    } finally {
      if (envPtr != IntPtr.Zero) Marshal.FreeHGlobal(envPtr);
      if (envBlk != IntPtr.Zero) DestroyEnvironmentBlock(envBlk);
      if (dup != IntPtr.Zero) CloseHandle(dup);
      if (tok != IntPtr.Zero) CloseHandle(tok);
    }
  }
}
