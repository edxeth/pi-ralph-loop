# Native macOS planning

## Planning goals

Resolve macOS-specific tooling, signing, GUI permission, and architecture assumptions before the Ralph loop starts.

## Questions to resolve during planning

1. Is macOS the execution host, the target runtime, or both?
2. Which macOS version and CPU arch matter: Intel, Apple Silicon, or universal output?
3. Are Xcode Command Line Tools required and present?
4. Is Homebrew part of the expected setup?
5. Are codesign, notarization, keychain access, or Apple developer credentials required?
6. Does the plan depend on GUI automation, accessibility permissions, launchd agents, or app bundle packaging?
7. Is the verification path local-only or CI-driven?

## Useful local verification checks

Use only the checks relevant to the planning task.

- `sw_vers`
- `uname -m`
- `xcode-select -p`
- `brew --version`
- `security find-identity -p codesigning -v`
- `codesign --version`

## Planning guidance

- Treat codesign/notarization as explicit scope decisions, not implicit assumptions.
- Be careful with GUI automation and accessibility permissions; unattended loops should not depend on a human approving dialogs mid-run.
- Distinguish local development packaging from distributable macOS packaging.
- Encode only the startup checks relevant to the actual macOS constraints in the plan.

## What to encode in the Ralph bundle

When relevant, make the bundle explicit about:
- macOS version/arch assumptions
- Xcode/Homebrew/tooling requirements
- signing/notarization expectations
- launchd/accessibility or app-bundle constraints
- verification commands and logs needed for unattended execution
