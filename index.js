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
 *
 * 临时记忆 (temporary memory) — a second, separable layer
 * ------------------------------------------------------
 * The files above are permanent rules the user authors. The working set is the
 * other half of a session's memory: "hand this to another conversation", "this is
 * the stage I am in", "do X once Y lands". It lives in one store beside the
 * suggestion store, is injected as its OWN section (`TEMP_SECTION_NAME`, order
 * -490), and every entry is either open or archived — an archived entry leaves
 * the prompt immediately, which is what keeps this layer from becoming a second
 * long-term memory. Off unless `config.tempMemory === true`.
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
/**
 * Runtime state file for the panel's auto-capture switch: literally `on` or
 * `off`.
 *
 * Why this exists at all
 * ----------------------
 * `config.autoCapture` is frozen at load time, so a config change can only take
 * effect after a Harness restart — and the graphical panel cannot reach it. The
 * panel is the obvious place for this switch, so the switch writes a file the
 * host re-reads on every poll, and the file wins over the config. The config
 * field stays as the fallback for profiles that predate the switch, which keeps
 * `0.5.0` behaviour exactly intact for anyone who never touches the panel.
 *
 * It is deliberately NOT created at scaffold time: an absent file must keep
 * meaning "no opinion, use the config", or a fresh install would silently
 * override a profile that deliberately set `autoCapture: true`.
 */
const SWITCH_FILE = '.autocapture'
/** Hard ceiling for one suggestion's wording. */
const MAX_SUGGEST_CHARS = 4000
/** Hard ceiling for the user's own supplement ("补充说明") attached to one suggestion. */
const MAX_NOTE_CHARS = 1000
/** Decided suggestions are pruned once the store grows past this. */
const MAX_KEPT_ITEMS = 80

// ---- 临时记忆（活跃工作集） ---------------------------------------------------
//
// A SECOND, separable layer: the user's own long-term memory is permanent rules
// and a profile, while this is the working set — "what I am doing right now",
// "hand this to another conversation", "do X once Y lands". It is cross-session
// (one store, above every conversation), auto-injected, and per-item: an entry
// leaves the prompt the moment it is finished, which is what keeps the layer
// from growing into a second long-term memory.
//
// Two things ride on this being a SEPARATE section rather than another heading
// inside the long-term block:
//  1. the long-term preamble says "written and maintained by the user" — that
//     would be a lie for entries a model wrote at the user's request; and
//  2. `maxChars` (the user's own budget) must not be eaten by working notes.
const TEMP_SECTION_NAME = 'user-memory-temp'
/** Immediately after the long-term block (-500), still above the persona (0). */
const TEMP_SECTION_ORDER = -490
/** One JSON store beside the suggestion store, not inside the memory dir. */
const TEMP_FILE = 'temp-memory.json'
/**
 * The three kinds exist because their readers and their lifetimes differ:
 * `handoff` is read by ANOTHER conversation, `stage` by every conversation for
 * as long as the stage lasts, `waiting` mostly by the one that created it.
 */
const TEMP_KINDS = ['handoff', 'stage', 'waiting']
const TEMP_KIND_TITLES = { handoff: '交接', stage: '阶段目标', waiting: '等待项' }
/** Independent budget: this block never touches `maxChars`. */
const DEFAULT_TEMP_MAX_CHARS = 1200
/**
 * Hard ceiling for one body, and deliberately NOT a soft target: a handoff entry
 * doubles as a delivery document, so it is allowed to be long. This only stops a
 * runaway paste.
 */
const MAX_TEMP_BODY_CHARS = 8000
const MAX_TEMP_TITLE_CHARS = 200
/** Open entries are never pruned; finished ones are capped by count AND age. */
const TEMP_ARCHIVE_KEEP = 20
const TEMP_ARCHIVE_DAYS = 30
/** Room reserved inside the temp budget for the "not injected, see the file" note. */
const TEMP_NOTE_RESERVE = 120

/** Injected order: behaviour-shaping first, descriptive later, soft last. */
const SECTIONS = [
  { file: 'rules-must.md', title: '必须遵守（硬性要求）' },
  { file: 'agent.md', title: '行为设定' },
  { file: 'profile.md', title: '用户画像' },
  { file: 'rules-should.md', title: '可选遵守（酌情）' },
]

