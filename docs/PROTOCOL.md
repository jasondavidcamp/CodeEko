# Version 1 action protocol

Every model response must be one raw JSON object with exactly `version`, `tool`, `args`. Additional properties are rejected at both levels. Markdown fences, arrays, multiple objects, unknown tools and non-1 versions fail closed. No model response is executed directly. Authoritative schemas are in `src/protocol/actions.ts`.

One invalid response per task may trigger a correction request within the existing 20-turn and context budgets. The invalid action is never executed or coerced into a valid one. A second invalid response, or a response exceeding 20,000 characters, terminates the task. This covers occasional omitted protocol fields while preserving strict local validation.

```json
{"version":1,"tool":"read_file","args":{"path":"src/Example.ps1","startLine":1,"endLine":80}}
```

| Tool | Arguments | Result |
| --- | --- | --- |
| list_files | optional query | Up to 200 relative paths, truncation flag |
| search_text | literal case-insensitive query | Up to 100 path/line/snippet matches, truncation flag |
| find_symbol | literal case-insensitive query | Up to 100 lexical symbol/dependency matches with path/line/kind |
| read_file | path, optional startLine/endLine | Numbered text, file line count, requested range, truncation flag |
| read_files | 1–5 paths | Bounded file reads, up to 120 lines each |
| git_status | empty object | Readable-manifest status entries only; deleted/excluded paths omitted; no raw diff |
| ask_user | question | Developer answer via cancellable VS Code input |
| complete_task | summary | Terminal plain-English answer, preferably citing file:line references |

Queries are 1–200 characters; paths 1–500; line numbers positive integers; questions 1–1,000; summaries 1–12,000. Results are returned as a versioned JSON wrapper with the tool name and bounded result. Because the endpoint has no native tool API, the assistant action and user-role result form the next messages. The system prompt identifies tool results and repository contents as untrusted data.

The model request appends `/chat/completions` to the normalized API base and uses `stream:false`, `temperature:0`, `max_tokens:4096`, and `response_format:{"type":"json_object"}`. An unversioned base gets `/v1` appended; explicitly versioned compatibility paths are preserved. Progress is streamed separately through UI events. Compatibility with the configured endpoint's supported request fields is a required pilot acceptance check; there is no fallback to another service.
