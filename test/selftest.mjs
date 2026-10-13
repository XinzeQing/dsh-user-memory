// Self-test for the dsh-user-memory plugin logic.
// Run:  node test/selftest.mjs
// Drives apply() with a fake Cordis context, so it needs no Harness process.
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

// The switch state file lives in $DSH_HOME, so every case must run against a
// throwaway home: otherwise this suite reads the real user's .autocapture and
// its result depends on whether that person happens to have the switch on.
const realHome = process.env.DSH_HOME
const baseHome = await mkdtemp(join(tmpdir(), 'umhome-'))
process.env.DSH_HOME = baseHome

let failures = 0
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failures += 1
}

function makeCtx() {
  const box = { captured: null, disposers: [], route: null, tools: [], preStep: null }
  const ctx = {
    logger: { info: () => {}, warn: (m) => console.log('[warn]', m) },
    effect(fn) { box.disposers.push(fn()) },
    systemPrompt: { section(s) { box.captured = s; return () => {} } },
    // Declared hard dependency of the plugin: its two tools live here.
    tools: { register(definition) { box.tools.push(definition); return () => {} } },
    on(event, handler) {
      if (event === 'agent/pre-step') box.preStep = handler
      return () => {}
    },
    // Stands in for `ctx.inject([...], cb)` for both services the plugin asks
    // for; captures the route and the tool definitions the plugin registers so
    // the tests can call them like the browser and the model do.
    inject(services, cb) {
      cb({
        get(name) {
          if (name === 'connection') {
            return { fetch: { register(definition) { box.route = definition; return () => {} } } }
          }
          if (name === 'tools') {
            return { register(definition) { box.tools.push(definition); return () => {} } }
          }
          return undefined
        },
        effect(fn) { box.disposers.push(fn()) },
      })
    },
  }
  return { ctx, box }
}

const settle = () => new Promise((r) => setTimeout(r, 3400))
const request = (payload) => ({ json: async () => payload })

// ---------- 1. fresh scaffold ----------
const dir1 = await mkdtemp(join(tmpdir(), 'um-'))
const a = makeCtx()
await apply(a.ctx, { dir: dir1 })
const fresh = a.box.captured.text()

check('section name', a.box.captured.name === 'user-memory')
check('section order', a.box.captured.order === -500)
check('text is provider fn', typeof a.box.captured.text === 'function')
check('scaffold made 5 files', (await readdir(dir1)).length === 5, (await readdir(dir1)).sort().join(','))
check('fresh: injects the seeded hard rule', fresh.includes('只有我明确说'))
check('fresh: heading-only files are NOT injected', !fresh.includes('### 我的行为设定') && !fresh.includes('### 用户画像') && !fresh.includes('### 可选遵守'))
check('fresh: no HTML comment leaks into prompt', !fresh.includes('<!--'))

// ---------- 2. edits are picked up ----------
await writeFile(join(dir1, 'agent.md'), '# 我的行为设定\n\n- 先给我方案，我选完你才做。\n', 'utf8')
await writeFile(join(dir1, 'profile.md'), '# 用户画像\n\n- 中文交流。\n', 'utf8')
await settle()
const edited = a.box.captured.text()
check('edit: agent setting appears', edited.includes('先给我方案'))
check('edit: profile appears', edited.includes('中文交流'))
check('edit: section order preserved', edited.indexOf('必须遵守') < edited.indexOf('我的行为设定') && edited.indexOf('我的行为设定') < edited.indexOf('用户画像'))

// ---------- 3. budget bounds the WHOLE block ----------
const dir2 = await mkdtemp(join(tmpdir(), 'um-'))
const b = makeCtx()
await apply(b.ctx, { dir: dir2, maxChars: 300 })
await writeFile(join(dir2, 'rules-must.md'), '# 必须遵守\n\n' + '- 这是一条很长的规则。\n'.repeat(60), 'utf8')
await settle()
const capped = b.box.captured.text()
check('budget: total block respects maxChars', capped.length <= 300, `len=${capped.length}`)
check('budget: truncation is announced', capped.includes('已截断'))

// ---------- 4. all files empty -> nothing injected ----------
const dir3 = await mkdtemp(join(tmpdir(), 'um-'))
const c = makeCtx()
await apply(c.ctx, { dir: dir3 })
for (const f of ['rules-must.md', 'agent.md', 'profile.md', 'rules-should.md']) {
  await writeFile(join(dir3, f), '# 标题\n\n<!-- 只有注释 -->\n', 'utf8')
}
await settle()
check('empty: nothing injected at all', c.box.captured.text() === '', JSON.stringify(c.box.captured.text().slice(0, 60)))

