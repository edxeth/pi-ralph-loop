# Native Windows planning

## Planning goals

Clarify Windows-specific assumptions early so the loop does not get stuck on UAC, packaging, shell/tooling mismatches, or filesystem quirks.

## Questions to resolve during planning

1. Is Windows the execution host, the target app OS, or both?
2. Is the authoritative verification environment local Windows, remote CI, or both?
3. Is unsigned packaging acceptable, or are signing/notarization-like steps required?
4. Are admin-only operations expected? If so, must elevation already be present before the loop starts?
5. Which shell/entrypoints are expected to work: `cmd.exe`, `powershell.exe`, `pwsh.exe`, native terminal, or app-specific CLIs?
6. Does the plan depend on Windows-only runtime components such as WebView2, tray behavior, hotkeys, services, or installers?
7. Is a drive-backed working directory required, or can the work safely run from the current path?

## Useful local verification checks

Use only the checks relevant to the planning task.

- `cmd.exe /c ver`
- `cmd.exe /c whoami`
- `'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoProfile -ExecutionPolicy Bypass -Command '$PSVersionTable.PSVersion.ToString()'`
- PowerShell admin probe:
  - `'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoProfile -ExecutionPolicy Bypass -Command '$id = [Security.Principal.WindowsIdentity]::GetCurrent(); $p = New-Object Security.Principal.WindowsPrincipal($id); [pscustomobject]@{ User = $id.Name; IsAdmin = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress'`
- Windows admin fallback probe:
  - `cmd.exe /c "fltmc >nul 2>&1 && echo ADMIN_OK || echo ADMIN_NO"`

## Planning guidance

- Prefer plans that avoid interactive UAC prompts during the loop.
- If elevation is required, encode that it must be present before loop start and verify it again at startup.
- Treat packaging, installer creation, tray/hotkey behavior, and native runtime dependencies as first-class verification concerns.
- If the repo is not on a drive-backed Windows path, do not assume Windows tooling will like the current working directory.
- Put Windows-specific startup checks into `.ralph/prompt.md` only when they are actually relevant.

## What to encode in the Ralph bundle

When relevant, make the bundle explicit about:
- Windows version/arch assumptions
- required shell/tool entrypoints
- whether admin is required, optional, or forbidden
- packaging artifact expectations
- runtime dependencies that must be present or detected
- unattended verification commands and failure signals
