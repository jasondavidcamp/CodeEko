# LLM Coding Agent Runtime Roadmap

## Product direction

Create **LLM Coding Agent Runtime**, a repository-aware TypeScript VS Code extension that turns a text-only LLM API into a locally controlled coding agent by providing repository tools, permission enforcement, validation, repair loops, task memory, and native VS Code review.

The extension supplies repository awareness and deterministic local tools to a configurable text-only model endpoint.

The initial release targets Git-based PowerShell repositories and Windows PowerShell 5.1. Installation should require only a locally installable VSIX and an individual Gemini API key.

## Pilot outcome

A developer opens a PowerShell repository in VS Code and asks, in ordinary conversation, “Change this code to add feature XYZ.” LLM Coding Agent Runtime then:

1. Detects the open repository automatically.
2. Understands the relevant code across the repository.
3. Asks a question only when ambiguity would materially change the result.
4. Makes coordinated multi-file changes immediately in Full access mode.
5. Creates or updates applicable Pester unit tests.
6. Runs Windows PowerShell 5.1 parsing, PSScriptAnalyzer when available, and safe Pester unit tests automatically.
7. Diagnoses and repairs validation failures, with a maximum of three edit-and-validation attempts.
8. Leaves all changes uncommitted.
9. Presents a plain-English summary in chat and opens code changes in VS Code’s native diff experience.
10. Supports follow-up instructions, cancellation, and undo without losing preexisting developer work.

## Target architecture

### VS Code extension

The extension becomes the desktop application and the sole component permitted to operate on the repository. It owns:

- Conversational task UI.
- Active workspace and Git-root discovery.
- Repository file reads, writes, creates, renames, and deletes.
- Git status, baseline capture, and change attribution.
- Native diff and Source Control integration.
- Windows PowerShell 5.1, Pester, PSScriptAnalyzer, Git, and other command execution.
- Permission mode enforcement.
- Progress reporting and cancellation.
- Per-repository task history and local index storage.
- Gemini endpoint communication and individual API-key storage through VS Code SecretStorage.

### Agent core

Implement the agent core in TypeScript within the extension package, using asynchronous workers where necessary to keep the extension host responsive. Use a bounded tool-using loop:

1. Interpret the request.
2. Select a local tool action.
3. Validate the model’s JSON response against a strict schema.
4. Execute the action through deterministic permission checks.
5. Return a bounded result to Gemini.
6. Repeat until the task is complete, blocked, cancelled, or reaches configured limits.

Gemini does not receive direct tool access. It proposes structured actions; local TypeScript code validates and executes them.

### Initial local tools

- [x] `list_files`
- [x] `search_text`
- [x] `find_symbol`
- [x] `read_file`
- [x] `read_files`
- [x] `apply_patch`
- [x] `create_file`
- [x] `delete_file`
- [x] `move_file`
- [x] `git_status`
- [x] `git_diff_summary`
- [ ] `run_command`
- [x] `run_validation`
- [x] `open_diff`
- [x] `ask_user`
- [x] `complete_task`

Every tool accepts repository-relative paths. Path containment, symlink/junction checks, cancellation, output limits, and timeouts are enforced outside the model.

## Permission modes

The developer selects the mode. The selected mode must remain clearly visible.

| Mode | Intended behavior |
| --- | --- |
| Review | Read and analyze the repository; propose work without changing files or running mutating commands. |
| Workspace | Edit within the open repository and run approved local validation with controlled network access. |
| Full access | Run general developer-selected or agent-selected commands and use broader system/network access, subject to destructive-action confirmation and audit logging. |
| Custom | Configure file, command, and network permissions independently. Add after the primary modes are stable. |

Permission mode does not replace product judgment. The agent proceeds with reversible assumptions supported by repository evidence and asks when ambiguity, conflict, authority, or destructive impact is material.

## Phased implementation

Checked items have implementation and automated/live evidence. Unchecked items include unfinished work and manual pilot gates. Synthetic fixture evidence does not close representative-repository or whole-application restart gates.

