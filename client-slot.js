/* Native DSH client module. Business logic stays in client-core.js. */
window.__ModuleLoader__.load({
  id: 'dsh-delete-chat',
  factory: (require) => {
    const React = require('react')
    const SLOT = 'sidebar.workspaces.session.row.action'

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
          const client = window.dshDeleteChat
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
        window.__dshDeleteChatRefreshSessions__ = refreshSessions
        return () => {
          if (window.__dshDeleteChatRefreshSessions__ === refreshSessions) {
            delete window.__dshDeleteChatRefreshSessions__
          }
        }
      })
      ctx.slots.inject(SLOT, () => {
        const dispose = ctx.slots.register({
          name: SLOT,
          id: 'dsh-delete-chat.delete',
          order: 300,
        }, DeleteSessionAction)
        window.__dshDeleteChatNativeSlotReady__ = true
        window.dshDeleteChat?.reportNativeReady?.()
        document.querySelector('.dshdc-del')?.setAttribute('data-dshdc-visible', '0')
        return () => {
          window.__dshDeleteChatNativeSlotReady__ = false
          dispose()
        }
      })
    }

    return { name: 'dsh-delete-chat', inject: ['slots', 'sessions'], apply }
  },
})
