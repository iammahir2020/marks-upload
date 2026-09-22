# Run the backend and frontend dev servers together. Ctrl+C stops both.
# The Windows counterpart of ./dev.sh — same job, different mechanism.
#
#   .\dev.ps1
#   $env:RECOGNIZER = "remote"; .\dev.ps1
#
# RECOGNIZER defaults to "cnn" (step 3r.6e) — fully local, so no
# GEMINI_API_KEY and no Tesseract binary are needed for a normal run. Set
# $env:RECOGNIZER before invoking this to use Gemini+Tesseract instead;
# that path does need backend\.env to carry a real key.
#
# Why this is not just dev.sh run through Git Bash: dev.sh stops its
# children with `kill -TERM 0`, a POSIX process-GROUP broadcast, and the
# long comment in that file is about getting the group membership exactly
# right so that uvicorn's --reload watcher and npm's real vite child are
# both inside it. Windows has no process groups in that sense. It has two
# separate things that between them cover the same ground:
#
#   1. The console. Every child started with -NoNewWindow shares this
#      console, and Windows delivers Ctrl+C to all of them at once.
#      uvicorn and vite each handle it correctly, so the ordinary case
#      needs no cleanup code at all.
#   2. `taskkill /T` in the finally block, which walks the real process
#      tree. This is what actually reaches uvicorn's reload worker:
#      `venv\Scripts\python.exe` is a launcher that spawns the real
#      interpreter, which spawns the reload worker, so the server is a
#      GRANDchild of what this script starts. Measured — /T terminates
#      all three, and port 8000 is free straight afterwards. It works
#      only while the tree is intact, which in the finally block it is.
#   3. A Job object with KILL_ON_JOB_CLOSE, as a backstop for the one
#      case (1) and (2) both miss: this script being killed outright
#      rather than asked to stop, so no finally ever runs.
#
# (3) took two attempts to get right, and the reason is worth keeping.
# Assigning only the two processes Start-Process returns is not enough:
# `venv\Scripts\python.exe` is a LAUNCHER that spawns the real interpreter
# immediately — sooner than this script can get back from Start-Process
# and call AssignPid — so uvicorn, and the reload worker it later spawns,
# were being born OUTSIDE the job. Measured symptom: a hard kill left the
# worker holding port 8000 while its parents died correctly. The fix is
# the second, delayed pass below, which walks the real tree once the
# servers are up. Assigning the interpreter itself is what matters: from
# then on every reload worker it spawns is born into the job, so the pass
# never has to repeat. Verified twice by hard-killing this script and
# confirming both ports come back bindable.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$venvPython = Join-Path $PSScriptRoot 'backend\venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Error "No backend venv at $venvPython. Create one first:`n  py -m venv backend\venv`n  backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt"
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'frontend\node_modules'))) {
    Write-Error "frontend\node_modules is missing. Run:`n  cd frontend; npm install"
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'backend\certs\cert.pem'))) {
    Write-Host 'No backend dev cert found - generating one (gen_dev_cert.py)...'
    & $venvPython (Join-Path $PSScriptRoot 'backend\gen_dev_cert.py')
    if ($LASTEXITCODE -ne 0) { Write-Error 'gen_dev_cert.py failed - see above.' }
}

if (-not ('MarksDev.JobObject' -as [type])) {
    Add-Type -Namespace MarksDev -Name JobObject -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
public static extern IntPtr CreateJobObject(IntPtr a, string lpName);

[DllImport("kernel32.dll")]
public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len);

[DllImport("kernel32.dll")]
public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

[DllImport("kernel32.dll")]
public static extern bool CloseHandle(IntPtr h);

// The handle Start-Process -PassThru hands back is not guaranteed to
// carry PROCESS_SET_QUOTA | PROCESS_TERMINATE, which is what
// AssignProcessToJobObject needs. Open our own with those rights
// (0x0100 | 0x0001) instead of hoping.
public static bool AssignPid(IntPtr job, int pid) {
    IntPtr h = OpenProcess(0x0100 | 0x0001, false, pid);
    if (h == IntPtr.Zero) return false;
    bool ok = AssignProcessToJobObject(job, h);
    CloseHandle(h);
    return ok;
}

// JOBOBJECT_EXTENDED_LIMIT_INFORMATION, declared rather than written out
// as a byte count: it is 144 bytes under 64-bit PowerShell and 112 under
// 32-bit, because five of its fields are SIZE_T. Letting Marshal work the
// size out keeps this correct in both hosts. LimitFlags happens to sit at
// offset 16 either way, but the struct says so rather than a comment.
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct ExtendedLimit {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public IntPtr MinimumWorkingSetSize;
    public IntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public IntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
    public IntPtr ProcessMemoryLimit;
    public IntPtr JobMemoryLimit;
    public IntPtr PeakProcessMemoryUsed;
    public IntPtr PeakJobMemoryUsed;
}

