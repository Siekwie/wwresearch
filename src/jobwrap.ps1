# Windows only. Runs the agent command inside a Job Object, so that everything
# the agent starts - shells, compilers, `nohup ... &` background searches - is
# in one group that can be stopped as a whole:
#
#   * when the agent exits, whatever it left running is killed with it
#   * when this wrapper is killed (Shut down, timeout, lease expiry, Ctrl+C),
#     the job handle closes and Windows kills every process in it
#   * every process in the job runs at below-normal priority, so a swarm of
#     CPU-heavy agents can't make the desktop unusable
#
# The command line comes from WWR_JOB_CMD; stdin/stdout/stderr are inherited.

$ErrorActionPreference = 'Stop'
$cmd = $env:WWR_JOB_CMD
if (-not $cmd) { [Console]::Error.WriteLine('wwresearch jobwrap: WWR_JOB_CMD is empty'); exit 2 }

$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class WwrJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct EXTENDED_LIMIT {
    public BASIC_LIMIT Basic;
    public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXTENDED_LIMIT info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

  const uint LIMIT_PRIORITY_CLASS = 0x20, LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const uint BELOW_NORMAL_PRIORITY_CLASS = 0x4000;
  static IntPtr job; // keep the handle open for the lifetime of this process

  /// Put this process (and so everything it starts from now on) into a new job.
  public static string Enter() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return "CreateJobObject failed (" + Marshal.GetLastWin32Error() + ")";
    var info = new EXTENDED_LIMIT();
    info.Basic.LimitFlags = LIMIT_KILL_ON_JOB_CLOSE | LIMIT_PRIORITY_CLASS;
    info.Basic.PriorityClass = BELOW_NORMAL_PRIORITY_CLASS;
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(EXTENDED_LIMIT))))
      return "SetInformationJobObject failed (" + Marshal.GetLastWin32Error() + ")";
    if (!AssignProcessToJobObject(job, GetCurrentProcess()))
      return "AssignProcessToJobObject failed (" + Marshal.GetLastWin32Error() + ")";
    return null;
  }

  public static int Run(string commandLine) {
    var psi = new ProcessStartInfo("cmd.exe", "/d /s /c \"" + commandLine + "\"");
    psi.UseShellExecute = false; // inherit our stdin/stdout/stderr
    using (var p = Process.Start(psi)) {
      p.WaitForExit();
      return p.ExitCode;
    }
  }
}
'@

$code = 1
try {
  Add-Type -TypeDefinition $source -Language CSharp
  $problem = [WwrJob]::Enter()
  if ($problem) { [Console]::Error.WriteLine("wwresearch jobwrap: $problem - running without a job; leftover processes may survive") }
  $code = [WwrJob]::Run($cmd)
} catch {
  [Console]::Error.WriteLine("wwresearch jobwrap: $($_.Exception.Message)")
  $code = 2
}
# Exiting closes the job handle: anything the agent left running dies here.
[Environment]::Exit($code)
