// Fixed bootstrap only; no repository text is compiled by Add-Type.
// The unnamed, non-inheritable job belongs to this validator. Normal exit or
// forced termination closes its last handle and kills ordinary descendants.
export const lifetimeBootstrap = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class ValidationLifetime {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    static IntPtr job;
    static Timer deadline;
    static void Stop() { TerminateJobObject(job, 1); }
    public static string Start(int milliseconds) {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new InvalidOperationException("Cannot create validation lifetime guard.");
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) ||
            !AssignProcessToJobObject(job, GetCurrentProcess())) {
            CloseHandle(job);
            throw new InvalidOperationException("Cannot attach validation lifetime guard.");
        }
        deadline = new Timer(delegate { Stop(); }, null, milliseconds, Timeout.Infinite);
        // One JSON line is the request. The host retains the sole writer until
        // completion; EOF means host death/cancellation even before startup.
        string request = Console.In.ReadLine();
        if (request == null) { Stop(); throw new EndOfStreamException(); }
        var watcher = new Thread(delegate() {
            try { Console.In.Read(); } catch { }
            Stop(); // EOF or unexpected additional input: fail closed
        });
        watcher.IsBackground = true;
        watcher.Start();
        return request;
    }
}
'@
`;