public static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    ExtendedLimit limit = new ExtendedLimit();
    limit.LimitFlags = 0x2000;  // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    int size = System.Runtime.InteropServices.Marshal.SizeOf(typeof(ExtendedLimit));
    IntPtr info = System.Runtime.InteropServices.Marshal.AllocHGlobal(size);
    System.Runtime.InteropServices.Marshal.StructureToPtr(limit, info, false);
    // 9 == JobObjectExtendedLimitInformation
    bool ok = SetInformationJobObject(job, 9, info, (uint)size);
    System.Runtime.InteropServices.Marshal.FreeHGlobal(info);
    return ok ? job : IntPtr.Zero;
}
'@
}

$job = [MarksDev.JobObject]::CreateKillOnCloseJob()
if ($job -eq [IntPtr]::Zero) {
    # Not fatal: the console signal and the finally block still cover the
    # ordinary Ctrl+C. Say so rather than pretending the guarantee holds.
    Write-Warning 'Could not create a Job object; servers may outlive this script if it is killed rather than stopped.'
}

$procs = @()
try {
    # -NoNewWindow keeps both children attached to THIS console, which is
    # what makes Ctrl+C reach them. A new window would give each its own
    # console and Ctrl+C here would reach neither.
    $procs += Start-Process -FilePath $venvPython -NoNewWindow -PassThru `
        -WorkingDirectory (Join-Path $PSScriptRoot 'backend') `
        -ArgumentList @(
            '-m', 'uvicorn', 'app.main:app', '--reload', '--host', '0.0.0.0',
            '--ssl-keyfile', 'certs/key.pem', '--ssl-certfile', 'certs/cert.pem'
        )

    # npm is a .cmd shim, which Start-Process cannot execute directly —
    # cmd.exe has to run it. cmd.exe joins the job, and vite is born into
    # it as cmd's own child.
    $procs += Start-Process -FilePath 'cmd.exe' -NoNewWindow -PassThru `
        -WorkingDirectory (Join-Path $PSScriptRoot 'frontend') `
        -ArgumentList @('/c', 'npm', 'run', 'dev')

    if ($job -ne [IntPtr]::Zero) {
        foreach ($p in $procs) {
            if (-not [MarksDev.JobObject]::AssignPid($job, $p.Id)) {
                Write-Warning "Could not put PID $($p.Id) in the cleanup job; it may outlive this script if killed."
            }
        }

        # Then, a moment later, everything they have spawned since.
        #
        # There is a race that the two assignments above cannot win.
        # `venv\Scripts\python.exe` is a LAUNCHER: it spawns the real
        # interpreter immediately, in less time than it takes to get back
        # from Start-Process and call AssignPid. So the process that
        # actually runs uvicorn — and therefore the reload worker IT later
        # spawns — can be born outside the job, which is exactly the
        # symptom measured before this: a hard kill of this script left the
        # worker holding port 8000 while its parents died correctly.
        #
        # A second pass after the servers are up closes it. Assigning the
        # real interpreter matters most: once IT is in the job, every
        # reload worker it spawns from then on is born into the job too, so
        # this does not need to repeat for the rest of the session.
        Start-Sleep -Seconds 8
        foreach ($p in $procs) {
            $frontier = @($p.Id)
            while ($frontier.Count -gt 0) {
                $next = @()
                foreach ($parent in $frontier) {
                    foreach ($child in (Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" -ErrorAction SilentlyContinue)) {
                        [void][MarksDev.JobObject]::AssignPid($job, $child.ProcessId)
                        $next += $child.ProcessId
                    }
                }
                $frontier = $next
            }
        }
    }

    Wait-Process -Id ($procs | ForEach-Object { $_.Id })
}
finally {
    # Cleanup, in the order that actually works.
    #
    # `taskkill /T` is the real mechanism: it walks the live process tree,
    # which is what reaches uvicorn's reload worker two levels down. It
    # only works while the tree is intact, so it runs first, before
    # anything above has had a chance to break it.
    #
    # No `2>$null` on these calls: in Windows PowerShell 5.1, redirecting
    # a native command's stderr wraps each line in an ErrorRecord, which
    # with $ErrorActionPreference = 'Stop' aborts the rest of this block —
    # and taskkill writes to stderr routinely, for something as ordinary
    # as a pid that has already exited. Cleanup that stops halfway on a
    # non-problem is worse than noisy cleanup, so the output is discarded
    # with Out-Null (stdout only) and errors are made non-fatal locally.
    $ErrorActionPreference = 'Continue'
    foreach ($p in $procs) {
        if ($null -eq $p) { continue }
        & taskkill.exe /PID $p.Id /T /F | Out-Null
    }

    # Then a report, not a second fight. If a port is still held after
    # the tree kill, something escaped in a way this script cannot
    # reliably trace — a reload worker orphaned by a crash mid-session,
    # say — and guessing at pids from the connection table makes that
    # worse, not better: the table names whichever process OPENED the
    # listening socket, which for uvicorn --reload is frequently one that
    # has already exited while the worker it handed the socket to is
    # still running. Naming the port and the command to investigate is
    # more useful than a sweep that cannot verify its own result.
    Start-Sleep -Milliseconds 500
    foreach ($port in 8000, 5173) {
        $held = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
        if ($held) {
            Write-Warning "Port $port is still held after cleanup. Find and stop it with:"
            Write-Warning "  Get-NetTCPConnection -State Listen -LocalPort $port | ForEach-Object { taskkill /PID `$_.OwningProcess /T /F }"
        }
    }
}