const PREAMBLE = [
  '## 用户长期记忆',
  '',
  '以下内容由用户本人编写和维护，是用户对 AI 提出的明确要求，不是参考资料。',
  '「必须遵守」与「行为设定」两节按字面执行；「可选遵守」酌情执行，冲突时以前者为准。',
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
    '- 只有用户明确说“做”或“可以”，才动手；用户没说的不要自己开工，也不要顺手改动别的文件。',
    '',
  ].join('\n'),

  'agent.md': [
    '# 行为设定',
    '',
    '<!--',
    '  这一节决定 AI 面对用户时的“行为模式”。目前尚未设定，下面是可选模式，用户选定后写进来：',
    '    - 直接干活：收到需求就动手，做完再汇报，不解释过程。',
    '    - 先回复再干：先用一句话说明判断和打算，再执行。',
    '    - 只解答不动手：只给答案和方案，绝不碰文件和命令。',
    '    - 先问清再干：需求有歧义时先问，问清楚再动手。',
    '    - 先给方案等用户挑：列出选项让用户选，选完才执行。',
    '  也可以写得更细，例如“提问时必须给出自己认为最优的一项并说明理由”。',
    '  本文件为空（或只剩注释）时，不会有任何行为设定被注入。',
    '-->',
    '',
  ].join('\n'),

  'profile.md': [
    '# 用户画像',
    '',
    '<!--',
    '  这里写用户本人：是谁、有哪些习惯、在意什么、讨厌什么。',
    '  AI 会把它当作背景来调整用词、详略和举例方式，但它不构成命令。',
    '  本文件为空（或只剩注释）时不会被注入。',
    '-->',
    '',
  ].join('\n'),

  'rules-should.md': [
    '# 可选遵守（酌情）',
    '',
    '<!--',
    '  这里写“最好这样，但要看情况”的偏好，与「必须遵守」分开，便于用户自行判断优先级。',
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
  if (spec === undefined) return '这个文件不注入（只作为用户自己的记录）。'
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

/**
 * Appended to the injected block only while `autoCapture` is on.
 *
 * Two hard constraints ride on this constant:
 *  1. it is CONSTANT — nothing from the conversation may be interpolated, or the
 *     prompt would change every turn and prompt caching would be lost;
 *  2. it sits OUTSIDE `maxChars`, so the user's own text keeps its full budget.
 * A disabled switch appends `''`, leaving the prompt byte-identical.
 */
// ---- 临时记忆：注入时怎么渲染 -------------------------------------------------

/** The block header. Constant text: it must never depend on the entries. */
const TEMP_PREAMBLE = [
  '## 临时记忆（活跃工作集）',
  '',
  '以下条目是**还没做完的事**，由用户在对话里要求写入：跨对话交接、当前阶段目标、等到某个条件就要执行的待办。',
  '它们不是永久规则，也不是参考资料，做完就会被清理掉。',
].join('\n')

/**
 * Appended only while a 等待 entry is open, and constant on purpose: the waiting
 * semantics have to be stated ONCE as a rule, not repeated on every entry, or a
 * full working set would spend its budget restating the same paragraph.
 */
const TEMP_WAITING_NOTICE = [
  '',
  '### 等待项',
  '',
  '- 上面若有「等待」条目，且它等的条件已经满足：直接执行，做完调 `temp_memory_done` 把它归档，它就不再出现在这里。',
  '- 条件没满足就不要动它，也不要为了确认反复问用户。',
].join('\n')

const tempHeading = (item) => `[${TEMP_KIND_TITLES[item.kind] || item.kind} #${item.id}] ${item.title}`

/**
 * Renders the temp block. The three rules that make this layer safe to leave on:
 *  - newest first, so the freshest handoff is the one that survives a full budget;
 *  - an entry that does not fit is NOT half-injected, only named — a truncated
 *    delivery document is worse than a pointer plus the store path;
 *  - with nothing changed, the output is byte-identical to the previous step's
 *    (the waiting notice is constant), which keeps prompt caching intact.
 */
const renderTemp = (items, maxChars, storePath) => {
  const open = items
    .filter((item) => item.status === 'open')
    .sort((a, b) =>
      String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)),
    )
  if (open.length === 0) return ''
  const budget = maxChars - TEMP_PREAMBLE.length - 2 - TEMP_NOTE_RESERVE
  if (budget <= 0) return ''
  let body = ''
  const skipped = []
  for (const item of open) {
    const chunk = `\n\n### ${tempHeading(item)}\n\n${item.body}`
    if (body.length + chunk.length <= budget) {
      body += chunk
      continue
    }
    skipped.push(item.id)
  }
  if (body === '') {
    // Nothing fits at all: one oversized handoff, or a budget the user shrank.
    // An index still beats silence — the model learns the entry exists, and where
    // to read it in full.
    return (
      TEMP_PREAMBLE +
      `\n\n（临时记忆预算 ${maxChars} 字符，装不下任何一条全文：#${open
        .map((item) => item.id)
        .join('、#')}；全文见 ${storePath}）`
    )
  }
  const note =
    skipped.length === 0
      ? ''
      : `\n\n（预算已满，另有 ${skipped.length} 条没有注入：#${skipped.join('、#')}；全文见 ${storePath}）`
  const waiting = open.some((item) => item.kind === 'waiting') ? TEMP_WAITING_NOTICE : ''
  return TEMP_PREAMBLE + body + note + waiting
}

