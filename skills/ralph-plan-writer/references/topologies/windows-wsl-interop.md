# Windows and WSL cross-boundary planning

## Planning goals

Surface cross-boundary risks during planning so the loop does not discover them too late.

## Questions to resolve during planning

1. Where does the Ralph loop run: Windows shell, WSL shell, or both?
2. Where does the repo live: Windows filesystem, WSL filesystem, or staged copies/worktrees in both?
3. Which side is the authoritative execution host for builds, packaging, and verification?
4. Are Windows tools expected to run from a WSL-launched session?
5. Is Windows admin required? If so, can it be inherited by launching WSL from an already elevated Windows terminal?
6. Is temporary Windows-side staging allowed to avoid UNC/current-directory issues?
7. Does verification depend on Windows↔WSL localhost communication?
8. Is the WSL distro already installed and usable, or must the loop discover/bootstrap it?

## Useful local verification checks

Use only the checks relevant to the planning task.

- `command -v cmd.exe`
- `command -v wslpath`
- `command -v powershell.exe`
- `wslpath -w "$PWD"`
- `cmd.exe /c ver`
- `cmd.exe /c whoami`
- PowerShell admin probe:
  - `'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoProfile -ExecutionPolicy Bypass -Command '$id = [Security.Principal.WindowsIdentity]::GetCurrent(); $p = New-Object Security.Principal.WindowsPrincipal($id); [pscustomobject]@{ User = $id.Name; IsAdmin = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress'`
- Windows admin fallback probe:
  - `cmd.exe /c "fltmc >nul 2>&1 && echo ADMIN_OK || echo ADMIN_NO"`

## Key planning risks

- A WSL repo path usually maps to `\\wsl.localhost\...`, and many Windows tools do not like that as a working directory.
- A drive-backed Windows staging/worktree may be required for packaging or app execution.
- Windows processes launched from WSL can inherit the Windows token behind the session; this matters for elevation-sensitive steps.
- Localhost behavior across Windows and WSL must be verified rather than assumed.
- Performance and tool behavior differ between WSL filesystem paths and Windows filesystem paths.

## Planning guidance

- Explicitly separate execution host, target OS, and verification host in the plan.
- If Windows elevation matters, ask about it during planning and encode a startup verification check in `.ralph/prompt.md`.
- Prefer plans that avoid interactive UAC prompts during the loop.
- If Windows tooling is likely to choke on a UNC path, plan an explicit staging or worktree strategy instead of leaving it implicit.
- Encode only the cross-boundary checks the runtime agent actually needs.

## What to encode in the Ralph bundle

When relevant, make the bundle explicit about:
- startup verification of interop tools and elevation
- Windows↔WSL path translation and staging rules
- which commands run on which side of the boundary
- where artifacts and logs should live
- how localhost connectivity is verified
- what counts as a blocker vs an assumption in unattended execution
