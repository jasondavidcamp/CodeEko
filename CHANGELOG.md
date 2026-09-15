# Changelog

## 0.4.41 — Initial public prerelease

- Publish as EKOD under the jasondavidcamp.ekod extension identity and MIT license.
- Repository-aware chat with persistent conversations, configurable permissions, guarded file edits, local commits and read-only commit inspection.
- Automatic Windows PowerShell 5.1 syntax, static-analysis and eligible Pester unit-test validation with bounded repair.
- Dedicated settings page and optional automatic diff tabs (off by default).
- Retain existing settings and reuse private-installation history when present; the API key must be entered again under the new extension identity.

### Known limitations

- On some workstations, the chat pane intermittently fails to load until VS Code is restarted again. Export Startup Diagnostics helps investigate; the cause remains unresolved.
- General shell commands, Git push and integration-test execution are not exposed by the runtime.
- This is an experimental prerelease, not a declaration that all roadmap acceptance gates are complete.
