# Acceptance and validation

## Automated

Run `npm test`. The suite uses isolated temporary Git repositories and mock HTTPS responses. It never runs the pilot repository's scripts, Pester tests, integrations or environment-changing operations.

- Traversal, sibling paths, absolute paths, alternate streams and Windows junctions are denied.
- Unknown/malformed/oversized or extra-field actions cannot execute; mutation is denied in every permission mode.
- Multi-root selection occurs before repository access and cancelling selection stops the operation.
- Tracked and untracked ignored files, generated output, sensitive names, binaries and linked paths are excluded.
- Lexical index refresh updates changed symbols and persists outside the repository.
- Model discovery normalizes paths, deduplicates IDs, handles empty/error responses and excludes credential-bearing error bodies.
- Cancellation aborts transport, index and loop before further execution.
- The loop retrieves evidence and stops at its action budget.
- Named threads survive reconstruction, separate repositories have distinct stores, running tasks recover as interrupted, corrupt history is not overwritten.
- A mocked VS Code host exercises command registration, SecretStorage, manual model fallback, conversation lifecycle, cancellation and the busy guard. The actual emitted webview script is syntax-checked. This does not replace a real Extension Development Host check.

## Manual pilot gate (not yet performed)

1. Build and install the VSIX in a clean Windows VS Code profile with access to your configured endpoint.
2. Set the HTTPS API endpoint, store an individual key and select a dynamically discovered model. Interrupt endpoint connectivity and verify the configured/manual model fallback and useful timeout error. Verify certificate/proxy handling without disabling TLS.
3. Open the real PowerShell 5.1 repository. Create two named threads, ask different questions and restart VS Code; verify histories and repository association.
4. Ask “Explain how the entry point loads its modules and where those behaviors are tested. Cite paths and lines.” Compare the answer against source; verify searches/read actions support the answer.
5. Add an uncommitted function, save it and ask about it. Verify refreshed symbols and unchanged working-tree content. Unsaved editor changes are outside this release's disk index.
6. Cancel a slow model request and a search. Verify no subsequent actions run and the thread reports cancelled. Close the panel mid-task and reopen it after cancellation finishes.
7. Open a multi-root workspace; verify selection precedes tool activity. Open the same repository in a second window and verify the lease prevents overlapping sessions.
8. Inspect Source Control before/after each question. All preexisting files must remain byte-for-byte unchanged and no index/chat artifacts should appear in the repository.
9. Check keyboard access, progress updates, long responses, narrow panel layouts, and literal rendering of HTML-like content.

These interactive and endpoint tests are required before declaring Phase 1/2 exit criteria satisfied. Packaging and mock tests alone do not establish endpoint compatibility or the full pilot outcome.
