import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CodexAgentManager } from '../electron/codex-agent-manager'
import { setDataDir } from '../electron/server-core/data-dir'

let startCount = 0
let resumeCount = 0

class StaleThread {
  id: string

  constructor(id: string) {
    this.id = id
  }

  async runStreamed() {
    throw new Error('Codex Exec exited with code 1: Reading prompt from stdin... Error: thread/resume: thread/resume failed: no rollout found for thread id stale-thread')
  }
}

class FreshThread {
  id: string

  constructor(id: string) {
    this.id = id
  }

  async runStreamed() {
    const id = this.id
    return {
      events: (async function* () {
        yield { type: 'thread.started', thread_id: id }
        yield { type: 'turn.started' }
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }
      })(),
    }
  }
}

class FakeCodex {
  constructor(_opts: Record<string, unknown>) {}

  resumeThread(id: string) {
    resumeCount++
    return new StaleThread(id)
  }

  startThread() {
    startCount++
    return new FreshThread(`fresh-thread-${startCount}`)
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bat-codex-resume-test-'))
  setDataDir(dataDir)
  try {
    const manager = new CodexAgentManager(() => [], {
      getCodexClass: async () => FakeCodex,
      findCodexBinary: () => process.execPath,
    })

    const resumed = await manager.resumeSession(
      'codex-test-session',
      'stale-thread',
      process.cwd(),
      'gpt-5.5',
      'workspace-write',
      'on-request'
    )
    assert.strictEqual(resumed, true)

    const sent = await manager.sendMessage('codex-test-session', 'hello')
    assert.strictEqual(sent, true)
    assert.strictEqual(resumeCount, 1)
    assert.strictEqual(startCount, 1)

    const meta = manager.getSessionMeta('codex-test-session')
    assert.strictEqual(meta?.sdkSessionId, 'fresh-thread-1')

    const state = manager.getSessionState('codex-test-session')
    const userMessages = state?.messages.filter(message => message.role === 'user') || []
    assert.strictEqual(userMessages.length, 1)
    assert.strictEqual(userMessages[0].content, 'hello')

    console.log('Codex stale resume fallback: passed')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack || err.message : String(err))
  process.exit(1)
})
