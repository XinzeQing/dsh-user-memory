/**
 * dsh-user-memory — user-authored, tiered long-term memory.
 *
 * What it does
 * ------------
 * Reads a small set of markdown files the USER owns, and injects them as one
 * system-prompt section placed between the harness identity and the deployment
 * persona (`SECTION_ORDER = -500`). That is the strongest placement a plugin can
 * claim for "must follow" instructions, and because the injected text is a
 * function of the current file contents, an edit takes effect on the next
 * assembly while an unchanged memory keeps the system prompt byte-identical and
 * therefore fully prompt-cached.
 *
 * Writing
 * -------
 * It writes in exactly two situations, both started by the user:
 *   1. the save action of the graphical panel, which this file serves over the
 *      single route below; and
 *   2. the ordinary file tools, when the user asks the agent to change a memory.
 * Beyond creating missing templates once (never overwriting), it never captures
 * a conversation, never summarises, never writes back on its own, and never
 * sends memory anywhere.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Row/plugin identity. */
export const name = 'user-memory'
/** Hard dependencies: the section registry this plugin contributes to, and the tool registry. */
export const inject = ['systemPrompt', 'tools']

/** The section name this plugin claims; unique so it shadows nothing. */
const SECTION_NAME = 'user-memory'
/** Between HARNESS_IDENTITY (-1000) and DEPLOYMENT_PERSONA_PREFIX (0). */
const SECTION_ORDER = -500
/** Cheap mtime poll: four tiny files, and an unchanged read keeps the prompt identical. */
const POLL_MS = 3000
/** Default total budget for the injected block. */
const DEFAULT_MAX_CHARS = 6000

/** The single HTTP route the graphical panel talks to. */
const ROUTE_PATH = '/api/dsh-user-memory'
/** Files the panel may read and write; every other name is refused. */
const EDITABLE_FILES = ['rules-must.md', 'agent.md', 'profile.md', 'rules-should.md', 'log.md']
/** Hard ceiling for one saved file, so a runaway paste cannot fill the disk. */
const MAX_CONTENT_BYTES = 256 * 1024

/** Producer-owned source kind for the injected acceptance notice. */
const SOURCE_KIND = 'plugin:dsh-user-memory'
/** Where suggestions awaiting the user's decision are persisted. */
const SUGGEST_FILE = 'memory-suggest.json'
/** Hard ceiling for one suggestion's wording. */
const MAX_SUGGEST_CHARS = 4000
/** Hard ceiling for the user's own supplement ("补充说明") attached to one suggestion. */
const MAX_NOTE_CHARS = 1000
/** Decided suggestions are pruned once the store grows past this. */
const MAX_KEPT_ITEMS = 80

/** Injected order: behaviour-shaping first, descriptive later, soft last. */
const SECTIONS = [
  { file: 'rules-must.md', title: '必须遵守（硬性要求）' },
  { file: 'agent.md', title: '我的行为设定' },
  { file: 'profile.md', title: '用户画像' },
  { file: 'rules-should.md', title: '可选遵守（酌情）' },
]

const PREAMBLE = [
  '## 用户长期记忆',
  '',
  '以下内容由用户本人编写和维护，是用户对我提出的明确要求，不是参考资料。',
  '「必须遵守」与「我的行为设定」两节按字面执行；「可选遵守」酌情执行，冲突时以前者为准。',
  '这份记忆只在用户明确要求时才会被修改。',
].join('\n')

/**
 * Created once, only when absent. Guidance lives in HTML comments so the
 * scaffold can teach without those comments ever reaching the model.
 */