const AUTO_CAPTURE_NOTICE = [
  '',
  '## 记忆采集提醒（开关已打开）',
  '',
  '- 本次对话中若发现值得长期记住的用户偏好或规则（明说的要求、反复出现的偏好、明确的禁止项），调用 `memory_suggest` 把它放进待确认区。',
  '- 不要直接改记忆文件：用户点了「采纳」才会真正写入。',
  '- 只提你确实观察到的，不要为了凑数而提。',
].join('\n')

/**
 * Parse the panel switch's state file.
 *
 * Returns `true`/`false` for a recognised word, and `null` for "no opinion"
 * (missing file, empty file, or anything unrecognised) — `null` is what lets the
 * caller fall back to the config instead of silently forcing the switch off.
 */
function parseSwitch(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'on' || value === '1' || value === 'true') return true
  if (value === 'off' || value === '0' || value === 'false') return false
  return null
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
 * @param {{ enabled?: boolean, dir?: string, maxChars?: number, autoCapture?: boolean }} [config]
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
  // Opt-in: off unless the config literally says `true`, so an untouched profile
  // injects exactly the bytes it injected before this field existed.
  const configAutoCapture = config.autoCapture === true

  // The panel switch lives in its own file, because `config` is a load-time
  // snapshot the panel cannot reach and a restart must not be required to flip a
  // boolean. `null` = the file has no opinion yet, so the config above decides.
  const switchPath = join(home, SWITCH_FILE)
  let switchState = null
  let autoCapture = configAutoCapture
  let refreshing = false

  const readSwitch = async () => {
    const raw = await readFile(switchPath, 'utf8').catch(() => '')
    return parseSwitch(raw)
  }

  try {
    await scaffold(dir)
  } catch (error) {
    ctx.logger?.warn?.(`user-memory: could not prepare ${dir}: ${String(error)}`)
  }

  // ---- 待确认区：AI 提议，用户点「采纳」才写 ------------------------------------
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

  // ---- 临时记忆（活跃工作集）：存储 --------------------------------------------
  //
  // Off unless the config opts in. With the switch off, the system prompt stays
  // byte-identical to 0.6.0 — the same compatibility promise the auto-capture
  // switch keeps, because a plugin that silently grows the user's prompt is a
  // plugin the user cannot measure.
  const tempEnabled = config.tempMemory === true
  const tempMaxChars =
    typeof config.tempMaxChars === 'number' &&
    Number.isFinite(config.tempMaxChars) &&
    config.tempMaxChars > 0
      ? config.tempMaxChars
      : DEFAULT_TEMP_MAX_CHARS
  // Beside the suggestion store, NOT inside the memory dir: the memory dir holds
  // the user's hand-written files, and a file a model can grow through a tool
  // does not belong in that list.
  const tempPath = join(home, TEMP_FILE)
  let tempStore = { nextId: 1, items: [] }

  /** Same tolerance as the suggestion store: unreadable means empty, never fatal. */
  const loadTempStore = async () => {
    try {
      const parsed = JSON.parse(await readFile(tempPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.items)) {
        tempStore = {
          nextId:
            Number.isInteger(parsed.nextId) && parsed.nextId > 0
              ? parsed.nextId
              : parsed.items.length + 1,
          items: parsed.items.filter((item) => item !== null && typeof item === 'object'),
        }
      }
    } catch {
      // No store yet — and none is created until the first entry is written, so
      // merely enabling the feature leaves the disk untouched.
    }
  }

  const saveTempStore = async () => {
    try {
      await mkdir(home, { recursive: true })
      await writeFile(tempPath, JSON.stringify(jsonSafe(tempStore), null, 2), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`user-memory: 临时记忆写入失败 ${tempPath}: ${String(error)}`)
    }
  }

  const openTempCount = () => tempStore.items.filter((item) => item.status === 'open').length

  /**
   * Open entries are immortal — an unfinished handoff is exactly the thing that
   * must survive — while finished ones are capped by age and then by count, so
   * the archive stays readable without a manual cleanup step.
   */
  const pruneTemp = () => {
    const cutoff = Date.now() - TEMP_ARCHIVE_DAYS * 24 * 60 * 60 * 1000
    const open = tempStore.items.filter((item) => item.status !== 'done')
    const finished = tempStore.items
      .filter((item) => item.status === 'done')
      .filter((item) => {
        const at = Date.parse(String(item.doneAt || item.createdAt))
        return Number.isNaN(at) ? true : at >= cutoff
      })
      .slice(-TEMP_ARCHIVE_KEEP)
    tempStore.items = open
      .concat(finished)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  }

  await loadTempStore()

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

  // ---- 临时记忆：模型侧的两个工具 ----------------------------------------------
  //
  // Both exist because the panel cannot be reached from a conversation and the
  // file cannot be edited by hand mid-task. The WRITE side is deliberately
  // gated in its own description — the store must not grow because the model
  // found it useful, which is the whole reason the user asked for a gate.
  const tempTool = {
    name: 'temp_memory',
    description:
      '把一条「临时记忆」写进跨对话的活跃工作集（会自动注入到之后的每一步上下文里）。**只在用户明确要求时调用**：' +
      '用户说「写临时记忆 / 记到临时记忆 / 交付记忆 / 换会话执行 / 下次对话接着做」，或让你把某件事记下来交给别的对话。' +
      '除此之外一律不要调用——不要在你觉得有用时写，不要自动总结，不要顺手记，否则会吃满用户的上下文预算。' +
      'kind：handoff=交接（给另一个对话的交付信息）、stage=阶段目标（眼下在做的事，减少重复说明）、' +
      'waiting=等待项（等条件满足再执行）。交接条目同时是交付文档，正文可以写长、写全。',
    parameters: toolSchema({
      kind: {
        type: 'string',
        required: true,
        enum: TEMP_KINDS,
        description: '条目类型：handoff / stage / waiting。',
      },
      title: {
        type: 'string',
        required: true,
        description: `一句话标题，写清是什么事（不超过 ${MAX_TEMP_TITLE_CHARS} 字）。`,
      },
      body: {
        type: 'string',
        required: true,
        description:
          '正文，markdown。交接条目按「目标 / 现状 / 下一步 / 关键路径 / 验收标准」写全，它是交付文档；' +
          '等待条目写清「等什么条件」和「条件满足后做什么」。',
      },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          open: { type: 'integer' },
        },
        required: ['id', 'kind', 'status', 'open'],
      },
      render: (args, value) => [
        {
          type: 'text',
          text:
            `临时记忆 #${value.id}（${TEMP_KIND_TITLES[value.kind] || value.kind}）已写入，` +
            `当前活跃 ${value.open} 条。它在下一步上下文里就会出现在「临时记忆」一节；` +
            '做完之后调 temp_memory_done 归档，它才会从注入里消失。',
        },
      ],
    },
    execute: async (args) => {
      if (!tempEnabled) throw new Error('临时记忆未启用：插件配置里的 tempMemory 没有打开')
      const kind = typeof args?.kind === 'string' ? args.kind : ''
      if (!TEMP_KINDS.includes(kind)) throw new Error(`不允许的条目类型：${kind || '(空)'}`)
      const title =
        typeof args?.title === 'string' ? args.title.trim().slice(0, MAX_TEMP_TITLE_CHARS) : ''
      const body = typeof args?.body === 'string' ? args.body.trim() : ''
      if (title === '') throw new Error('标题不能为空')
      if (body === '') throw new Error('正文不能为空（交接条目至少写清目标、现状、下一步）')
      const id = String(tempStore.nextId++)
      const now = new Date().toISOString()
      tempStore.items.push({
        id,
        kind,
        title,
        // A long body is allowed on purpose (a handoff is a delivery document);
        // this only stops a runaway paste.
        body: body.slice(0, MAX_TEMP_BODY_CHARS),
        status: 'open',
        createdAt: now,
        updatedAt: now,
      })
      pruneTemp()
      await saveTempStore()
      await refresh()
      return { id, kind, status: 'open', open: openTempCount() }
    },
  }

  const tempDoneTool = {
    name: 'temp_memory_done',
    description:
      '把一条临时记忆标记为完成并归档：它立刻从注入里消失，这就是「完成即清理」。' +
      '做完一条交接或等待项之后调用；如果决定不做、或条目已经过时，也用它归档，并把原因写进 note。' +
      '不删数据——归档条目仍能在面板里看到，需要时也能恢复。',
    parameters: toolSchema({
      id: { type: 'string', required: true, description: '条目编号，来自临时记忆里的 #编号。' },
      note: {
        type: 'string',
        description: '结果一句话：做完了什么、交付物在哪，或为什么不做。',
      },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          open: { type: 'integer' },
        },
        required: ['id', 'status', 'open'],
      },
      render: (args, value) => [
        {
          type: 'text',
          text: `临时记忆 #${value.id} 已归档，当前活跃 ${value.open} 条。`,
        },
      ],
    },
    execute: async (args) => {
      const id = typeof args?.id === 'string' ? args.id : String(args?.id ?? '')
      const item = tempStore.items.find((entry) => entry.id === id)
      if (item === undefined) throw new Error(`找不到临时记忆 #${id}`)
      item.status = 'done'
      item.note = typeof args?.note === 'string' ? args.note.trim().slice(0, 1000) : ''
      item.doneAt = new Date().toISOString()
      // Prune here too, not only on create: otherwise archiving is the one write
      // that can push the store one entry past its own cap.
      pruneTemp()
      await saveTempStore()
      await refresh()
      return { id, status: item.status, open: openTempCount() }
    },
  }

  // `ctx.tools.register` is the same seat `@nanmicoder/dsh-agent-teams` uses
  // (`lib/tools.js:572`). The earlier `ctx.inject(['tools'], (scope) =>
  // scope.get('tools'))` form registered nothing at runtime — the tool never
  // appeared in the Agent's catalog while the plugin fiber still reported
  // `active` — so the registry is now a declared hard dependency.
  // With the feature off the tool catalog is exactly 0.6.0's: a model that never
  // heard of 临时记忆 has no reason to write one.
  const toolDefinitions = tempEnabled
    ? [suggestTool, doneTool, tempTool, tempDoneTool]
    : [suggestTool, doneTool]
  for (const definition of toolDefinitions) {
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
  // The temp working set is its own section with its own budget, so it needs its
  // own published string; both are refreshed together by `reload`.
  let tempText = ''

  // Reads the files and republishes `text`. Never called concurrently with
  // itself: `refresh` guards it, and the switch action awaits it directly.
  const reload = async () => {
    switchState = await readSwitch()
    autoCapture = switchState === null ? configAutoCapture : switchState
    const parts = []
    for (const spec of SECTIONS) {
      const raw = await readFile(join(dir, spec.file), 'utf8').catch(() => '')
      const body = stripComments(raw)
      if (meaningful(body)) parts.push({ title: spec.title, body })
    }
    text = render(parts, maxChars) + (autoCapture ? AUTO_CAPTURE_NOTICE : '')
    // The temp store lives in this process, exactly like the suggestion store:
    // it is not re-read from disk on every poll. A hand edit of the JSON lands at
    // the next restart, which is the same rule the waiting area already follows
    // (and why the panel, not the editor, is the supported way to change it).
    tempText = tempEnabled ? renderTemp(tempStore.items, tempMaxChars, tempPath) : ''
  }

  const refresh = async () => {
    // Single-flight: the panel's own actions also call this, and a poll may
    // already be running. Overlapping runs could publish an older file's text
    // (a real ordering hazard, not a theoretical one, since both legs await
    // reads). A skipped round is fine — the next poll is 3 s away.
    if (refreshing) return
    refreshing = true
    try {
      await reload()
    } catch (error) {
      ctx.logger?.warn?.(`user-memory: read failed, keeping previous text: ${String(error)}`)
    } finally {
      refreshing = false
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

  // A SECOND section rather than one more heading inside the first. Two reasons,
  // and neither is cosmetic: the long-term block's preamble says it is written by
  // the user (untrue for entries a model wrote), and its `maxChars` budget is the
  // user's own — working notes must not spend it.
  // `interpolate: false`, because this text is written BY a model or typed by the
  // user at runtime: nothing in it should ever be expanded as a template.
  if (tempEnabled) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: TEMP_SECTION_NAME,
        order: TEMP_SECTION_ORDER,
        interpolate: false,
        text: () => tempText,
      }),
    )
  }

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
      return Response.json({
        ok: true,
        dir,
        files,
        suggestFile: suggestPath,
        // `source` tells the panel WHY the switch reads the way it does, so a
        // profile that turned it on in the config is not displayed as "off".
        autoCapture: { on: autoCapture, source: switchState === null ? 'config' : 'panel' },
        // The working set rides along in the same round trip so the panel can
        // show its own tab (path, budget state, how many are still open).
        temp: { enabled: tempEnabled, path: tempPath, open: openTempCount() },
      })
    }

    // Read the waiting area. The agent can only ever add to it; only the panel
    // can decide.
    if (action === 'suggestions') {
      return Response.json({ ok: true, items: store.items, pending: pendingCount() })
    }

    // The auto-capture switch. It writes exactly one word to one file this
    // plugin owns, then refreshes so the change reaches the NEXT model step
    // rather than waiting out the poll — the point of a switch is that flipping
    // it does something visible immediately.
    if (action === 'autoCapture') {
      const want = payload?.on
      if (typeof want !== 'boolean') {
        return Response.json({ ok: false, error: '开关状态必须是布尔值' }, { status: 400 })
      }
      try {
        await mkdir(home, { recursive: true })
        await writeFile(switchPath, want ? 'on\n' : 'off\n', 'utf8')
      } catch (error) {
        ctx.logger?.warn?.(`user-memory: switch write failed ${switchPath}: ${String(error)}`)
        return Response.json({ ok: false, error: '写入开关失败，请查看日志' }, { status: 500 })
      }
      // Publish the new state before reloading: the section provider is
      // synchronous and could be read mid-reload, so this keeps the switch and
      // the injected notice from ever disagreeing. `reload` is called directly
      // rather than through `refresh`, because a poll holding the single-flight
      // guard would make `refresh` skip and leave the old text in place.
      switchState = want
      autoCapture = want
      try {
        await reload()
      } catch (error) {
        ctx.logger?.warn?.(`user-memory: switch reload failed: ${String(error)}`)
      }
      return Response.json({ ok: true, autoCapture: { on: autoCapture, source: 'panel' } })
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
          return Response.json({ ok: false, error: '这条还在等用户决定，不需要撤销。' }, { status: 409 })
        }
        if (item.status !== 'accepted') {
          const reason =
            item.status === 'delivered'
              ? '这条已经交到下一轮了（AI 已经收到），无法撤销；可以在对话里直接让 AI 别写。'
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

    // ---- 临时记忆：面板侧的读写 --------------------------------------------------
    //
    // The agent's path is the two tools above. These actions exist for the panel:
    // the user adds, corrects, finishes and deletes entries without going through
    // a conversation, and without hand-editing a JSON file mid-task.
    if (action === 'tempLoad') {
      return Response.json({
        ok: true,
        enabled: tempEnabled,
        path: tempPath,
        items: tempStore.items,
        open: openTempCount(),
      })
    }

    if (action === 'tempSave') {
      if (!tempEnabled) {
        return Response.json({ ok: false, error: '临时记忆未启用（配置里的 tempMemory）' }, { status: 400 })
      }
      const kind = typeof payload?.kind === 'string' ? payload.kind : ''
      if (!TEMP_KINDS.includes(kind)) {
        return Response.json({ ok: false, error: '不允许的条目类型' }, { status: 400 })
      }
      const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
      const body = typeof payload?.body === 'string' ? payload.body : ''
      if (title === '') return Response.json({ ok: false, error: '标题不能为空' }, { status: 400 })
      if (body.trim() === '') {
        return Response.json({ ok: false, error: '正文不能为空' }, { status: 400 })
      }
      if (body.length > MAX_TEMP_BODY_CHARS) {
        return Response.json(
          { ok: false, error: `正文过长（上限 ${MAX_TEMP_BODY_CHARS} 字符）` },
          { status: 413 },
        )
      }
      const given = payload?.id === undefined || payload?.id === null ? '' : String(payload.id)
      const now = new Date().toISOString()
      let targetId = given
      if (given === '') {
        targetId = String(tempStore.nextId++)
        tempStore.items.push({
          id: targetId,
          kind,
          title: title.slice(0, MAX_TEMP_TITLE_CHARS),
          body,
          status: 'open',
          createdAt: now,
          updatedAt: now,
        })
      } else {
        const item = tempStore.items.find((entry) => entry.id === given)
        if (item === undefined) {
          return Response.json({ ok: false, error: `找不到临时记忆 #${given}` }, { status: 404 })
        }
        item.kind = kind
        item.title = title.slice(0, MAX_TEMP_TITLE_CHARS)
        item.body = body
        item.updatedAt = now
      }
      pruneTemp()
      await saveTempStore()
      await refresh()
      return Response.json({ ok: true, id: targetId, items: tempStore.items, open: openTempCount() })
    }

    // 归档 is the action that removes an entry from the prompt; 删除 only touches
    // the disk. Keeping them separate is what lets "完成后及时清理" be undone.
    if (action === 'tempDone') {
      const id = typeof payload?.id === 'string' ? payload.id : String(payload?.id ?? '')
      const item = tempStore.items.find((entry) => entry.id === id)
      if (item === undefined) {
        return Response.json({ ok: false, error: `找不到临时记忆 #${id}` }, { status: 404 })
      }
      const done = payload?.done !== false
      item.status = done ? 'done' : 'open'
      item.updatedAt = new Date().toISOString()
      if (done) item.doneAt = item.updatedAt
      else delete item.doneAt
      await saveTempStore()
      await refresh()
      return Response.json({
        ok: true,
        id,
        status: item.status,
        items: tempStore.items,
        open: openTempCount(),
      })
    }

    if (action === 'tempDelete') {
      const id = typeof payload?.id === 'string' ? payload.id : String(payload?.id ?? '')
      const index = tempStore.items.findIndex((entry) => entry.id === id)
      if (index < 0) {
        return Response.json({ ok: false, error: `找不到临时记忆 #${id}` }, { status: 404 })
      }
      tempStore.items.splice(index, 1)
      await saveTempStore()
      await refresh()
      return Response.json({ ok: true, id, items: tempStore.items, open: openTempCount() })
    }

    if (action === 'tempCleanup') {
      const before = tempStore.items.length
      tempStore.items = tempStore.items.filter((item) => item.status !== 'done')
      const removed = before - tempStore.items.length
      await saveTempStore()
      await refresh()
      return Response.json({ ok: true, removed, items: tempStore.items, open: openTempCount() })
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
