# dsh-session-delete

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds a red **Delete session** action to the Session `···` menu, moves the session's data into the Harness Trash, and offers a five-second **Undo** before the deletion becomes permanent.

> Hover over a session row in the sidebar → click the `···` icon → click the red **Delete session**. The row disappears immediately; a toast with a countdown appears at the bottom of the screen. Click **Undo** within five seconds to restore everything, or let the timer expire to make it final.

## Features

- 🔴 **Red menu action** — added to every Session row's `···` menu, ordered after the built-in Archive row with a separator.
- 🗑️ **Trash, not gone** — deleted sessions are *moved* to `<DSH home>/trash/sessions/<timestamp>-<sessionId>/` (log directory + projection cache + a `manifest.json` recording the original paths), never destroyed outright.
- ⏱️ **Five-second undo** — a frame-wide toast shows a live countdown; one click restores the files, the workspace membership (including its exact list position), and any archived/pinned marks.
- 📭 **Works on empty sessions** — sessions that were never opened (no stored files) are deleted too: there is nothing to move, so the manifest records only the membership detach.
- 🛡️ **Running-turn guard** — a session currently executing a turn is refused with an explanatory notice instead of being interrupted.
- 🧹 **Self-cleaning** — trash entries well past the undo window are swept away by a one-shot sweep on the next delete after the Host starts.

## Installation

Requires [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `>=0.2.2-rc.5 <0.3.0`.

```bash
git clone https://github.com/<you>/dsh-session-delete.git
cd dsh-session-delete

# The two runtime deps resolve from npm (declared in package.json).
npm install

# Install the bundle into your DSH profile (adjust --profile if yours isn't "web").
dsh plugin --profile web add /absolute/path/to/dsh-session-delete
```

> If the registry is unreachable (offline install, or a DSH-internal build), symlink the deps into `node_modules` from the DSH install tree instead:
>
> ```bash
> ln -s <dsh-install>/node_modules/@deepseek-ai/dsh-typert-protocol node_modules/@deepseek-ai/dsh-typert-protocol
> ln -s <dsh-install>/node_modules/@deepseek-ai/schemastery            node_modules/schemastery
> ```
>
> where `<dsh-install>` is the directory holding `@deepseek-ai/*` (for a global install: `dirname $(dirname $(readlink -f $(command -v dsh)))`).

Then restart the DSH Web GUI (or `dsh web`) and reload the page.

### Uninstall

```bash
dsh plugin --profile web remove @local/session-delete
```

> If `dsh plugin add` reports `ERR_PNPM_UNEXPECTED_STORE`, your PATH's pnpm major differs from the one that created the profile. Use a wrapper pinned to the profile's pnpm (e.g. `pnpm@10.34.7`) in front of `PATH`, then retry.

## Configuration

`cordis.patch.yml` in this bundle supplies one Host row:

```yaml
- insert:
    - id: session-delete
      name: '@local/session-delete'
      config:
        trashRoot: !!js dshHomePath('trash')   # where trash entries live
        undoSeconds: 5                          # length of the undo window
```

Edit `config.undoSeconds` (1–3600) in your profile's `cordis.patch.yml` and restart to change the countdown; the Client toast mirrors the default `5`.

## How it works

The plugin is a **static bundle** (`dsh.client` dual-face package) with two halves:

| File | Side | Role |
| --- | --- | --- |
| [`index.js`](index.js) | Host | `sessionTrash` service, Remote methods `delete` / `undo` / `deleted` on wire namespace `sessionDelete` |
| [`client.js`](client.js) | Client | menu action, countdown toast, Remote descriptors, session-list suppression |
| [`cordis.patch.yml`](cordis.patch.yml) | Bundle patch | injects the Host row with its config |
| [`locale/`](locale/) | Meta | plugin title/description/detail in `en` + `zh` |

### Delete sequence (Host)

1. **Running-turn gate** — if `agents.get(id).status === 'running'`, refuse with `session/delete-running`.
2. **Registry detach** — remove the id from its workspace (recording the original list position), and drop archived/pinned marks. This is what makes the sidebar row leave its group.
3. **Move files** — `rename()` the session's log directory and projection cache into the trash entry (same filesystem; a live writer's open handle follows the inode, so an idle open session keeps writing into the trashed directory and undo reconnects seamlessly).
4. **Write `manifest.json`** — records every `from → to` move plus the membership needed for undo.

Any failure rolls the completed moves back and re-attaches the membership, so a failed delete leaves everything untouched.

### Undo (within the window)

Reverses each move (idempotently — already-restored paths are skipped, so a retry can't strand the entry), re-attaches membership at its recorded position, then removes the trash entry. The Host enforces `deletedAt + undoMs` (a reload can't beat the clock).

### Why rows can be suppressed

A session that lives in Host memory (e.g. never written to disk) still appears in `session.list()` — the Host store exposes no public per-id removal. The Client therefore hides such rows through the standard `sessions.handleSessionRemoved` relay, seeded from the Host's `deleted()` method (which lists trash manifests) on every page load. Undoing restores the row.

## Known limitations

- **Undo while the conversation view is open** — the Client's per-session `removed` flag has no public reset; after undo, that session's input area may stay inert until you reopen the session. Rows always restore correctly.
- **Attachments are not deleted** — `~/.dsh/attachments/objects/` is a content-addressed store shared across sessions; removing entries would corrupt other sessions.
- **Trash sweep timing** — expired trash entries are removed by a sweep that runs once, on the first delete after the Host starts (not on start-up itself).
- **Host changes need a restart** — this bundle is installed as a `link:` package, which DSH's HMR treats as a pending external module: `index.js` edits apply only after restarting DSH. `client.js` (Client half) reloads with the page.

## Development

```bash
node --check index.js && node --check client.js   # syntax gate
dsh plugin --profile web install                  # re-link after moving the checkout
```

The plugin's unit-level behavior was verified with small Node harnesses that stub the Cordis context (`reflect.provide`, `effect`, `inject`) and the Remote namespace; the visual menu/toast flow is verified in the GUI by hand.

## Docs

- [`docs/DETAIL.md`](docs/DETAIL.md) — user-facing behavior reference rendered on the plugin's detail page.

## License

MIT