const TEMPLATES = {
  'rules-must.md': [
    '# 必须遵守（硬性要求）',
    '',
    '<!--',
    '  只写“无论如何都要做到”的事。一条一行，以 "- " 开头。',
    '  写具体、可判定的行为，不写空泛原则。',
    '  本文件为空（或只剩注释）时，不会有任何硬性要求被注入。',
    '-->',
    '',
    '- 只有我明确说“做”或“可以”，你才动手；我没说的不要自己开工，也不要顺手改动别的文件。',
    '',
  ].join('\n'),

  'agent.md': [
    '# 我的行为设定',
    '',
    '<!--',
    '  这一节决定我面对你时的“行为模式”。目前尚未设定，下面是可选模式，你选定后我写进来：',
    '    - 直接干活：收到需求就动手，做完再汇报，不解释过程。',
    '    - 先回复再干：先用一句话说明我的判断和打算，再执行。',
    '    - 只解答不动手：只给答案和方案，绝不碰文件和命令。',
    '    - 先问清再干：需求有歧义时先问，问清楚再动手。',
    '    - 先给方案等我挑：列出选项让你选，你选完我才执行。',
    '  也可以写得更细，例如“提问时必须给出你认为最优的一项并说明理由”。',
    '  本文件为空（或只剩注释）时，不会有任何行为设定被注入。',
    '-->',
    '',
  ].join('\n'),

  'profile.md': [
    '# 用户画像',
    '',
    '<!--',
    '  这里写你自己：你是谁、你的习惯、你在意什么、你讨厌什么。',
    '  我会把它当作背景来调整用词、详略和举例方式，但它不构成命令。',
    '  本文件为空（或只剩注释）时不会被注入。',
    '-->',
    '',
  ].join('\n'),

  'rules-should.md': [
    '# 可选遵守（酌情）',
    '',
    '<!--',
    '  这里写“最好这样，但要看情况”的偏好，与「必须遵守」分开，便于你自行判断优先级。',
    '  一条一行，以 "- " 开头。本文件为空（或只剩注释）时不会被注入。',
    '-->',
    '',
  ].join('\n'),

  'log.md': [
    '# 记忆变更日志',
    '',
    '<!-- 每次增删改记忆后追加一行：日期 | 改了什么 | 为什么 -->',
    '',
  ].join('\n'),
}

/** Drop HTML comments and collapse the blank runs they leave behind. */
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** True when a file still carries real content once headings are removed. */
function meaningful(body) {
  return body.replace(/^#{1,6}\s.*$/gm, '').trim()
}

/**
 * What this content will actually do to the prompt — shown in the panel so the
 * user never has to guess whether an edit took effect.
 */
function describeInjection(file, content) {
  const spec = SECTIONS.find((entry) => entry.file === file)
  if (spec === undefined) return '这个文件不注入（只作为你自己的记录）。'
  const body = meaningful(stripComments(content))
  if (body === '') return '目前这一节是空的（只剩标题或注释），不会注入。'
  return `已生效：这一节会注入（约 ${[...body].length} 字）。`
}

/** Appended when a section does not fit; its length is part of the budget. */
const TRUNCATION_NOTICE = '\n\n…（本段超出预算已截断，完整内容见记忆目录）'

/** Compose the injected block. `maxChars` bounds the whole block, preamble and notice included. */
function render(parts, maxChars) {
  if (parts.length === 0) return ''
  const budget = maxChars - PREAMBLE.length - 2
  if (budget <= 0) return ''
  let body = ''
  for (const part of parts) {
    const chunk = `\n\n### ${part.title}\n\n${part.body}`
    if (body.length + chunk.length <= budget) {
      body += chunk
      continue
    }
    const room = budget - body.length - TRUNCATION_NOTICE.length
    if (room >= 120) {
      body += chunk.slice(0, room) + TRUNCATION_NOTICE
    }
    break
  }
  return body.length === 0 ? '' : PREAMBLE + body
}

/** Create the memory directory and any missing template; never overwrite. */
async function scaffold(dir) {
  await mkdir(dir, { recursive: true })
  for (const [file, content] of Object.entries(TEMPLATES)) {
    const target = join(dir, file)
    const existing = await readFile(target, 'utf8').then(
      () => true,
      () => false,
    )
    if (existing) continue
    await writeFile(target, content, 'utf8')
  }
}

/** Read the request body defensively: a malformed body is an empty payload, never a crash. */
async function readPayload(request) {
  try {
    if (typeof request?.json === 'function') return await request.json()
    if (typeof request?.text === 'function') return JSON.parse((await request.text()) || '{}')
  } catch {
    /* fall through to the empty payload */
  }
  return {}
}

/** Freeze a value and everything reachable from it. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key])
  return value
}

/**
 * An identified, immutable user message — the runtime shape
 * `@deepseek-ai/dsh-llm`'s `createUserMessage` produces, inlined because a
 * `link:`-installed bundle is resolved through its real path, where
 * `@deepseek-ai/*` is not reachable (see the header of this file).
 */
function userMessage(text) {
  return deepFreeze(
    structuredClone({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND },
      role: 'user',
      id: randomUUID(),
    }),
  )
}

