# Task-scoped undo

Use **Undo task changes** in the conversation panel after an edit task finishes or is cancelled. The runtime opens native previews and asks for confirmation. Undo is a developer UI action, not a model tool. Review and Custom modes cannot perform it.

Undo restores the recorded starting bytes, including preexisting developer edits and original encoding/BOM/newlines. It removes task-created files and restores task-deleted files. A move is reversed through its recorded source and destination changes. It never changes the Git index or creates a commit.

All affected paths are checked before restoration begins and again before each write. Undo refuses changed content, dirty editor buffers, linked paths, ignored/protected paths, a changed HEAD, corrupt snapshots, and unconfirmed edit operations. It does not attempt a fuzzy reverse patch. Later edits—even unrelated edits within the same affected file—require reconciliation before undo.

## Cancellation and interruption

Undo restores files sequentially, not as a single filesystem transaction. Its private journal records the path about to be restored and each completed restoration. Cancelling leaves completed restorations intact and reports their count. Reopen the conversation and use Undo again to resume. A pending restoration whose bytes already match the baseline can be recognized after reload without rewriting it. Later conflicting changes still stop recovery.

The conversation blocks new tasks while its recorded undo remains incomplete. Historical native diff tabs are labeled when reopened after undo; they show the original task's changes, not the current working tree. Earlier validation results no longer describe the restored working tree. Undo is available for the conversation's latest recorded edit task, not as an arbitrary history browser.

Filesystem checks do not provide an atomic compare-and-swap against another local process. Empty directories created during editing can remain, and custom Windows ACL preservation is not guaranteed. Unconfirmed original edits require manual inspection; this feature does not automatically guess their outcome. Undo after actual isolated VS Code termination/restart is tested; mid-write termination and representative repository acceptance remain pilot checks.
