/**
 * Client half of the @local/session-delete bundle.
 *
 * Registers a red "Delete session" action in the shared Session context menu
 * (order 700, after the built-in Archive row) and a frame-wide undo overlay
 * with a five-second countdown in `shell.overlay`. Calls run through a
 * hand-written Remote contribution mounted under the `sessionDelete`
 * namespace, served by the bundle's Host service.
 *
 * Static bundle note: this module is loaded through the platform module
 * loader, so `require` resolves only the declared `dsh.client.inject` entries
 * plus `external` — never a package the page did not ship.
 */
window.__ModuleLoader__.load({
  id: '@local/session-delete',
  factory(require) {
    const React = require('react')
    const zod = require('zod')

    const NS = 'sessionDelete'
    const PACKAGE = '@local/session-delete'

    const en = {
      menuDelete: 'Delete session',
      deleteFailed: 'Delete failed',
      undoFailed: 'Undo failed',
      refusedRunning: 'Stop the running turn before deleting this session.',
      refusedGone: 'This deletion can no longer be undone.',
      refusedExpired: 'The undo window has closed.',
      refusedGeneric: 'This session cannot be deleted right now.',
      deleted: '“{title}” deleted',
      deletedPlain: 'Session deleted',
      undo: 'Undo',
      expiringIn: 'Undo in {seconds}s',
      expiringInOne: 'Undo in 1s',
    }
    const zh = {
      menuDelete: '删除会话',
      deleteFailed: '删除失败',
      undoFailed: '撤销失败',
      refusedRunning: '请先停止正在进行的回合，再删除该会话。',
      refusedGone: '此删除已无法撤销。',
      refusedExpired: '撤销时限已过。',
      refusedGeneric: '该会话当前无法删除。',
      deleted: '“{title}”已删除',
      deletedPlain: '会话已删除',
      undo: '撤销',
      expiringIn: '{seconds} 秒内可撤销',
      expiringInOne: '1 秒内可撤销',
    }

    /** Map a Host refusal to its localized copy; unknown codes keep the server message. */
    function refusalText(t, code) {
      if (code === 'session/delete-running') return t('refusedRunning')
      if (code === 'session/trash-entry-missing') return t('refusedGone')
      if (code === 'session/trash-entry-expired') return t('refusedExpired')
      return undefined
    }

    /** Surface a failure through the shared notice path, localized when known. */
    function notifyRefusal(ctx, t, result, fallbackKey) {
      const normalized = result instanceof Error ? normalizeThrown(result) : result
      const known = refusalText(t, normalized?.error?.code)
      // Unmapped codes (gateway/internal etc.) keep the server message so a
      // misconfigured Host path surfaces its cause instead of a dead end.
      notifyFailure(ctx, known ?? normalized?.error?.message ?? t(fallbackKey))
    }

    // The Host derives SRC descriptors from the service markers; the client
    // side needs concrete strict codecs per parameter, so the contribution
    // declares both methods with plain string ids. `delete`/`undo` take one
    // string argument on the wire field `sessionId`/`trashId` (the Host
    // parameter names) and return JSON values without client decoding.
    const stringCodec = {
      mode: 'strict',
      typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      create: () => zod.z.string(),
    }
    const trashIdCodec = {
      mode: 'strict',
      typeSymbol: `${PACKAGE}#sessionDelete.undo:trashId`,
      create: () => zod.z.string(),
    }
    const descriptors = [
      {
        id: `${PACKAGE}#sessionDelete.delete`,
        service: 'sessionTrash',
        namespace: 'sessionDelete',
        method: 'delete',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: stringCodec }],
        result: { mode: 'src-json' },
      },
      {
        id: `${PACKAGE}#sessionDelete.undo`,
        service: 'sessionTrash',
        namespace: 'sessionDelete',
        method: 'undo',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'trashId', wire: 'trashId', source: 'json', codec: trashIdCodec }],
        result: { mode: 'src-json' },
      },
      {
        id: `${PACKAGE}#sessionDelete.deleted`,
        service: 'sessionTrash',
        namespace: 'sessionDelete',
        method: 'deleted',
        invocation: { kind: 'direct' },
        parameters: [],
        result: { mode: 'src-json' },
      },
    ]

    let h = null

    /** Seconds left before the Host closes this entry's undo window. */
    function computeRemaining(entry, undoSeconds) {
      const deadline = entry.expiresAt ?? entry.createdAt + undoSeconds * 1000
      return Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    }

    /** One frame-wide undo notice with its countdown; self-dismisses at zero. */
    function UndoToast(props) {
      const { entry, t, onUndo, onExpire } = props
      // Wall-clock countdown from the delete instant, so throttled background
      // tabs and timer drift cannot outlive the Host's real deadline.
      const [remaining, setRemaining] = React.useState(() => computeRemaining(entry, props.undoSeconds))
      React.useEffect(() => {
        setRemaining(computeRemaining(entry, props.undoSeconds))
        const timer = setInterval(() => {
          setRemaining(computeRemaining(entry, props.undoSeconds))
          if (computeRemaining(entry, props.undoSeconds) <= 0) clearInterval(timer)
        }, 250)
        return () => { clearInterval(timer) }
      }, [entry.trashId, props.undoSeconds])
      React.useEffect(() => {
        if (remaining > 0) return
        onExpire(entry.trashId)
      }, [remaining, entry.trashId, onExpire])
      const label = entry.title !== undefined && entry.title.length > 0
        ? t('deleted', { title: entry.title })
        : t('deletedPlain')
      const busy = entry.undoState === 'undoing'
      const seconds = Math.max(remaining, 0)
      return h('div', { className: 'dsw-session-delete-toast', role: 'status' },
        h('div', { className: 'dsw-session-delete-text' }, label),
        h('div', { className: 'dsw-session-delete-countdown' },
          seconds === 1 ? t('expiringInOne') : t('expiringIn', { seconds })),
        h('button', {
          type: 'button',
          className: 'dsw-session-delete-undo',
          disabled: busy || seconds <= 0,
          onClick: () => { onUndo(entry) },
        }, t('undo')))
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-delete: dictionaries')

      h = React.createElement
      // Scoped style element so the undo look stays with the plugin and
      // unmounts with it; tokens come from the frame theme.
      const style = document.createElement('style')
      style.textContent = [
        '.dsw-session-delete-layer{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:60;display:flex;flex-direction:column;gap:8px;pointer-events:none;}',
        '.dsw-session-delete-toast{pointer-events:auto;display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;',
        'background:#141414;opacity:1;color:#f5f5f5;box-shadow:0 6px 24px rgba(0,0,0,.5);',
        'border:1px solid #2b2b2b;font-size:13px;}',
        '.dsw-session-delete-text{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dsw-session-delete-countdown{color:#9a9a9a;font-variant-numeric:tabular-nums;white-space:nowrap;}',
        '.dsw-session-delete-undo{border:none;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px;font-weight:600;',
        'background:var(--dsw-alias-accent);color:var(--dsw-alias-text-on-accent);}',
        '.dsw-session-delete-undo:disabled{opacity:.6;cursor:default;}',
      ].join('')
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'session-delete: styles')

      // Mount the Remote contribution so ctx.remote.sessionDelete.* exists.
      // Self-mounted namespace: this plugin's own lifetime must NOT inject
      // `remote.sessionDelete` — a fiber body stays pending until every inject
      // key is provided, so waiting on a service this same body mounts would
      // deadlock. Mirror the action-cards pattern instead: mount first, then
      // enter a scoped `ctx.inject` whose fiber starts with the key present.
      let namespace = null
      let namespaceFailure = null
      const namespaceWaiters = []
      const settleNamespace = () => {
        while (namespaceWaiters.length > 0) namespaceWaiters.shift()()
      }
      ctx.effect(() => {
        let disposed = false
        let disposer
        void ctx.remote.$mount({ package: PACKAGE, descriptors }).then((dispose) => {
          if (disposed) { void dispose(); return }
          disposer = dispose
          ctx.inject(['remote.sessionDelete'], (inner) => {
            namespace = inner.remote.sessionDelete
            settleNamespace()
          })
          // Seed this page's tombstones from the Host: a page reload starts with
          // an empty local set, yet rows of sessions deleted earlier (their live
          // Session still resident on the Host) must not reappear.
          void namespace.deleted().then((res) => {
            if (disposed || res?.ok !== true || !Array.isArray(res.value?.sessionIds)) return
            for (const sessionId of res.value.sessionIds) {
              if (deletedSessionIds.has(sessionId)) continue
              deletedSessionIds.add(sessionId)
              hideRow(ctx.get('sessions'), sessionId)
            }
            return refreshSessionList(ctx)
          }).catch(() => { /* seeding is best-effort */ })
        }, (cause) => {
          namespaceFailure = cause instanceof Error ? cause.message : String(cause)
          settleNamespace()
        })
        return () => {
          disposed = true
          namespace = null
          if (disposer !== undefined) void disposer()
        }
      }, 'session-delete: remote mount')

      /** Wait for the mount to settle, then return the namespace service. */
      async function whenRemote() {
        if (namespace === null && namespaceFailure === null) {
          await new Promise((resolve) => { namespaceWaiters.push(resolve) })
        }
        if (namespace === null) {
          throw new Error(namespaceFailure ?? 'session delete is unavailable')
        }
        return namespace
      }

      // Frame-wide undo layer: entries appear when the menu action resolves.
      const entryStore = createEntryStore(React)
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'session-delete.undo', locale: NS,
        inject: () => ({
          useEntries: entryStore.useEntries,
          t,
          undoSeconds: readUndoSeconds(),
          onUndo: entry => { void requestUndo(ctx, entryStore, t, whenRemote, entry) },
          onExpire: trashId => { entryStore.remove(trashId) },
        }),
      }, function SessionDeleteOverlay(props) {
        const { useEntries, t, undoSeconds, onUndo, onExpire } = props
        const entries = useEntries(value => value)
        return h('div', { className: 'dsw-session-delete-layer' },
          entries.map(entry => h(UndoToast, {
            key: entry.trashId, entry, t, undoSeconds, onUndo, onExpire,
          })))
      }))

      // The menu action itself: red row, ordered after the built-in Archive.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-delete.delete',
        target: 'session',
        order: 700,
        resolve: ({ sessionId }) => [{
          // The running gate is advisory: the Host re-checks and refuses a
          // turn that started after the menu opened; requestDelete surfaces
          // refusals through the shared notice path with localized copy.
          id: 'delete', label: t('menuDelete'), danger: true, afterContent: true, separatorBefore: true,
          run: () => { void requestDelete(ctx, entryStore, t, whenRemote, sessionId) },
        }],
      }), 'session-delete: menu')
    }

    /** Undo window shown in the countdown; the Host enforces the real deadline. */
    function readUndoSeconds() {
      return 5
    }

    /** Minimal observable store for the pending undo entries. */
    function createEntryStore(React) {
      let state = []
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      return {
        useEntries: selector => React.useSyncExternalStore(
          listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
          () => state, () => state),
        add: (entry) => { state = [...state, entry]; emit() },
        remove: (trashId) => {
          const next = state.filter(candidate => candidate.trashId !== trashId)
          if (next.length === state.length) return
          state = next; emit()
        },
        setState: (trashId, patch) => {
          state = state.map(candidate => candidate.trashId === trashId ? { ...candidate, ...patch } : candidate)
          emit()
        },
      }
    }

    /**
     * Session ids deleted in this page whose rows must stay hidden.
     *
     * The Host cannot un-admit a live Session from `session.list()` (its store
     * exposes no per-id removal; the `enter()` disposer belongs to the creating
     * fiber), so a refresh would hand such a row straight back. Remembering the
     * ids here lets every refresh re-apply the public `handleSessionRemoved`
     * removal, which the list manager folds into its in-flight pull mutations.
     */
    const deletedSessionIds = new Set()

    /** Remove `id` from the Session list snapshot through the public relay. */
    function hideRow(sessions, sessionId) {
      if (sessions === undefined) return
      try { sessions.handleSessionRemoved(sessionId) } catch { /* row gone or not present */ }
    }

    /**
     * Re-pull the Session list baseline, then re-apply this page's removals.
     * The sidebar row lives in this list (filtered by workspace membership),
     * not only in the workspace record, so a deleted row lingers without this.
     */
    async function refreshSessionList(ctx) {
      const sessions = ctx.get('sessions')
      if (sessions === undefined) return
      try { await sessions.refresh() } catch { /* baseline pull will catch up later */ }
      for (const sessionId of deletedSessionIds) hideRow(sessions, sessionId)
    }

    async function requestDelete(ctx, entryStore, t, whenRemote, sessionId) {
      try {
        const remote = await whenRemote()
        const result = await remote.delete(sessionId)
        if (!result.ok) {
          notifyRefusal(ctx, t, result, 'deleteFailed')
          return
        }
        const { trashId, title } = result.value
        deletedSessionIds.add(sessionId)
        // Drop the row now, then re-pull: the refresh may still carry the id if
        // the Host keeps the Session resident in memory.
        hideRow(ctx.get('sessions'), sessionId)
        await refreshSessionList(ctx)
        entryStore.add({
          trashId, sessionId, title, undoState: 'waiting',
          createdAt: Date.now(),
          expiresAt: Date.now() + readUndoSeconds() * 1000,
        })
      } catch (error) {
        notifyRefusal(ctx, t, error, 'deleteFailed')
      }
    }

    async function requestUndo(ctx, entryStore, t, whenRemote, entry) {
      entryStore.setState(entry.trashId, { undoState: 'undoing' })
      try {
        const remote = await whenRemote()
        const result = await remote.undo(entry.trashId)
        if (!result.ok) {
          entryStore.setState(entry.trashId, { undoState: 'waiting' })
          notifyRefusal(ctx, t, result, 'undoFailed')
          return
        }
        // Clear the tombstone before refreshing so the restored row reappears.
        if (entry.sessionId !== undefined) deletedSessionIds.delete(entry.sessionId)
        await refreshSessionList(ctx)
        entryStore.remove(entry.trashId)
      } catch (error) {
        entryStore.setState(entry.trashId, { undoState: 'waiting' })
        notifyRefusal(ctx, t, error, 'undoFailed')
      }
    }

    /** Map thrown failures to the same refusal shape (code lives on `code`). */
    function normalizeThrown(error) {
      if (error instanceof Error && typeof error.code === 'string') return { error: { code: error.code, message: error.message } }
      if (error instanceof Error) return { error: { code: undefined, message: error.message } }
      return { error: { code: undefined, message: undefined } }
    }

    function notifyFailure(ctx, message) {
      try { ctx.contextMenus.notify(message) } catch { /* menu closed; nothing to attach to */ }
    }

    // Self-mounted namespace access: the mount resolves the scoped
    // `ctx.inject(['remote.sessionDelete'])` service and request paths await
    // it through `whenRemote`, so this plugin's own inject list never names the
    // key it provides (see the mount comment in apply()).
    // `sessions` lets refreshSessionList re-pull the sidebar's baseline.
    return { inject: ['remote', 'sessions', 'locale', 'slots', 'contextMenus'], apply }
  },
})
