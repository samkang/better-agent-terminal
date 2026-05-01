import * as assert from 'assert'
import { ClaudeAgentManager } from '../electron/claude-agent-manager.ts'

type SentEvent = {
  channel: string
  args: unknown[]
}

function makeWindow(events: SentEvent[]) {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        events.push({ channel, args })
      },
    },
  }
}

async function main() {
  const remoteEvents: SentEvent[] = []
  const localEvents: SentEvent[] = []
  const remoteWindow = makeWindow(remoteEvents)
  const localWindow = makeWindow(localEvents)

  const manager = new ClaudeAgentManager(
    () => [remoteWindow as never, localWindow as never],
    profileId => profileId === 'remote-profile' ? [remoteWindow as never] : profileId === 'local-profile' ? [localWindow as never] : []
  )

  const started = await manager.startSession('scope-test-session', {
    cwd: process.cwd(),
    ownerProfileId: 'remote-profile',
  })
  assert.strictEqual(started, true)
  assert.ok(remoteEvents.some(event => event.channel === 'claude:message'), 'remote profile should receive session events')
  assert.strictEqual(localEvents.length, 0, 'unrelated local windows must not receive remote session events')

  remoteEvents.length = 0
  localEvents.length = 0

  const reset = await manager.resetSession('scope-test-session')
  assert.strictEqual(reset, true)
  assert.ok(
    remoteEvents.some(event => event.channel === 'claude:session-reset' && event.args[0] === 'scope-test-session'),
    'remote profile should receive reset events'
  )
  assert.strictEqual(localEvents.length, 0, 'reset events must stay scoped to the owning profile')

  console.log('Claude session window scope: passed')
  process.exit(0)
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack || err.message : String(err))
  process.exit(1)
})
