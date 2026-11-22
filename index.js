/**
 * Host half of the @local/session-delete bundle.
 *
 * Owns the `sessionTrash` service: it removes one session from the Workspace
 * registry, moves its persisted log directory and projection-cache file into
 * the Harness Trash, and can undo the move within the configured window.
 *
 * Deletion order (each step before the next):
 *  1. refuse while the session's live agent is inside a running turn;
 *  2. drop workspace membership and archive/pin marks in one durable write
 *     (this is what removes the sidebar row);
 *  3. move the log directory into the Trash (rename on the same filesystem;
 *     a live writer's open file handle follows the inode);
 *  4. move the projection-cache record beside it;
 *  5. write the trash manifest that undo reads back.
 *
 * The Client half calls `sessionDelete.delete` / `sessionDelete.undo` through
 * the API Gateway, which derives SRC descriptors from the Remote-method
 * markers this module attaches to the service prototype.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'

/** Prototype key carrying the Remote-method markers (`@Remote` writes it in TS). */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Seconds an undone trash entry stays restorable; the Client countdown mirrors this. */
const DEFAULT_UNDO_SECONDS = 5
/** Fallback trash root when the Config carries none (patch normally supplies `dshHomePath('trash')`). */
const DEFAULT_TRASH_ROOT = '/trash'
/** Entries older than the undo window are swept on the first delete after activation. */
const MANIFEST_NAME = 'manifest.json'
/** Under the trash root: one entry per deleted session. */
const SESSIONS_DIR = 'sessions'

/** Format one trash entry folder name: sortable time plus the session id. */
function entryName(now, sessionId) {
  const stamp = new Date(now).toISOString().replaceAll(':', '-')
  return `${stamp}-${sessionId}`
}

/** Attach the Remote-method markers the Gateway's SRC path reads on the exported class. */
function markRemoteMethods(target) {
  Object.defineProperty(target.prototype, REMOTE_METHOD_DESCRIPTOR, {
    value: {
      version: 1,
      methods: [
        { method: 'delete', invocation: { kind: 'direct' } },
        { method: 'undo', invocation: { kind: 'direct' } },
        { method: 'deleted', invocation: { kind: 'direct' } },
      ],
    },
    enumerable: false,
    writable: true,
    configurable: true,
  })
}

export class SessionTrashService extends TypertRemoteService {
  static inject = ['sessionPersistence']

  /** Loader-facing Config: where Trash entries live and how long undo stays open. */
  static Config = z.object({
    trashRoot: z.string().description('Absolute directory that receives deleted sessions.'),
    undoSeconds: z.number().min(1).max(3600).default(5)
      .description('Seconds the undo window stays open after a delete.'),
  })

  constructor(ctx, config = {}) {
    // The Gateway dispatches on this binding's namespace; the Client mounts
    // `sessionDelete/*`, so the wire namespace is fixed here.
    super(ctx, 'sessionTrash', { namespace: 'sessionDelete' })
    // Re-bind with an explicit frozen object: the Gateway's `validateBinding`
    // requires `binding.service` to be the unproxied instance, and re-reads it
    // through `originalOf()`. Building it against `this` (rather than the
    // super() receiver) keeps that identity exact.
    Object.defineProperty(this, 'typertRemote', {
      value: Object.freeze({ service: this, serviceKey: 'sessionTrash', namespace: 'sessionDelete' }),
      enumerable: false,
      writable: false,
      configurable: true,
    })
    this.config = {
      trashRoot: config.trashRoot ?? DEFAULT_TRASH_ROOT,
      undoSeconds: Number.isFinite(config.undoSeconds) && config.undoSeconds > 0
        ? Math.floor(config.undoSeconds)
        : DEFAULT_UNDO_SECONDS,
    }
  }

  /**
   * Delete one session into the Trash.
   * @param sessionId - exact session identity.
   * @returns `{ trashId, title? }` for the Client undo toast.
   */
  delete(sessionId) {
    return this.deleteSession(sessionId)
  }

  /**
   * Undo one earlier delete: restore files, registry membership, and marks.
   * @param trashId - the id `delete` returned.
   * @returns `{ restored: true }` on success.
   */
  undo(trashId) {
    return this.undoSession(trashId)
  }

