# Native Linux planning

## Planning goals

Resolve distro, package manager, privilege, service, and device/runtime assumptions before generating the Ralph bundle.

## Questions to resolve during planning

1. Which distro and version matter for execution and verification?
2. Is Linux the primary host, the target runtime, or just the backend side of a split topology?
3. Are `sudo`/root privileges available, unavailable, or to be avoided?
4. Which package manager is expected: `apt`, `dnf`, `yum`, `pacman`, `zypper`, or something else?
5. Does the plan depend on system services, `systemd`, sockets, device access, or GUI stacks like X11/Wayland/PulseAudio?
6. Are there kernel/runtime assumptions such as GPU drivers, ALSA, PulseAudio, Docker, or namespace features?
7. Is verification local-only, containerized, or CI-driven?

## Useful local verification checks

Use only the checks relevant to the planning task.

- `uname -a`
- `cat /etc/os-release`
- `command -v sudo`
- `sudo -n true`
- `command -v apt dnf yum pacman zypper`
- `systemctl --version`
- `id`

## Planning guidance

- Prefer non-interactive verification paths.
- If `sudo` is required, determine whether it is already usable non-interactively or whether the loop must avoid it.
- Distinguish base OS setup from project-local setup.
- Be explicit about display/audio/device assumptions for desktop or media workflows.
- Do not add Linux startup checks to `.ralph/prompt.md` unless Linux-specific risk is part of the plan.

## What to encode in the Ralph bundle

When relevant, make the bundle explicit about:
- distro/version assumptions
- package manager commands
- `sudo` expectations
- service/process model
- device/runtime dependencies
- verification commands and logs required for unattended execution