### Phase 0 — Specify the behavioral contract

Goal: establish a stable behavioral contract before implementation.

- [ ] Turn the pilot outcome above into executable acceptance scenarios.
- [x] Specify requirements for path safeguards, Git filtering, retrieval ranking, patch preflight, trust modes, telemetry, and repair bounds.
- [x] Record current Gemini request/response behavior and JSON reliability tests.
- [ ] Select strict JSON schemas for every model action and tool result.
- [x] Define hard limits for turns, files read, context characters, command output, command duration, and repair attempts.

Exit criteria:

- [x] Acceptance scenarios and JSON protocol are documented.
- [x] Existing safeguards have corresponding TypeScript requirements.
- [x] No pilot requirement depends on a separately installed backend or runtime.

### Phase 1 — Extension shell and direct Gemini chat

Goal: install one VSIX and hold a persistent conversation with the configured endpoint.

- [x] Scaffold the TypeScript VS Code extension and chat panel.
- [x] Provide a user-configured HTTPS API endpoint setting with no built-in default.
- [x] Store each developer’s API key through SecretStorage.
- [x] Query `/v1/models`, show a model picker, remember the last selection, and provide a configured fallback.
- [ ] Stream concise responses, progress, and errors.
- [x] Detect the single open workspace and its Git root automatically.
- [x] Ask the developer to select a repository for multi-root workspaces.
- [x] Persist multiple named threads per repository.
- [x] Allow only one executing task per repository.

Exit criteria:

- [ ] A developer installs the VSIX, enters a key, selects a returned model, and chats with Gemini.
- [x] Threads survive VS Code restarts and remain associated with the correct repository (verified in an isolated Windows VS Code instance).
- [x] No repository content is changed in this phase.

### Phase 2 — Repository awareness and local indexing

Goal: answer codebase questions accurately before enabling edits.

- [x] Build a local manifest that honors Git ignore rules and excludes secrets, binaries, generated output, `.git`, and linked paths.
- [x] Store the index in VS Code private per-user storage, outside the repository.
- [x] Incrementally refresh it through file-system watchers and Git state changes.
- [x] Extract PowerShell functions, classes, parameters, module manifests, exports, imports, dot-sourced scripts, and Pester relationships.
- [x] Add deterministic text, filename, and symbol search before considering embeddings.
- [x] Let the agent iteratively search and read relevant files instead of sending the whole repository.
- [x] Cap and record context selected for each model request.

Exit criteria:

- [x] The agent can explain a feature that spans several PowerShell files and cite the relevant local files.
- [x] Index updates are reflected without rebuilding the entire index.
- [x] No index files appear in the Git working tree.

### Phase 3 — Safe multi-file editing and native review

Goal: make immediate repository changes while preserving developer work.

- [x] Capture the starting Git status and content baseline for each task.
- [x] Implement schema-validated patch/create/move/delete actions.
- [x] Apply writes atomically per file with stale-content detection. Moves use two filesystem operations and are not atomic as a whole.
- [x] Preserve encodings, BOMs, and line endings important to Windows PowerShell repositories.
- [x] Work alongside existing uncommitted changes.
- [x] Stop and ask when edits overlap ambiguously or developer changes cannot be preserved confidently.
- [x] Attribute preexisting changes separately from agent changes.
- [x] Leave work uncommitted; never commit or push unless explicitly requested in a future scope.
- [x] Open changed files in VS Code’s diff editor and Source Control view.
- [x] Keep raw Git patches out of chat.

Exit criteria:

- [x] A natural-language feature request results in coordinated, uncommitted multi-file changes.
- [x] Existing unrelated changes remain byte-for-byte intact.
- [x] Chat provides only a plain-English summary; native VS Code views show code differences.

### Phase 4 — Windows PowerShell 5.1 validation and repair

Goal: complete changes with automatic, trustworthy local validation.

