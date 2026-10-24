// Browzie Lens: the on-screen virtual cursor.
//
// Separate, click-through, per-pixel-alpha windows that draw Claude's cursor, a glow frame around
// the controlled viewport and a banner for handoffs. They are OS windows over the Browzie Chrome
// window, not part of any web page, so websites cannot see them, and Chrome's own screenshots
// (captureVisibleTab) do not include them. Each is shown only where the Browzie window itself is
// visible, so your other windows cover the cursor the way they cover Chrome.
//
// It also watches your real mouse and keyboard with low-level hooks, which mark input that
// software injected (including the key Chrome simulates to bring a window to the front). Only
// hardware input that touches the Browzie window is reported: a click, wheel or key there means
// you are taking over; your pointer resting over it means "wait". What you do in other windows
// is ignored, so you can keep working while Browzie works. Key contents are never read.
//
// Protocol: JSON lines on stdin from the Browzie host, JSON lines on stdout.
//   {"op":"move","x":..,"y":..,"al":..,"at":..,"s":..}   screen DIPs + screen DIP origin + scale
//   {"op":"down"} {"op":"up"} {"op":"show","label":".."} {"op":"hide"}
//   {"op":"frame","x":..,"y":..,"w":..,"h":..,"al":..,"at":..,"s":..,"label":".."}
//   {"op":"banner","text":".."}            empty text hides it
//   {"op":"where"}                         answers with the tip position (tests)
//   frame also carries "title" (the Browzie window's tab title) and "ww","wh" (its size in DIPs),
//   used to find that window among your other Chrome windows, and "key" (its Chrome window id)
//   {"op":"place","rid":..,"key":..,"title":..,"w":..,"h":..,"anchor":hwnd,"desk":..,"fill":bool,"wait":ms}
//                                          a Chrome window that just opened: move it to the virtual
//                                          desktop of window "anchor" (or desktop "desk": a number or
//                                          a GUID) and, with fill, restore it there filling the
//                                          screen. The window is never activated.
//   {"op":"restore","rid":..,"key":..,"title":..}   un-minimise that window without activating it
// Out: {"ev":"ready"} {"ev":"where","x":..,"y":..}
//      {"ev":"input","kind":"mouse"|"key","browzie":true|false}   hardware input (browzie: in the Browzie window)
//      {"ev":"over","on":true|false}                          your pointer entered / left the Browzie window
//      {"ev":"reply","rid":..,...}                            the answer to place and restore
//
// One-shot modes (run by the MCP server and the tests):
//   browzie-lens.exe --anchor <pid>      the window that process runs in (its terminal), found by
//                                      walking up the process tree, and that window's desktop
//   browzie-lens.exe --desktops          the virtual desktops in order, and the current one
//   browzie-lens.exe --launch <exe> ...  start a program minimised, without activating it
//
// Build (no SDK needed, csc.exe ships with Windows):
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /optimize
//     /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll
//     /out:browzie-lens.exe Lens.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Native
{
    public const int WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20, WS_EX_TOPMOST = 0x8,
        WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000;
    public const int ULW_ALPHA = 2;
    public const uint SWP_NOSIZE = 0x1, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int W, H; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLEND { public byte Op, Flags, Alpha, Format; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUT { public uint cbSize, dwTime; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }

    [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINT p, ref SIZE s, IntPtr src, ref POINT sp, int key, ref BLEND b, int flags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUT li);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc fn, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT minPos, maxPos; public RECT normal; }
    public const uint SWP_NOZORDER = 0x4, SWP_NOOWNERZORDER = 0x200;
    public const int SW_SHOWNOACTIVATE = 4, SW_SHOWMINNOACTIVE = 7;

    public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time);
    [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc fn, uint pid, uint thread, uint flags);

    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32 { public uint size, usage, pid; public IntPtr heap; public uint module, threads, ppid; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO { public int cb; public string reserved, desktop, title; public int x, y, w, h, xChars, yChars, fill, flags; public short show, reserved2; public IntPtr reserved3, stdIn, stdOut, stdErr; }
    [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr process, thread; public int pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    public static string ClassOf(IntPtr h) { var s = new System.Text.StringBuilder(128); GetClassName(h, s, 128); return s.ToString(); }
    public static string TitleOf(IntPtr h) { var s = new System.Text.StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    public static uint PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
    public static string Q(string s) { return new JavaScriptSerializer().Serialize(s ?? ""); }
}

// Virtual desktops. The documented IVirtualDesktopManager tells which desktop a window is on.
// (The overlay layers need no moving: they are hidden whenever the Browzie window is not on the
// desktop in view, and Windows shows a window again on the desktop in view.) Moving another
// program's window (the Chrome window Browzie drives) takes the shell's internal desktop manager,
// whose interface ids change between Windows builds: only the builds listed in Ids() are used,
// every call's result is checked, and anything unexpected leaves the window where it is.
static class Desks
{
    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVirtualDesktopManager
    {
        [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr h, out int on);
        [PreserveSig] int GetWindowDesktopId(IntPtr h, out Guid id);
        [PreserveSig] int MoveWindowToDesktop(IntPtr h, ref Guid id);
    }
    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IServiceProvider10 { [PreserveSig] int QueryService(ref Guid service, ref Guid riid, out IntPtr obj); }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutPtr(IntPtr self, out IntPtr v);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutUint(IntPtr self, out uint v);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutGuid(IntPtr self, out Guid v);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetAtFn(IntPtr self, uint i, ref Guid riid, out IntPtr v);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ViewForHwnd(IntPtr self, IntPtr h, out IntPtr view);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MoveView(IntPtr self, IntPtr view, IntPtr desktop);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int NoArgs(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DeskArg(IntPtr self, IntPtr desktop);
    static T Slot<T>(IntPtr o, int i) { IntPtr vt = Marshal.ReadIntPtr(o); return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, i * IntPtr.Size), typeof(T)); }

    // (the shell's objects go stale when Explorer restarts: they are dropped and made again)
    static IVirtualDesktopManager vdm;
    static IVirtualDesktopManager Vdm
    {
        get
        {
            if (vdm == null) vdm = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")));
            return vdm;
        }
    }
    public static Guid Of(IntPtr h)
    {
        try { Guid g; return Vdm.GetWindowDesktopId(h, out g) == 0 ? g : Guid.Empty; }
        catch { vdm = null; return Guid.Empty; }
    }
    public static bool OnCurrent(IntPtr h)
    {
        try { int on; return Vdm.IsWindowOnCurrentVirtualDesktop(h, out on) == 0 && on != 0; }
        catch { vdm = null; return true; }
    }
    static int Build()
    {
        try { return int.Parse(Convert.ToString(Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber", "0"))); }
        catch { return 0; }
    }
    // The internal desktop manager's and desktop's interface ids by Windows build. On these builds
    // MoveViewToDesktop, GetCurrentDesktop, GetDesktops and SwitchDesktop sit at vtable slots 4, 6, 7
    // and 9 and take no monitor argument (Windows 11 21H2 and early 22H2 builds did, so they are left out).
    static string[] Ids()
    {
        int b = Build();
        if (b >= 26100) return new[] { "53F5CA0B-158F-4124-900C-057158060B27", "3F07F4BE-B107-441A-AF0F-39D82529072C" };
        if (b >= 22621) return new[] { "A3175F2D-239C-4BD2-8AA0-EEBA8B0B138E", "3F07F4BE-B107-441A-AF0F-39D82529072C" };
        if (b >= 19041 && b < 22000) return new[] { "B2F925B9-5A0F-4D2E-9F4D-2B1507593C10", "FF72FFDD-BE7E-43FC-9C03-AD81681E88E4" };
        return null;
    }
    delegate void ManagerFn(IntPtr manager, IServiceProvider10 shell, Guid desktopIid);
    static string WithManager(ManagerFn fn)
    {
        string[] ids = Ids();
        if (ids == null) return "unsupported Windows build " + Build();
        IntPtr m = IntPtr.Zero;
        try
        {
            var shell = (IServiceProvider10)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239")));
            Guid svc = new Guid("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B"), iid = new Guid(ids[0]);
            int hr = shell.QueryService(ref svc, ref iid, out m);
            if (hr != 0 || m == IntPtr.Zero) { m = IntPtr.Zero; return "no desktop manager for this Windows build (0x" + hr.ToString("x") + ")"; }
            fn(m, shell, new Guid(ids[1]));
            return "";
        }
        catch (Exception e) { return e.GetType().Name + ": " + e.Message; }
        finally { if (m != IntPtr.Zero) Marshal.Release(m); }
    }
    // Calls keep(id, desktop) for each desktop in Task View order; keep returns true to hold on to
    // that desktop object (the caller then releases it).
    static void Each(IntPtr m, Guid vdIid, Func<Guid, IntPtr, bool> keep)
    {
        IntPtr arr;
        if (Slot<OutPtr>(m, 7)(m, out arr) != 0 || arr == IntPtr.Zero) return;
        try
        {
            uint n;
            if (Slot<OutUint>(arr, 3)(arr, out n) != 0) return;
            for (uint i = 0; i < n; i++)
            {
                IntPtr d;
                if (Slot<GetAtFn>(arr, 4)(arr, i, ref vdIid, out d) != 0 || d == IntPtr.Zero) continue;
                Guid id;
                bool kept = Slot<OutGuid>(d, 4)(d, out id) == 0 && keep(id, d);
                if (!kept) Marshal.Release(d);
            }
        }
        finally { Marshal.Release(arr); }
    }
    public static List<Guid> All()
    {
        var list = new List<Guid>();
        WithManager((m, shell, vdIid) => Each(m, vdIid, (id, d) => { list.Add(id); return false; }));
        return list;
    }
    public static Guid Current()
    {
        Guid cur = Guid.Empty;
        WithManager((m, shell, vdIid) =>
        {
            IntPtr d;
            if (Slot<OutPtr>(m, 6)(m, out d) != 0 || d == IntPtr.Zero) return;
            Guid id;
            if (Slot<OutGuid>(d, 4)(d, out id) == 0) cur = id;
            Marshal.Release(d);
        });
        return cur;
    }
    // "3" (the third desktop) or a desktop GUID.
    public static Guid Parse(string s)
    {
        Guid g;
        if (Guid.TryParse(s, out g)) return g;
        int n;
        if (int.TryParse(s, out n) && n >= 1)
        {
            var all = All();
            if (n <= all.Count) return all[n - 1];
        }
        return Guid.Empty;
    }
    // Has the shell give a window on the desktop in view the foreground (IApplicationView.SetFocus,
    // the first method after IInspectable's). The shell may do this where a program may not: a
    // window moved to another desktop can keep the foreground there. "" when it worked.
    public static string Focus(IntPtr h)
    {
        if (!OnCurrent(h)) return "not on the desktop in view";
        string why = "";
        string err = WithManager((m, shell, vdIid) =>
        {
            IntPtr col = IntPtr.Zero, view = IntPtr.Zero;
            try
            {
                Guid avc = new Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5");
                if (shell.QueryService(ref avc, ref avc, out col) != 0 || col == IntPtr.Zero) { col = IntPtr.Zero; why = "no application view collection"; return; }
                if (Slot<ViewForHwnd>(col, 6)(col, h, out view) != 0 || view == IntPtr.Zero) { view = IntPtr.Zero; why = "the shell has no view for that window"; return; }
                int hr = Slot<NoArgs>(view, 6)(view);
                if (hr != 0) why = "the shell refused (0x" + hr.ToString("x") + ")";
            }
            finally
            {
                if (view != IntPtr.Zero) Marshal.Release(view);
                if (col != IntPtr.Zero) Marshal.Release(col);
            }
        });
        return err.Length > 0 ? err : why;
    }
    // Shows a desktop (SwitchDesktop). "" when it is the one in view afterwards, else why not.
    public static string Switch(Guid target)
    {
        string why = "";
        string err = WithManager((m, shell, vdIid) =>
        {
            IntPtr desk = IntPtr.Zero;
            try
            {
                Each(m, vdIid, (id, d) => { if (id != target || desk != IntPtr.Zero) return false; desk = d; return true; });
                if (desk == IntPtr.Zero) { why = "that desktop does not exist"; return; }
                int hr = Slot<DeskArg>(m, 9)(m, desk);
                if (hr != 0) why = "the shell refused the switch (0x" + hr.ToString("x") + ")";
            }
            finally { if (desk != IntPtr.Zero) Marshal.Release(desk); }
        });
        if (err.Length > 0) return err;
        if (why.Length > 0) return why;
        return Current() == target ? "" : "that desktop is not in view";
    }
    // Moves another program's window to a desktop. "" when it is there afterwards, else why not.
    public static string MoveOther(IntPtr h, Guid target)
    {
        string why = "";
        string err = WithManager((m, shell, vdIid) =>
        {
            IntPtr desk = IntPtr.Zero, col = IntPtr.Zero, view = IntPtr.Zero;
            try
            {
                Each(m, vdIid, (id, d) => { if (id != target || desk != IntPtr.Zero) return false; desk = d; return true; });
                if (desk == IntPtr.Zero) { why = "that desktop does not exist"; return; }
                Guid avc = new Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5");
                if (shell.QueryService(ref avc, ref avc, out col) != 0 || col == IntPtr.Zero) { col = IntPtr.Zero; why = "no application view collection"; return; }
                if (Slot<ViewForHwnd>(col, 6)(col, h, out view) != 0 || view == IntPtr.Zero) { view = IntPtr.Zero; why = "the shell has no view for that window"; return; }
                int hr = Slot<MoveView>(m, 4)(m, view, desk);
                if (hr != 0) why = "the shell refused the move (0x" + hr.ToString("x") + ")";
            }
            finally
            {
                if (view != IntPtr.Zero) Marshal.Release(view);
                if (col != IntPtr.Zero) Marshal.Release(col);
                if (desk != IntPtr.Zero) Marshal.Release(desk);
            }
        });
        if (err.Length > 0) return err;
        if (why.Length > 0) return why;
        return Of(h) == target ? "" : "the window did not arrive on that desktop";
    }
}

// Processes: names and parents, from one Toolhelp snapshot.
static class Procs
{
    public static Dictionary<uint, Native.PROCESSENTRY32> Map()
    {
        var map = new Dictionary<uint, Native.PROCESSENTRY32>();
        IntPtr snap = Native.CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
        try
        {
            var e = new Native.PROCESSENTRY32 { size = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32)) };
            if (Native.Process32FirstW(snap, ref e)) do { map[e.pid] = e; } while (Native.Process32NextW(snap, ref e));
        }
        finally { Native.CloseHandle(snap); }
        return map;
    }
    public static DateTime StartOf(uint pid)
    {
        try { return Process.GetProcessById((int)pid).StartTime; } catch { return DateTime.MinValue; }
    }
    // Walks from pid up through its parents (at most 16), calling visit for each until it returns
    // true. A parent id can be reused by an unrelated process once the parent has exited, so a
    // "parent" that started after its child ends the walk.
    public static void Up(uint pid, Func<Native.PROCESSENTRY32, bool> visit)
    {
        var map = Procs.Map();
        uint cur = pid;
        DateTime born = StartOf(pid);
        for (int depth = 0; depth < 16; depth++)
        {
            Native.PROCESSENTRY32 e;
            if (!map.TryGetValue(cur, out e) || visit(e)) return;
            DateTime pb = StartOf(e.ppid);
            if (pb == DateTime.MinValue || (born != DateTime.MinValue && pb > born)) return;
            born = pb;
            cur = e.ppid;
        }
    }
}

// One-shot command line modes.
static class Cli
{
    static readonly HashSet<string> Stop = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "explorer.exe", "svchost.exe", "services.exe", "wininit.exe", "winlogon.exe", "sihost.exe", "chrome.exe", "msedge.exe" };

    // The window a process runs in. Walking up from it: a console that a terminal hosts (Windows
    // Terminal owns the hidden pseudo console window), a classic console window, or a top-level
    // window of its own (an IDE, the Claude app).
    public static string Anchor(uint pid)
    {
        string found = null;
        Procs.Up(pid, e =>
        {
            if (Stop.Contains(e.exe)) return true;
            string how = "console";
            IntPtr h = ConsoleHost(e.pid);
            if (h == IntPtr.Zero) { h = TopWindow(e.pid); how = "window"; }
            if (h == IntPtr.Zero) return false;
            found = "{\"hwnd\":" + h.ToInt64() + ",\"how\":\"" + how + "\",\"exe\":" + Native.Q(e.exe) + ",\"class\":" + Native.Q(Native.ClassOf(h)) + ",\"desktop\":\"" + Desks.Of(h) + "\"}";
            return true;
        });
        return found ?? "{\"hwnd\":0}";
    }
    static IntPtr ConsoleHost(uint pid)
    {
        Native.FreeConsole();
        if (!Native.AttachConsole(pid)) return IntPtr.Zero;
        IntPtr c = Native.GetConsoleWindow();
        Native.FreeConsole();
        if (c == IntPtr.Zero) return IntPtr.Zero;
        IntPtr owner = Native.GetAncestor(c, 3); // GA_ROOTOWNER: the terminal that hosts the pseudo console
        if (owner != IntPtr.Zero && owner != c && Native.IsWindowVisible(owner)) return owner;
        return Native.ClassOf(c) == "ConsoleWindowClass" && Native.IsWindowVisible(c) ? c : IntPtr.Zero;
    }
    static IntPtr TopWindow(uint pid)
    {
        IntPtr found = IntPtr.Zero;
        Native.EnumWindows((h, l) =>
        {
            if (!Native.IsWindowVisible(h) || Native.PidOf(h) != pid || Native.GetWindow(h, 4) != IntPtr.Zero) return true; // GW_OWNER
            if ((Native.GetWindowLong(h, -20) & Native.WS_EX_TOOLWINDOW) != 0 || Native.TitleOf(h).Length == 0) return true;
            found = h;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    public static string DesktopsJson()
    {
        var sb = new System.Text.StringBuilder("{\"desktops\":[");
        var all = Desks.All();
        for (int i = 0; i < all.Count; i++) sb.Append(i > 0 ? "," : "").Append('"').Append(all[i]).Append('"');
        return sb.Append("],\"current\":\"").Append(Desks.Current()).Append("\"}").ToString();
    }

    // Starts a program minimised and not activated (SW_SHOWMINNOACTIVE), the way a shortcut set to
    // "Run: Minimized" does, and prints its process id.
    public static string Launch(string[] args)
    {
        var cmd = new System.Text.StringBuilder(Quote(args[1]));
        for (int i = 2; i < args.Length; i++) cmd.Append(' ').Append(Quote(args[i]));
        var si = new Native.STARTUPINFO { cb = Marshal.SizeOf(typeof(Native.STARTUPINFO)), flags = 1, show = (short)Native.SW_SHOWMINNOACTIVE }; // STARTF_USESHOWWINDOW
        Native.PROCESS_INFORMATION pi;
        if (!Native.CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi))
            return "{\"pid\":0,\"error\":" + Marshal.GetLastWin32Error() + "}";
        Native.CloseHandle(pi.thread);
        Native.CloseHandle(pi.process);
        return "{\"pid\":" + pi.pid + "}";
    }
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in a)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { sb.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
            sb.Append('\\', slashes).Append(ch);
            slashes = 0;
        }
        return sb.Append('\\', slashes * 2).Append('"').ToString();
    }
}

// A borderless layered window whose whole look is one premultiplied ARGB bitmap.
class Layer : Form
{
    public Layer()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT | Native.WS_EX_TOPMOST | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
            return cp;
        }
    }
    public int X, Y, W, H;
    public void Render(Bitmap bmp, int x, int y)
    {
        X = x; Y = y; W = bmp.Width; H = bmp.Height;
        IntPtr screen = Native.GetDC(IntPtr.Zero), mem = Native.CreateCompatibleDC(screen);
        IntPtr hb = bmp.GetHbitmap(Color.FromArgb(0)), old = Native.SelectObject(mem, hb);
        try
        {
            var size = new Native.SIZE { W = bmp.Width, H = bmp.Height };
            var src = new Native.POINT();
            var dst = new Native.POINT { X = x, Y = y };
            var blend = new Native.BLEND { Op = 0, Flags = 0, Alpha = 255, Format = 1 };
            Native.UpdateLayeredWindow(Handle, screen, ref dst, ref size, mem, ref src, 0, ref blend, Native.ULW_ALPHA);
        }
        finally
        {
            Native.SelectObject(mem, old);
            Native.DeleteObject(hb);
            Native.DeleteDC(mem);
            Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }
    public void MoveTo(int x, int y)
    {
        X = x; Y = y;
        Native.SetWindowPos(Handle, Native.HWND_TOPMOST, x, y, 0, 0, Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
    }
}

class Lens : ApplicationContext
{
    static readonly Color Purple = Color.FromArgb(124, 58, 237);
    static readonly object OutLock = new object();
    static void Emit(string json) { lock (OutLock) { Console.Out.WriteLine(json); Console.Out.Flush(); } }
    // BROWZIE_LENS_LOG=<file>: a trace of window placement and foreground decisions (diagnostics)
    static readonly string LogFile = Environment.GetEnvironmentVariable("BROWZIE_LENS_LOG");
    static void Log(string s)
    {
        if (string.IsNullOrEmpty(LogFile)) return;
        try { System.IO.File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\r\n"); } catch { }
    }

    readonly Layer cursor = new Layer(), frame = new Layer(), banner = new Layer();
    readonly SynchronizationContext ui;
    readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer { Interval = 16 };
    float scale = 1;          // physical pixels per DIP, from the last message
    int tipX = -10000, tipY = -10000;
    bool wantCursor, wantFrame, pressed;
    string label = "Claude", bannerText = "";
    double rippleStart = -1;
    readonly Stopwatch clock = Stopwatch.StartNew();
    Native.RECT anchor;        // Browzie window rect when positions were last set
    bool anchored;
    Native.RECT frameRect;
    IntPtr browzie = IntPtr.Zero; // the Chrome window Browzie is driving
    string browzieTitle = "";
    double browzieW, browzieH;      // its size in DIPs
    double browzieL, browzieT;      // its position in DIPs
    double lastAl, lastAt;      // screen DIP origin from the last frame message
    bool over;                  // your real pointer is over the Browzie window
    double lastOverSent = -1000;
    double lastInputSent = -1000, lastOverCheck = -1000;
    static readonly bool CountInjected = Environment.GetEnvironmentVariable("BROWZIE_LENS_COUNT_INJECTED") == "1";
    Native.HookProc mouseHook, keyHook; // kept referenced so the collector never frees them
    Native.WinEventProc winEvent, fgEvent;
    double lastHuman = -1e9;      // your last real mouse or keyboard input
    double lastHumanChrome = -1e9; // your last real click into a Chrome window, or key press while one was in front
    double lastHumanPress = -1e9;  // your last real click or key press anywhere (the taskbar, Alt+Tab)
    double lastHumanSwitch = -1e9; // your last real click, Alt+Tab, Win+Tab or Ctrl+Win+arrow (what can bring a window on another desktop in front)
    double lastBrowziePress = -1e9; // Browzie's last mouse press or release
    IntPtr userFront;             // the window you last had in front (never a Browzie window)
    readonly Dictionary<IntPtr, double> early = new Dictionary<IntPtr, double>(); // popups being moved, by deadline

    // Browser windows of this Chrome, by when they first appeared (0: already open when the lens
    // started), the ones a placement has taken, and the ones placed, by Chrome window id.
    readonly Dictionary<IntPtr, double> seen = new Dictionary<IntPtr, double>();
    readonly HashSet<IntPtr> claimed = new HashSet<IntPtr>();
    readonly Dictionary<string, IntPtr> keyed = new Dictionary<string, IntPtr>();
    readonly List<PlaceJob> jobs = new List<PlaceJob>();
    readonly uint browserPid; // the Chrome that started the Browzie host (0 if not found)
    class PlaceJob { public string rid = "", key = "", title = "", desk = ""; public double w, h, start, deadline; public IntPtr anchor; public bool fill; }

    Lens()
    {
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        foreach (var l in new[] { frame, banner, cursor }) { var h = l.Handle; }
        mouseHook = OnMouse;
        keyHook = OnKey;
        IntPtr mod = Native.GetModuleHandle(null);
        Native.SetWindowsHookEx(14, mouseHook, mod, 0); // WH_MOUSE_LL
        Native.SetWindowsHookEx(13, keyHook, mod, 0);   // WH_KEYBOARD_LL
        uint chrome = 0;
        Procs.Up((uint)Process.GetCurrentProcess().Id, e => { if (e.exe.Equals("chrome.exe", StringComparison.OrdinalIgnoreCase)) { chrome = e.pid; return true; } return false; });
        browserPid = chrome;
        Scan(0);
        // window created / destroyed / shown in that Chrome, so a window it just opened is known at once
        winEvent = OnWinEvent;
        Native.SetWinEventHook(0x8000, 0x8002, IntPtr.Zero, winEvent, browserPid, 0, 2); // WINEVENT_OUTOFCONTEXT | SKIPOWNPROCESS
        // which window has the foreground (any program), to give it back if a Browzie window takes it
        fgEvent = OnForeground;
        Native.SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, fgEvent, 0, 0, 2); // EVENT_SYSTEM_FOREGROUND
        userFront = Native.GetForegroundWindow();
        tick.Tick += (s, e) => Tick();
        tick.Start();
        var reader = new Thread(ReadLoop) { IsBackground = true };
        reader.Start();
        Emit("{\"ev\":\"ready\"}");
    }

    void ReadLoop()
    {
        var json = new JavaScriptSerializer();
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            Dictionary<string, object> m;
            try { m = json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
            ui.Post(_ => { try { Handle(m); } catch { } }, null);
        }
        ui.Post(_ => ExitThread(), null);
    }

    static double D(Dictionary<string, object> m, string k)
    {
        object v;
        return m.TryGetValue(k, out v) && v != null ? Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture) : 0;
    }
    static string S(Dictionary<string, object> m, string k)
    {
        object v;
        return m.TryGetValue(k, out v) && v != null ? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) : "";
    }
    static void Reply(string rid, string body) { Emit("{\"ev\":\"reply\",\"rid\":" + Native.Q(rid) + "," + body + "}"); }

    // ------------------------------------------------------------- windows Chrome opens, virtual desktops
    // A browser window: top-level, unowned, can be minimised (menus, tooltips and bubbles cannot).
    bool IsBrowserWindow(IntPtr h)
    {
        if (Native.GetAncestor(h, 2) != h || Native.GetWindow(h, 4) != IntPtr.Zero) return false;
        if (Native.ClassOf(h) != "Chrome_WidgetWin_1") return false;
        int style = Native.GetWindowLong(h, -16), ex = Native.GetWindowLong(h, -20);
        if ((style & 0x20000) == 0 || (ex & Native.WS_EX_TOOLWINDOW) != 0) return false; // WS_MINIMIZEBOX
        return browserPid != 0 ? Native.PidOf(h) == browserPid : IsChrome(h);
    }
    void Scan(double t)
    {
        Native.EnumWindows((h, l) => { if (!seen.ContainsKey(h) && IsBrowserWindow(h)) seen[h] = t; return true; }, IntPtr.Zero);
    }
    void OnWinEvent(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time)
    {
        try
        {
            if (obj != 0 || child != 0 || h == IntPtr.Zero) return; // OBJID_WINDOW, CHILDID_SELF
            if (ev == 0x8001) { seen.Remove(h); claimed.Remove(h); early.Remove(h); ours.Remove(h); frontFrom.Remove(h); return; } // destroyed (handles get reused)
            if (ev == 0x8002 && early.ContainsKey(h)) { Early(h); return; }
            if (seen.ContainsKey(h) || !IsBrowserWindow(h)) return;
            double t = Math.Max(1, clock.Elapsed.TotalMilliseconds);
            seen[h] = t;
            Log("new window " + h + " ev " + ev + " browziePress " + (int)(t - lastBrowziePress) + " ms ago, you in Chrome " + (int)(t - lastHumanChrome) + " ms ago, home " + HomeDesk() + ", its desk " + Desks.Of(h));
            // A window this Chrome opens right after Browzie clicked, when you have not just clicked or
            // typed in Chrome yourself, is a popup of the page Browzie uses: it goes to Browzie's desktop at
            // once, before it shows up on yours. (The extension's place request then finds it there.)
            if (t - lastBrowziePress < 5000 && t - lastHumanChrome > 1500 && HomeDesk() != Guid.Empty)
            {
                early[h] = t + 2000;
                ours.Add(h);
                Early(h);
            }
            if (jobs.Count > 0) RunJobs();
        }
        catch { }
    }
    Guid HomeDesk() { return browzie != IntPtr.Zero && Native.IsWindow(browzie) ? Desks.Of(browzie) : Guid.Empty; }
    // (until the shell knows a new window, moving it fails: tried again when it shows and every tick)
    // (calls into the shell pump messages while they wait, so events and ticks can arrive in the
    // middle of a move: a window is never moved twice at once)
    bool moving;
    void Early(IntPtr h)
    {
        if (moving) return;
        Guid g = HomeDesk();
        double dl;
        if (g == Guid.Empty || !Native.IsWindow(h) || !early.TryGetValue(h, out dl) || clock.Elapsed.TotalMilliseconds > dl) { early.Remove(h); return; }
        Guid at = Desks.Of(h);
        if (at != g && at != Guid.Empty)
        {
            // Chrome may have put it in front already: that goes back first, since moving the window
            // in front to another desktop can take your view along with it
            if (Native.GetForegroundWindow() == h) GiveBackFront(h);
            if (moving) return;
            WatchView(g);
        }
        moving = true;
        try
        {
            string r = at == g ? "already there" : Desks.MoveOther(h, g);
            Log("early " + h + ": " + (r.Length == 0 ? "moved" : r));
            if (r.Length == 0 || r == "already there") early.Remove(h);
        }
        finally { moving = false; }
        GiveBackFront(h);
    }
    // Moving a window to Browzie's desktop can switch your view there with it (when Chrome activates it
    // again during or just after the move). For a moment after a move, a switch to Browzie's desktop
    // you did not make (a click, Alt+Tab, Task View, a touchpad swipe) is undone.
    Guid viewWas, viewHome;
    double viewFrom = -1e9, viewUntil = -1e9, lastViewCheck = -1e9;
    void WatchView(Guid home)
    {
        Guid cur = Desks.Current();
        if (cur == Guid.Empty || cur == home) return;
        viewWas = cur;
        viewHome = home;
        viewFrom = clock.Elapsed.TotalMilliseconds;
        viewUntil = viewFrom + 2500;
    }
    void CheckView()
    {
        double now = clock.Elapsed.TotalMilliseconds;
        if (now > viewUntil || moving || now - lastViewCheck < 50) return;
        lastViewCheck = now;
        if (lastHumanSwitch > viewFrom - 300) { viewUntil = -1e9; return; } // you switched: leave it
        if (Desks.Current() != viewHome) return;
        moving = true;
        string r;
        try { r = Desks.Switch(viewWas); }
        finally { moving = false; }
        Log("view followed a window to Browzie's desktop; back to " + viewWas + ": " + (r.Length == 0 ? "ok" : r));
        if (r.Length == 0) viewUntil = -1e9;
        IntPtr fg = Native.GetForegroundWindow();
        if (ours.Contains(fg)) GiveBackFront(fg);
    }
    // Chrome activates a window it opens for a page (a popup), which would take the keyboard from
    // the program you are using. Unless you activated it yourself (it is on the desktop in view and
    // you just clicked or switched: on it, on the taskbar, Alt+Tab), the foreground goes back to the
    // window you had in front, or to the taskbar if that one is on another desktop.
    readonly HashSet<IntPtr> ours = new HashSet<IntPtr>(); // windows Browzie placed or moved
    readonly Dictionary<IntPtr, double> frontWatch = new Dictionary<IntPtr, double>(); // and until when to keep giving back the foreground
    readonly Dictionary<IntPtr, double> frontFrom = new Dictionary<IntPtr, double>();  // when it last came to the front
    double lastFrontTry = -1e9;
    void OnForeground(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time)
    {
        try
        {
            if (h == IntPtr.Zero) return;
            string cls = Native.ClassOf(h);
            Log("foreground " + h + " " + cls + (ours.Contains(h) ? " (Browzie's)" : ""));
            // a touchpad swipe between desktops, Task View or Alt+Tab is showing: you are switching
            if (cls == "VirtualDesktopGestureSwitcher" || cls == "XamlExplorerHostIslandWindow" || cls == "MultitaskingViewFrame") lastHumanSwitch = clock.Elapsed.TotalMilliseconds;
            if (ours.Contains(h)) { frontFrom[h] = clock.Elapsed.TotalMilliseconds; GiveBackFront(h); return; }
            if (Native.PidOf(h) != (uint)Process.GetCurrentProcess().Id) userFront = h;
        }
        catch { }
    }
    void GiveBackFront(IntPtr h)
    {
        if (Native.GetForegroundWindow() != h) return;
        double now = clock.Elapsed.TotalMilliseconds;
        double since = now - lastHumanSwitch;
        // (a popup Browzie's click opened is Browzie's until it is moved, whatever you clicked meanwhile)
        if (since < 1500 && !early.ContainsKey(h) && Desks.OnCurrent(h)) { Log("front " + h + ": you activated it"); frontWatch.Remove(h); return; }
        // moving a window between desktops can make it the foreground again: keep watching a moment
        if (!frontWatch.ContainsKey(h)) frontWatch[h] = now + 2500;
        // you just clicked (the notification, the taskbar) or pressed Alt+Tab: a switch to that
        // window's desktop you asked for may still be under way, so look again shortly. Only once
        // each time it comes to the front: keys you type meanwhile would go to a window you cannot see.
        double from;
        if (!frontFrom.TryGetValue(h, out from)) frontFrom[h] = from = now;
        if (now - lastHumanSwitch < 600 && now - from < 600) return;
        IntPtr to = userFront;
        bool yours = to != IntPtr.Zero && to != h && Native.IsWindow(to) && Desks.OnCurrent(to);
        if (!yours) to = Native.FindWindow("Shell_TrayWnd", null);
        if (to == IntPtr.Zero) return;
        if (Native.SetForegroundWindow(to) && Native.GetForegroundWindow() == to) { Log("front " + h + ": given back to " + to); return; }
        // A program may only hand the foreground on while it has it; the shell may always, so it is
        // asked to focus your window (not in the middle of another call into the shell).
        if (yours && !moving)
        {
            moving = true;
            string r;
            try { r = Desks.Focus(to); }
            finally { moving = false; }
            Log("front " + h + ": shell focus on " + to + ": " + (r.Length == 0 ? "ok" : r));
            if (r.Length == 0) return;
        }
        // else: share input state with the front window's thread for the moment it takes (no input
        // is sent anywhere), which lets this program hand the foreground on
        uint pid;
        uint front = Native.GetWindowThreadProcessId(h, out pid), me = Native.GetCurrentThreadId();
        bool ok = false;
        if (front != 0 && front != me && Native.AttachThreadInput(me, front, true))
        {
            try { ok = Native.SetForegroundWindow(to); }
            finally { Native.AttachThreadInput(me, front, false); }
            Log("front " + h + ": given back to " + to + " through its thread: " + ok);
        }
        if (ok) return;
        // While you are using the computer, Windows lets only the program that sent the last input
        // change the foreground (and the shell refuses for it too). A mouse move by zero pixels
        // makes this program that one for the call: the pointer stays put, nothing is clicked or typed.
        var still = new[] { new Native.INPUT { type = 0, mi = new Native.MOUSEINPUT { dwFlags = 1 } } }; // INPUT_MOUSE, MOUSEEVENTF_MOVE
        Native.SendInput(1, still, Marshal.SizeOf(typeof(Native.INPUT)));
        ok = Native.SetForegroundWindow(to) && Native.GetForegroundWindow() == to;
        Log("front " + h + ": given back to " + to + " after a zero-pixel move: " + ok);
    }
    IntPtr Keyed(string key)
    {
        IntPtr h;
        if (key.Length > 0 && keyed.TryGetValue(key, out h))
        {
            if (Native.IsWindow(h)) return h;
            keyed.Remove(key);
        }
        return IntPtr.Zero;
    }
    static bool SizeNear(IntPtr h, double w, double ht)
    {
        Native.RECT r;
        if (Native.IsIconic(h))
        {
            var wp = new Native.WINDOWPLACEMENT { length = Marshal.SizeOf(typeof(Native.WINDOWPLACEMENT)) };
            if (!Native.GetWindowPlacement(h, ref wp)) return false;
            r = wp.normal;
        }
        else if (!Native.GetWindowRect(h, out r)) return false;
        double s = 1;
        try { uint dpi = Native.GetDpiForWindow(h); if (dpi > 0) s = dpi / 96.0; } catch { }
        return Math.Abs((r.R - r.L) - w * s) < 24 * s && Math.Abs((r.B - r.T) - ht * s) < 24 * s;
    }
    // The window a placement is for: one that appeared after the request was made (or just before
    // it: Chrome may show it before the extension hears back), not taken by another placement; the
    // size Chrome reported must match when one was given, a matching title is preferred.
    IntPtr Pick(PlaceJob j)
    {
        IntPtr best = IntPtr.Zero;
        int bestScore = -1;
        double bestAt = -1;
        foreach (var kv in seen)
        {
            if (kv.Value <= 0 || kv.Value < j.start - 4000 || claimed.Contains(kv.Key) || !Native.IsWindow(kv.Key)) continue;
            int score = 0;
            if (j.w > 0) { if (!SizeNear(kv.Key, j.w, j.h)) continue; score += 2; }
            if (j.title.Length > 0 && Native.TitleOf(kv.Key).StartsWith(j.title, StringComparison.Ordinal)) score += 1;
            if (score > bestScore || (score == bestScore && kv.Value > bestAt)) { best = kv.Key; bestScore = score; bestAt = kv.Value; }
        }
        return best;
    }
    void RunJobs()
    {
        if (jobs.Count == 0 || moving) return;
        moving = true;
        try
        {
            double now = clock.Elapsed.TotalMilliseconds;
            Scan(Math.Max(1, now));
            foreach (var j in jobs.ToArray())
            {
                IntPtr h = Pick(j);
                if (h != IntPtr.Zero) { jobs.Remove(j); Place(j, h); }
                else if (now > j.deadline) { jobs.Remove(j); Reply(j.rid, "\"ok\":false,\"found\":false"); }
            }
        }
        finally { moving = false; }
    }
    // Moves the window to the home desktop while it is still minimised (so it never shows up on the
    // desktop you are using), then with fill restores it there without activating it, filling the
    // work area of its monitor. Activating a window on another desktop would switch you to it.
    void Place(PlaceJob j, IntPtr h)
    {
        claimed.Add(h);
        ours.Add(h);
        if (j.key.Length > 0) keyed[j.key] = h;
        Guid target = Guid.Empty;
        if (j.anchor != IntPtr.Zero && Native.IsWindow(j.anchor)) target = Desks.Of(j.anchor);
        if (target == Guid.Empty && j.desk.Length > 0) target = Desks.Parse(j.desk);
        Guid from = Desks.Of(h);
        string move;
        if (target == Guid.Empty) move = j.anchor == IntPtr.Zero && j.desk.Length == 0 ? "no home desktop given" : "home desktop not found";
        else if (from == Guid.Empty) move = "the window's desktop is unknown";
        else if (from == target) move = "already there";
        else { string err = Desks.MoveOther(h, target); move = err.Length == 0 ? "moved" : err; }
        if (j.fill)
        {
            if (Native.IsIconic(h)) Native.ShowWindow(h, Native.SW_SHOWNOACTIVATE);
            Fill(h);
        }
        GiveBackFront(h);
        Reply(j.rid, "\"ok\":true,\"found\":true,\"hwnd\":" + h.ToInt64() + ",\"move\":" + Native.Q(move) +
            ",\"home\":" + (target != Guid.Empty && Desks.Of(h) == target ? "true" : "false") + ",\"current\":" + (Desks.OnCurrent(h) ? "true" : "false"));
    }
    // Sizes a restored window so its visible frame covers the monitor's work area, the way a
    // maximised window does (window rects include invisible resize borders, which are added back).
    static void Fill(IntPtr h)
    {
        var mi = new Native.MONITORINFO { cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO)) };
        if (!Native.GetMonitorInfo(Native.MonitorFromWindow(h, 2), ref mi)) return;
        Native.RECT wr, vis;
        if (!Native.GetWindowRect(h, out wr)) return;
        if (Native.DwmGetWindowAttribute(h, 9, out vis, Marshal.SizeOf(typeof(Native.RECT))) != 0) vis = wr; // DWMWA_EXTENDED_FRAME_BOUNDS
        int l = Clamp(vis.L - wr.L), t = Clamp(vis.T - wr.T), r = Clamp(wr.R - vis.R), b = Clamp(wr.B - vis.B);
        var w = mi.rcWork;
        Native.SetWindowPos(h, IntPtr.Zero, w.L - l, w.T - t, (w.R - w.L) + l + r, (w.B - w.T) + t + b, Native.SWP_NOACTIVATE | Native.SWP_NOZORDER | Native.SWP_NOOWNERZORDER);
    }
    static int Clamp(int v) { return Math.Max(0, Math.Min(16, v)); }

    // Chrome DIP screen coordinates -> physical pixels, on the monitor that shows the foreground window.
    Point ToPhysical(double x, double y, double al, double at, double s)
    {
        var mi = new Native.MONITORINFO { cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO)) };
        Native.GetMonitorInfo(Native.MonitorFromWindow(browzie != IntPtr.Zero ? browzie : Native.GetForegroundWindow(), 2), ref mi);
        return new Point((int)Math.Round(mi.rcWork.L + (x - al) * s), (int)Math.Round(mi.rcWork.T + (y - at) * s));
    }

    void Anchor()
    {
        Native.RECT r;
        anchored = browzie != IntPtr.Zero && Native.GetWindowRect(browzie, out r);
        if (anchored) { Native.GetWindowRect(browzie, out r); anchor = r; }
    }

    // Finds the Browzie window among all Chrome windows: its title starts with the active tab's
    // title and its size matches what the extension reported.
    void FindBrowzie()
    {
        IntPtr best = IntPtr.Zero;
        int bestScore = -1;
        Native.EnumWindows((h, l) =>
        {
            if (!Native.IsWindowVisible(h)) return true;
            var cls = new System.Text.StringBuilder(64);
            Native.GetClassName(h, cls, 64);
            if (cls.ToString() != "Chrome_WidgetWin_1" || !IsChrome(h)) return true;
            var title = new System.Text.StringBuilder(512);
            Native.GetWindowText(h, title, 512);
            if (title.Length == 0) return true;
            Native.RECT r;
            Native.GetWindowRect(h, out r);
            int score = 0;
            if (browzieTitle.Length > 0 && title.ToString().StartsWith(browzieTitle, StringComparison.Ordinal)) score += 2;
            // window rects include invisible resize borders, so allow some slack
            if (browzieW > 0 && Math.Abs((r.R - r.L) - browzieW * scale) < 24 * scale && Math.Abs((r.B - r.T) - browzieH * scale) < 24 * scale) score += 1;
            if (browzieW > 0)
            {
                var p = ToPhysical(browzieL, browzieT, lastAl, lastAt, scale);
                if (Math.Abs(r.L - p.X) < 16 * scale && Math.Abs(r.T - p.Y) < 16 * scale) score += 1;
            }
            if (score > bestScore && score > 0) { bestScore = score; best = h; }
            return true;
        }, IntPtr.Zero);
        if (best != IntPtr.Zero) browzie = best;
    }
    bool InBrowzie(Native.POINT p)
    {
        if (browzie == IntPtr.Zero) return false;
        return Native.GetAncestor(Native.WindowFromPoint(p), 2) == browzie; // GA_ROOT; our overlays are click-through, so never hit
    }

    // Low-level hooks: real hardware input only (injected input carries a flag).
    IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (code >= 0)
            {
                int flags = Marshal.ReadInt32(lParam, 12);
                bool injected = (flags & 0x3) != 0; // LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED
                if (!injected || CountInjected)
                {
                    var p = new Native.POINT { X = Marshal.ReadInt32(lParam, 0), Y = Marshal.ReadInt32(lParam, 4) };
                    int msg = wParam.ToInt32();
                    double t = clock.Elapsed.TotalMilliseconds;
                    lastHuman = t;
                    if (msg == 0x200) // move: track whether the pointer is over the Browzie window
                    {
                        if (t - lastOverCheck > 30)
                        {
                            lastOverCheck = t;
                            bool now = InBrowzie(p);
                            // moving inside the Browzie window: report it (at most every 150 ms); leaving it: report once.
                            // A pointer that only rests there sends nothing, so it never holds Browzie up.
                            if (now && t - lastOverSent > 150) { lastOverSent = t; over = true; Emit("{\"ev\":\"over\",\"on\":true}"); }
                            else if (!now && over) { over = false; Emit("{\"ev\":\"over\",\"on\":false}"); }
                        }
                    }
                    else if (msg == 0x201 || msg == 0x204 || msg == 0x207 || msg == 0x20A || msg == 0x20B || msg == 0x20E)
                    {
                        if (msg != 0x20A && msg != 0x20E)
                        {
                            lastHumanPress = lastHumanSwitch = t;
                            if (browserPid != 0 && Native.PidOf(Native.GetAncestor(Native.WindowFromPoint(p), 2)) == browserPid) lastHumanChrome = t;
                        }
                        Emit("{\"ev\":\"input\",\"kind\":\"mouse\",\"browzie\":" + (InBrowzie(p) ? "true" : "false") + "}");
                    }
                }
            }
        }
        catch { }
        return Native.CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }
    IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            int msg = wParam.ToInt32();
            if (code >= 0 && (msg == 0x100 || msg == 0x104)) // key down
            {
                int flags = Marshal.ReadInt32(lParam, 8);
                bool injected = (flags & 0x12) != 0; // LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED
                double t = clock.Elapsed.TotalMilliseconds;
                if (!injected || CountInjected)
                {
                    lastHuman = lastHumanPress = t;
                    if (browserPid != 0 && Native.PidOf(Native.GetForegroundWindow()) == browserPid) lastHumanChrome = t;
                    int vk = Marshal.ReadInt32(lParam, 0);
                    bool alt = (flags & 0x20) != 0, win = (Native.GetAsyncKeyState(0x5B) & 0x8000) != 0 || (Native.GetAsyncKeyState(0x5C) & 0x8000) != 0;
                    if ((vk == 0x09 && (alt || win)) || ((vk == 0x25 || vk == 0x27) && win)) lastHumanSwitch = t; // Tab, Left, Right
                }
                if ((!injected || CountInjected) && t - lastInputSent > 100)
                {
                    lastInputSent = t;
                    bool inBrowzie = browzie != IntPtr.Zero && Native.GetForegroundWindow() == browzie;
                    Emit("{\"ev\":\"input\",\"kind\":\"key\",\"browzie\":" + (inBrowzie ? "true" : "false") + "}");
                }
            }
        }
        catch { }
        return Native.CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }

    void Handle(Dictionary<string, object> m)
    {
        string op = m.ContainsKey("op") ? Convert.ToString(m["op"]) : "";
        switch (op)
        {
            case "move":
            {
                float s = (float)D(m, "s");
                if (s > 0 && Math.Abs(s - scale) > 0.01) { scale = s; DrawCursor(); }
                var p = ToPhysical(D(m, "x"), D(m, "y"), D(m, "al"), D(m, "at"), scale);
                tipX = p.X; tipY = p.Y;
                Anchor();
                PlaceCursor();
                break;
            }
            case "down": pressed = true; rippleStart = lastBrowziePress = clock.Elapsed.TotalMilliseconds; DrawCursor(); break;
            case "up": pressed = false; lastBrowziePress = clock.Elapsed.TotalMilliseconds; DrawCursor(); break;
            case "show":
                if (m.ContainsKey("label") && m["label"] != null) label = Convert.ToString(m["label"]);
                if (!wantCursor) { wantCursor = true; DrawCursor(); }
                Sync();
                break;
            case "hide": wantCursor = false; wantFrame = false; Sync(); break;
            case "frame":
            {
                float s = (float)D(m, "s");
                if (s > 0) scale = s;
                if (m.ContainsKey("title") && m["title"] != null) browzieTitle = Convert.ToString(m["title"]);
                browzieW = D(m, "ww");
                browzieH = D(m, "wh");
                browzieL = D(m, "wl");
                browzieT = D(m, "wt");
                lastAl = D(m, "al");
                lastAt = D(m, "at");
                IntPtr known = Keyed(S(m, "key"));
                if (known != IntPtr.Zero) browzie = known;
                else if (browzie == IntPtr.Zero || !Native.IsWindow(browzie) || browzieTitle.Length > 0) FindBrowzie();
                var a = ToPhysical(D(m, "x"), D(m, "y"), D(m, "al"), D(m, "at"), scale);
                var b = ToPhysical(D(m, "x") + D(m, "w"), D(m, "y") + D(m, "h"), D(m, "al"), D(m, "at"), scale);
                var nr = new Native.RECT { L = a.X, T = a.Y, R = b.X, B = b.Y };
                if (!wantFrame || nr.L != frameRect.L || nr.T != frameRect.T || nr.R != frameRect.R || nr.B != frameRect.B)
                {
                    frameRect = nr;
                    wantFrame = true;
                    DrawFrame();
                    if (bannerText.Length > 0) DrawBanner();
                }
                Anchor();
                Sync();
                break;
            }
            case "where":
                Emit("{\"ev\":\"where\",\"x\":" + tipX + ",\"y\":" + tipY + ",\"left\":" + cursor.X + ",\"top\":" + cursor.Y + ",\"pad\":" + (int)Math.Round(Pad * scale) + ",\"shown\":" + (cursor.Visible ? "true" : "false") +
                    ",\"frame\":[" + frameRect.L + "," + frameRect.T + "," + frameRect.R + "," + frameRect.B + "],\"frameShown\":" + (frame.Visible ? "true" : "false") +
                    ",\"browzie\":" + browzie.ToInt64() + ",\"front\":" + (Native.GetForegroundWindow() == browzie ? "true" : "false") +
                    ",\"tipVisible\":" + (Visible(tipX, tipY) ? "true" : "false") + ",\"wantCursor\":" + (wantCursor ? "true" : "false") + "}");
                break;
            case "banner":
                bannerText = m.ContainsKey("text") && m["text"] != null ? Convert.ToString(m["text"]) : "";
                DrawBanner();
                Sync();
                break;
            case "place":
            {
                double now = clock.Elapsed.TotalMilliseconds;
                double wait = D(m, "wait");
                var j = new PlaceJob
                {
                    rid = S(m, "rid"), key = S(m, "key"), title = S(m, "title"), desk = S(m, "desk"),
                    w = D(m, "w"), h = D(m, "h"), fill = S(m, "fill") == "True" || S(m, "fill") == "true",
                    anchor = new IntPtr((long)D(m, "anchor")), start = now, deadline = now + (wait > 0 ? wait : 2500),
                };
                jobs.Add(j);
                RunJobs();
                break;
            }
            case "restore":
            {
                // a window the extension placed, else the one minimised Chrome window with that title
                IntPtr h = Keyed(S(m, "key"));
                string title = S(m, "title");
                if (h == IntPtr.Zero && title.Length > 0)
                {
                    var hits = new List<IntPtr>();
                    Native.EnumWindows((w, l) => { if (Native.IsIconic(w) && IsBrowserWindow(w) && Native.TitleOf(w).StartsWith(title, StringComparison.Ordinal)) hits.Add(w); return true; }, IntPtr.Zero);
                    if (hits.Count == 1) h = hits[0];
                }
                bool ok = h != IntPtr.Zero;
                if (ok && Native.IsIconic(h)) Native.ShowWindow(h, Native.SW_SHOWNOACTIVATE);
                Reply(S(m, "rid"), "\"ok\":" + (ok ? "true" : "false"));
                break;
            }
        }
    }

    // ------------------------------------------------------------- drawing
    const int Pad = 26;   // logical px from the window's corner to the cursor tip (room for the ripple)

    static GraphicsPath ArrowPath(float k)
    {
        var pts = new[] { new PointF(0, 0), new PointF(0, 17), new PointF(4.2f, 13.2f), new PointF(7.2f, 20), new PointF(10, 18.8f), new PointF(7.1f, 12.2f), new PointF(12.5f, 12.2f) };
        var path = new GraphicsPath();
        var sc = new PointF[pts.Length];
        for (int i = 0; i < pts.Length; i++) sc[i] = new PointF(pts[i].X * k, pts[i].Y * k);
        path.AddPolygon(sc);
        return path;
    }

    static GraphicsPath Pill(RectangleF r)
    {
        float d = r.Height;
        var p = new GraphicsPath();
        p.AddArc(r.X, r.Y, d, d, 90, 180);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 180);
        p.CloseFigure();
        return p;
    }

    void DrawCursor()
    {
        float k = scale;
        int w = (int)Math.Ceiling(130 * k), h = (int)Math.Ceiling(64 * k);
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);
            float tx = Pad * k, ty = Pad * k;
            double age = rippleStart < 0 ? 1e9 : clock.Elapsed.TotalMilliseconds - rippleStart;
            if (age < 320)
            {
                float f = (float)(age / 320.0), r = (5 + 17 * f) * k;
                using (var pen = new Pen(Color.FromArgb((int)(200 * (1 - f)), Purple), 2.2f * k))
                    g.DrawEllipse(pen, tx - r, ty - r, 2 * r, 2 * r);
            }
            float ak = (pressed ? 0.9f : 1f) * k;
            g.TranslateTransform(tx, ty);
            using (var arrow = ArrowPath(ak))
            {
                g.TranslateTransform(1.2f * k, 1.8f * k);
                using (var shadow = new SolidBrush(Color.FromArgb(70, 0, 0, 0))) g.FillPath(shadow, arrow);
                g.TranslateTransform(-1.2f * k, -1.8f * k);
                using (var fill = new SolidBrush(pressed ? Color.FromArgb(91, 33, 182) : Purple)) g.FillPath(fill, arrow);
                using (var pen = new Pen(Color.White, 1.4f * k) { LineJoin = LineJoin.Round }) g.DrawPath(pen, arrow);
            }
            g.ResetTransform();
            if (!string.IsNullOrEmpty(label))
            {
                using (var font = new Font("Segoe UI Semibold", 12f * k, FontStyle.Regular, GraphicsUnit.Pixel))
                {
                    var sz = g.MeasureString(label, font);
                    var box = new RectangleF(tx + 13 * k, ty + 19 * k, sz.Width + 10 * k, sz.Height + 3 * k);
                    using (var pill = Pill(box))
                    using (var fill = new SolidBrush(Color.FromArgb(235, Purple)))
                    {
                        g.FillPath(fill, pill);
                        using (var pen = new Pen(Color.FromArgb(220, 255, 255, 255), 1f * k)) g.DrawPath(pen, pill);
                    }
                    g.DrawString(label, font, Brushes.White, box.X + 5 * k, box.Y + 1.5f * k);
                }
            }
            cursor.Render(bmp, tipX - (int)Math.Round(tx), tipY - (int)Math.Round(ty));
        }
    }

    void PlaceCursor()
    {
        if (!cursor.Visible) return;
        cursor.MoveTo(tipX - (int)Math.Round(Pad * scale), tipY - (int)Math.Round(Pad * scale));
    }

    void DrawFrame()
    {
        int w = frameRect.R - frameRect.L, h = frameRect.B - frameRect.T;
        if (w < 20 || h < 20) return;
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            for (int i = 0; i < 6; i++)
                using (var pen = new Pen(Color.FromArgb(150 - i * 24, Purple), 1f))
                    g.DrawRectangle(pen, i + 0.5f, i + 0.5f, w - 2 * i - 1, h - 2 * i - 1);
            frame.Render(bmp, frameRect.L, frameRect.T);
        }
    }

    void DrawBanner()
    {
        if (bannerText.Length == 0) return;
        float k = scale;
        int vw = Math.Max(300, frameRect.R - frameRect.L);
        using (var font = new Font("Segoe UI Semibold", 13f * k, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var probe = new Bitmap(1, 1))
        using (var pg = Graphics.FromImage(probe))
        {
            var maxW = (int)(vw * 0.8);
            var sz = pg.MeasureString(bannerText, font, maxW - (int)(28 * k));
            int w = (int)Math.Ceiling(sz.Width + 32 * k), h = (int)Math.Ceiling(sz.Height + 18 * k);
            using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);
                var r = new RectangleF(1, 1, w - 2, h - 2);
                using (var path = new GraphicsPath())
                {
                    float d = 12 * k;
                    path.AddArc(r.X, r.Y, d, d, 180, 90);
                    path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
                    path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
                    path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
                    path.CloseFigure();
                    using (var fill = new SolidBrush(Color.FromArgb(242, 30, 16, 60))) g.FillPath(fill, path);
                    using (var pen = new Pen(Purple, 2f * k)) g.DrawPath(pen, path);
                }
                g.DrawString(bannerText, font, Brushes.White, new RectangleF(16 * k, 9 * k, w - 28 * k, h - 12 * k));
                int left = frameRect.R > frameRect.L ? frameRect.L + ((frameRect.R - frameRect.L) - w) / 2 : 40;
                banner.Render(bmp, left, (frameRect.B > frameRect.T ? frameRect.T : 40) + (int)(14 * k));
            }
        }
    }

    // ------------------------------------------------------------- visibility, window tracking, user input
    static bool IsChrome(IntPtr h)
    {
        uint pid;
        Native.GetWindowThreadProcessId(h, out pid);
        try { return Process.GetProcessById((int)pid).ProcessName.Equals("chrome", StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    // Is the Browzie window what you see at this physical point (not covered by another window)?
    bool Visible(int x, int y)
    {
        if (browzie == IntPtr.Zero || Native.IsIconic(browzie)) return false;
        return InBrowzie(new Native.POINT { X = x, Y = y });
    }
    void Sync()
    {
        bool fg = browzie != IntPtr.Zero && Native.GetForegroundWindow() == browzie;
        Show(cursor, wantCursor && Visible(tipX, tipY));
        Show(frame, wantFrame && (fg || Visible((frameRect.L + frameRect.R) / 2, (frameRect.T + frameRect.B) / 2)));
        Show(banner, bannerText.Length > 0 && Visible(banner.X + banner.W / 2, banner.Y + banner.H / 2));
    }
    static void Show(Layer l, bool on)
    {
        if (on && !l.Visible) { l.Show(); Native.SetWindowPos(l.Handle, Native.HWND_TOPMOST, l.X, l.Y, 0, 0, Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW); }
        else if (!on && l.Visible) l.Hide();
    }

    int frontCheck;
    void Tick()
    {
        if (jobs.Count > 0 && frontCheck % 3 == 0) RunJobs();
        if (early.Count > 0) foreach (var h in new List<IntPtr>(early.Keys)) Early(h);
        CheckView();
        if (frontWatch.Count > 0 && clock.Elapsed.TotalMilliseconds - lastFrontTry > 120)
        {
            lastFrontTry = clock.Elapsed.TotalMilliseconds;
            foreach (var kv in new List<KeyValuePair<IntPtr, double>>(frontWatch))
            {
                if (lastFrontTry > kv.Value || !Native.IsWindow(kv.Key)) { frontWatch.Remove(kv.Key); continue; }
                if (Native.GetForegroundWindow() == kv.Key) GiveBackFront(kv.Key);
            }
        }
        if (++frontCheck % 6 == 0)
        {
            Sync(); // covered or uncovered by other windows since the last check
            // the Browzie window was dragged: carry the cursor, frame and banner along with it
            Native.RECT r;
            // resized (maximised, restored, snapped): the frame no longer fits; hide until Browzie's
            // next action sends fresh geometry
            if (browzie != IntPtr.Zero && anchored && Native.GetWindowRect(browzie, out r) && (r.R - r.L != anchor.R - anchor.L || r.B - r.T != anchor.B - anchor.T))
            {
                anchor = r;
                wantCursor = false;
                wantFrame = false;
                Sync();
            }
            else if (browzie != IntPtr.Zero && anchored && Native.GetWindowRect(browzie, out r) && (r.L != anchor.L || r.T != anchor.T) && r.R - r.L == anchor.R - anchor.L)
            {
                int dx = r.L - anchor.L, dy = r.T - anchor.T;
                anchor = r;
                tipX += dx; tipY += dy;
                frameRect.L += dx; frameRect.R += dx; frameRect.T += dy; frameRect.B += dy;
                PlaceCursor();
                frame.MoveTo(frame.X + dx, frame.Y + dy);
                banner.MoveTo(banner.X + dx, banner.Y + dy);
            }
        }
        if (rippleStart >= 0)
        {
            if (clock.Elapsed.TotalMilliseconds - rippleStart < 340) DrawCursor();
            else { rippleStart = -1; DrawCursor(); }
        }
    }

    [STAThread]
    static void Main(string[] args)
    {
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { Native.SetProcessDPIAware(); } catch { } }
        if (args.Length > 0 && args[0].StartsWith("--"))
        {
            var o = Console.Out; // bound to the pipe before --anchor attaches to other consoles
            string res = "{\"error\":\"usage: --anchor <pid> | --desktops | --launch <exe> [args]\"}";
            uint pid;
            if (args[0] == "--anchor" && args.Length > 1 && uint.TryParse(args[1], out pid)) res = Cli.Anchor(pid);
            else if (args[0] == "--desktops") res = Cli.DesktopsJson();
            else if (args[0] == "--launch" && args.Length > 1) res = Cli.Launch(args);
            o.WriteLine(res);
            o.Flush();
            return;
        }
        Application.EnableVisualStyles();
        Application.Run(new Lens());
    }
}