// ---------- 5. autoCapture (default off) ----------
// The switch's whole promise: OFF is byte-identical to "this field never
// existed", ON appends one constant block that does NOT eat the own-text budget.
const captureBody = '# 必须遵守\n\n- 采集开关测试用的固定规则。\n'

const dir5 = await mkdtemp(join(tmpdir(), 'um-'))
const e = makeCtx()
await apply(e.ctx, { dir: dir5 }) // autoCapture omitted entirely
await writeFile(join(dir5, 'rules-must.md'), captureBody, 'utf8')
await settle()
const omitted = e.box.captured.text()

const dir6 = await mkdtemp(join(tmpdir(), 'um-'))
const f = makeCtx()
await apply(f.ctx, { dir: dir6, autoCapture: false })
await writeFile(join(dir6, 'rules-must.md'), captureBody, 'utf8')
await settle()
const off = f.box.captured.text()

const dir7 = await mkdtemp(join(tmpdir(), 'um-'))
const g = makeCtx()
await apply(g.ctx, { dir: dir7, autoCapture: true })
await writeFile(join(dir7, 'rules-must.md'), captureBody, 'utf8')
await settle()
const on = g.box.captured.text()

check('autoCapture absent: notice NOT injected', !omitted.includes('记忆采集提醒'))
check('autoCapture false: notice NOT injected', !off.includes('记忆采集提醒'))
check('autoCapture false: byte-identical to absent', off === omitted && omitted.length > 0, `len ${off.length} vs ${omitted.length}`)
check('autoCapture true: notice injected', on.includes('## 记忆采集提醒（开关已打开）'))
check('autoCapture true: notice lands after the memory body', on.startsWith(off))
check('autoCapture true: only the notice was added', on.slice(off.length).startsWith('\n## 记忆采集提醒（开关已打开）'))
check('autoCapture true: body budget untouched (no truncation)', on.includes('采集开关测试用的固定规则') && !on.includes('已截断'))

// The notice is out-of-budget on purpose: maxChars bounds the user's own text,
// so turning the switch on may push the TOTAL past maxChars.
const dir8 = await mkdtemp(join(tmpdir(), 'um-'))
const h = makeCtx()
await apply(h.ctx, { dir: dir8, maxChars: 300, autoCapture: true })
await writeFile(join(dir8, 'rules-must.md'), '# 必须遵守\n\n' + '- 这是一条很长的规则。\n'.repeat(60), 'utf8')
await settle()
const cappedOn = h.box.captured.text()
check('autoCapture true: own text still truncated at maxChars', cappedOn.includes('已截断'))
check('autoCapture true: notice survives the truncation path', cappedOn.includes('记忆采集提醒'))
check('autoCapture true: notice sits outside the budget', cappedOn.length > 300, `len=${cappedOn.length}`)

// ---------- 6. enabled:false mounts nothing ----------
const dir4 = await mkdtemp(join(tmpdir(), 'um-'))
const d = makeCtx()
await apply(d.ctx, { dir: dir4, enabled: false })
check('disabled: no section registered', d.box.captured === null)
check('disabled: no route registered', d.box.route === null)

// ---------- 6. the panel route ----------
const route = a.box.route
check('route: path and method', route !== null && route.path === '/api/dsh-user-memory' && route.methods.includes('POST'))

const loaded = await (await route.fetch(request({ action: 'load' }))).json()
check('route load: ok + all five files', loaded.ok === true && loaded.files.length === 5, loaded.files.map((f) => f.file).join(','))
check('route load: reports the directory', loaded.dir === dir1)

const saved = await (await route.fetch(request({ action: 'save', file: 'rules-must.md', content: '# 必须遵守\n\n- 面板写入测试。\n' }))).json()
check('route save: ok', saved.ok === true)
check('route save: explains the injection', typeof saved.injection === 'string' && saved.injection.includes('已生效'), saved.injection)
check('route save: really wrote the file', (await readFile(join(dir1, 'rules-must.md'), 'utf8')).includes('面板写入测试'))
await settle()
check('route save: injection refreshed immediately', a.box.captured.text().includes('面板写入测试'))

const blank = await (await route.fetch(request({ action: 'save', file: 'profile.md', content: '# 用户画像\n\n<!-- 只有注释 -->\n' }))).json()
check('route save: empty section reported as not injected', blank.ok === true && blank.injection.includes('不会注入'), blank.injection)

const traversal = await (await route.fetch(request({ action: 'save', file: '../../evil.md', content: 'x' }))).json()
check('route: refuses a path outside the memory dir', traversal.ok === false, traversal.error)

const badType = await (await route.fetch(request({ action: 'save', file: 'agent.md', content: 123 }))).json()
check('route: refuses non-string content', badType.ok === false, badType.error)

const unknown = await (await route.fetch(request({ action: 'nope' }))).json()
check('route: refuses an unknown action', unknown.ok === false)