- [x] Invoke the Windows PowerShell 5.1 parser directly from the extension.
- [x] Detect PSScriptAnalyzer and Pester versions.
- [x] Allow developer selection of Pester 4 or 5 without silently substituting another major; invalidate cached results when selection changes.
- [x] Attempt current-user module installation when enabled in user settings; clearly report failure and reduced validation scope.
- [x] Test access to PowerShell Gallery during module installation.
- [ ] Support an internal/Nexus module source.
- [x] Discover repository-defined Pester unit tests.
- [x] Add or update Pester tests for changed behavior when appropriate.
- [x] Automatically run parser checks, available static analysis, and developer-selected unit tests. Selection is required because test names alone cannot establish safety.
- [x] Do not automatically run integration tests or operations that affect IIS, services, Azure DevOps, databases, network resources, or other environments.
- [x] Feed validation failures back into the agent for at most three total edit-and-validation attempts.
- [x] Stop early on repeated unchanged validation or identical failure diagnostics after a repair.
- [x] Compare parser/analyzer findings with task-start snapshots; explicitly label unknown failure origin when comparison is unavailable.
- [ ] Compare test failures against an isolated, approved baseline test run to distinguish all preexisting test failures from regressions.
- [x] Report every validation command, result, omission, and remaining failure in plain English.

Exit criteria:

- [x] The acceptance feature passes Windows PowerShell 5.1 parsing and the applicable Pester unit suite.
- [x] A deliberately introduced failure triggers bounded diagnosis and repair.
- [x] Unsafe/integration tests are not started automatically.

### Phase 5 — Codex-like task control

Goal: make iterative daily use reliable.

- [x] Support natural follow-ups without slash commands.
- [ ] Retain task intent, assumptions, tool results, agent-owned edits, and validation history.
- [x] Implement safe cancellation of model calls, searches, edits, and child processes.
- [x] On cancellation, report completed edits and validation state.
- [x] Implement task-scoped undo that reverses only agent-attributed changes and refuses ambiguous reversals.
- [x] Stream brief progress such as repository inspection, files being edited, and validation being run.
- [x] Add permission selection, with Full access optimized first and Review/Workspace polished next.
- [x] Require explicit confirmation for destructive operations even in Full access.

Exit criteria:

- [ ] A developer can correct the agent conversationally, cancel it, resume the thread, and undo its last task without losing prior work.
- [x] Permission changes affect the next action predictably and remain visible.

### Phase 6 — Pilot hardening and distribution

Goal: distribute a repeatable initial release.

- [x] Package the extension as one locally installable VSIX.
- [x] Keep runtime dependencies contained within the VSIX.
- [ ] Add structured local logs for model calls, tools, commands, edits, validation, permissions, and errors without recording API keys.
- [ ] Test on representative Windows developer configurations and network conditions.
- [ ] Validate certificate trust, proxies, endpoint timeouts, API failures, and model-list fallback.
- [x] Test Windows PowerShell 5.1 UTF-8/BOM/UTF-16LE handling and Pester 5 execution.
- [x] Test missing modules, failed installation reporting and selected-major discovery.
- [ ] Verify real Pester 4 execution on a workstation where publisher policy permits installation (current installation attempt was rejected; verification was not bypassed).
- [x] Add recovery tests for VS Code termination after an applied edit and during active Pester validation.
- [ ] Enforce and verify child-process lifetime when the extension host dies without a coordinated process-tree shutdown.
- [ ] Exercise termination during individual file replacement, deletion, and move operations on representative workstations.
- [x] Document install, first-run authentication, permission modes, limitations, and uninstall/data cleanup.

Exit criteria:

- [ ] A developer can install the VSIX and complete the pilot scenario without separate infrastructure setup.
- [ ] The pilot behaves consistently after VS Code restart, network interruption, validation failure, and cancellation.

## Deferred work

