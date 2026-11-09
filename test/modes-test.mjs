// 工作流 / 短期目标: the store, the route actions, and the per-agent prompt
// sections the composer chips switch.
//
// The point of these tests is the split the feature exists for: definitions are
// global, the PICK is per session, and the injected text follows the pick — not
// the other way round. A goal has no default at all, which is checked explicitly
// because "no goal" must cost zero prompt bytes.

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'umem-modes-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

const dir = join(home, 'memory')
const request = (payload) => ({ json: async () => payload })

// One record per agent: the two sections it was given, and the text each would
// inject RIGHT NOW (the closures read the live pick).
const sections = new Map()
const sectionText = (agent, name) => {
  const list = sections.get(agent) || []
  const hit = list.find((entry) => entry.name === name)
  return hit === undefined ? null : hit.text()
}

const makeAgent = (id, log) => {
  const agent = { id, session: { id }, ctx: null }
  agent.ctx = {
    inject(services, cb) {
      cb({
        systemPrompt: {
          section(def) {
            const list = sections.get(agent) || []
            list.push(def)
            sections.set(agent, list)
            return () => {}
          },
        },
      })
      return { dispose() { if (Array.isArray(log)) log.push(1) } }
    },
  }
  return agent
}

const disposed = []
const agentA = makeAgent('sess-a', disposed)
const agentB = makeAgent('sess-b')
const handlers = new Map()
let route = null
const box = { tools: [], disposers: [] }

const ctx = {
  logger: { info() {}, warn() {} },
  effect(fn) {
    box.disposers.push(fn())
  },
  systemPrompt: { section() { return () => {} } },
  tools: { register(def) { box.tools.push(def); return () => {} } },
  agents: { list: () => [agentA] },
  on(event, handler) {
    handlers.set(event, handler)
    return () => {}
  },
  inject(services, cb) {
    cb({
      get(name) {
        if (name === 'connection') {
          return { fetch: { register(def) { route = def; return () => {} } } }
        }
        if (name === 'tools') return { register(def) { box.tools.push(def); return () => {} } }
        return undefined
      },
      effect(fn) { box.disposers.push(fn()) },
    })
    return () => {}
  },
}

await apply(ctx, { tempMemory: false })
const call = async (payload) => await (await route.fetch(request(payload))).json()

