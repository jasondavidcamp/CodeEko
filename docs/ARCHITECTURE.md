# Architecture and security boundaries

## Layers

| Directory | Responsibility |
| --- | --- |
| `src/ui` | VS Code commands, SecretStorage, settings, repository selection, accessible CSP-restricted conversation webview, cancellation and lifecycle |
| `src/api` | HTTPS endpoint normalization, model discovery, bounded chat response, timeouts, cancellation, no credential-bearing error bodies |
| `src/agent` | Sequential 20-action loop, context/read budgets, progress, terminal state |
| `src/protocol` | Version-1 strict schemas, JSON parsing and model protocol instructions |
| `src/tools` | Deterministic read/edit dispatch and bounded results |
| `src/policy` | Tool allowlist, mode validation, lexical and realpath containment, linked-path rejection |
| `src/repository` | Fixed Git subprocesses and workspace selection |
| `src/indexing` | Git-filtered manifest, text decoding, lexical PowerShell symbols and dependencies |
| `src/state` | Validated named threads, lazy repository sessions, task baselines and edit journals, repository OS lease |

The VS Code extension host owns filesystem and Git access. The model only receives selected bounded text and returns an action proposal. It cannot invoke a tool by emitting code. The executor validates the complete JSON action and applies a separate deterministic policy before dispatch. Full access does not bypass this policy. Workspace requires a native preview and cancellable in-pane approval for delete, move and whole-file erasure. Full access skips those confirmations. Workspace and Full access permit edits; Review is read-only; legacy Custom settings map to Review. Workspace and Full access permit fixed validation commands in version 0.3; general command execution remains unavailable.

The webview has no filesystem/network access, no local resource roots, no remote content and a nonce-only Content Security Policy. Messages and model answers are rendered through `textContent`. UI events are validated in the extension; work is serialized. API credentials are never sent to the webview. Keys are scoped to the normalized endpoint so endpoint changes do not silently reuse an existing credential. Redirects are rejected. API response/error bodies are never logged; the current credential is redacted from successful model text as defense in depth.

## Repository boundaries

For multiple workspace folders, select one before running Git. Inspect directory metadata (up to 10,000 directories, excluding linked/generated directories) to identify nested Git roots; if ambiguous, select a repository before invoking Git or reading source files. Resolve its Git root and canonical real path. All tool file paths must appear in the readable manifest. Deny absolute paths, traversal, Windows alternate streams, backslash ambiguities, `.git`, symbolic links and junctions. Revalidate path components and final real paths on reads. Git produces membership and ignore lists, including tracked files subsequently ignored. No shell, hooks, repository scripts, integrations or external commands are exposed to the model.

Filesystem checks mitigate accidental escapes; they are not an OS sandbox against a hostile local process racing path replacement between checks and opens. Do not use this extension on hostile or concurrently replaced repositories. Hard links cannot be reliably attributed to a unique repository. The extension requires workspace trust, but trust does not disable filtering.

The manifest excludes common sensitive names and generated/binary paths; source code can itself contain secrets. This release does not claim data-loss prevention. Retrieved file contents are sent to the configured endpoint. The persisted index contains filenames and lexical symbol/dependency text; conversation summaries may contain snippets. Editing baselines separately store raw eligible file bytes in private extension storage for attribution and review. There is no raw API log.

## Editing and review

`RepositorySession` defers repository preparation until a schema-validated, authorized tool needs it. The first model request uses the existing protocol and conversation history without refreshing the index, loading edit journals, capturing snapshots or constructing validation. `ask_user` and `complete_task` do not initialize these resources. Repository identity, the panel lease and the active-turn lock still apply. Conversation-only and read-only turns preserve previous review/undo/task references and create no edit journals.

History records whether a running turn has initialized edit state. On restart, an interrupted conversation preserves its prior review/undo references, including an undo reference cleared by a commit. An interrupted edit restores its active task references for review/recovery. Histories written before this marker retain legacy interrupted-task recovery.

The first repository action loads and validates referenced journals, checks incomplete undo, and records HEAD. Reads/searches refresh current membership and ignore policy without creating an edit baseline. Test-request inventory is deferred until the first repository action and reuses that action's fresh index; it never precedes the first model request. Refreshes remain necessary at later action boundaries and after mutations.

The edit baseline begins immediately before the first mutation, explicit validation, task-diff/review or commit action. It captures HEAD, status and bounded file snapshots once per turn. Changes already present at this point are developer work, subject to the existing safe follow-up attribution rules below. Earlier explicit reads and returned search/symbol results retain their first byte hashes independently of the baseline. Capture rechecks those hashes and HEAD against the new snapshots and disk; changed, missing or newly excluded observations stop the turn, even if the model reread them or omitted `expectedHash`. Search results do not grant explicit-read authority. Only successful explicit file reads transfer that authority to the edit task. The normal mutation checks then continue to protect against changes after capture. Undo restores this edit baseline, not repository contents from the time the user sent the message.