/**
 * The notice appended to the next user turn once suggestions are accepted. It
 * asks for the writing, but keeps the two cases that must stop for the user's
 * eyes: a materially different wording, and a conflict with what is already
 * there.
 */
function acceptedText(items) {
  const lines = [
    '<MEMORY_SUGGESTION_ACCEPTED>',
    '用户在右侧「长期记忆 → 待确认」里采纳了这些记忆建议：',
  ]
  for (const item of items) {
    lines.push('', `#${item.id} → ${item.file}`)
    for (const line of String(item.text).split(/\r?\n/)) lines.push(`  ${line}`)
    if (typeof item.why === 'string' && item.why !== '') lines.push(`  理由：${item.why}`)
    // The user's own supplement, written into the panel's 补充框 and stored the
    // moment they clicked 采纳. It outranks my wording; say so explicitly, so a
    // later reader never mistakes it for a side note.
    if (typeof item.userNote === 'string' && item.userNote !== '') {
      lines.push('  用户补充（用户自己在采纳时写的额外说明；与上面的原文冲突时以它为准）：')
      for (const line of item.userNote.split(/\r?\n/)) lines.push(`    ${line}`)
    }
  }
  lines.push(
    '',
    '现在把每一条总结成合适的措辞，并进对应记忆文件（直接用文件工具改）。',
    '带「用户补充」的条目，把补充当作该条的最终要求：与建议原文冲突时以补充为准；补充里已经给出的具体措辞直接照用。',
    '两种例外要先停下、把 diff 摆给用户看：你的措辞与用户采纳的原文有实质差异；或这条与文件里已有内容重复、冲突。',
    '每一条处理完（写完，或说明为什么不写）调用一次 memory_suggest_done。',
    '</MEMORY_SUGGESTION_ACCEPTED>',
  )
  return lines.join('\n')
}

/**
 * Host plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, dir?: string, maxChars?: number }} [config]
 */
