# Version 1 action protocol

Every model response must be one raw JSON object with exactly `version`, `tool`, `args`. Additional properties are rejected at both levels. Markdown fences, arrays, multiple objects, unknown tools and non-1 versions fail closed. No model response is executed directly. Authoritative schemas are in `src/protocol/actions.ts`.

Up to two format-only correction requests are allowed inside the existing 20-turn and context budgets, including consecutive malformed replies. Corrections retain the original task history, loaded protocol guidance and a schema hint; nonempty malformed responses are included as untrusted data. A third invalid reply overall or a response exceeding 20,000 characters stops the task. Invalid actions are never executed or coerced. The chat explains that the rejected response made no changes and earlier edits remain.

The first request uses a compact core with tool signatures, critical rules and conversation continuity. Detailed repository, editing, PowerShell, validation and Git instructions load on demand after validated, authorized actions; failed automatic validation also loads repair guidance. Modules are included in the next normal request, without a discovery/model-routing call. This changes instructions only: tools, strict schemas, permissions, fresh-read checks and execution remain unchanged. Questions and direct completion load no modules or repository resources. Conversation history is not compacted by this change. See ARCHITECTURE.md for selection and baseline timing.

```json
{"version":1,"tool":"read_file","args":{"path":"src/Example.ps1","startLine":1,"endLine":80}}
```

| Tool | Arguments | Result |
| --- | --- | --- |
| list_files | optional query | Up to 200 relative paths, truncation flag |
| search_text | literal case-insensitive query | Up to 100 path/line/snippet matches, truncation flag |
| find_symbol | literal case-insensitive query | Up to 100 lexical symbol/dependency matches with path/line/kind |
| read_file | path, optional startLine/endLine | Clean source text (LF, no added prefixes), file line count, range, truncation flag, raw-byte SHA-256 hash, encoding and line ending |
| read_files | 1–5 paths | Bounded file reads, up to 120 lines each |
| git_status | empty object | Readable-manifest status entries only; deleted/excluded paths omitted; no raw diff |
| ask_user | question | Developer answer through the cancellable conversation composer |
| complete_task | summary | Terminal plain-English answer, preferably citing file:line references |
| apply_patch | path, optional expectedHash, edits: [{oldText,newText,replaceAll?}] | Exact replacement result and new hash |
| create_file | path, content | New file result and hash; existing destinations refused |
| delete_file | path, expectedHash | Delete result after native confirmation |
| move_file | path, destination, expectedHash | Move result after native confirmation |
| git_diff_summary | empty object | Task change metadata, no raw patch |
| open_diff | optional path | Native task diff review |
| run_validation | empty object | Fixed parsing, analysis and approved Pester results; at most three rounds |

Mutation tools require Workspace or Full access. Read the target first. Omit expectedHash for patches to use the runtime-observed version; delete/move require the returned 64-character lowercase SHA-256 hash. Each patch contains 1–10 exact replacements of at most 12,000 characters per old/new string, matched against the same original clean source text. Match text must be unique unless that edit explicitly sets replaceAll:true, which expands to every exact literal occurrence. Zero matches, overlapping occurrences/replacements and failed checks reject the entire batch before writing. At most 1000 expanded replacement locations are allowed, and projected output size is checked before constructing it. There is no fuzzy or regex matching. One empty oldText is allowed only for an empty file. New content is limited to 16,000 characters; the overall 20,000-character response cap still applies. Newlines are normalized for matching and restored on write. Re-read after each edit before editing the same file again. Safety conflicts stop the task. General commands and pushes are unavailable; local commits require an explicit current user request. Direct chat undo requests are handled locally for the conversation's latest recorded edit task; undo is not a model tool. Completion automatically validates edited tasks; failures feed back into the loop and the third failed round blocks completion. See VALIDATION.md.

Queries are 1–200 characters; paths 1–500; line numbers positive integers; questions 1–1,000; summaries 1–12,000. Results are returned as a versioned JSON wrapper with the tool name and bounded result. Because the endpoint has no native tool API, the assistant action and user-role result form the next messages. The system prompt identifies tool results and repository contents as untrusted data.

For a requested before/after test comparison, call `run_validation` before the first mutation. That approved observation counts toward the three-round maximum. Later Pester 5 results can report preexisting, newly failing, changed and unknown failures plus observed resolutions. Do not infer a baseline when the report says comparison is unavailable, or present newly observed failures as proof of causation.

A rejected mutation may return `error: "read_required"` or `"patch_target_required"` with a relative path and `currentRead` from an automatic policy-checked file read. No rejected edit is replayed. Propose a new action from these contents; omit `expectedHash` for patches or copy the refreshed hash for delete/move. Read additional lines when needed. Earlier conversation summaries and validation are not reads. At most two corrections per unresolved file are allowed; only an applied mutation to that file resets its counter, not reads, no-op patches or mutations elsewhere. The existing 20-model-turn and 12-edit-attempt limits still apply; automatic reads count toward the 30-file-read limit. Actual external changes and other safety conflicts remain terminal.

The model request appends `/chat/completions` to the normalized API base and uses configured streaming (on by default), `temperature:0` and `max_tokens:4096`. Default User message compatibility embeds instructions and conversation records in one user message without `response_format`. Standard mode uses role messages and `response_format:{"type":"json_object"}`. An unversioned base gets `/v1` appended; explicitly versioned compatibility paths are preserved. Complete actions are validated before execution. Compatibility with the configured endpoint's supported request fields is a required pilot acceptance check; there is no fallback to another service.

Test requests receive a bounded current file inventory after the first validated, authorized repository action, never before the first model call. Prefer batch reads and existing suites. Model-facing validation reports omit passing-case inventories and fingerprints while retaining counts, failures, diagnostics and comparison evidence; the complete report remains in private storage. Progress describes file reads, edits and validation instead of internal turn/context counters.

`git_commit {message:string, paths:string[]}` accepts a nonempty message up to 2,000 characters and 1–24 individual repository files. The host requires an explicit commit request in the latest user message independently of the model. A successful local commit is terminal; no subsequent model call can schedule another operation in that task. Review denies it; Workspace confirms in-pane and Full access proceeds directly. Push, amend and history rewriting are not supported. See README local-commit limitations.

For `apply_patch`, `expectedHash` is optional and should be omitted by the model. The runtime supplies the hash from its latest read of the same file. Missing reads, external changes and writes since that read still invalidate the patch. An explicitly supplied hash is validated as before. Delete and move continue to require an explicit hash.

`git_show_commit { revision?: string }` is read-only in all permission modes. Revision is HEAD, HEAD~1–HEAD~99, or a 7–64 character hexadecimal commit hash. It returns pinned commit metadata and filtered, bounded first-parent diffs. Use this for commit-history questions; `git_diff_summary` reports only the current task’s changes. Summarize returned patches in prose.
