# Session delete

Adds a red **Delete session** action to each Session row's `···` menu in the sidebar. Choosing it moves the session's log directory and its cached projection file into the Harness Trash under the DeepSeek Harness home (`~/.dsh/trash/` in the default layout; exactly the directory configured by the plugin's `trashRoot`), detaches the session from its workspace, and refreshes the Session list so the row disappears. A session with no stored files (never opened, or opened without messages) is deleted the same way: there is simply nothing to move.

A frame-wide notification then shows a countdown matching the configured undo window (five seconds by default) with an **Undo** button. Undo restores the session files and re-attaches its workspace membership (pinned and archived marks included) at its previous list position when that position still exists; otherwise the session rejoins at the end of the list. After the countdown the deletion stands and the trash entry stays on disk until it is swept on a later delete.

## Behavior and limits

- A session that is currently running a turn cannot be deleted; the menu action reports the refusal.
- The active (open) session can be deleted; its live agent stays in memory and keeps writing into the trashed directory until the process exits, so an undo in the window restores it seamlessly.
- Workspace order, pins, and archives of other sessions are untouched.
- Trash entries live in `<trashRoot>/sessions/<timestamp>-<sessionId>/` with a `manifest.json` recording the original paths; entries well past the undo window are removed by a sweep that runs once, on the first delete after the Host starts.
- The operation is available through the UI only; it is not exposed as an agent tool.
- A deleted session that still lives in Host memory (never written to disk) cannot leave the Host's session list, so the Client hides its row through the standard session-removal relay, seeded from the Trash after every page load; undoing restores the row.
- Undoing a delete made while that session's conversation view was open re-shows the row, but its input area may stay inert until the session is reopened (a Host limitation: the Client's removed flag has no public reset).