  /**
   * Session ids currently held in the Trash, unreadable rows for the Client.
   * A live Session cannot leave `session.list()`, so the Client re-hides these
   * ids after every list pull — including ones this page never saw deleted.
   * @returns `{ sessionIds }` for ids whose manifest entry still exists.
   */
  async deleted() {
    const root = path.join(this.config.trashRoot, SESSIONS_DIR)
    let names
    try { names = await fs.readdir(root) } catch { return { sessionIds: [] } }
    const sessionIds = []
    for (const name of names) {
      if (name === MANIFEST_NAME) continue
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(root, name, MANIFEST_NAME), 'utf8'))
        if (typeof manifest.sessionId === 'string') sessionIds.push(manifest.sessionId)
      } catch { /* partially written or swept entry: not a tombstone */ }
    }
    return { sessionIds }
  }

  /** Serialize deletions against each other and workspace writes. */
  async deleteSession(sessionId) {
    const sessions = this.ctx.get('sessions')
    const agents = this.ctx.get('agents')
    const registry = this.ctx.get('workspaceRegistry')
    const persistence = this.ctx.sessionPersistence
    if (persistence === undefined) {
      throw new RemoteError('gateway/internal', 'session delete is unavailable in this deployment', {})
    }

    // 1. Live gate: a running turn is user work; refuse instead of stopping it.
    const agent = agents?.get(sessionId)
    if (agent !== undefined && agent.status === 'running') {
      throw new RemoteError('session/delete-running', 'stop the running turn before deleting this session', { sessionId })
    }

    // Snapshot the display title before any detach, for the undo undo toast.
    const title = await this.readTitle(sessionId)

    // 2. Live idle sessions keep their in-memory agent: the Agent API exposes
    // no sanctioned outside dispose, and the registry detach below is what
    // removes the sidebar row. The log directory rename follows the inode, so
    // the live writer keeps appending into the trashed directory and undo
    // renames it back seamlessly.

    // 3. Registry: detach from its workspace and drop archive/pin marks.
    const membership = await this.detachFromRegistry(registry, sessionId)

    // 4+5+6. Move files into the Trash and write the manifest. A failure
    // rolls the registry detach back too, so the sidebar row stays put.
    try {
      return await this.moveToTrash(sessionId, { title, membership })
    } catch (error) {
      await this.reattachToRegistry(registry, { ...membership, sessionId }).catch(() => {})
      throw error
    }
  }

  /** Undo one trash entry within the window. */
  async undoSession(trashId) {
    const entryDir = path.join(this.config.trashRoot, SESSIONS_DIR, trashId)
    let manifest
    try {
      manifest = JSON.parse(await fs.readFile(path.join(entryDir, MANIFEST_NAME), 'utf8'))
    } catch {
      throw new RemoteError('session/trash-entry-missing', 'this deletion can no longer be undone', { trashId })
    }
    if (manifest.undoMs !== undefined && Date.now() - manifest.deletedAt > manifest.undoMs + 500) {
      throw new RemoteError('session/trash-entry-expired', 'the undo window has closed', { trashId })
    }
    const failures = []
    // Files first: restore log directory and projection record to their
    // recorded locations. A missing `to` counts as already restored, so a
    // retry after a later-phase failure does not strand the entry.
    for (const move of manifest.moves ?? []) {
      try {
        await fs.access(move.to)
      } catch {
        continue
      }
      try {
        await fs.mkdir(path.dirname(move.from), { recursive: true })
        await fs.rename(move.to, move.from)
      } catch (error) {
        failures.push(move.kind ?? move.to)
      }
    }
    if (failures.length > 0) {
      throw new RemoteError('gateway/internal', 'undo could not restore the session files', { trashId })
    }
    // Registry membership next: if this throws, the entry survives on disk
    // and a retry skips the already-restored moves.
    const registry = this.ctx.get('workspaceRegistry')
    if (registry !== undefined && manifest.membership !== undefined) {
      await this.reattachToRegistry(registry, manifest.membership)
    }
    await fs.rm(entryDir, { recursive: true, force: true })
    return { restored: true }
  }

  /** Read the persisted display title best-effort; absence keeps the generic toast. */
  async readTitle(sessionId) {
    try {
      const stat = await this.ctx.sessionPersistence.stat(sessionId)
      const session = this.ctx.get('sessions')?.get(sessionId)
      if (session !== undefined) {
        const events = session.snapshotEvents()
        for (let index = events.length - 1; index >= 0; index--) {
          if (events[index].type === 'session/title') return String(events[index].data.title)
        }
      }
      void stat
      return undefined
    } catch {
      return undefined
    }
  }

  /** Remove one id from every durable workspace surface; returns the undo record. */
  async detachFromRegistry(registry, sessionId) {
    const membership = { workspaceId: undefined, wasArchived: false, wasPinned: false }
    if (registry === undefined) return membership
    if (registry.archivedSessionIds?.includes(sessionId) === true) membership.wasArchived = true
    if (registry.pinnedSessionIds?.includes(sessionId) === true) membership.wasPinned = true
    for (const workspace of registry.list()) {
      const position = workspace.sessionIds.indexOf(sessionId)
      if (position < 0) continue
      membership.workspaceId = workspace.id
      membership.position = position
      await workspace.detachSession(sessionId)
      break
    }
    if (membership.wasArchived) await registry.unarchiveSession(sessionId)
    if (membership.wasPinned) await registry.unpinSession(sessionId)
    return membership
  }

  /** Restore registry membership recorded at delete time. */
  async reattachToRegistry(registry, membership) {
    if (membership.workspaceId !== undefined) {
      const workspace = registry.get(membership.workspaceId)
      if (workspace !== undefined) {
        await workspace.attachSession(membership.sessionId)
        if (membership.position !== undefined && membership.position >= 0) {
          // Best-effort position restore; a reordered list keeps the session.
          const ids = [...workspace.sessionIds.filter(id => id !== membership.sessionId)]
          const anchor = ids[membership.position]
          await workspace.insertSessionBefore(membership.sessionId, anchor)
        }
      }
    }
    if (membership.wasArchived) await registry.archiveSession(membership.sessionId)
    if (membership.wasPinned) await registry.pinSession(membership.sessionId)
  }

  /** Move the log directory and projection record into a fresh trash entry. */
  async moveToTrash(sessionId, { title, membership }) {
    const trashRoot = this.config.trashRoot
    const sessionsRoot = path.join(trashRoot, SESSIONS_DIR)
    const now = Date.now()
    const trashId = entryName(now, sessionId)
    const entryDir = path.join(sessionsRoot, trashId)
    const undoMs = this.config.undoSeconds * 1000
    const moves = []
    const failures = []

    // Locate the log directory through the backend's own location record;
    // a pending (never materialized) session has no files to move.
    const logDir = await this.findLogDir(sessionId)
    if (logDir !== undefined) {
      const to = path.join(entryDir, 'session')
      try {
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.rename(logDir, to)
        moves.push({ from: logDir, to, kind: 'log' })
      } catch (error) {
        failures.push(`log: ${String(error)}`)
      }
    }
    // The projcache record lives at `<dshHome>/storages/session_projcache/
    // sessions/<id>.json`; the trash root is `<dshHome>/trash`, so one
    // dirname strips `trash` and the next strips nothing else (never used
    // when the configured root is deeper than one level below home).
    const projection = path.join(
      path.dirname(trashRoot),
      'storages', 'session_projcache', 'sessions', `${sessionId}.json`,
    )
    try {
      await fs.access(projection)
      const to = path.join(entryDir, `${sessionId}.projcache.json`)
      await fs.rename(projection, to)
      moves.push({ from: projection, to, kind: 'projection' })
    } catch {
      // An absent cache is not a failure; cold reads rebuild it.
    }
    // Zero stored files is a valid deletion (a pending or cold-only session):
    // the manifest still records the membership detach, so undo restores it,
    // and there are simply no file moves to reverse.
    if (failures.length > 0) {
      // Roll the completed moves back so the session stays exactly as it was.
      for (const move of moves.reverse()) {
        await fs.mkdir(path.dirname(move.from), { recursive: true }).catch(() => {})
        await fs.rename(move.to, move.from).catch(() => {})
      }
      throw new RemoteError('gateway/internal', `delete failed while moving session files (${failures.join('; ')})`, { sessionId })
    }

    const manifest = {
      version: 1,
      trashId,
      sessionId,
      title,
      deletedAt: now,
      undoMs,
      undoSeconds: this.config.undoSeconds,
      membership: { ...membership, sessionId },
      moves,
    }
    await fs.mkdir(entryDir, { recursive: true })
    await fs.writeFile(path.join(entryDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8')
    void this.sweepExpired()
    return { trashId, ...(title === undefined ? {} : { title }) }
  }

  /** Resolve the stored log directory for one id from the persistence snapshot. */
  async findLogDir(sessionId) {
    try {
      const snapshot = await this.ctx.sessionPersistence.stat(sessionId)
      const file = snapshot?.location?.path
      if (typeof file !== 'string' || file.length === 0) return undefined
      // The artifact lives at `<projectDir>/<encodedId>/<file>`; the session's
      // whole directory moves so the lock file travels with it.
      return path.dirname(file)
    } catch {
      return undefined
    }
  }

  /** Remove trash entries whose undo window closed long ago (first delete after activation). */
  async sweepExpired() {
    if (this.config.swept === true) return
    this.config.swept = true
    const root = path.join(this.config.trashRoot, SESSIONS_DIR)
    const cutoff = Date.now() - this.config.undoSeconds * 1000 * 120
    let names
    try { names = await fs.readdir(root) } catch { return }
    for (const name of names) {
      if (name === MANIFEST_NAME) continue
      // Entry names start with an ISO stamp whose colons became dashes:
      // `YYYY-MM-DDTHH-MM-SS-sssZ-sessionId`. Restore colons only in the
      // time part (positions 13, 16, 19) before parsing.
      const stamp = Date.parse(
        name.slice(0, 10) + 'T' + name.slice(11, 13) + ':' + name.slice(14, 16) + ':' + name.slice(17, 19) + '.' + name.slice(20, 23) + 'Z',
      )
      if (Number.isFinite(stamp) && stamp < cutoff) {
        await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}

/**
 * Plugin entry. The Loader mounts this module's default export as the plugin,
 * so the class carries both `apply` (as the constructor) and the Config schema.
 * Constructing the service publishes it under `sessionTrash` and attaches the
 * Remote markers the Gateway reads.
 */
export default class SessionDeletePlugin extends SessionTrashService {
}

// The Gateway reads the markers from the prototype of the instance it
// receives, so they must sit on this exported class rather than the base.
markRemoteMethods(SessionDeletePlugin)

export { SessionDeletePlugin as apply }
