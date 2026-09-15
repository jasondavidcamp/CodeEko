# Version 1 action protocol

Every model response must be one raw JSON object with exactly `version`, `tool`, `args`. Additional properties are rejected at both levels. Markdown fences, arrays, multiple objects, unknown tools and non-1 versions fail closed. No model response is executed directly. Authoritative schemas are in `src/protocol/actions.ts`.

Up to two isolated invalid responses may receive field-specific correction feedback inside the existing 20-turn and context budgets. Two consecutive invalid replies, a third invalid reply overall, or a response exceeding 20,000 characters stops the task. Invalid actions are never executed or coerced. The chat explains that the rejected response made no changes and earlier edits remain.

```json
{"version":1,"tool":"read_file","args":{"path":"src/Example.ps1","startLine":1,"endLine":80}}
```

| Tool | Arguments | Result |
| --- | --- | --- |
| list_files | optional query | Up to 200 relative paths, truncation flag |
| search_text | literal case-insensitive query | Up to 100 path/line/snippet matches, truncation flag |
| find_symbol | literal case-insensitive query | Up to 100 lexical symbol/dependency matches with path/line/kind |
| read_file | path, optional startLine/endLine | Numbered text, file line count, range, truncation flag, raw-byte SHA-256 hash, encoding and line ending |
| read_files | 1–5 paths | Bounded file reads, up to 120 lines each |
| git_status | empty object | Readable-manifest status entries only; deleted/excluded paths omitted; no raw diff |
| ask_user | question | Developer answer via cancellable VS Code input |
| complete_task | summary | Terminal plain-English answer, preferably citing file:line references |
| apply_patch | path, expectedHash, edits: [{oldText,newText}] | Exact replacement result and new hash |
| create_file | path, content | New file result and hash; existing destinations refused |
| delete_file | path, expectedHash | Delete result after native confirmation |
| move_file | path, destination, expectedHash | Move result after native confirmation |
| git_diff_summary | empty object | Task change metadata, no raw patch |
| open_diff | optional path | Native task diff review |
| run_validation | empty object | Fixed parsing, analysis and approved Pester results; at most three rounds |

Mutation tools require Workspace or Full access. Read the target first and use its returned 64-character lowercase SHA-256 hash. Each patch contains 1–10 exact replacements of at most 12,000 characters per old/new string, matched against the same original text without displayed line-number prefixes. Match text must be unique and replacements cannot overlap. One empty oldText is allowed only for an empty file. New content is limited to 16,000 characters; the overall 20,000-character response cap still applies. Newlines are normalized for matching and restored on write. Re-read after each edit before editing the same file again. Safety conflicts stop the task. General commands, commits and pushes are unavailable. Undo is a developer UI action, not a model tool. Completion automatically validates edited tasks; failures feed back into the loop and the third failed round blocks completion. See VALIDATION.md.

Queries are 1–200 characters; paths 1–500; line numbers positive integers; questions 1–1,000; summaries 1–12,000. Results are returned as a versioned JSON wrapper with the tool name and bounded result. Because the endpoint has no native tool API, the assistant action and user-role result form the next messages. The system prompt identifies tool results and repository contents as untrusted data.

For a requested before/after test comparison, call `run_validation` before the first mutation. That approved observation counts toward the three-round maximum. Later Pester 5 results can report preexisting, newly failing, changed and unknown failures plus observed resolutions. Do not infer a baseline when the report says comparison is unavailable, or present newly observed failures as proof of causation.

A rejected mutation may return `error: "read_required"` with a relative path. No edit was applied. Call `read_file`, copy its returned hash and then propose the edit again. Earlier conversation summaries and validation are not reads. At most two such corrections are allowed inside the existing 20-action and 12-edit-attempt limits. This recovery is only available when the file still matches the task's current snapshot; actual external changes and other safety conflicts remain terminal.

The model request appends `/chat/completions` to the normalized API base and uses `stream:false`, `temperature:0`, `max_tokens:4096`, and `response_format:{"type":"json_object"}`. An unversioned base gets `/v1` appended; explicitly versioned compatibility paths are preserved. Progress is streamed separately through UI events. Compatibility with the configured endpoint's supported request fields is a required pilot acceptance check; there is no fallback to another service.

Test requests receive a bounded current file inventory before the first model call. Prefer batch reads and existing suites. Model-facing validation reports omit passing-case inventories and fingerprints while retaining counts, failures, diagnostics and comparison evidence; the complete report remains in private storage. Progress describes file reads, edits and validation instead of internal turn/context counters.
