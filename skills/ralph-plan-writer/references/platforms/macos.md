# macOS system preflight

Use this reference only when the plan depends on macOS host/runtime setup, Homebrew, Xcode tools, codesign/notarization, GUI permissions, launchd, app bundles, or Apple runtime constraints.

## Resolve before writing `.ralph/`

- Role: execution host, target runtime, verification host, or split topology.
- macOS version and CPU architecture.
- Xcode Command Line Tools, SDK, and Homebrew requirements.
- Privilege model: no privilege, admin approval, GUI permission, keychain/signing identity, or pre-provisioned outside the loop.
- Packaging/signing scope: local dev artifact, app bundle, signed app, notarized artifact, installer.
- Verification path that can run unattended.

## Safe probes

Run only probes relevant to the plan.

- `sw_vers`
- `uname -m`
- `xcode-select -p`
- `brew --version`
- `codesign --version`
- `security find-identity -p codesigning -v`

## Block the bundle when

- the loop would need interactive admin, accessibility, screen-recording, automation, keychain, signing, or notarization approval
- Xcode tools, SDKs, Homebrew packages, signing identities, or Apple credentials are unverified
- verification depends on GUI dialogs or permission prompts during the loop
- packaging/distribution requirements are unclear

## Encode in the bundle

Record confirmed macOS version, architecture, tooling, privilege/permission model, signing or packaging scope, and unattended verification commands in `.ralph/plan.md`. Add startup checks to `.ralph/prompt.md` only when the runtime agent must revalidate them before working.
