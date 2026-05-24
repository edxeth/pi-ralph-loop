# Windows system preflight

Use this reference only when the plan depends on Windows host/runtime setup, PowerShell/cmd, UAC/admin, Win32 apps, WebView2, tray/hotkeys, services, installers, or Windows packaging.

## Resolve before writing `.ralph/`

- Role: execution host, target runtime, verification host, or split topology.
- Windows version/architecture and required shell entrypoints.
- Privilege model: normal user, already elevated admin, forbidden admin, or setup handled outside the loop.
- Native dependencies: WebView2, Visual Studio tools, services, installers, certificates, tray/hotkey behavior, or app packaging.
- Working-directory requirements: drive-backed path, staging path, or current path.
- Verification path that can run unattended without UAC dialogs.

## Safe probes

Run only probes relevant to the plan.

- `cmd.exe /c ver`
- `cmd.exe /c whoami`
- `cmd.exe /c "fltmc >nul 2>&1 && echo ADMIN_OK || echo ADMIN_NO"`
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$PSVersionTable.PSVersion.ToString()"`
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=New-Object Security.Principal.WindowsPrincipal($id);[pscustomobject]@{User=$id.Name;IsAdmin=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress"`

## Block the bundle when

- the loop would need an interactive UAC prompt
- admin, signing, installer tooling, WebView2, services, or native build tools are required but unverified
- Windows tooling must run from a path that may be UNC/WSL-backed and no staging plan exists
- verification depends on GUI state, tray behavior, hotkeys, or installers without an unattended check

## Encode in the bundle

Record confirmed Windows version, shell entrypoints, privilege model, native dependencies, staging rules, artifact expectations, and unattended verification commands in `.ralph/plan.md`. Add startup checks to `.ralph/prompt.md` only when the runtime agent must revalidate them before working.
