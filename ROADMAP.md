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

- `list_files`
- `search_text`
- `find_symbol`
- `read_file`
- `read_files`
- `apply_patch`
- `create_file`
- `delete_file`
- `move_file`
- `git_status`
- `git_diff_summary`
- `run_command`
- `run_validation`
- `open_diff`
- `ask_user`
- `complete_task`

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

### Phase 0 — Specify the behavioral contract

Goal: establish a stable behavioral contract before implementation.

- Turn the pilot outcome above into executable acceptance scenarios.
- Specify requirements for path safeguards, Git filtering, retrieval ranking, patch preflight, trust modes, telemetry, and repair bounds.
- Record current Gemini request/response behavior and JSON reliability tests.
- Select strict JSON schemas for every model action and tool result.
- Define hard limits for turns, files read, context characters, command output, command duration, and repair attempts.

Exit criteria:

- Acceptance scenarios and JSON protocol are documented.
- Existing safeguards have corresponding TypeScript requirements.
- No pilot requirement depends on a separately installed backend or runtime.

### Phase 1 — Extension shell and direct Gemini chat

Goal: install one VSIX and hold a persistent conversation with the configured endpoint.

- Scaffold the TypeScript VS Code extension and chat panel.
- Provide a user-configured HTTPS API endpoint setting with no built-in default.
- Store each developer’s API key through SecretStorage.
- Query `/v1/models`, show a model picker, remember the last selection, and provide a configured fallback.
- Stream concise responses, progress, and errors.
- Detect the single open workspace and its Git root automatically.
- Ask the developer to select a repository for multi-root workspaces.
- Persist multiple named threads per repository.
- Allow only one executing task per repository.

Exit criteria:

- A developer installs the VSIX, enters a key, selects a returned model, and chats with Gemini.
- Threads survive VS Code restarts and remain associated with the correct repository.
- No repository content is changed in this phase.

### Phase 2 — Repository awareness and local indexing

Goal: answer codebase questions accurately before enabling edits.

- Build a local manifest that honors Git ignore rules and excludes secrets, binaries, generated output, `.git`, and linked paths.
- Store the index in VS Code private per-user storage, outside the repository.
- Incrementally refresh it through file-system watchers and Git state changes.
- Extract PowerShell functions, classes, parameters, module manifests, exports, imports, dot-sourced scripts, and Pester relationships.
- Add deterministic text, filename, and symbol search before considering embeddings.
- Let the agent iteratively search and read relevant files instead of sending the whole repository.
- Cap and record context selected for each model request.

Exit criteria:

- The agent can explain a feature that spans several PowerShell files and cite the relevant local files.
- Index updates are reflected without rebuilding the entire index.
- No index files appear in the Git working tree.

### Phase 3 — Safe multi-file editing and native review

Goal: make immediate repository changes while preserving developer work.

- Capture the starting Git status and content baseline for each task.
- Implement schema-validated patch/create/move/delete actions.
- Apply changes atomically per file with stale-content detection.
- Preserve encodings, BOMs, and line endings important to Windows PowerShell repositories.
- Work alongside existing uncommitted changes.
- Stop and ask when edits overlap ambiguously or developer changes cannot be preserved confidently.
- Attribute preexisting changes separately from agent changes.
- Leave work uncommitted; never commit or push unless explicitly requested in a future scope.
- Open changed files in VS Code’s diff editor and Source Control view.
- Keep raw Git patches out of chat.

Exit criteria:

- A natural-language feature request results in coordinated, uncommitted multi-file changes.
- Existing unrelated changes remain byte-for-byte intact.
- Chat provides only a plain-English summary; native VS Code views show code differences.

### Phase 4 — Windows PowerShell 5.1 validation and repair

Goal: complete changes with automatic, trustworthy local validation.

- Invoke the Windows PowerShell 5.1 parser directly from the extension.
- Detect PSScriptAnalyzer and Pester versions.
- Attempt current-user module installation when missing; clearly report failure and reduced validation scope.
- Test access to PowerShell Gallery and support a future internal/Nexus module source.
- Discover repository-defined Pester unit tests.
- Add or update Pester tests for changed behavior when appropriate.
- Automatically run parser checks, static analysis, and safe unit tests.
- Do not automatically run integration tests or operations that affect IIS, services, Azure DevOps, databases, network resources, or other environments.
- Feed validation failures back into the agent for at most three total edit-and-validation attempts.
- Report every validation command, result, omission, and remaining failure in plain English.

Exit criteria:

