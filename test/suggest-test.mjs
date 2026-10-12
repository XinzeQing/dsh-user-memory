// Self-test for the "waiting area" gate (memory_suggest / memory_suggest_done).
// Run:  node test/suggest-test.mjs
//
// The promise this whole plugin rests on is "nothing is written until the user
// says so". These tests drive the real host module with a fake Cordis context
// and check that promise from both ends: the tool can only propose, and only
// the panel route can decide.
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

let failures = 0
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failures += 1
}
async function throws(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}

function makeCtx() {
  const box = { captured: null, disposers: [], route: null, tools: [], preStep: null }
  const ctx = {
    logger: { info: () => {}, warn: (m) => console.log('[warn]', m) },
    effect(fn) {
      box.disposers.push(fn())
    },
    systemPrompt: {
      section(s) {
        box.captured = s
        return () => {}
      },
    },
    // Declared hard dependency: `ctx.tools.register` is where the two tools go.
    tools: {
      register(definition) {
        box.tools.push(definition)
        return () => {}
      },
    },
    on(event, handler) {
      if (event === 'agent/pre-step') box.preStep = handler
      return () => {}
    },
    // Stands in for `ctx.inject([...], cb)` for both services the plugin asks for.
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

const home = await mkdtemp(join(tmpdir(), 'um-suggest-'))
process.env.DSH_HOME = home
const memDir = join(home, 'memory')

const first = makeCtx()
await apply(first.ctx, { dir: memDir })

const request = (payload) => ({ json: async () => payload })
const post = async (payload) => (await first.box.route.fetch(request(payload))).json()
const suggest = first.box.tools.find((t) => t.name === 'memory_suggest')
const done = first.box.tools.find((t) => t.name === 'memory_suggest_done')

// ---------- 1. the tools exist and are shaped like tools ----------
check(
  'tools: both registered',
  first.box.tools.length === 2 && suggest !== undefined && done !== undefined,
  first.box.tools.map((t) => t.name).join(','),
)
check(
  'tools: suggest enumerates exactly the editable files',
  JSON.stringify(suggest.parameters.properties.file.enum) ===
    JSON.stringify(['rules-must.md', 'agent.md', 'profile.md', 'rules-should.md', 'log.md']),
)
check('tools: text is required', suggest.parameters.required.includes('text'))
check(
  'tools: parameters are finished JSON Schema, not a defineTool spec',
  [suggest, done].every(
    (t) =>
      t.parameters.type === 'object' &&
      t.parameters.additionalProperties === false &&
      Array.isArray(t.parameters.required) &&
      Object.values(t.parameters.properties).every((p) => p.required === undefined) &&
      t.output.schema.type === 'object' &&
      Array.isArray(t.output.schema.required) &&
      Object.values(t.output.schema.properties).every((p) => p.required === undefined),
  ),
)
// The registry validator itself, when the local dsh install is reachable: this
// is the exact call that used to throw and abort apply() before the tools were
// registered — and before the prompt section was.
try {
  const { assertSupportedJsonSchema } = await import(
    'file:///C:/Users/Adler/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
  )
  for (const t of [suggest, done]) {
    assertSupportedJsonSchema(t.parameters)
    assertSupportedJsonSchema(t.output.schema)
  }
  check('tools: the real registry validator accepts both schemas', true)
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') console.log('SKIP  tools: dsh-tools not reachable')
  else check('tools: the real registry validator accepts both schemas', false, String(error?.message ?? error))
}
check(
  'tools: output renders a text block',
  suggest.output.render({}, { id: '9', file: 'agent.md', pending: 2 }).every((b) => b.type === 'text') &&
    done.output.render({}, { id: '9', status: 'done' }).every((b) => b.type === 'text'),
)

// ---------- 2. proposing writes nothing ----------
const proposed = await suggest.execute({
  file: 'agent.md',
  text: '  中文回答，条目要短。  ',
  why: '用户反复要求',
})
check(
  'propose: returns pending + count',
  proposed.id === '1' && proposed.file === 'agent.md' && proposed.status === 'pending' && proposed.pending === 1,
  JSON.stringify(proposed),
)
check(
  'propose: does NOT touch the memory file',
  !(await readFile(join(memDir, 'agent.md'), 'utf8')).includes('条目要短'),
)
check(
  'propose: the text is trimmed and persisted',
  (await readFile(join(home, 'memory-suggest.json'), 'utf8')).includes('"text": "中文回答，条目要短。"'),
)

// ---------- 3. bad proposals are refused ----------
const escape = await throws(() => suggest.execute({ file: '../../evil.md', text: 'x' }))
check('propose: refuses a path outside the list', escape !== null && escape.message.includes('不允许'), escape && escape.message)
const blank = await throws(() => suggest.execute({ file: 'agent.md', text: '   ' }))
check('propose: refuses empty text', blank !== null, blank && blank.message)
const noFile = await throws(() => suggest.execute({ text: 'x' }))
check('propose: refuses a missing file name', noFile !== null, noFile && noFile.message)

// ---------- 4. oversize text is capped, not rejected ----------
const long = await suggest.execute({ file: 'profile.md', text: 'x'.repeat(5000) })
const stored = JSON.parse(await readFile(join(home, 'memory-suggest.json'), 'utf8'))
check(
  'propose: caps the text at 4000 chars',
  stored.items.find((i) => i.id === long.id).text.length === 4000,
)

// ---------- 5. the panel reads the waiting area ----------
const listed = await post({ action: 'suggestions' })
check(
  'route suggestions: lists every item + the pending count',
  listed.ok === true && listed.items.length === 2 && listed.pending === 2,
  `items=${listed.items.length} pending=${listed.pending}`,
)

// ---------- 6. only a valid decision can change anything ----------
const badDecision = await first.box.route.fetch(
  request({ action: 'resolveSuggestion', id: '1', decision: 'write' }),
)
check(
  'route resolve: refuses a decision that is neither accept nor dismiss',
  (await badDecision.json()).ok === false && badDecision.status === 400,
)
const missing = await first.box.route.fetch(
  request({ action: 'resolveSuggestion', id: '99', decision: 'accept' }),
)
check('route resolve: 404 for an unknown id', (await missing.json()).ok === false && missing.status === 404)

// ---------- 7. acceptance is delivered on the next real user turn ----------
const accepted = await post({ action: 'resolveSuggestion', id: '1', decision: 'accept' })
check('route resolve: accept', accepted.ok === true && accepted.status === 'accepted')

const decision = { kind: 'enter', messages: [] }
const delivered = await first.box.preStep({ messages: [{ source: { kind: 'user' } }] }, async () => decision)
check(
  'pre-step: appends exactly one message to the turn',
  delivered !== decision && delivered.kind === 'enter' && delivered.messages.length === 1,
)
const notice = delivered.messages[0]
check(
  'pre-step: it is an immutable user message of ours',
  notice.role === 'user' &&
    notice.source.kind === 'plugin:dsh-user-memory' &&
    typeof notice.id === 'string' &&
    notice.id.length > 10 &&
    Object.isFrozen(notice),
  `${notice.role}/${notice.source.kind}`,
)
const noticeText = notice.content[0].text
check(
  'pre-step: the notice asks for the write and for a diff on wording drift',
  noticeText.includes('<MEMORY_SUGGESTION_ACCEPTED>') &&
    noticeText.includes('#1') &&
    noticeText.includes('agent.md') &&
    noticeText.includes('中文回答，条目要短。') &&
    noticeText.includes('先停下'),
)
check(
  'pre-step: the item is now delivered, not merely accepted',
  (await post({ action: 'suggestions' })).items.find((i) => i.id === '1').status === 'delivered',
)

// ---------- 8. an internal step must not eat the acceptance ----------
await post({ action: 'resolveSuggestion', id: '2', decision: 'accept' })
const internal = await first.box.preStep(
  { messages: [{ source: { kind: 'compaction' } }] },
  async () => decision,
)
check('pre-step: an internal step does not consume an acceptance', internal === decision)
check(
  'pre-step: it stays accepted, waiting for a real user turn',
  (await post({ action: 'suggestions' })).items.find((i) => i.id === '2').status === 'accepted',
)

// ---------- 9. dismissing leaves no trace in the pending count ----------
const dismissed = await post({ action: 'resolveSuggestion', id: '2', decision: 'dismiss' })
check('route resolve: dismiss', dismissed.ok === true && dismissed.status === 'dismissed')
check('route suggestions: pending excludes decided items', (await post({ action: 'suggestions' })).pending === 0)

// ---------- 10. reporting back ----------
const finished = await done.execute({ id: '1', note: '写进 agent.md 第一条' })
const afterDone = JSON.parse(await readFile(join(home, 'memory-suggest.json'), 'utf8'))
check(
  'done: marks it complete and keeps the note',
  finished.status === 'done' && afterDone.items.find((i) => i.id === '1').note === '写进 agent.md 第一条',
)
const unknownDone = await throws(() => done.execute({ id: '42' }))
check('done: refuses an unknown id', unknownDone !== null, unknownDone && unknownDone.message)

// ---------- 11. the waiting area survives a restart ----------
const second = makeCtx()
await apply(second.ctx, { dir: memDir })
const reloaded = await (await second.box.route.fetch(request({ action: 'suggestions' }))).json()
check(
  'store: reloaded with the same items and statuses',
  reloaded.items.length === 2 && reloaded.items.find((i) => i.id === '1').status === 'done',
)
const afterRestart = await second.box.tools
  .find((t) => t.name === 'memory_suggest')
  .execute({ file: 'log.md', text: '重启后新增的一条' })
check('store: numbering continues across a restart', afterRestart.id === '3', afterRestart.id)

// ---------- 12. the panel can tell the user where the waiting area lives ----------
const loaded = await post({ action: 'load' })
check(
  'route load: reports the waiting-area file',
  loaded.suggestFile === join(home, 'memory-suggest.json'),
  loaded.suggestFile,
)

for (const entry of [first, second]) {
  for (const fn of entry.box.disposers) if (typeof fn === 'function') fn()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