export async function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const configuredDir = typeof config.dir === 'string' ? config.dir.trim() : ''
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = configuredDir || join(home, 'memory')
  const maxChars =
    typeof config.maxChars === 'number' && Number.isFinite(config.maxChars) && config.maxChars > 0
      ? config.maxChars
      : DEFAULT_MAX_CHARS

  try {
    await scaffold(dir)
  } catch (error) {
    ctx.logger?.warn?.(`user-memory: could not prepare ${dir}: ${String(error)}`)
  }

  // ---- 待确认区：我提议，用户点「采纳」才写 ------------------------------------
  //
  // The only path from a suggestion to a memory file is the user's own click in
  // the panel. The agent may PROPOSE (memory_suggest) and REPORT
  // (memory_suggest_done) through the two tools below, and neither of them
  // touches a memory file — so "writes only when the user says so" survives
  // contact with a model that can call tools.
  const suggestPath = join(home, SUGGEST_FILE)
  let store = { nextId: 1, items: [] }

  const loadStore = async () => {
    try {
      const parsed = JSON.parse(await readFile(suggestPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.items)) {
        store = {
          nextId:
            Number.isInteger(parsed.nextId) && parsed.nextId > 0
              ? parsed.nextId
              : parsed.items.length + 1,
          items: parsed.items.filter((item) => item !== null && typeof item === 'object'),
        }
      }
    } catch {
      /* first run, or an unreadable file: start empty rather than fail */
    }
  }

  /** Drop `undefined` values so `JSON.stringify` can never return `undefined`. */
  const jsonSafe = (value) => JSON.parse(JSON.stringify(value ?? null, (_key, item) => (item === undefined ? undefined : item)))

  const saveStore = async () => {
    try {
      await mkdir(home, { recursive: true })
      // `JSON.stringify` answers `undefined` for a value whose own properties —
      // or an item inside `items` — hold `undefined` (an optional tool argument
      // that was left out, for instance), and `writeFile(undefined)` throws.
      // That used to make the whole proposal disappear with only a warn log:
      // the tool still returned "已放进待确认区", but nothing was ever written.
      // Serializing a value that is guaranteed JSON-clean keeps the write honest.
      await writeFile(suggestPath, JSON.stringify(jsonSafe(store), null, 2), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`user-memory: 待确认区写入失败 ${suggestPath}: ${String(error)}`)
    }
  }

  const pendingCount = () => store.items.filter((item) => item.status === 'pending').length

  /** Keep every undecided item; drop the oldest decided ones once the store grows. */
  const prune = () => {
    if (store.items.length <= MAX_KEPT_ITEMS) return
    const open = store.items.filter(
      (item) => item.status === 'pending' || item.status === 'accepted',
    )
    const closed = store.items.filter(
      (item) => item.status !== 'pending' && item.status !== 'accepted',
    )
    store.items = open.concat(closed.slice(-Math.max(0, MAX_KEPT_ITEMS - open.length)))
    store.items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  }

  await loadStore()

  /**
   * `ctx.tools.register()` takes a finished JSON Schema, not the `defineTool`
   * spec form. Passing the spec form — as this plugin did at first, i.e.
   * `{ file: { type: 'string', required: true } }` — makes the registry throw
   * `unsupported JSON schema: schema.file is not a supported keyword` from
   * `assertSupportedJsonSchema` inside `dsh-tools/lib/index.js:2878 register()`,
   * and a raw schema that keeps `required: true` inside a property throws
   * `schema.properties.<name>.required is not supported on type "string"`.
   * Only type/oneOf/properties/required/additionalProperties/items/enum/const
   * (plus annotations) survive, so `required: true` becomes a `required` array.
   * `defineTool` does this same conversion, but the package is not importable
   * from this plugin's real path.
   */
  const toolSchema = (spec) => {
    const properties = {}
    const required = []
    for (const [key, value] of Object.entries(spec)) {
      const { required: isRequired, ...rest } = value
      properties[key] = rest
      if (isRequired === true) required.push(key)
    }
    const schema = { type: 'object', additionalProperties: false, properties }
    if (required.length > 0) schema.required = required
    return schema
  }

  const suggestTool = {
    name: 'memory_suggest',
    description:
      '把一条「长期记忆」的修改建议放进待确认区，等用户在右侧面板点「采纳」。这个工具不写任何文件：' +
      '用户采纳后你会在下一轮收到通知，那时才由你总结并写入。用户说了「记住」、或你发现值得长期保留的' +
      '偏好与规矩时用它提议，一次一条。',
    parameters: toolSchema({
      file: {
        type: 'string',
        required: true,
        enum: EDITABLE_FILES,
        description: '建议写进哪个记忆文件。',
      },
      text: {
        type: 'string',
        required: true,
        description: '建议写进去的完整措辞（能直接使用的文字，不要写“在某处加一句”这类指令）。',
      },
      why: { type: 'string', description: '为什么值得记：来自用户哪句话、要解决什么。' },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          status: { type: 'string' },
          pending: { type: 'integer' },
        },
        required: ['id', 'file', 'status', 'pending'],
      },
      render: (args, value) => [
        {
          type: 'text',
          text:
            `建议 #${value.id} 已放进待确认区（目标 ${value.file}），当前待确认 ${value.pending} 条。` +
            '它不会自动写入：用户点「采纳」后你才会在下一轮收到通知。现在继续手里的活，不要自己去改这个文件。',
        },
      ],
    },
    execute: async (args) => {
      const file = typeof args?.file === 'string' ? args.file : ''
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      if (!EDITABLE_FILES.includes(file)) throw new Error(`不允许的记忆文件：${file || '(空)'}`)
      if (text === '') throw new Error('建议内容不能为空')
      const id = String(store.nextId++)
      store.items.push({
        id,
        file,
        text: text.slice(0, MAX_SUGGEST_CHARS),
        why: typeof args?.why === 'string' ? args.why.trim().slice(0, 1000) : '',
        createdAt: new Date().toISOString(),
        status: 'pending',
      })
      prune()
      await saveStore()
      return { id, file, status: 'pending', pending: pendingCount() }
    },
  }

  const doneTool = {
    name: 'memory_suggest_done',
    description:
      '处理完一条已被采纳的记忆建议后调用：写完就标记完成，决定不写就说明原因。只记账，不改任何记忆文件。',
    parameters: toolSchema({
      id: { type: 'string', required: true, description: '建议编号，来自采纳通知里的 #编号。' },
      note: { type: 'string', description: '结果一句话：写进了哪个文件，或为什么不写。' },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['id', 'status'],
      },
      render: (args, value) => [{ type: 'text', text: `建议 #${value.id} 已标记为 ${value.status}。` }],
    },
    execute: async (args) => {
      const id = typeof args?.id === 'string' ? args.id : String(args?.id ?? '')
      const item = store.items.find((entry) => entry.id === id)
      if (item === undefined) throw new Error(`找不到建议 #${id}`)
      item.status = 'done'
      item.note = typeof args?.note === 'string' ? args.note.trim().slice(0, 1000) : ''
      item.doneAt = new Date().toISOString()
      await saveStore()
      return { id, status: item.status }
    },
  }

  // `ctx.tools.register` is the same seat `@nanmicoder/dsh-agent-teams` uses
  // (`lib/tools.js:572`). The earlier `ctx.inject(['tools'], (scope) =>
  // scope.get('tools'))` form registered nothing at runtime — the tool never
  // appeared in the Agent's catalog while the plugin fiber still reported
  // `active` — so the registry is now a declared hard dependency.
  for (const definition of [suggestTool, doneTool]) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  // Same seat and same guard as dsh-skill-pin: `agent/pre-step` also fires for
  // internal steps (compaction, titles, background agents), so an acceptance
  // waits for a step that actually carries a typed user message instead of being
  // silently consumed by one of those.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    const accepted = store.items.filter((item) => item.status === 'accepted')
    if (accepted.length === 0) return decision
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    if (!messages.some((message) => message?.source?.kind === 'user')) return decision
    for (const item of accepted) {
      item.status = 'delivered'
      item.deliveredAt = new Date().toISOString()
    }
    await saveStore()
    return { kind: 'enter', messages: [...decision.messages, userMessage(acceptedText(accepted))] }
  })

  // The section provider must be synchronous, so the files are read here and
  // the last good result is served; an unchanged result leaves the prompt
  // byte-identical, which keeps prompt caching intact.
  let text = ''

  const refresh = async () => {
    try {
      const parts = []
      for (const spec of SECTIONS) {
        const raw = await readFile(join(dir, spec.file), 'utf8').catch(() => '')
        const body = stripComments(raw)
        if (meaningful(body)) parts.push({ title: spec.title, body })
      }
      text = render(parts, maxChars)
    } catch (error) {
      ctx.logger?.warn?.(`user-memory: read failed, keeping previous text: ${String(error)}`)
    }
  }

  await refresh()

  ctx.effect(() => {
    const handle = setInterval(() => {
      void refresh()
    }, POLL_MS)
    handle.unref?.()
    return () => clearInterval(handle)
  })

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => text,
    }),
  )

  // The graphical panel's only backend. Both actions are read/write of files
  // this plugin already owns; the file name is checked against a fixed list.
  const handle = async (request) => {
    const payload = await readPayload(request)
    const action = typeof payload?.action === 'string' ? payload.action : ''

    if (action === 'load') {
      const files = []
      for (const file of EDITABLE_FILES) {
        const content = await readFile(join(dir, file), 'utf8').catch(() => '')
        files.push({ file, content })
      }
      return Response.json({ ok: true, dir, files, suggestFile: suggestPath })
    }

    // Read the waiting area. The agent can only ever add to it; only the panel
    // can decide.
    if (action === 'suggestions') {
      return Response.json({ ok: true, items: store.items, pending: pendingCount() })
    }

    if (action === 'resolveSuggestion') {
      const id = typeof payload?.id === 'string' ? payload.id : String(payload?.id ?? '')
      const choice = payload?.decision
      if (choice !== 'accept' && choice !== 'dismiss' && choice !== 'revoke') {
        return Response.json({ ok: false, error: '决定必须是 accept、dismiss 或 revoke' }, { status: 400 })
      }
      const item = store.items.find((entry) => entry.id === id)
      if (item === undefined) {
        return Response.json({ ok: false, error: '找不到这条建议' }, { status: 404 })
      }

      // 撤销：只对「已采纳、但还没交到下一轮」那一小段窗口有效 —— 这正是误点
      // 与反悔的窗口。判定只依据当前 status，所以重复点击、以及和 pre-step
      // 送达撞车（先送达、后撤销）都不会把状态写坏：撞车时这里如实拒绝。
      if (choice === 'revoke') {
        if (item.status === 'pending') {
          return Response.json({ ok: false, error: '这条还在等你决定，不需要撤销。' }, { status: 409 })
        }
        if (item.status !== 'accepted') {
          const reason =
            item.status === 'delivered'
              ? '这条已经交到下一轮了（我已经收到），无法撤销；可以在对话里直接让我别写。'
              : '这条已经处理完了，无法撤销。'
          return Response.json({ ok: false, error: reason, status: item.status }, { status: 409 })
        }
        item.status = 'pending'
        delete item.decidedAt
        delete item.deliveredAt
        await saveStore()
        ctx.logger?.info?.(`user-memory: 建议 #${id} 撤销采纳 → pending`)
        return Response.json({ ok: true, id, status: item.status, pending: pendingCount() })
      }

      // The user's own supplement travels with the acceptance. It is stored here
      // and only here — typing into the panel's box writes nothing, so an
      // undecided suggestion leaves no trace on disk.
      if (choice === 'accept' && typeof payload?.note === 'string') {
        item.userNote = payload.note.trim().slice(0, MAX_NOTE_CHARS)
        item.userNoteAt = new Date().toISOString()
      }

      item.status = choice === 'accept' ? 'accepted' : 'dismissed'
      item.decidedAt = new Date().toISOString()
      await saveStore()
      ctx.logger?.info?.(`user-memory: 建议 #${id} → ${item.status}`)
      return Response.json({
        ok: true,
        id,
        status: item.status,
        pending: pendingCount(),
        userNote: typeof item.userNote === 'string' ? item.userNote : '',
      })
    }

    if (action === 'save') {
      const file = payload?.file
      const content = payload?.content
      if (typeof file !== 'string' || !EDITABLE_FILES.includes(file)) {
        return Response.json({ ok: false, error: '不允许的文件名' }, { status: 400 })
      }
      if (typeof content !== 'string') {
        return Response.json({ ok: false, error: '内容必须是文本' }, { status: 400 })
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
        return Response.json({ ok: false, error: '内容过大，已拒绝保存' }, { status: 413 })
      }
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, file), content, 'utf8')
      } catch (error) {
        ctx.logger?.warn?.(`user-memory: save failed for ${file}: ${String(error)}`)
        return Response.json({ ok: false, error: '写入失败，请查看日志' }, { status: 500 })
      }
      // Make the change visible to the very next model step instead of waiting
      // out the poll interval.
      await refresh()
      return Response.json({ ok: true, file, injection: describeInjection(file, content) })
    }

    return Response.json({ ok: false, error: '未知操作' }, { status: 400 })
  }

  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection')
    const register =
      typeof connection?.fetch?.register === 'function'
        ? connection.fetch.register.bind(connection.fetch)
        : undefined
    if (register === undefined) {
      ctx.logger?.warn?.('user-memory: connection.fetch.register 不可用，图形面板将无法读写记忆。')
      return
    }
    scope.effect(() =>
      register({
        path: ROUTE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handle,
      }),
    )
    ctx.logger?.info?.(`user-memory: 图形面板接口已注册 ${ROUTE_PATH}`)
  })

  ctx.logger?.info?.(`user-memory: watching ${dir} (budget ${maxChars} chars)`)
}