- The acceptance feature passes Windows PowerShell 5.1 parsing and the applicable Pester unit suite.
- A deliberately introduced failure triggers bounded diagnosis and repair.
- Unsafe/integration tests are not started automatically.

### Phase 5 — Codex-like task control

Goal: make iterative daily use reliable.

- Support natural follow-ups without slash commands.
- Retain task intent, assumptions, tool results, agent-owned edits, and validation history.
- Implement safe cancellation of model calls, searches, edits, and child processes.
- On cancellation, report completed edits and validation state.
- Implement task-scoped undo that reverses only agent-attributed changes and refuses ambiguous reversals.
- Stream brief progress such as repository inspection, files being edited, and validation being run.
- Add permission selection, with Full access optimized first and Review/Workspace polished next.
- Require explicit confirmation for destructive operations even in Full access.

Exit criteria:

- A developer can correct the agent conversationally, cancel it, resume the thread, and undo its last task without losing prior work.
- Permission changes affect the next action predictably and remain visible.

### Phase 6 — Pilot hardening and distribution

Goal: distribute a repeatable initial release.

- Package the extension as one locally installable VSIX.
- Keep runtime dependencies contained within the VSIX.
- Add structured local logs for model calls, tools, commands, edits, validation, permissions, and errors without recording API keys.
- Test on representative Windows developer configurations and network conditions.
- Validate certificate trust, proxies, endpoint timeouts, API failures, and model-list fallback.
- Test PowerShell 5.1 encoding, module, and Pester-version variations.
- Add recovery tests for VS Code termination during editing or validation.
- Document install, first-run authentication, permission modes, limitations, and uninstall/data cleanup.

Exit criteria:

- A developer can install the VSIX and complete the pilot scenario without separate infrastructure setup.
- The pilot behaves consistently after VS Code restart, network interruption, validation failure, and cancellation.

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

1. **Read-only vertical slice:** VSIX installation → key/model selection → automatic workspace detection → repository search/read → grounded answer.
2. **Editing vertical slice:** natural-language feature request → multi-file edit → native VS Code diffs → plain-English summary.
3. **Validation vertical slice:** automatic PowerShell 5.1/Pester validation → bounded repair → final results.
4. **Daily-use slice:** threads → follow-ups → cancellation → undo → polished permission modes.

Each slice should be demonstrated against the real pilot repository before adding the next layer.

## Immediate next backlog

Implementation evidence (2026-09-14): the initial TypeScript read-only slice now has an extension shell, strict version-1 action schemas, SecretStorage integration, model discovery with manual fallback, repository filtering, lexical PowerShell indexing, a bounded action loop, cancellation and persistent named threads. The HTTPS API endpoint is configured by the developer and has no built-in default. Automated isolated-repository and mock-endpoint checks are included; a VSIX can be built locally. Phase 1/2 exit criteria remain open pending a real VS Code/endpoint/PowerShell-repository demonstration. Editing, validation/repair and undo remain unimplemented.

Live validation evidence (2026-09-14): a real public Gemini model passed the read-only explanation/follow-up suite over a synthetic five-file PowerShell module and test fixture. The same suite passed inside an isolated VS Code 1.138.0-insider Extension Development Host, alongside extension activation and conversation-panel lifecycle checks. Discovery, grounded citations, saved-thread reload, symbol refresh, cancellation and repository preservation passed. See `docs/ACCEPTANCE.md` for exact scope and remaining UI/restart/representative-repository checks. The next implementation slice remains safe multi-file editing and native review; the full pilot is not yet complete.

1. Write the JSON action protocol and TypeScript interfaces.
2. Scaffold the VSIX and direct Gemini client.
3. Implement SecretStorage, model discovery, and the model picker.
4. Implement workspace/Git-root detection and multi-root prompting.
5. Build the read-only PowerShell manifest, symbol index, search, and file-reading tools.
6. Demonstrate a repository-grounded explanation through the new extension.
7. Add file mutation tools, baseline tracking, and native diff review.
8. Add Windows PowerShell 5.1 validation and Pester discovery.
9. Add the three-attempt repair loop.
10. Run the selected real multi-file feature as the pilot acceptance test.

## Definition of pilot success

The pilot succeeds when the developer can install one VSIX, open the Git-based PowerShell repository, enter an ordinary feature request, and receive correct uncommitted multi-file changes with appropriate Pester updates and passing Windows PowerShell 5.1 validation. The developer reviews code only through native VS Code diffs, receives a concise narrative in chat, and can follow up, cancel, or undo without losing preexisting work.
