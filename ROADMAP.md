# CodeEko Roadmap

## Product direction

CodeEko is a TypeScript VS Code extension that connects a configurable HTTPS model endpoint to local repository tools. It provides persistent chat, permission controls, file editing, Git inspection, validation and bounded repair. The initial language target is PowerShell in Git repositories on Windows. C# and TypeScript are planned next; language-specific indexing and validation for them are not yet implemented. A future Visual Studio extension is planned alongside VS Code, using shared runtime capabilities behind editor-specific adapters.

README.md introduces the product and links to setup, usage and development guides. AGENTS.md defines contributor working boundaries. This roadmap records implemented capabilities and remaining work. Checked items have automated or recorded live evidence; they do not imply every workstation configuration has been verified.

## Implemented capabilities

### Conversation and configuration

- [x] Install CodeEko as a self-contained VS Code extension.
- [x] Configure an HTTPS endpoint with no built-in default; store API keys in VS Code SecretStorage.
- [x] Discover models and support a configured fallback.
- [x] Default to User message compatibility for endpoints that do not support system instructions or JSON mode.
- [x] Retain original task context through empty-response retries and format correction.
- [x] Recover recognized provider malformed-function-call rejections with bounded plain-JSON retries; preserve finish reasons without executing rejected responses.
- [x] Diagnose over-escaped action JSON and provide targeted bounded-repair guidance and a multiline editing example; verify strict rejection, source preservation, permission enforcement and offline replay using captured failure shapes.
- [x] Persist named conversations per repository, with recent chats, searchable history and activity times.
- [x] Rename, archive and restore conversations from the chat pane.
- [x] Keep conversation questions, permission choices and model selection in the pane.
- [x] Provide a dedicated settings tab and automatic sidebar activation.
- [x] Use the `codeeko.*` namespace for settings, commands and views.
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
- [x] Route direct conversational undo requests to guarded local undo, preserving unrelated pending work and reporting missing conversation task history without a model call.

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
- [x] Retry transient repository-lease contention during reload with a five-second limit and pane-disposal cancellation; test exclusion, reacquisition and Windows owner-process termination.
- [x] Export sanitized startup diagnostics independently of a functioning chat pane.
- [x] Offer opt-in bounded rejected-response capture and offline schema replay.
- [x] Open the latest rejected-response capture directly from Diagnostics settings, with guidance when no logs exist.
- [x] Document install, build, configuration, limitations and data cleanup.
- [x] Provide a current-user source-build installer with locked dependencies, optional tests, build-only mode and installed-version verification.
- [x] Publish the initial MIT-licensed experimental release. Binary distribution is now paused; source installation is the current path.
- [x] Keep README brief and move setup, usage and development details to linked guides.

## Next priorities

1. **Startup reliability.** Verify the bounded lease-retry fix across repeated full-application restarts and additional profiles. An affected installed profile failed at lease acquisition during reload; broader startup failure causes remain unconfirmed.
2. **End-to-end task reliability.** Exercise conversational corrections, test generation, cancellation, resume and undo across representative repositories.
3. **Validation compatibility.** Broaden test-suite compatibility and verify Pester 4 on a configuration where it is available.
4. **Performance.** Reduce unnecessary repository preparation and API context for ordinary conversation, reuse the persisted index safely, and improve retrieval relevance. Measure local preparation, model calls, context size and end-to-end latency before and after each change.
5. **Distribution quality.** Add repeatable release automation and expand platform/configuration checks before a stable release.

### Performance

- [x] Defer repository indexing and task-baseline capture until validated, authorized repository actions. Deterministic model and mocked VS Code tests verify one-call greetings, questions and read-only turns without edit journals; deferred test inventory; one initial baseline refresh; read/search-to-edit version checks; cancellation cleanup; automatic validation; and retained native review/undo references. Baselines begin at the first action requiring edit-task state, with earlier read evidence checked before publication.
- [ ] Compare fresh-chat greeting exports from the previous and lazy-initialization builds in installed VS Code on representative workstations, then verify a read/edit/validation/review/undo sequence and reload recovery there. Keep endpoint/model/streaming settings comparable and distinguish local task overhead from API latency.
- [ ] Reduce coding instructions and context for greetings and ordinary conversation while preserving task continuity, action validation, and permission boundaries. Use the existing timing comparison to measure prompt size, model-call count, response quality, and latency against the full prompt. Include ambiguous follow-ups and transitions back to repository work in continuity checks.
- [ ] Load the persisted index on startup and revalidate it against the current repository, changed/deleted files and ignore rules before reuse. Treat cached data as untrusted, recover from corrupt or incompatible caches, and verify that stale entries cannot authorize file access. Measure cold and warm startup cost.
- [ ] Improve lexical retrieval relevance and bounded context selection before considering embeddings. Use representative PowerShell questions and test-generation tasks to measure relevant-file retrieval, context size, model-call count and end-to-end latency.
- [x] Add local preparation and tool/validation timings alongside API timings, correlated by task, turn and session, with bounded persistent metadata-only history.
- [x] Show request-body size and prompt character count in the Request performance table, including instructions and conversation context. Persist exact UTF-8 JSON payload byte counts without recording content; verify compatibility modes, Unicode, pending/failed requests, older records and table rendering with synthetic tests.
- [x] Add first-body/first-SSE timing, bounded body-chunk samples, per-request event-loop delay and sanitized storage-operation failures; verify delayed streaming, local stalls, persistence and storage failures with synthetic tests.
- [ ] Compare repeated fresh-chat, existing-chat and repository-task runs using the expanded diagnostics without recording source text or credentials.

