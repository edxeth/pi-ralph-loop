# Windows and WSL interop preflight

Use this reference only when the plan crosses Windows and WSL, uses Windows tools from WSL, depends on `wsl.exe`/`wslpath`, touches UNC paths, relies on Windows↔WSL localhost behavior, or needs inherited Windows elevation.

## Resolve before writing `.ralph/`

- Ralph execution host: Windows shell, WSL shell, or both.
- Repo location: Windows drive path, WSL filesystem path, or staged/worktree copies.
- Authoritative side for build, packaging, tests, app launch, and logs.
- Path translation rules and artifact locations.
- Whether Windows tools can run from the current WSL session and working directory.
- Windows admin model when elevation-sensitive steps exist.
- Localhost direction: Windows to WSL, WSL to Windows, or both.

## Safe probes

Run only probes relevant to the plan.

- `command -v cmd.exe`
- `command -v wslpath`
- `command -v powershell.exe`
- `wslpath -w "$PWD"`
- `cmd.exe /c ver`
- `cmd.exe /c whoami`
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '$PSVersionTable.PSVersion.ToString()'`
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '$id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=New-Object Security.Principal.WindowsPrincipal($id);[pscustomobject]@{User=$id.Name;IsAdmin=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress'`

## Block the bundle when

- the repo path maps to UNC and required Windows tools may reject it
- the plan needs Windows admin but WSL did not inherit an elevated Windows token
- build/test/package steps cross the boundary without a staging or path strategy
- localhost behavior matters and no safe connectivity check exists
- required commands must run on both sides but one side lacks the needed toolchain

## Encode in the bundle

Record execution side, verification side, staging/worktree strategy, path conversion rules, elevation assumptions, localhost checks, and artifact/log locations in `.ralph/plan.md`. Add startup checks to `.ralph/prompt.md` only for boundary facts the runtime agent must revalidate before working.
