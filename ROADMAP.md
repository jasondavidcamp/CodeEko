# EKOD Roadmap

## Product direction

EKOD is a TypeScript VS Code extension that connects a configurable HTTPS model endpoint to local repository tools. It provides persistent chat, permission controls, file editing, Git inspection, validation and bounded repair. The initial language target is PowerShell in Git repositories on Windows.

README.md introduces the product and links to setup, usage and development guides. AGENTS.md defines contributor working boundaries. This roadmap records implemented capabilities and remaining work. Checked items have automated or recorded live evidence; they do not imply every workstation configuration has been verified.

## Implemented capabilities

### Conversation and configuration

- [x] Install EKOD as a self-contained VS Code extension.
- [x] Configure an HTTPS endpoint with no built-in default; store API keys in VS Code SecretStorage.
- [x] Discover models and support a configured fallback.
- [x] Persist named conversations per repository, with recent chats, searchable history and activity times.
- [x] Rename, archive and restore conversations from the chat pane.
- [x] Keep conversation questions, permission choices and model selection in the pane.
- [x] Provide a dedicated settings tab and automatic sidebar activation.
- [x] Use the `ekod.*` namespace for settings, commands and views.
- [x] Keep product documentation independent of publisher accounts and derive runtime/test identity from installation metadata.
- [x] Keep automatic diff tabs off by default; provide an opt-in setting.

### Repository awareness and editing

- [x] Discover the workspace and Git root; resolve multi-root ambiguity in the pane.
- [x] Index eligible files while excluding ignored, linked, generated, binary and sensitive paths.
- [x] Search filenames, text and PowerShell symbols; support bounded individual and batch reads.
- [x] Validate structured model actions before execution.
- [x] Implement patch, create, move and delete operations with containment and stale-content checks.
- [x] Preserve supported encodings, byte-order marks and line endings.
- [x] Preserve dirty editor buffers and attribute task changes separately from preexisting work.
- [x] Recover bounded read/hash and literal-target errors using fresh file evidence.
- [x] Support explicit repeated-text replacements with full preflight.
- [x] Inspect working-tree status and selected commit history, including tracked deletions and renames.
- [x] Commit explicitly selected files when requested, including “commit just” and “commit only” requests, preserving unrelated staged and unstaged changes.
- [x] Provide native diffs and task-scoped undo with ambiguous-reversal refusal.

### Permissions and task control

- [x] Review mode permits repository inspection without edits.
- [x] Workspace mode confirms destructive operations in the chat pane.
- [x] Full access permits supported repository edits and validation without operation confirmations.
- [x] Retain path, stale-file, unsaved-buffer and operation-schema checks in every mode.
- [x] Support cancellation, follow-ups and one executing task per repository.
- [x] Bound model calls, context, output, tool duration and repair attempts.
- [x] Report completed work and unresolved failures when a task stops.

Full access currently covers supported repository tools and fixed validation commands. General shell execution and Git push are not implemented.

### Validation and recovery

- [x] Run Windows PowerShell 5.1 parsing and available PSScriptAnalyzer checks.
- [x] Discover Pester versions and support explicit major-version selection.
- [x] Automatically inspect and select eligible unit tests and local dependencies.
- [x] Report unsupported or skipped suites as partial coverage.
- [x] Provide optional current-user installation of missing validation modules.
- [x] Feed failures back into bounded repair and stop repeated unchanged failures.
- [x] Compare compatible pre-edit Pester 5 observations with later results.
- [x] Preserve task evidence across synthetic interrupted-write, move and delete scenarios.
- [x] Test extension-host termination during validation and cleanup of owned child processes.
- [x] Recover interrupted tasks without automatically replaying edits or claiming validation success.
- [x] Prevent delayed watcher notifications from falsely changing validation membership.

### Diagnostics and distribution

- [x] Persist bounded startup lifecycle diagnostics with webview handshake and bootstrap events.
- [x] Export sanitized startup diagnostics independently of a functioning chat pane.
- [x] Offer opt-in bounded rejected-response capture and offline schema replay.
- [x] Document install, build, configuration, limitations and data cleanup.
- [x] Provide a current-user source-build installer with locked dependencies, optional tests, build-only mode and installed-version verification.
- [x] Publish the initial MIT-licensed experimental release. Binary distribution is now paused; source installation is the current path.
- [x] Keep README brief and move setup, usage and development details to linked guides.

## Next priorities

1. **Startup reliability.** Reproduce and diagnose the intermittent chat initialization failure on an affected profile. Some users need a second VS Code restart; the cause remains unresolved.
2. **End-to-end task reliability.** Exercise conversational corrections, test generation, cancellation, resume and undo across representative repositories.
3. **Validation compatibility.** Broaden test-suite compatibility and verify Pester 4 on a configuration where it is available.
4. **Performance.** Measure model calls, context growth and test-generation latency over repeated runs before tuning limits.
5. **Distribution quality.** Add repeatable release automation and expand platform/configuration checks before a stable release.

## Remaining acceptance checks

- [ ] Reproduce the startup failure and demonstrate the fix over repeated full-application restarts.
- [ ] Verify editing, validation, follow-ups and undo in representative repositories and installed profiles.
- [ ] Expand recovery checks from synthetic interruption points to representative workstation conditions.
- [ ] Verify real Pester 4 execution; current automated coverage skips it when unavailable.
- [ ] Verify complex eligible-test selection and report partial coverage clearly.
- [ ] Improve test-failure attribution when no compatible pre-edit observation exists.
- [ ] Validate certificate trust, proxies, timeouts, API failures and model-list fallback across configurations.
- [ ] Verify local commits under additional repository configurations and interruption scenarios.
- [ ] Measure repeated live test-generation performance and duplicate-suite avoidance.
- [ ] Improve durable task intent and validation context across long conversations.
- [ ] Add response streaming and broader structured local diagnostics without recording credentials.
- [ ] Automate release packaging, checksum generation and verification.

## Deferred scope

- General shell commands and broader network tools.
- Git push and autonomous commits without a user request.
- Concurrent tasks against one repository and multi-repository edits.
- Integration tests or other environment-changing validation.
- Additional programming languages.
- Repository instruction-file support.
- Embeddings until measured retrieval failures justify them.
- Detailed model-request inspection and centralized policy management.
- Marketplace distribution until release quality is established.

## Evidence and limits

The initial public prerelease passed 118 tests with one unavailable Pester 4 check skipped, plus an isolated native VS Code 1.137.0 sidebar/settings check. Live model tests used synthetic PowerShell fixtures. Six repeated launches against one isolated profile passed but did not reproduce the intermittent startup failure. These results do not close the outstanding installed-profile, representative-repository or startup checks above.

Detailed acceptance scenarios and validation behavior are documented in `docs/ACCEPTANCE.md` and `docs/VALIDATION.md`. Moves involve multiple filesystem operations and are not atomic as a whole. Unit-test selection is conservative inspection, not an execution sandbox. An experimental release is not evidence that all acceptance gates are complete.

Naming cleanup verification (0.4.42): 118 tests passed, one unavailable Pester 4 check skipped, and the native VS Code 1.137.0 activation/sidebar/settings check passed. Current tracked files and the rebuilt VSIX were scanned for retired product identifiers and publication-sensitive references; none were found. Earlier commit history remains unchanged; release binaries were subsequently removed.

Source installer verification: a real dependency restore and package build passed, the built VSIX installed into an isolated VS Code user profile, and Windows PowerShell 5.1 subprocess tests verified paths containing spaces, build-only mode, optional tests and stop-on-failure behavior. No elevation or workstation-policy changes were used by the installer.