### Planned C# and TypeScript support

The current PowerShell index extracts lexical symbols; it does not provide compiler-level type or reference resolution. Share retrieval, task continuity, editing safeguards and the agent loop across languages, while adding language-specific project discovery, symbol extraction, semantic resolution and validation incrementally.

- [ ] Define a shared language-support interface for project discovery, symbols, imports/references and validation capabilities. Support mixed-language repositories and report unavailable tooling without claiming semantic understanding from text matching alone.
- [ ] Add C# repository understanding: discover solutions and projects, index namespaces, types and members, and resolve project references. Evaluate Roslyn or an available language service for type/reference resolution before introducing a separate indexing service.
- [ ] Add TypeScript repository understanding: discover package boundaries and tsconfig files, index declarations and imports/exports, and resolve module references. Evaluate the TypeScript compiler or language service for type/reference resolution, including TSX and monorepos.
- [ ] Add C# editing and validation using the repository's SDK, build configuration and existing unit-test framework. Detect missing tooling, select relevant tests, preserve unrelated failures, and apply execution permissions to build/test steps and their hooks.
- [ ] Add TypeScript editing and validation using the repository's package manager, lockfile, type-checking, lint and unit-test configuration. Inspect scripts and hooks before execution; do not assume dependency installation or integration-test execution is authorized.
- [ ] Verify C# and TypeScript support on representative single-project, multi-project and mixed-language repositories. Measure retrieval relevance, context size and task latency, and test cross-file changes, cancellation, continuity and preexisting-work preservation before describing either language as supported.

### Planned Visual Studio extension and shared runtime boundaries

Support Visual Studio as a future extension host alongside VS Code. Keep the current VS Code experience working while defining reusable boundaries; the host/runtime integration approach and supported Visual Studio versions require investigation before implementation.

- [ ] Separate editor-independent model transport, action protocol, agent loop, permission policy, retrieval, task continuity, Git operations and validation orchestration from editor SDK dependencies. Define explicit interfaces and shared contract tests before extracting or duplicating components.
- [ ] Define host adapters for workspace/solution discovery, document snapshots and unsaved buffers, applying edits, native diffs/navigation, conversation interactions, settings, secure credential storage, diagnostics and lifecycle/cancellation. Keep editor UI and SDK objects outside shared runtime contracts.
- [ ] Evaluate how Visual Studio will host or communicate with the existing TypeScript runtime, including an owned local worker with a versioned protocol versus other integration options. Record packaging, runtime dependencies, process ownership, startup cost and deployment constraints before selecting an approach; do not assume TypeScript code can run directly in either host.
- [ ] Define language-service capability boundaries so C# and TypeScript analysis can use host-provided services or standalone tooling without coupling the agent loop to one editor. Report capability differences explicitly.
- [ ] Specify repository identity, storage/schema compatibility and exclusive task ownership across both hosts. Prevent concurrent conflicting edits when VS Code and Visual Studio open the same repository; define whether conversation history is shared and how migrations preserve it. Do not assume credential stores are interchangeable.
- [ ] Build a Visual Studio extension incrementally: connection/settings and chat first, then repository inspection, editing and validation. Keep questions and approvals in its conversation pane and use native editor review surfaces where appropriate.
- [ ] Verify shared behavior and host-specific integration separately, covering unsaved-document preservation, permissions, cancellation, interrupted tasks, startup, installation/update and representative solutions. Document supported Visual Studio versions and installation requirements before release.

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
- [ ] Persist a structured task summary that retains the original objective, accepted constraints, decisions, completed work, validation evidence and unresolved issues across runs and restarts.
- [ ] Add bounded context compaction so older messages can leave the context window without losing task intent. Carry the durable summary into subsequent runs, incorporate user corrections, and distinguish prior evidence from current repository state; summaries must not replace fresh reads or permission checks.
- [ ] Test continuity beyond the 20-message history window, across context/action-budget stops and after restart. Verify that short follow-ups resume the intended task, changed requirements supersede stale decisions, and interrupted work is not replayed automatically.
- [x] Add bounded session request-performance diagnostics with timing, format-repair markers, timeouts and metadata-only export.
- [x] Add default-on SSE response streaming, in-pane receiving progress and first-content diagnostics with complete-action validation.
- [x] Expand metadata-only diagnostics with model IDs, context size, available token usage, completion reasons and recognized rate-limit signals; retain bounded history across restarts.
- [ ] Automate release packaging, checksum generation and verification.

