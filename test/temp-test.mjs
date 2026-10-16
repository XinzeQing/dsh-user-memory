// Self-test for the 临时记忆 (temporary working set) layer.
// Run:  node test/temp-test.mjs
//
// Same fake-context approach as selftest.mjs, with two deliberate differences:
//  - it captures EVERY registered section rather than the last one, because the
//    whole point of this layer is that it is a SECOND section;
//  - every phase gets a throwaway $DSH_HOME. That is not cosmetic: the store is
//    GLOBAL on purpose (cross-conversation), so two ctx objects sharing one home
//    would share one working set — which is exactly the property the last phase
//    tests on purpose.
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const realHome = process.env.DSH_HOME
let home = await mkdtemp(join(tmpdir(), 'umhome-'))
const useHome = async () => {
  home = await mkdtemp(join(tmpdir(), 'umhome-'))
  process.env.DSH_HOME = home
  return home
}
process.env.DSH_HOME = home

let failures = 0
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failures += 1
}

function makeCtx() {
  const box = { sections: [], disposers: [], route: null, tools: [] }
  const ctx = {
    logger: { info: () => {}, warn: (m) => console.log('[warn]', m) },
    effect(fn) {
      box.disposers.push(fn())
    },
    systemPrompt: {
      section(section) {
        box.sections.push(section)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        box.tools.push(definition)
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    inject(services, cb) {
      cb({
        get(name) {
          if (name === 'connection') {
            return {
              fetch: {
                register(definition) {
                  box.route = definition
                  return () => {}
                },
              },
            }
          }
          if (name === 'tools') {
            return {
              register(definition) {
                box.tools.push(definition)
                return () => {}
              },
            }
          }
          return undefined
        },
        effect(fn) {
          box.disposers.push(fn())
        },
      })
    },
  }
  return { ctx, box }
}

const request = (payload) => ({ json: async () => payload })
const settle = () => new Promise((r) => setTimeout(r, 3400))
const tool = (box, name) => box.tools.find((definition) => definition.name === name)
const block = (box, name) => {
  const section = box.sections.find((entry) => entry.name === name)
  return section === undefined ? '' : section.text()
}
const storeOf = async () => JSON.parse(await readFile(join(home, 'temp-memory.json'), 'utf8'))
const hasStore = async () => (await readdir(home)).includes('temp-memory.json')
const posted = async (route, payload) => (await route.fetch(request(payload))).json()

// ---------- 1. 默认关闭：和 0.6.0 逐字节一致 ----------
const dir1 = await mkdtemp(join(tmpdir(), 'um-'))
await useHome()
const off = makeCtx()
await apply(off.ctx, { dir: dir1 })
check(
  'default: exactly one section (the long-term one)',
  off.box.sections.length === 1 && off.box.sections[0].name === 'user-memory',
  off.box.sections.map((s) => s.name).join(','),
)
check(
  'default: no temp tools registered',
  tool(off.box, 'temp_memory') === undefined && tool(off.box, 'temp_memory_done') === undefined,
)
check('default: the long-term tools are still there', off.box.tools.length === 2, String(off.box.tools.length))
check('default: no store file appears behind the user', (await hasStore()) === false)

// ---------- 2. 打开：多出的一节，名字/顺序/工具都对 ----------
const on = makeCtx()
await apply(on.ctx, { dir: dir1, tempMemory: true })
const tempSection = on.box.sections.find((entry) => entry.name === 'user-memory-temp')
check(
  'on: two sections, long-term first',
  on.box.sections.length === 2 && on.box.sections[0].name === 'user-memory',
  on.box.sections.map((s) => s.name).join(','),
)
check('on: temp section order sits just below the long-term block', tempSection.order === -490)
check('on: temp section text is a provider fn', typeof tempSection.text === 'function')
check(
  'on: both temp tools registered',
  ['temp_memory', 'temp_memory_done'].every((name) => tool(on.box, name) !== undefined),
  on.box.tools.map((d) => d.name).join(','),
)
check('on: an empty working set injects nothing at all', block(on.box, 'user-memory-temp') === '')
check('on: mounting the plugin does not create the store', (await hasStore()) === false)

// ---------- 3. 写入工具：下一步的上下文里立刻出现 ----------
const write = await tool(on.box, 'temp_memory').execute({
  kind: 'handoff',
  title: '把夹具改完交给下一轮',
  body: '目标：换掉夹具。\n现状：改到一半。\n下一步：跑 temp-test。',
})
check('tool: returns a string id and the new count', write.id === '1' && write.open === 1, JSON.stringify(write))
const injected = block(on.box, 'user-memory-temp')
check('inject: the block header is present', injected.includes('## 临时记忆（活跃工作集）'))
check('inject: heading carries kind and id', injected.includes('### [交接 #1] 把夹具改完交给下一轮'))
check('inject: the body is injected verbatim', injected.includes('下一步：跑 temp-test。'))
check(
  'inject: the long-term block is untouched by it',
  block(on.box, 'user-memory') === block(off.box, 'user-memory') && block(on.box, 'user-memory').length > 0,
)
check(
  'inject: it lives in $DSH_HOME, not in the memory dir',
  (await hasStore()) && !(await readdir(dir1)).includes('temp-memory.json'),
  (await readdir(dir1)).join(','),
)

// ---------- 4. 写入门槛写在工具描述里 ----------
const desc = tool(on.box, 'temp_memory').description
check('gate: description硬编码「只在用户明确要求时调用」', desc.includes('只在用户明确要求时调用'))
check(
  'gate: description forbids self-initiated writes',
  desc.includes('一律不要调用') && desc.includes('不要自动总结'),
)
check(
  'gate: the three kinds are advertised with their meaning',
  desc.includes('handoff=交接') && desc.includes('stage=阶段目标') && desc.includes('waiting=等待项'),
)
check(
  'gate: kind is an enum in the schema',
  JSON.stringify(tool(on.box, 'temp_memory').parameters.properties.kind.enum) ===
    JSON.stringify(['handoff', 'stage', 'waiting']),
)

const refusal = async (args) => {
  try {
    await tool(on.box, 'temp_memory').execute(args)
    return '(no error)'
  } catch (error) {
    return String(error.message)
  }
}
check('gate: an unknown kind is refused', (await refusal({ kind: 'note', title: 'x', body: 'y' })).includes('不允许的条目类型'))
check('gate: an empty title is refused', (await refusal({ kind: 'stage', title: '   ', body: 'y' })).includes('标题不能为空'))
check('gate: an empty body is refused', (await refusal({ kind: 'stage', title: 'x', body: '  ' })).includes('正文不能为空'))

// ---------- 5. 完成即清理，但数据留着 ----------
const done = await tool(on.box, 'temp_memory_done').execute({
  id: '1',
  note: '夹具已交下一轮，落点 test/temp-test.mjs',
})
check('done: reports the archive', done.id === '1' && done.status === 'done' && done.open === 0, JSON.stringify(done))
check('done: the block is EMPTY again', block(on.box, 'user-memory-temp') === '', JSON.stringify(block(on.box, 'user-memory-temp')))
const archived = (await storeOf()).items[0]
check('done: the entry survives on disk as an archive', archived.status === 'done' && typeof archived.doneAt === 'string')
check('done: the note is kept as the 结果 line', archived.note.includes('落点 test/temp-test.mjs'))
const missing = await (async () => {
  try {
    await tool(on.box, 'temp_memory_done').execute({ id: '99' })
    return '(no error)'
  } catch (error) {
    return String(error.message)
  }
})()
check('done: an unknown id is refused', missing.includes('找不到临时记忆 #99'), missing)

// ---------- 6. 等待项：常量的那段提醒 ----------
const waiting = await tool(on.box, 'temp_memory').execute({
  kind: 'waiting',
  title: '等 CI 绿了再打 tag',
  body: '等什么：CI 跑完。\n条件满足后：打 tag 并通知。',
})
check('waiting: ids continue across a reload', waiting.id === '2', JSON.stringify(waiting))
const withWaiting = block(on.box, 'user-memory-temp')
check('waiting: the notice is appended while one is open', withWaiting.includes('### 等待项'))
check('waiting: the notice tells the model to archive, not to ask again', withWaiting.includes('temp_memory_done'))
await tool(on.box, 'temp_memory_done').execute({ id: '2', note: '已打 tag。' })
check(
  'waiting: the notice goes away with the last waiting entry',
  !block(on.box, 'user-memory-temp').includes('### 等待项'),
)
check('waiting: stored kind is preserved for the panel', (await storeOf()).items[1].kind === 'waiting')

// ---------- 7. 预算：独立、最新优先、超出的只点名不半截注入 ----------
const dir2 = await mkdtemp(join(tmpdir(), 'um-'))
await useHome()
const bud = makeCtx()
await apply(bud.ctx, { dir: dir2, tempMemory: true, tempMaxChars: 320, maxChars: 400 })
const t = tool(bud.box, 'temp_memory')
await t.execute({ kind: 'stage', title: '小条目一', body: '短正文一。' })
await t.execute({ kind: 'handoff', title: '大条目', body: '长正文。'.repeat(120) })
await t.execute({ kind: 'waiting', title: '小条目三', body: '短正文三。' })
const capped = block(bud.box, 'user-memory-temp')
check('budget: newest entry first', capped.indexOf('小条目三') < capped.indexOf('小条目一'))
check('budget: an oversized entry is NOT half-injected', !capped.includes('长正文。'.repeat(20)))
check('budget: the skipped entry is named in the note', capped.includes('#2') && capped.includes('没有注入'))
check('budget: the note points at the store', capped.includes('temp-memory.json') && capped.includes('全文见'))
check('budget: the block does not blow past its own budget', capped.length <= 320 + 200, `len=${capped.length}`)
check(
  'budget: the long-term block is not billed for it',
  block(bud.box, 'user-memory').length <= 400 && block(bud.box, 'user-memory').includes('必须遵守'),
)
// A budget too small to hold anything degrades to silence, not to a broken block.
const tiny = makeCtx()
await apply(tiny.ctx, { dir: dir2, tempMemory: true, tempMaxChars: 40 })
check('budget: a 40-char budget injects nothing at all', block(tiny.box, 'user-memory-temp') === '')

// ---------- 8. 归档不是无限增长 ----------
await useHome()
const dir3 = await mkdtemp(join(tmpdir(), 'um-'))
const grow = makeCtx()
await apply(grow.ctx, { dir: dir3, tempMemory: true })
const gTool = tool(grow.box, 'temp_memory')
const gDone = tool(grow.box, 'temp_memory_done')
for (let i = 0; i < 25; i += 1) {
  const created = await gTool.execute({ kind: 'stage', title: `第 ${i + 1} 条`, body: `正文 ${i + 1}` })
  await gDone.execute({ id: created.id, note: 'done' })
}
const grown = (await storeOf()).items
check('prune: finished entries are capped at 20', grown.length === 20, String(grown.length))
check('prune: the newest archive survives', grown[grown.length - 1].title === '第 25 条', grown[grown.length - 1].title)
check('prune: only finished entries are ever dropped', grown.every((item) => item.status === 'done'))
// …and an open entry is immortal, however many archives pile up.
await gTool.execute({ kind: 'stage', title: '还没做完的一条', body: '正文。' })
for (let i = 0; i < 25; i += 1) {
  const created = await gTool.execute({ kind: 'stage', title: `后补 ${i + 1}`, body: `正文 ${i + 1}` })
  await gDone.execute({ id: created.id, note: 'done' })
}
const regrown = (await storeOf()).items
check(
  'prune: the open entry survives 25 more archives',
  regrown.some((item) => item.title === '还没做完的一条') && regrown.filter((i) => i.status === 'done').length === 20,
  `${regrown.length} total`,
)

// ---------- 9. 面板路由 ----------
await useHome()
const dir4 = await mkdtemp(join(tmpdir(), 'um-'))
const panel = makeCtx()
await apply(panel.ctx, { dir: dir4, tempMemory: true })
const route = panel.box.route
check('route: the same untouched endpoint is reused', route.path === '/api/dsh-user-memory')

const loaded = await posted(route, { action: 'tempLoad' })
check(
  'tempLoad: ok + path + enabled',
  loaded.ok === true && loaded.enabled === true && loaded.path.endsWith('temp-memory.json'),
  JSON.stringify(loaded.path),
)
check('tempLoad: starts empty', Array.isArray(loaded.items) && loaded.items.length === 0 && loaded.open === 0)

const saved = await posted(route, { action: 'tempSave', kind: 'handoff', title: '面板新增的一条', body: '正文：面板写的。' })
check('tempSave: creates with a fresh id', saved.ok === true && saved.id === '1' && saved.open === 1, JSON.stringify(saved.id))
check('tempSave: it is injected right away, no poll', block(panel.box, 'user-memory-temp').includes('面板新增的一条'))

const edited = await posted(route, { action: 'tempSave', id: '1', kind: 'stage', title: '面板改过的一条', body: '正文：改过。' })
check('tempSave: edits in place, no new id', edited.ok === true && edited.items.length === 1 && edited.id === '1')
check('tempSave: the edit is injected right away', block(panel.box, 'user-memory-temp').includes('面板改过的一条'))
check('tempSave: kind is editable', edited.items[0].kind === 'stage')

const badKind = await posted(route, { action: 'tempSave', kind: 'nope', title: 'x', body: 'y' })
check('tempSave: refuses an unknown kind', badKind.ok === false, badKind.error)
const badTitle = await posted(route, { action: 'tempSave', kind: 'stage', title: '  ', body: 'y' })
check('tempSave: refuses an empty title', badTitle.ok === false, badTitle.error)
const badBody = await posted(route, { action: 'tempSave', kind: 'stage', title: 'x', body: 5 })
check('tempSave: refuses a non-string body', badBody.ok === false, badBody.error)
const noSuch = await posted(route, { action: 'tempSave', id: '77', kind: 'stage', title: 'x', body: 'y' })
check('tempSave: refuses an unknown id', noSuch.ok === false, noSuch.error)

const flipped = await posted(route, { action: 'tempDone', id: '1' })
check('tempDone: archives and empties the block', flipped.ok === true && flipped.open === 0 && block(panel.box, 'user-memory-temp') === '')
const back = await posted(route, { action: 'tempDone', id: '1', done: false })
check(
  'tempDone: restores to active',
  back.ok === true && back.status === 'open' && block(panel.box, 'user-memory-temp').includes('面板改过的一条'),
)
check('tempDone: a restored entry loses its doneAt', (await storeOf()).items.every((item) => item.doneAt === undefined))

const gone = await posted(route, { action: 'tempDelete', id: '1' })
check('tempDelete: removes it from disk', gone.ok === true && gone.items.length === 0)
const goneAgain = await posted(route, { action: 'tempDelete', id: '1' })
check('tempDelete: a second delete is a clean refusal', goneAgain.ok === false)

const toClean = await posted(route, { action: 'tempSave', kind: 'stage', title: '清理目标', body: '正文。' })
await posted(route, { action: 'tempDone', id: toClean.id })
const cleaned = await posted(route, { action: 'tempCleanup' })
check(
  'tempCleanup: drops every archived entry',
  cleaned.ok === true && cleaned.removed === 1 && cleaned.items.length === 0,
  JSON.stringify(cleaned.removed),
)

// A disabled plugin must refuse the panel's temp actions rather than pretend.
const beforeCount = (await storeOf()).items.length
const offPanel = makeCtx()
await apply(offPanel.ctx, { dir: dir4 })
const offRoute = offPanel.box.route
const refusedSave = await posted(offRoute, { action: 'tempSave', kind: 'stage', title: 'x', body: 'y' })
check('disabled: tempSave is refused', refusedSave.ok === false, refusedSave.error)
const offLoad = await posted(offRoute, { action: 'tempLoad' })
check('disabled: tempLoad still answers, and says it is off', offLoad.ok === true && offLoad.enabled === false)
check('disabled: the refused write left the store alone', (await storeOf()).items.length === beforeCount)

// ---------- 10. 跨对话：另一个会话（新的 apply）直接看到同一条 ----------
const handoff = await posted(route, { action: 'tempSave', kind: 'handoff', title: '换会话接着做', body: '现状：写完了插件，还没跑测试。' })
const other = makeCtx()
await apply(other.ctx, { dir: dir4, tempMemory: true })
check(
  'handoff: a second session sees the entry without being told',
  block(other.box, 'user-memory-temp').includes('换会话接着做'),
)
check(
  'handoff: and it is the SAME store, so cleanup is shared',
  block(other.box, 'user-memory-temp').includes('还没跑测试'),
)
await tool(other.box, 'temp_memory_done').execute({ id: handoff.id, note: '在另一个会话里做完并归档。' })
check('handoff: the archiving session sees an empty block', block(other.box, 'user-memory-temp') === '')
check(
  'handoff: the archive is on disk, so the next process inherits it as done',
  (await storeOf()).items.find((item) => item.id === handoff.id).status === 'done',
)

// ---------- 11. 已知边界：磁盘上的外部改动，运行中不生效 ----------
// The store is authoritative in the process that owns it (one harness process
// hosts every conversation, so that is the normal case). A hand edit, or a second
// process on the same $DSH_HOME, lands at the next start — the panel is the
// supported editor. These two checks pin that boundary rather than assume it.
await writeFile(
  join(home, 'temp-memory.json'),
  JSON.stringify(
    {
      nextId: 9,
      items: [
        {
          id: '8',
          kind: 'stage',
          title: '外部写入的阶段目标',
          body: '正文：外部写的。',
          status: 'open',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    null,
    2,
  ),
  'utf8',
)
await settle()
check(
  'limit: a hand-edited store is not picked up mid-run',
  block(other.box, 'user-memory-temp').includes('外部写入的阶段目标') === false,
  block(other.box, 'user-memory-temp'),
)
const after = await tool(other.box, 'temp_memory').execute({ kind: 'stage', title: '接在内存里的 id 之后', body: '正文。' })
check('limit: ids keep counting from the in-process store', after.id === '4', JSON.stringify(after))
check(
  'limit: the next write overwrites the hand edit',
  (await storeOf()).items.every((item) => item.id !== '8'),
)

if (realHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = realHome

for (const x of [off, on, bud, tiny, grow, panel, offPanel, other]) {
  for (const dispose of x.box.disposers) if (typeof dispose === 'function') dispose()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