Capture performs one index refresh, without an additional eager refresh before it. Initialization publishes the thread's task reference only after capture and validation construction succeed, before executing any action. Failed/cancelled initialization removes unpublished snapshots and remains failed for that turn; turn cleanup releases the active-task lock. No action is replayed. Journal loading preserves unconfirmed operations as evidence and does not inherit their attribution or automatically resolve them. Incomplete undo must be resumed before repository work; ordinary conversation remains available.

Git zero-context hunks identify protected spans of preexisting staged/unstaged edits; uncertain attribution protects the whole file. A patch must match both the recorded read hash and current raw bytes, use exact unique non-overlapping text, and, in Workspace mode, avoid protected spans. Full access may edit those spans within the user request. The executor checks permission, cancellation, HEAD, path policy, hard links and dirty editor buffers before mutation. Follow-ups inherit prior attribution only for currently dirty files on the same Git HEAD, when bytes still match the previous task and no operation is unconfirmed. Clean files and committed tasks reset inherited overlap protection.

Prepared journal entries and content-addressed snapshots precede even temporary-file content writes; applied entries follow mutation. A task with pending evidence refuses further mutations. Same-directory temporary files are flushed before atomic replacement. Creates use no-overwrite hard links and remove the temporary alias before recording applied status; moves link the destination then unlink the source. A move is not atomic as a whole. Crashes can leave unconfirmed entries or temporary files, and cancelled directory creation can leave empty directories. Completed edits are retained on cancellation. Task-scoped undo is available through the UI with full preflight and a resumable restoration journal; original unconfirmed edits still require inspection. There is no automatic rollback. Checks do not eliminate races with hostile external processes.

Native diff tabs compare immutable baseline and recorded output snapshots, isolating task changes from earlier developer work. Source Control displays the complete Git working tree. Reloaded journals are review-only. Snapshots remain local plaintext with no automatic retention policy. Edit attempts are capped at 12 per task and journals at 24 changed paths.

Fixed Git calls disable external diffs, textconv, fsmonitor and configured clean/smudge/process filters where applicable. Inherited Git environment overrides are removed. The model cannot supply command arguments or change Git policy files.

## State and limits

Thread files use versioned schema validation, temporary-file write and same-directory rename. Invalid existing history is preserved and opening fails instead of overwriting it. A per-repository named-pipe lease prevents cross-window writes for the Windows pilot and is automatically released after extension-host termination. Running tasks recover as interrupted; follow-ups start a fresh loop with recent conversation history. Up to 500 metadata-only progress events per thread record tool names and per-request context character counts and are saved at task completion/cancellation; no API key, raw tool output or prompt is added to this activity trace. The whole history file has a 20 MB cap; writes beyond that cap fail without replacing existing history.

Budgets: 20 actions/task, 60,000 context characters/request, 14,000 result characters/action, 30 explicit file reads/task, 5 files/read_files call, 200 lines/file read, 12,000 text characters/read, 100 search matches, 10 million text characters/search, 20,000 manifest entries, 50 MB candidate bytes and 30 seconds/index refresh, 256,000 bytes/file, 1 MB HTTP response, 4 MiB Git stdout, 15 seconds/Git subprocess. Chat messages are at most 8,000 characters; completion summaries at most 12,000. Timeout/cancellation/invalid protocol terminate safely. Tool failures return a bounded generic error that permits the model to choose another read-only action within the same limits.

No retries are made for failed network requests. Up to two isolated schema-invalid model responses can receive correction requests within the existing task budgets; no invalid action is executed. A missing or incorrectly copied read hash returns a typed `ReadRequired` conflict only after confirming that disk bytes match the task's recorded current state and path, dirty-buffer and hard-link checks pass. The agent can correct this at most twice by reading again within the existing budgets. Other mutation failures stop the task instead of permitting speculative retries. The validation coordinator enforces at most three total validation rounds, separate from the existing action budget. Completion cannot bypass failed validation; further edits are denied after round three. See VALIDATION.md for the runner and execution boundaries.

## Endpoint configuration

The endpoint has no built-in default and must be configured in user settings before connecting. The client normalizes the `/v1` base path, uses Bearer authentication, discovers model IDs dynamically and enforces explicit request budgets. It never falls back to another provider.

## Extension conventions

The extension follows VS Code's [workspace trust guidance](https://code.visualstudio.com/api/extension-guides/workspace-trust), [webview security guidance](https://code.visualstudio.com/api/extension-guides/webview), and [VSIX packaging workflow](https://code.visualstudio.com/api/working-with-extensions/publishing-extension). No API token is stored in VS Code settings or custom files.