- TFVC workflows.
- Multiple simultaneous tasks against one repository.
- Multi-repository editing.
- Automatic integration or environment-changing tests.
- Automatic commits or pushes.
- Embeddings/vector databases before measured retrieval failures justify them.
- Repository `AGENTS.md`-style instructions.
- Detailed developer-facing model-egress inspection.
- Central administrator policy and audit aggregation.
- Additional languages beyond the PowerShell pilot.

## Recommended delivery slices

- [x] **Read-only vertical slice:** VSIX installation → key/model selection → automatic workspace detection → repository search/read → grounded answer.
- [x] **Editing vertical slice:** natural-language feature request → multi-file edit → native VS Code diffs → plain-English summary.
- [x] **Validation vertical slice:** automatic PowerShell 5.1/Pester validation → bounded repair → final results.
- [ ] **Daily-use slice:** threads → follow-ups → cancellation → undo → polished permission modes.

Each slice should be demonstrated against the real pilot repository before adding the next layer.

## Implementation status and next backlog

Read-only slice evidence (2026-09-14): the extension shell, strict version-1 action schemas, SecretStorage integration, model discovery with manual fallback, repository filtering, lexical PowerShell indexing, bounded action loop, cancellation and persistent named threads are implemented. The HTTPS API endpoint is configured by the developer and has no built-in default.

Live validation evidence (2026-09-14): a real public Gemini model passed the read-only explanation/follow-up suite over a synthetic five-file PowerShell module and test fixture. The same suite passed inside an isolated VS Code 1.138.0-insider Extension Development Host, alongside extension activation and conversation-panel lifecycle checks. Discovery, grounded citations, saved-thread reload, symbol refresh, cancellation and repository preservation passed.

Editing slice evidence (0.2, 2026-09-14): guarded patch/create/move/delete, task baselines and attribution, destructive confirmation, encoding preservation, cancellation summaries and persistent native review are implemented. Live Gemini updated two PowerShell files and created documentation while preserving a developer comment and staged work. The real extension host opened three native diffs. See `docs/ACCEPTANCE.md` for exact evidence and remaining interactive/restart/representative-repository checks. Moves are not atomic as a whole. Validation followed in 0.3 and explicit task undo in 0.4; the full pilot is not yet complete.

Validation slice evidence (0.3): fixed Windows PowerShell 5.1 parsing, built-in analyzer rules, developer-selected Pester 4/5 tests, optional CurrentUser module installation, persisted results, cancellation and three-round repair limits are implemented. Live Gemini repaired a failing Pester test in two rounds while preserving test expectations and staged work. Missing or unapproved checks remain explicitly partial; test selection does not sandbox code.

1. Demonstrate editing, native review and validation on a representative repository, including interactive approval and restart checks.
2. Harden mid-write interruption recovery and baseline test-failure attribution.
3. Validate Pester 4, enterprise module sources, certificate/proxy behavior and representative repository compatibility.
4. Run the selected real multi-file feature as the full pilot acceptance test.

Undo evidence (0.4): exact baseline restoration across patch/create/delete/move, full preflight, later-edit refusal, native previews, cancellation and resumable undo journals passed automated tests. The complete suite passed 38 tests. The real VS Code host restored a live Gemini task's baseline while preserving staged work and a developer comment. Whole-application termination and manual interactive pilot checks remain open.

Restart evidence (0.4.1): a dedicated isolated VS Code process was terminated while a real Pester child was running after an applied edit. The child stopped. Restart recovered two threads and interrupted status, preserved the edit and developer work, reopened the native panel, avoided automatic replay and false validation success, and supported undo. Mid-write and manual representative-workstation checks remain open.

## Definition of pilot success

The pilot succeeds when the developer can install one VSIX, open the Git-based PowerShell repository, enter an ordinary feature request, and receive correct uncommitted multi-file changes with appropriate Pester updates and passing Windows PowerShell 5.1 validation. The developer reviews code only through native VS Code diffs, receives a concise narrative in chat, and can follow up, cancel, or undo without losing preexisting work.
