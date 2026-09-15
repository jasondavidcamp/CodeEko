# Changelog

## Unreleased

- Build and install from source with the current-user installer.
- Pause prebuilt VSIX downloads; retain release source tags.
- Shorten README and link to setup, usage and development guides.

## 0.4.42 — EKOD naming cleanup

- Use `ekod.*` for every setting, command and view, and `EKOD_*` for development environment variables.
- Use EKOD-only storage, temporary-file and native-diff identifiers.
- Refresh the roadmap around public product capabilities and outstanding verification.
- Upgrade: configure endpoint, model and preferences in EKOD Settings; back up existing extension data first.


## 0.4.41 — Initial public prerelease

- Publish EKOD under the MIT license.
- Repository-aware chat with persistent conversations, configurable permissions, guarded file edits, local commits and read-only commit inspection.
- Automatic Windows PowerShell 5.1 syntax, static-analysis and eligible Pester unit-test validation with bounded repair.
- Dedicated settings page and optional automatic diff tabs (off by default).

### Known limitations

- On some workstations, the chat pane intermittently fails to load until VS Code is restarted again. Export Startup Diagnostics helps investigate; the cause remains unresolved.
- General shell commands, Git push and integration-test execution are not exposed by the runtime.
- This is an experimental prerelease, not a declaration that all roadmap acceptance gates are complete.
