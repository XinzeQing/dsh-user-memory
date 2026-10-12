// Self-test for the dsh-user-memory plugin logic.
// Run:  node test/selftest.mjs
// Drives apply() with a fake Cordis context, so it needs no Harness process.
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

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

// ---------- 5. enabled:false mounts nothing ----------
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

for (const x of [a, b, c, d]) for (const fn of x.box.disposers) if (typeof fn === 'function') fn()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
