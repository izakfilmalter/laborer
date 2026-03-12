export const LaborerHookPlugin = async () => {
  const terminalId = process.env.LABORER_TERMINAL_ID
  const hookUrl = process.env.LABORER_HOOK_URL
  if (!(terminalId && hookUrl)) {
    return {}
  }

  const children = new Set()

  const post = async (event) => {
    try {
      await fetch(hookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminalId, event }),
      })
    } catch {}
  }

  return {
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        if (event.properties.info.parentID) {
          children.add(event.properties.info.id)
        } else {
          await post('active')
        }
        return
      }

      if (event.type === 'session.status') {
        const sid = event.properties.sessionID
        if (children.has(sid)) {
          return
        }
        if (event.properties.status.type === 'busy') {
          await post('active')
        } else if (event.properties.status.type === 'idle') {
          await post('waiting_for_input')
        }
        return
      }

      if (event.type === 'session.error') {
        const sid = event.properties.sessionID
        if (sid && children.has(sid)) {
          return
        }
        await post('waiting_for_input')
      }
    },
  }
}