## Deferred scope

- General shell commands and broader network tools.
- Git push and autonomous commits without a user request.
- Concurrent tasks against one repository and multi-repository edits.
- Integration tests or other environment-changing validation.
- Programming languages beyond PowerShell and the planned C# and TypeScript support.
- Repository instruction-file support.
- Embeddings until measured retrieval failures justify them.
- Detailed model-request inspection and centralized policy management.
- Marketplace distribution until release quality is established.

## Evidence and limits

- [x] Provide a standalone PowerShell idle/repeat API probe with generated production fresh-chat message profiles, configurable batches and idle intervals, incremental reports and optional fresh connections. Windows PowerShell 5.1 loopback tests and static analysis passed; live endpoint behavior remains environment-specific.

- [x] Add a synthetic in-extension request timing comparison with alternating minimal/full fresh-chat prompts, unchanged transport settings, cancellation and metadata-only reporting; verified with fake-provider transport tests.
- [x] Refine the comparison into compact, wrapped, full-protocol and provider-default output-limit variants with identical requested answers, validity-gated timing summaries, response-shape counts and sanitized transport error codes; verified offline.
- [ ] Run the comparison on an affected workstation and compare first-body timing before attributing the delay to request content or transport.

Conversational undo verification (2026-09-16): chat-handler tests submit the exact request "undo the pending changes", restore a synthetic task edit, preserve an unrelated staged file and the Git index, enforce Review denial and report missing undo history with zero provider calls. Request recognition, existing undo conflict/cancellation/recovery tests and protocol regressions passed (39 distinct targeted tests). The user's pending repository changes were not discarded as part of this verification.

Repository-lease recovery verification (2026-09-16): 150 tests passed, with unavailable Pester 4 coverage skipped. Regression tests cover contention timeout, cancellation, idempotent release, reacquisition and recovery after a separate Windows owner process terminates. Three installed-profile window reloads restored chat and acknowledged rendering. The final reload reproduced EADDRINUSE; bounded retry acquired the lease after 3.5 seconds and chat loaded without another reload. Full-application restarts and other workstation configurations remain open; these checks do not establish that every startup failure is resolved.

The initial public prerelease passed 118 tests with one unavailable Pester 4 check skipped, plus an isolated native VS Code 1.137.0 sidebar/settings check. Live model tests used synthetic PowerShell fixtures. Six repeated launches against one isolated profile passed but did not reproduce the intermittent startup failure. These results do not close the outstanding installed-profile, representative-repository or startup checks above.

Detailed acceptance scenarios and validation behavior are documented in `docs/ACCEPTANCE.md` and `docs/VALIDATION.md`. Moves involve multiple filesystem operations and are not atomic as a whole. Unit-test selection is conservative inspection, not an execution sandbox. An experimental release is not evidence that all acceptance gates are complete.

Naming cleanup verification (0.4.42): 118 tests passed, one unavailable Pester 4 check skipped, and the native VS Code 1.137.0 activation/sidebar/settings check passed. Current tracked files and the rebuilt VSIX were scanned for retired product identifiers and publication-sensitive references; none were found. Earlier commit history remains unchanged; release binaries were subsequently removed.

Source installer verification: a real dependency restore and package build passed, the built VSIX installed into an isolated VS Code user profile, and Windows PowerShell 5.1 subprocess tests verified paths containing spaces, build-only mode, optional tests and stop-on-failure behavior. No elevation or workstation-policy changes were used by the installer.

Endpoint compatibility verification (0.4.45): 126 tests passed, one unavailable Pester 4 check skipped; native VS Code activation/sidebar/settings checks and packaging passed. Synthetic transport regressions cover user-message requests, empty output, null tools, retained task evidence and unchanged read-only enforcement. Representative endpoint verification remains open.

Action-encoding verification (2026-09-16): captured responses contained over-escaped top-level JSON quotes, including a multiline test-file creation action. Offline replay identifies this shape without executing it. The updated build passed 147 tests with one unavailable Pester 4 check skipped, and VSIX packaging passed. An installed-profile fresh-chat editing run added a direct-array test using six successful model responses with no format-repair requests or new rejection captures. PowerShell 5.1 parsing and static analysis passed; Pester execution was blocked by inherited signed-script policy, so no live unit-test pass is claimed. This single run does not establish general endpoint reliability. Reload initially failed at repository lease acquisition; a second reload restored the pane. Startup reliability remains open.

Local deployment follow-up (2026-09-16): the installed protocol and transport matched the verified build. With temporary process-only RemoteSigned validation, the six new-function tests passed independently, then the installed chat completed validation with 13 passing tests and no failures. Parsing and eligible static analysis passed; the operational/module-dependent suite and analysis remained skipped for manual inspection, so coverage was partial. The original inherited validation policy was restored afterward; no workstation policy was changed.
