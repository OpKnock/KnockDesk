// Awareness ka window watcher — Windows par EK hamesha-chalta PowerShell.
//
// ════════════════════════════════════════════════════════════════════════════
//  POORA LOOP C# MEIN HAI — JAAN BUJH KAR
// ════════════════════════════════════════════════════════════════════════════
//
//  Pehle ye loop PowerShell ke cmdlets se chalta tha (Get-Process, Get-ChildItem,
//  Get-ItemProperty har 1.5 s par). Naapne par wo ek CPU core ka ~5.5% musalsal
//  kha raha tha — laptop ki battery par din bhar ka bojh. Ab PowerShell sirf
//  ek dafa C# compile karta hai aur loop compiled code mein chalta hai.
//
//  Ye teen cheezein batata hai, aur sirf TABDEELI par ek JSON line likhta hai:
//
//    app/title  -> saamne wali window
//    mic        -> kaun si apps is lamhe mic istemal kar rahi hain (call ki pehchan)
//    display    -> koi app screen ko jagaye hue hai (video chal rahi hai, call,
//                  presentation). Is ke baghair video dekhta hua user "uth gaya"
//                  gina jata tha, aur mouse hilate hi KnockDesk "wapas aa gaye" kehta.
//
// ── IS SCRIPT MEIN BACKSLASH, BACKTICK AUR DOLLAR-BRACE NAHI HAIN ───────────
//
//  Ye JS ka template literal hai: backslash ko JS kha jata hai aur registry ka
//  path toot jata hai (ye ghalti pehle ho chuki hai). Is liye C# mein quote aur
//  backslash `(char)34` / `(char)92` se bante hain, aur path tukron se jurta hai.
//  Naya code likhte waqt bhi yehi usool rakhein.
//
//  Parent ka pid is liye: Electron crash ho ya Task Manager se mare to ye loop
//  khud nikal jaye — warna ek lawaris PowerShell hamesha chalta rehta.

const FOCUS_WATCH_PS1 = `param([int]$ParentPid = 0, [int]$IntervalMs = 2000)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

public static class KnockDeskWatch
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("powrprof.dll")] static extern uint CallNtPowerInformation(int level, IntPtr inBuf, uint inLen, out uint state, uint outLen);

    static readonly char Q = (char)34;
    static readonly char B = (char)92;
    const int SystemExecutionState = 16;
    const uint DisplayRequired = 2;

    static string Esc(string s)
    {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            if (c == Q) { sb.Append(B); sb.Append(Q); }
            else if (c == B) { sb.Append(B); sb.Append(B); }
            else if (c < 32) sb.Append(' ');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static string Str(string name, string value)
    {
        return Q + name + Q + ":" + Q + Esc(value) + Q;
    }

    static bool Alive(int pid)
    {
        try { using (Process p = Process.GetProcessById(pid)) { return !p.HasExited; } }
        catch { return false; }
    }

    static string ProcName(uint pid)
    {
        if (pid == 0) return "";
        try { using (Process p = Process.GetProcessById((int)pid)) { return p.ProcessName; } }
        catch { return ""; }
    }

    // Windows har app ke liye LastUsedTimeStop likhta hai; 0 = abhi istemal ho raha hai.
    static void Busy(RegistryKey root, bool nonPackaged, List<string> busy)
    {
        if (root == null) return;
        foreach (string name in root.GetSubKeyNames())
        {
            if (!nonPackaged && name == "NonPackaged") continue;
            try
            {
                using (RegistryKey k = root.OpenSubKey(name))
                {
                    if (k == null) continue;
                    object stop = k.GetValue("LastUsedTimeStop");
                    if (stop == null || Convert.ToInt64(stop) != 0) continue;
                    busy.Add(nonPackaged ? name.Substring(name.LastIndexOf('#') + 1) : name);
                }
            }
            catch { }
        }
    }

    static string MicUsers()
    {
        List<string> busy = new List<string>();
        try
        {
            string path = string.Join(B.ToString(), new string[] {
                "Software", "Microsoft", "Windows", "CurrentVersion", "CapabilityAccessManager", "ConsentStore", "microphone" });
            using (RegistryKey root = Registry.CurrentUser.OpenSubKey(path))
            {
                Busy(root, false, busy);
                if (root != null) { using (RegistryKey np = root.OpenSubKey("NonPackaged")) { Busy(np, true, busy); } }
            }
        }
        catch { }
        return string.Join("|", busy.ToArray());
    }

    static bool ScreenKeptAwake()
    {
        try
        {
            uint state;
            if (CallNtPowerInformation(SystemExecutionState, IntPtr.Zero, 0, out state, 4) != 0) return false;
            return (state & DisplayRequired) != 0;
        }
        catch { return false; }
    }

    public static void Run(int parentPid, int intervalMs)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        string last = null;
        string mic = "";
        bool display = false;
        uint namePid = 0;
        string name = "";
        int loop = 0;
        StringBuilder title = new StringBuilder(512);
        while (true)
        {
            if (parentPid > 0 && loop % 4 == 0 && !Alive(parentPid)) return;
            IntPtr hwnd = GetForegroundWindow();
            title.Length = 0;
            GetWindowText(hwnd, title, 512);
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid != namePid) { namePid = pid; name = ProcName(pid); }
            if (loop % 3 == 0) { mic = MicUsers(); display = ScreenKeptAwake(); }
            loop++;
            string text = title.ToString();
            string cur = pid + "|" + name + "|" + text + "|" + mic + "|" + (display ? "1" : "0");
            if (cur != last)
            {
                last = cur;
                Console.Out.WriteLine("{" + Str("app", name) + "," + Str("title", text) + "," + Q + "pid" + Q + ":" + pid
                    + "," + Str("mic", mic) + "," + Q + "display" + Q + ":" + (display ? "true" : "false") + "}");
                Console.Out.Flush();
            }
            Thread.Sleep(intervalMs);
        }
    }
}
'@
[KnockDeskWatch]::Run($ParentPid, $IntervalMs)
`;

module.exports = { FOCUS_WATCH_PS1 };
