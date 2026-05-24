# Linux system preflight

Use this reference only when the plan depends on Linux host/runtime setup, packages, services, daemons, devices, display/audio, containers, `sudo`, root, or Linux packaging.

## Resolve before writing `.ralph/`

- Role: execution host, target runtime, verification host, or split topology.
- Distro/version and package manager.
- Privilege model: no privilege, `sudo` available, root shell, or pre-provisioned outside the loop.
- System dependencies: packages, services, daemons, sockets, devices, containers, GPU, audio, display, or kernel features.
- Verification path that can run unattended.

## Safe probes

Run only probes relevant to the plan.

- `uname -a`
- `cat /etc/os-release`
- `id`
- `command -v sudo`
- `sudo -n true`
- `command -v apt dnf yum pacman zypper`
- `systemctl --version`

## Block the bundle when

- the loop would need an unknown `sudo` password or interactive privilege prompt
- required packages, services, devices, containers, display/audio stacks, or drivers are unverified
- verification requires hardware, daemon state, or root access the loop cannot get unattended
- setup would mutate the host and the user has not approved that setup path

## Encode in the bundle

Record confirmed distro, package manager, privilege model, system dependencies, service/process model, and unattended verification commands in `.ralph/plan.md`. Add startup checks to `.ralph/prompt.md` only when the runtime agent must revalidate them before working.
