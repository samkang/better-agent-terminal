/**
 * Run: pnpm exec tsx tests/web-channel-name.test.ts
 */
import * as assert from 'assert'
import { toChannelName } from '../src/web/channel-name'

let passed = 0, failed = 0
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${(e as Error).message}`) }
}

console.log('toChannelName')
test('namespace + camelCase method → kebab', () => {
  assert.strictEqual(toChannelName('pty', 'getCwd'), 'pty:get-cwd')
})
test('namespace + single-word method → unchanged method', () => {
  assert.strictEqual(toChannelName('pty', 'write'), 'pty:write')
})
test('namespace + multi-cap acronym method', () => {
  assert.strictEqual(toChannelName('claude', 'getCliPath'), 'claude:get-cli-path')
})
test('claude.startSession → claude:start-session', () => {
  assert.strictEqual(toChannelName('claude', 'startSession'), 'claude:start-session')
})
test('settings.detectCx → settings:detect-cx', () => {
  assert.strictEqual(toChannelName('settings', 'detectCx'), 'settings:detect-cx')
})
test('image.readAsDataUrl → image:read-as-data-url', () => {
  assert.strictEqual(toChannelName('image', 'readAsDataUrl'), 'image:read-as-data-url')
})
test('snippet.getAll preserves all-lower → snippet:getAll? no, kebab', () => {
  // existing channel is 'snippet:getAll' (camelCase preserved). The codebase is
  // inconsistent. We choose: ALWAYS kebab. Document the exceptions in stubs.ts
  // if they break.
  assert.strictEqual(toChannelName('snippet', 'getAll'), 'snippet:get-all')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
