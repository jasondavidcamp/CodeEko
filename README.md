# LLM Coding Agent Runtime

A TypeScript VS Code extension that supplies local repository tools to a configured, text-only, OpenAI-compatible Gemini endpoint. Version 0.3 adds Windows PowerShell 5.1 validation and bounded repair to guarded multi-file editing and native VS Code diffs. Changes remain uncommitted; task undo is not yet implemented.

## Install and connect

1. Install Git and VS Code 1.95 or newer on your Windows workstation. No separate runtime or backend installation is required.
2. In VS Code, run **Extensions: Install from VSIX…** and select `llm-coding-agent-runtime-0.3.0.vsix`.
3. Open and trust a local Git repository folder. In a multi-root workspace, the extension prompts for the repository before invoking Git.
4. Set the user setting `llmRuntime.endpoint` to your HTTPS API base URL before connecting. It has no built-in default. An origin/base path gets `/v1` appended; an explicitly versioned base such as `/v1` or `/v1beta/openai` is preserved. There is no public-provider fallback.
5. Run **LLM Runtime: Set API Key**. Each endpoint's key lives only in VS Code SecretStorage. Changing endpoints requires a key for the new endpoint.
6. Run **LLM Runtime: Select Model**. This queries `/v1/models` and persists the chosen ID. If discovery fails, the picker offers manual entry prefilled with the saved model; cancellation preserves that selection.
7. Run **LLM Runtime: Open Conversation**, name a conversation, and ask a normal question such as “Explain how these PowerShell functions load configuration; cite files and lines.” Use **Cancel task** to stop a request or tool loop. Closing the panel also cancels work.

`llmRuntime.requestTimeout` defaults to 60 seconds. `llmRuntime.permissionMode` defaults to Full access and is always visible in the panel. **Workspace and Full access enable repository edits; Review and Custom remain read-only.** No mode enables general commands. Endpoint/model/timeout/permission settings are application-scoped so repository settings cannot redirect credentials or elevate permissions.

Ask for a focused code change to use editing. The agent reads files before proposing exact replacements. Stale content, unsaved editor buffers, and overlap with preexisting developer edits stop the task. Delete, move, and whole-file erasure open a preview and require approval, with Cancel selected initially. Completed changes open in native diff tabs; use **Review changes** to reopen the recorded task diffs and **Source Control** for the full working tree. Cancellation retains completed edits and reports them.

## Develop, test, package

Use Node.js 22 or newer and npm for development only:

```powershell
npm ci
npm test
npm run package
```

Press F5 to launch an Extension Development Host. Packaging produces a single VSIX containing compiled JavaScript and Zod (the only runtime library). TypeScript, VS Code types and `vsce` are development dependencies. Git runs as fixed argument arrays with no shell, a 15-second timeout, disabled fsmonitor, optional locks disabled, and a 4 MiB output cap. Fixed validation commands and developer-selected Pester tests are supported; general command execution is unavailable. See [Validation](docs/VALIDATION.md) for selection, module installation, execution policy and process limits.

Developer references are included in `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, and `docs/ACCEPTANCE.md`. The roadmap remains the long-term product direction.

Optional live tests use an isolated synthetic PowerShell repository. Set `LLM_RUNTIME_TEST_ENDPOINT`, `LLM_RUNTIME_TEST_API_KEY`, and `LLM_RUNTIME_TEST_MODEL` in the process environment, then run `npm run test:live`, `npm run test:live:editing`, or `npm run test:live:validation`. These tests make billable model requests and are excluded from `npm test`. Run `npm run test:host` to test all three suites and actual native diff tabs in the VS Code extension host; Microsoft's development-only `@vscode/test-electron` helper downloads a separate test build into the OS temporary directory. Set `LLM_RUNTIME_VSCODE_VERSION` to choose a version (default `stable`), or set `LLM_RUNTIME_VSCODE_EXECUTABLE` to use an existing executable. It launches a temporary profile without changing your normal VS Code settings. Never put test keys in source files or committed settings.

## Current limits

- Live progress is streamed at action boundaries; individual model JSON responses are buffered, bounded, parsed, and validated before execution. Token-level SSE streaming is not implemented.
- PowerShell indexing uses conservative lexical patterns, not the PowerShell AST. It extracts function/class names, typed parameters, manifest fields, import/export/dot-source lines and Pester descriptions. Complex multiline syntax and dynamic dependencies may be missed; use text search and read the source to confirm. UTF-8 and UTF-16LE BOM are supported; legacy ANSI and UTF-16BE files are excluded.
- Files over 256 KB, ignored content, likely sensitive configuration, binaries, generated directories, and linked paths are excluded. This is a conservative filename policy, not a general secret detector. Do not put credentials into chat or source files intended for model context.
- Only on-disk content is indexed; save editor buffers before asking about recent edits. Index refreshes enumerate the Git manifest and reuse unchanged symbol entries. A watcher invalidates the in-memory index; each tool also refreshes Git membership/ignore policy. The private index snapshot is rebuilt after restart, while conversation history is loaded.
- One conversation panel holds an OS lease per repository, preventing overlapping tasks and history writes across local VS Code windows. Windows named-pipe leases are released on process exit. Remote hosts and network-shared repositories are outside this pilot.
- Edits preserve UTF-8/UTF-8 BOM/UTF-16LE BOM and uniform line endings. New PowerShell files use UTF-8 BOM and CRLF. Mixed line endings, hard-linked mutation targets, case-only moves, and ambiguous preexisting changes are refused. New destinations never overwrite an existing file.
- File replacement is atomic, but the final content check and replacement are not a filesystem compare-and-swap. A move uses two filesystem operations; an interruption can leave both names. Unconfirmed journal entries are labeled for inspection. There is no automatic rollback or task undo, and custom Windows ACL preservation is not guaranteed.
- Automatic validation uses at most three rounds. Missing modules, declined test execution and unsupported module-loading analysis are reported as partial coverage. A test filename does not prove safety: only developer-selected Pester files execute. The default execution policy is inherited from the workstation.
- A public Gemini model and isolated VS Code Extension Development Host have passed the live smoke suite; see `docs/ACCEPTANCE.md` for evidence and remaining interactive checks. Other endpoint/network/proxy/certificate configurations still require validation. The client uses the VS Code extension host's Node HTTPS/fetch behavior; it does not bypass TLS verification or implement custom proxy routing.

## Data and cleanup

Conversation history, index metadata, validation reports, task journals, and raw file baseline/review snapshots are stored beneath VS Code's private per-user extension global storage, partitioned by a hash of the canonical Git root. No index or chat files are written to the inspected repository. History and snapshots are local plaintext under the user's OS account protections; API keys use SecretStorage. Snapshots can retain up to the 50 MB indexed baseline per task plus edits, with no automatic retention cleanup yet. Up to 100 named threads with 100 messages each are retained; each new task supplies at most 20 recent messages to the model. Interrupted tasks are marked interrupted when loaded and can receive a follow-up. Recorded diff snapshots survive reload and show the task's changes, not later external edits.

To reset data, close all LLM Runtime panels and remove this extension's `globalStorage/internal-pilot.llm-coding-agent-runtime` directory from the VS Code user-data location. To replace a key, rerun Set API Key. Uninstall through Extensions; VS Code may retain extension data and secrets, so follow your organization's workstation cleanup policy.
