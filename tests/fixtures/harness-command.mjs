// Test-only command driver; use a normally created UI conversation.
// Never append synthetic turn events: native session persistence owns their order.
import { randomUUID } from 'node:crypto'
export const inject = ['commands', 'tools', 'cliworker']
export async function apply(ctx) {
  ctx.commands.register({
    definitionId: 'cliworker-test-driver',
    name: 'worker-test',
    description: 'TEST ONLY: exercise real CLI Worker tool',
    input: { hint: '<task>' },
    handler: async (invocation) => {
      const tool = ctx.tools.get('cliworker_start')
      const controller = new AbortController()
      try {
        const receipt = await tool.execute(
          {
            title: '真实侧栏验收',
            prompt: invocation.rawInput || 'Reply CLIWORKER_UI_OK only. Do not change files.',
          },
          {
            agent: invocation.agent,
            signal: controller.signal,
            callId: randomUUID(),
            name: 'cliworker_start',
            arguments: {},
            deferContext() {},
            concludeTurn() {},
          },
        )
        return { kind: 'success', text: `Test driver submitted real tool: ${receipt}` }
      } catch (error) {
        return { kind: 'error', text: String(error) }
      }
    },
  })
}
