/* Native DSH client module. Business logic stays in client-core.js. */
window.__ModuleLoader__.load({
  id: 'dsh-chat-prune',
  factory: (require) => {
    const React = require('react')
    const SLOT = 'sidebar.workspaces.session.row.action'
    const MANAGER_SLOT = 'sidebar.footer.action'

    function ManageConversations({ wide }) {
      const isChinese = !navigator.language || /^zh/i.test(navigator.language)
      const label = isChinese ? '管理对话' : 'Manage conversations'
      return React.createElement('button', {
        type: 'button', className: 'dshdc-sidebar-manage',
        'aria-label': label, title: label, 'aria-haspopup': 'dialog',
        onClick: () => window.dshChatPrune?.openManager(),
      }, React.createElement('svg', {
        viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }, React.createElement('path', { d: 'M4 5h16v12H9l-5 4V5Zm4 4h8M8 13h5' })),
      wide ? React.createElement('span', null, label) : null)
    }

    function DeleteSessionAction({ sessionId }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const isChinese = !navigator.language || /^zh/i.test(navigator.language)
      const label = isChinese ? '删除对话' : 'Delete conversation'
      return React.createElement('button', {
        type: 'button',
        className: 'dshdc-native-del',
        'aria-label': error || label,
        title: error || label,
        disabled: busy,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, padding: 0, border: 0, borderRadius: 5,
          background: 'transparent', color: 'inherit', cursor: 'pointer',
        },
        onPointerDown: (event) => event.stopPropagation(),
        onClick: async (event) => {
          event.preventDefault()
          event.stopPropagation()
          const button = event.currentTarget
          const client = window.dshChatPrune
          if (!client?.requestDelete) {
            setError(isChinese ? '删除插件尚未就绪，请重新加载界面' : 'Reload the interface to initialize deletion')
            return
          }
          setBusy(true)
          try {
            await client.requestDelete(sessionId, button)
          } finally {
            setBusy(false)
          }
        },
      }, React.createElement('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true,
      }, React.createElement('path', {
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        d: 'M3 4.5h10M6 4.5V2.5h4v2M4.5 4.5l.7 9h5.6l.7-9M7 7v4M9 7v4',
      })))
    }

    function apply(ctx) {
      const refreshSessions = async (deletedId) => {
        await ctx.sessions.refresh()
        // refresh() may have joined a pull that started before the deletion.
        if (deletedId && ctx.sessions.list.getSnapshot().byId[deletedId]) {
          await ctx.sessions.refresh()
          if (ctx.sessions.list.getSnapshot().byId[deletedId]) {
            throw new Error('Session list still contains the deleted conversation')
          }
        }
      }
      ctx.effect(() => {
        let disposed = false
        let retryTimer
        const refreshAtStartup = async (attempt = 0) => {
          try {
            await refreshSessions()
            // The host can publish an error snapshot without rejecting refresh().
            const snapshot = ctx.sessions.list.getSnapshot()
            if (snapshot.state === 'error') {
              throw snapshot.error || new Error('Session catalog is not ready')
            }
          } catch (error) {
            if (disposed) return
            if (attempt < 6) {
              retryTimer = setTimeout(() => refreshAtStartup(attempt + 1), 800 * (attempt + 1))
            } else {
              console.warn('[dsh-chat-prune] Startup session refresh failed', error)
            }
          }
        }
        window.__dshChatPruneRefreshSessions__ = refreshSessions
        // Run after client services finish applying, independently of the manager.
        retryTimer = setTimeout(() => refreshAtStartup(), 0)
        return () => {
          disposed = true
          clearTimeout(retryTimer)
          if (window.__dshChatPruneRefreshSessions__ === refreshSessions) {
            delete window.__dshChatPruneRefreshSessions__
          }
        }
      })
      ctx.slots.inject(SLOT, () => {
        const dispose = ctx.slots.register({
          name: SLOT,
          id: 'dsh-chat-prune.delete',
          order: 300,
        }, DeleteSessionAction)
        window.__dshChatPruneNativeSlotReady__ = true
        window.dshChatPrune?.reportNativeReady?.()
        document.querySelector('.dshdc-del')?.setAttribute('data-dshdc-visible', '0')
        return () => {
          window.__dshChatPruneNativeSlotReady__ = false
          dispose()
        }
      })
      ctx.slots.inject(MANAGER_SLOT, () => {
        const dispose = ctx.slots.register({
          name: MANAGER_SLOT, id: 'dsh-chat-prune.manage', order: 200,
        }, ManageConversations)
        window.__dshChatPruneManagerSlotReady__ = true
        document.getElementById?.('dshdc-manage')?.setAttribute('hidden', '')
        return () => {
          window.__dshChatPruneManagerSlotReady__ = false
          document.getElementById?.('dshdc-manage')?.removeAttribute('hidden')
          dispose()
        }
      })
    }

    return { name: 'dsh-chat-prune', inject: ['slots', 'sessions'], apply }
  },
})
