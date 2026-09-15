# Changelog

## Unreleased

- Build and install from source with the current-user installer.
- Pause prebuilt VSIX downloads; retain release source tags.
- Shorten README and link to setup, usage and development guides.

## 0.4.46 — Default endpoint compatibility

- Default to User message compatibility for new and unset configurations.
- Keep Standard available and preserve explicitly saved preferences.

## 0.4.45 — Endpoint compatibility

- Add optional User message compatibility mode, without system messages or the JSON-mode request parameter.
- Retry empty responses with the original request and preserve task context during format correction.
- Retain strict action validation, permission enforcement and bounded correction attempts.

## 0.4.44 — Diagnostic log navigation

- Add Open rejected-response logs to Diagnostics settings, revealing the newest capture without displaying its contents.
- Open extension storage with capture instructions when no logs exist.

## 0.4.43 — Selected-file commit requests

- Recognize explicit requests such as “commit just the six character test for now” and “commit only this test.”
- Verify that committing one selected file preserves unrelated staged and unstaged changes.

## 0.4.42 — EKOD naming cleanup

- Use `ekod.*` for every setting, command and view, and `EKOD_*` for development environment variables.
- Use EKOD-only storage, temporary-file and native-diff identifiers.
- Refresh the roadmap around public product capabilities and outstanding verification.
- Upgrade: configure endpoint, model and preferences in EKOD Settings; back up existing extension data first. Chats and diagnostics now use EKOD’s private extension storage; data in other extension storage folders is not loaded automatically. API keys remain in VS Code SecretStorage.


## 0.4.41 — Initial public prerelease

- Publish EKOD under the MIT license.
- Repository-aware chat with persistent conversations, configurable permissions, guarded file edits, local commits and read-only commit inspection.
- Automatic Windows PowerShell 5.1 syntax, static-analysis and eligible Pester unit-test validation with bounded repair.
- Dedicated settings page and optional automatic diff tabs (off by default).

### Known limitations

- On some workstations, the chat pane intermittently fails to load until VS Code is restarted again. Export Startup Diagnostics helps investigate; the cause remains unresolved.
- General shell commands, Git push and integration-test execution are not exposed by the runtime.
- This is an experimental prerelease, not a declaration that all roadmap acceptance gates are complete.
