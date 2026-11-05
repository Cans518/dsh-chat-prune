# Ask a DSH desktop process to quit through its own normal shutdown path.
#
# DSH 0.2.x hides its window to the tray on close and offers plugins no quit API.
# Its main process does quit normally, saving conversations and stopping the host
# cleanly, when Windows ends the session. This sends that same close-application
# notification (WM_QUERYENDSESSION / WM_ENDSESSION with ENDSESSION_CLOSEAPP, as the
# Windows Restart Manager does) and then WM_CLOSE to the process's own windows.
# It never terminates a process.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ProcessId)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DshCloseRequest {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  const uint WM_CLOSE = 0x0010, WM_QUERYENDSESSION = 0x0011, WM_ENDSESSION = 0x0016;
  const uint SMTO_ABORTIFHUNG = 0x0002;
  static readonly IntPtr ENDSESSION_CLOSEAPP = new IntPtr(0x00000001);

  public static int Request(uint processId) {
    var windows = new List<IntPtr>();
    EnumWindows((hwnd, _) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner != processId) return true;
      var name = new StringBuilder(64);
      GetClassName(hwnd, name, name.Capacity);
      // Chromium/Electron BrowserWindows; tray and internal helper windows use other classes.
      if (name.ToString() == "Chrome_WidgetWin_1") windows.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    IntPtr ignored;
    foreach (var hwnd in windows) {
      SendMessageTimeout(hwnd, WM_QUERYENDSESSION, IntPtr.Zero, ENDSESSION_CLOSEAPP, SMTO_ABORTIFHUNG, 5000, out ignored);
      SendMessageTimeout(hwnd, WM_ENDSESSION, new IntPtr(1), ENDSESSION_CLOSEAPP, SMTO_ABORTIFHUNG, 5000, out ignored);
    }
    foreach (var hwnd in windows) PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    return windows.Count;
  }
}
'@
$count = [DshCloseRequest]::Request([uint32]$ProcessId)
Write-Output "close-requested windows=$count"
if ($count -eq 0) { exit 4 }