const garbage = await (await route.fetch({ json: async () => { throw new Error('bad body') } })).json()
check('route: survives a malformed body', garbage.ok === false)

// ---------- 7. the panel switch (runtime state file) ----------
// The switch exists because `config` is a load-time snapshot the panel cannot
// reach: flipping it must take effect on the NEXT model step, with no restart.
// These blocks isolate DSH_HOME per case, because the state file lives beside
// the suggestion store (in $DSH_HOME) rather than in the memory dir.
// (`realHome` was captured at the top, before case 1 ran.)

const iHome = await mkdtemp(join(tmpdir(), 'umhome-'))
const iDir = await mkdtemp(join(tmpdir(), 'um-'))
process.env.DSH_HOME = iHome
const i = makeCtx()
await apply(i.ctx, { dir: iDir, autoCapture: true })
await writeFile(join(iDir, 'rules-must.md'), captureBody, 'utf8')
await settle()
check('switch: no state file -> the config decides', i.box.captured.text().includes('记忆采集提醒'))
check('switch: no state file is created behind the user', !(await readdir(iHome)).includes('.autocapture'), (await readdir(iHome)).join(','))

const iRoute = i.box.route
const initial = await (await iRoute.fetch(request({ action: 'load' }))).json()
check(
  'switch: load reports state + where it came from',
  initial.autoCapture.on === true && initial.autoCapture.source === 'config',
  JSON.stringify(initial.autoCapture),
)

const flippedOff = await (await iRoute.fetch(request({ action: 'autoCapture', on: false }))).json()
check('switch: the panel can turn it off', flippedOff.ok === true && flippedOff.autoCapture.on === false, JSON.stringify(flippedOff))
check(
  'switch: it writes the state file',
  (await readFile(join(iHome, '.autocapture'), 'utf8')).trim() === 'off',
  JSON.stringify(await readFile(join(iHome, '.autocapture'), 'utf8')),
)
// The whole point: no restart, no waiting out the 3s poll — the very next model
// step sees the notice gone.
check('switch: the notice is gone right away, without a poll', !i.box.captured.text().includes('记忆采集提醒'))
check('switch: the memory body itself is untouched', i.box.captured.text().includes('采集开关测试用的固定规则'))

const reloaded = await (await iRoute.fetch(request({ action: 'load' }))).json()
check('switch: load now reports the panel as the source', reloaded.autoCapture.on === false && reloaded.autoCapture.source === 'panel', JSON.stringify(reloaded.autoCapture))

const flippedOn = await (await iRoute.fetch(request({ action: 'autoCapture', on: true }))).json()
check('switch: the panel can turn it back on', flippedOn.ok === true && flippedOn.autoCapture.on === true)
check('switch: the notice is back right away', i.box.captured.text().includes('## 记忆采集提醒（开关已打开）'))

// A state file the user hand-edited into gibberish must not silently disable
// the feature: unrecognised content means "no opinion", so the config decides.
await writeFile(join(iHome, '.autocapture'), 'maybe\n', 'utf8')
await settle()
check('switch: an unreadable state falls back to the config', i.box.captured.text().includes('记忆采集提醒'))

const notBoolean = await (await iRoute.fetch(request({ action: 'autoCapture', on: 'yes' }))).json()
check('switch: refuses a non-boolean', notBoolean.ok === false, notBoolean.error)

// A file left over from a previous session must win over the config, or the
// panel's own switch would be undone by the next restart. `jHome` is a fresh
// empty home that already carries the state file a previous run left behind.
const jHome = await mkdtemp(join(tmpdir(), 'umhome-'))
await writeFile(join(jHome, '.autocapture'), 'off\n', 'utf8')
process.env.DSH_HOME = jHome
const j = makeCtx()
await apply(j.ctx, { dir: iDir, autoCapture: true })
await settle()
check('switch: the state file outlives a restart and beats the config', !j.box.captured.text().includes('记忆采集提醒'))

// Config says nothing, state file says nothing: OFF, and byte-identical to the
// pre-switch behaviour (the compatibility promise of 0.5.0).
const kHome = await mkdtemp(join(tmpdir(), 'umhome-'))
process.env.DSH_HOME = kHome
const k = makeCtx()
await apply(k.ctx, { dir: iDir })
await settle()
check('switch: silent config + silent state = OFF', !k.box.captured.text().includes('记忆采集提醒'))
const kLoaded = await (await k.box.route.fetch(request({ action: 'load' }))).json()
check('switch: and it reports OFF from the config', kLoaded.autoCapture.on === false && kLoaded.autoCapture.source === 'config', JSON.stringify(kLoaded.autoCapture))

if (realHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = realHome

for (const x of [a, b, c, d, e, f, g, h, i, j, k]) for (const fn of x.box.disposers) if (typeof fn === 'function') fn()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