let failed = 0
const check = (label, ok, detail) => {
  if (ok) console.log('PASS  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
  else {
    failed += 1
    console.log('FAIL  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
  }
}

// ---------- storage ---------------------------------------------------------
check('modes: the memory scaffold is still exactly five files', (await readdir(dir)).length === 5, await readdir(dir))
check('modes: no modes.json before the first save', !(await readdir(dir)).includes('modes.json'))

const empty = await call({ action: 'modesLoad' })
check('modes: an empty store reports empty lists and no default', empty.ok && empty.workflows.length === 0 && empty.goals.length === 0 && empty.defaultWorkflow === '')

// ---------- authoring -------------------------------------------------------
const savedFlow = await call({
  action: 'modeSave',
  kind: 'workflow',
  name: '硬件模块验证',
  body: '一次只推进一个模块。先给约束与验收判据，再给最小 demo。',
})
check('modes: a workflow is created and echoed back', savedFlow.ok && savedFlow.workflows.length === 1 && typeof savedFlow.id === 'string', savedFlow.id)
const flowId = savedFlow.id
check('modes: modes.json exists after the first save', (await readdir(dir)).includes('modes.json'))
check('modes: the file is valid JSON on disk', JSON.parse(await readFile(join(dir, 'modes.json'), 'utf8')).workflows.length === 1)

const savedGoal = await call({
  action: 'modeSave',
  kind: 'goal',
  name: '光电赛 A 题',
  body: '本届光电设计大赛 A 题：光照测量与分级报警，宿舍条件验证。',
})
check('modes: a goal is created', savedGoal.ok && savedGoal.goals.length === 1)
const goalId = savedGoal.id

const tooLong = await call({ action: 'modeSave', kind: 'workflow', name: 'x', body: 'y'.repeat(12001) })
check('modes: an over-long body is refused', tooLong.ok === false && tooLong.error.includes('过长'))
const blank = await call({ action: 'modeSave', kind: 'goal', name: '  ', body: 'x' })
check('modes: an empty name is refused', blank.ok === false)

const edited = await call({
  action: 'modeSave',
  kind: 'workflow',
  id: flowId,
  name: '硬件模块验证（改）',
  body: '一次只推进一个模块，用户自己接线，AI 只给最小 demo。',
})
check('modes: editing keeps the id and replaces the body', edited.ok && edited.workflows[0].id === flowId && edited.workflows[0].name.includes('改'))

// ---------- per-session picks ----------------------------------------------
check('modes: agent A gets exactly the two sections', (sections.get(agentA) || []).map((s) => s.name).join(',') === 'user-memory-workflow,user-memory-goal', (sections.get(agentA) || []).map((s) => s.name))
const flowSection = (sections.get(agentA) || []).find((s) => s.name === 'user-memory-workflow')
const goalSection = (sections.get(agentA) || []).find((s) => s.name === 'user-memory-goal')
check('modes: the sections sit between memory (-500) and persona (0)', flowSection.order === -485 && goalSection.order === -480)
check('modes: nothing is injected before any pick or default', sectionText(agentA, 'user-memory-workflow') === '' && sectionText(agentA, 'user-memory-goal') === '')

const picked = await call({ action: 'sessionMode', sessionId: 'sess-a', kind: 'workflow', id: flowId })
check('modes: a session pick is stored', picked.ok && picked.session.workflow === flowId && picked.selected.workflowName === '硬件模块验证（改）', picked.session)
check('modes: the pick reaches this agent only', sectionText(agentA, 'user-memory-workflow').includes('硬件模块验证（改）') && (sectionText(agentB, 'user-memory-workflow') ?? '') === '')
check('modes: the injected block is a heading plus the body', sectionText(agentA, 'user-memory-workflow').startsWith('## 当前工作流：硬件模块验证（改）\n\n'))

const pickedGoal = await call({ action: 'sessionMode', sessionId: 'sess-a', kind: 'goal', id: goalId })
check('modes: the goal pick is stored and injected', pickedGoal.session.goal === goalId && sectionText(agentA, 'user-memory-goal').includes('光电赛 A 题'))

// A second conversation created later sees the default and no goal.
handlers.get('agent/created')({ agent: agentB })
check('modes: a new agent is installed on agent/created', (sections.get(agentB) || []).length === 2)

// Default: explicitly chosen by the user, applied to sessions that never picked.
const asDefault = await call({ action: 'modeDefault', id: flowId })
check('modes: a default workflow is stored', asDefault.ok && asDefault.defaultWorkflow === flowId)
check('modes: the default reaches a session with no pick', sectionText(agentB, 'user-memory-workflow').includes('硬件模块验证（改）'))
check('modes: the default never creates a goal', sectionText(agentB, 'user-memory-goal') === '')

const noDefault = await call({ action: 'modeDefault', id: '' })
check('modes: the default can be cleared', noDefault.ok && noDefault.defaultWorkflow === '' && sectionText(agentB, 'user-memory-workflow') === '')

// Explicit off beats the default; that is the whole reason the sentinel exists.
await call({ action: 'modeDefault', id: flowId })
await call({ action: 'sessionMode', sessionId: 'sess-a', kind: 'workflow', id: '__none__' })
check('modes: an explicit "none" beats the default', sectionText(agentA, 'user-memory-workflow') === '')
await call({ action: 'sessionMode', sessionId: 'sess-a', kind: 'workflow', id: '' })
check('modes: "" goes back to following the default', sectionText(agentA, 'user-memory-workflow').includes('硬件模块验证（改）'))

await call({ action: 'sessionMode', sessionId: 'sess-a', kind: 'goal', id: '__none__' })
check('modes: a goal can be turned off explicitly too', sectionText(agentA, 'user-memory-goal') === '')

// ---------- deletion --------------------------------------------------------
const removed = await call({ action: 'modeDelete', kind: 'workflow', id: flowId })
check('modes: deleting a workflow clears it from the default', removed.ok && removed.defaultWorkflow === '' && removed.workflows.length === 0)
check('modes: and no longer injects on any agent', sectionText(agentA, 'user-memory-workflow') === '' && sectionText(agentB, 'user-memory-workflow') === '')
check('modes: the goal is untouched', removed.goals.length === 1 && removed.goals[0].id === goalId)

const badKind = await call({ action: 'modeSave', kind: 'other', name: 'x', body: 'y' })
check('modes: an unknown kind is refused', badKind.ok === false)
const missing = await call({ action: 'sessionMode', sessionId: 'sess-a', kind: 'workflow', id: 'nope' })
check('modes: picking a missing mode is refused', missing.ok === false)

// ---------- disposal --------------------------------------------------------
handlers.get('agent/disposed')({ agent: agentA })
check('modes: agent/disposed cleans its sections up', disposed.length === 1)

await rm(home, { recursive: true, force: true })
if (failed > 0) {
  console.log('\n' + failed + ' FAILED')
  process.exit(1)
}
console.log('\nALL PASS')
