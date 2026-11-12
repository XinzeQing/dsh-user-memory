// Optional headless UI test for the browser half (client.js): it renders the
// real panel component and drives the 补充框 / 撤销采纳 flow the way a browser
// would (click a tab, type, click 采纳 / 撤销采纳, fire the 5s poll).
//
// It needs React + jsdom, which this plugin deliberately does NOT depend on
// (the repository ships zero dependencies and no build step). Point
// UMEM_UI_DEPS at a node_modules directory that has both, and the test runs;
// without it the test skips and exits 0, so CI stays dependency-free:
//
//   mkdir %TEMP%\umem-deps && cd %TEMP%\umem-deps
//   npm init -y && npm install react@19 react-dom@19 jsdom@26
//   set UMEM_UI_DEPS=%TEMP%\umem-deps\node_modules
//   node test/panel-test.mjs
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const DEPS = process.env.UMEM_UI_DEPS

if (DEPS === undefined || DEPS === '' || !existsSync(DEPS)) {
  console.log('SKIP  panel: set UMEM_UI_DEPS to a node_modules dir with react + react-dom + jsdom')
  process.exit(0)
}

const require = createRequire(join(DEPS, 'umem-ui-deps.cjs'))
let JSDOM
try {
  ;({ JSDOM } = require('jsdom'))
} catch (error) {
  console.log('SKIP  panel: react/react-dom/jsdom not resolvable from ' + DEPS + ' (' + error.message + ')')
  process.exit(0)
}

let failures = 0
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failures += 1
}

// `url` gives the document a real origin: without one `window.localStorage`
// throws (opaque origin), and the panel's remember-the-tab path would silently
// fall back to the default instead of being exercised.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const w = dom.window
globalThis.window = w
globalThis.document = w.document
Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true })
globalThis.HTMLElement = w.HTMLElement
globalThis.HTMLTextAreaElement = w.HTMLTextAreaElement
globalThis.Event = w.Event
globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w)
globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// React DOM must be imported only after the DOM globals above exist: imported
// earlier it decides it is running without a document and never wires up
// onChange, so typing into the panel's box would silently do nothing.
const load = async (id) => await import(pathToFileURL(require.resolve(id)).href)
let React
let createRoot
let act
try {
  React = (await load('react')).default
  ;({ createRoot } = await load('react-dom/client'))
} catch (error) {
  console.log('SKIP  panel: react/react-dom not resolvable from ' + DEPS + ' (' + error.message + ')')
  process.exit(0)
}
act = React.act || (await load('react-dom/test-utils')).act

// Deterministic poll: capture the panel's 5s interval instead of waiting.
const intervals = []
globalThis.setInterval = (fn, ms) => {
  intervals.push({ fn, ms })
  return intervals.length
}
globalThis.clearInterval = () => {}

// The host route, stubbed at the JSON boundary: the panel only ever sees `fetch`.
const FILES = ['rules-must.md', 'agent.md', 'profile.md', 'rules-should.md', 'log.md']
let items = []
const sent = []
let lastResolve = null
// Mirrors the host's runtime switch state, so the panel is driven the way the
// real route drives it (including the `source` it reports back).
let capture = { on: false, source: 'config' }
// The 临时记忆 store, mirrored the same way: the panel is only a view over it.
let tempStore = { nextId: 1, items: [] }
const tempOpen = () => tempStore.items.filter((i) => i.status === 'open').length
const tempReply = () => ({
  ok: true,
  enabled: true,
  path: 'C:\\Users\\example\\.dsh\\temp-memory.json',
  // Fresh objects per response, like the real route: the panel is handed a new
  // array every time, so React cannot bail out on an identical reference.
  items: tempStore.items.map((item) => Object.assign({}, item)),
  open: tempOpen(),
})

// The 工作流 / 短期目标 store, mirrored across the route boundary. Definitions
// and picks live in one file on the host; the panel only authors definitions.
let modeStore = { workflows: [], goals: [], defaultWorkflow: '', sessions: {} }
const modeReply = (sessionId = '') => {
  const pick = modeStore.sessions[sessionId] || {}
  const flow = modeStore.workflows.find((i) => i.id === (pick.workflow && pick.workflow !== '__none__' ? pick.workflow : modeStore.defaultWorkflow))
  const goal = modeStore.goals.find((i) => i.id === pick.goal)
  return {
    ok: true,
    path: 'C:\\Users\\example\\.dsh\\memory\\modes.json',
    workflows: modeStore.workflows.map((i) => Object.assign({}, i)),
    goals: modeStore.goals.map((i) => Object.assign({}, i)),
    defaultWorkflow: modeStore.defaultWorkflow,
    sessionId,
    session: { workflow: pick.workflow || '', goal: pick.goal || '' },
    selected: {
      workflow: flow ? flow.id : '',
      workflowName: flow ? flow.name : '',
      goal: goal ? goal.id : '',
      goalName: goal ? goal.name : '',
    },
  }
}

// The 条目 docs the load route hands the panel (0.8.2). The editor is a view over
// these, so the stub has to carry the same shape the host's parseDoc produces.
const docs = {
  'rules-must.md': {
    title: '必须遵守',
    comments: ['<!-- 手写备注 -->'],
    preamble: [],
    groups: [
      {
        title: '硬性要求',
        sep: '\n\n',
        entries: [
          { kind: 'bullet', text: '- 回答短一点。', sep: '\n\n' },
          { kind: 'bullet', text: '- 不许写假大空。', sep: '\n' },
        ],
      },
    ],
  },
}
const reportFor = (file) => ({
  budget: 6000,
  totalChars: 20,
  injectedChars: 10,
  dropped: 1,
  sections: [
    {
      file,
      title: '',
      chars: 20,
      injectedChars: 10,
      fitted: 'partial',
      entries: [
        { entryIndex: 0, chars: 10, fitted: 'full' },
        { entryIndex: 1, chars: 10, fitted: 'dropped' },
      ],
    },
  ],
})

function route(payload) {
  sent.push(payload)
  if (payload.action === 'load') {
    return {
      ok: true,
      dir: 'C:\\Users\\example\\.dsh\\memory',
      files: FILES.map((file) => ({
        file,
        content: '',
        doc: docs[file] || { title: '', comments: [], preamble: [], groups: [] },
        entries: [],
      })),
      injection: reportFor('rules-must.md'),
      autoCapture: capture,
    }
  }
  if (payload.action === 'saveDoc') {
    docs[payload.file] = payload.doc
    return {
      ok: true,
      file: payload.file,
      content: '# 必须遵守\n',
      doc: payload.doc,
      entries: [],
      injection: '已生效：这一节 2 条会整节注入（约 20 字）。',
      report: Object.assign(reportFor(payload.file), { injectedChars: 20, dropped: 0, sections: [{ file: payload.file, title: '', chars: 20, injectedChars: 20, fitted: 'full', entries: [] }] }),
    }
  }
  if (payload.action === 'modesLoad') return modeReply(payload.sessionId || '')
  if (payload.action === 'modeSave') {
    if (payload.id) {
      const item = modeStore[payload.kind === 'goal' ? 'goals' : 'workflows'].find((i) => i.id === payload.id)
      item.name = payload.name
      item.body = payload.body
    } else {
      const id = (payload.kind === 'goal' ? 'g' : 'w') + '-' + String(modeStore.workflows.length + modeStore.goals.length + 1)
      modeStore[payload.kind === 'goal' ? 'goals' : 'workflows'].push({ id, name: payload.name, body: payload.body })
    }
    return modeReply('')
  }
  if (payload.action === 'modeDefault') {
    modeStore.defaultWorkflow = payload.id
    return modeReply('')
  }
  if (payload.action === 'modeDelete') {
    modeStore[payload.kind === 'goal' ? 'goals' : 'workflows'] = modeStore[payload.kind === 'goal' ? 'goals' : 'workflows'].filter((i) => i.id !== payload.id)
    if (modeStore.defaultWorkflow === payload.id) modeStore.defaultWorkflow = ''
    return modeReply('')
  }
  if (payload.action === 'sessionMode') {
    const pick = modeStore.sessions[payload.sessionId] || (modeStore.sessions[payload.sessionId] = {})
    if (payload.id === '') delete pick[payload.kind]
    else pick[payload.kind] = payload.id
    return modeReply(payload.sessionId)
  }
  if (payload.action === 'autoCapture') {
    if (typeof payload.on !== 'boolean') return { ok: false, error: '开关状态必须是布尔值' }
    capture = { on: payload.on, source: 'panel' }
    return { ok: true, autoCapture: capture }
  }
  if (payload.action === 'suggestions') {
    return { ok: true, items, pending: items.filter((i) => i.status === 'pending').length }
  }
  if (payload.action === 'resolveSuggestion') {
    lastResolve = payload
    const item = items.find((i) => i.id === payload.id)
    if (payload.decision === 'accept') {
      item.status = 'accepted'
      item.userNote = typeof payload.note === 'string' ? payload.note.trim() : ''
    } else if (payload.decision === 'decline') {
      item.status = 'declined'
      item.userNote = typeof payload.note === 'string' ? payload.note.trim() : ''
    } else if (payload.decision === 'revoke') {
      if (item.status === 'declined') {
        item.status = 'pending'
        delete item.decidedAt
        delete item.userNote
      } else {
        item.status = 'pending'
        delete item.decidedAt
      }
    } else {
      item.status = 'dismissed'
    }
    return { ok: true, id: payload.id, status: item.status, userNote: item.userNote || '', pending: 0 }
  }
  if (payload.action === 'tempLoad') return tempReply()
  if (payload.action === 'tempSave') {
    const id = payload.id === '' || payload.id === undefined ? String(tempStore.nextId++) : payload.id
    const existing = tempStore.items.find((i) => i.id === id)
    const now = '2026-10-16T00:20:00.000Z'
    if (existing) {
      existing.kind = payload.kind
      existing.title = payload.title
      existing.body = payload.body
      existing.updatedAt = now
    } else {
      tempStore.items.push({
        id,
        kind: payload.kind,
        title: payload.title,
        body: payload.body,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      })
    }
    return Object.assign({ id }, tempReply())
  }
  if (payload.action === 'tempDone') {
    const item = tempStore.items.find((i) => i.id === payload.id)
    if (payload.done === false) {
      item.status = 'open'
      delete item.doneAt
    } else {
      item.status = 'done'
      item.doneAt = '2026-10-16T00:21:00.000Z'
    }
    return tempReply()
  }
  if (payload.action === 'tempDelete') {
    tempStore.items = tempStore.items.filter((i) => i.id !== payload.id)
    return tempReply()
  }
  if (payload.action === 'tempCleanup') {
    tempStore.items = tempStore.items.filter((i) => i.status !== 'done')
    return tempReply()
  }
  return { ok: false, error: 'unknown action' }
}

globalThis.fetch = async (url, init) => ({ json: async () => route(JSON.parse(init.body)) })

// ---- load the real client module -------------------------------------------
let captured = null
w.__ModuleLoader__ = { load(module) { captured = module } }
await import(pathToFileURL(CLIENT).href)

const definition = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
const registered = []
definition.apply({
  slots: {
    inject: (name, cb) => { cb() },
    register: (def, comp) => { registered.push({ def, comp }); return () => {} },
  },
})
const panelEntry = registered.find((r) => r.def.key === 'user-memory')
const sidebarEntry = registered.find((r) => r.def.name === 'sidebar.panellist')
check('client: registers both the main panel and the sidebar entry', Boolean(panelEntry) && Boolean(sidebarEntry))

const Panel = panelEntry.comp
const container = document.createElement('div')
document.body.appendChild(container)
let root = createRoot(container)

const flush = async (fn) => {
  await act(async () => {
    if (fn) await fn()
  })
}
const click = async (el) => {
  check('  (click target exists)', Boolean(el))
  await flush(() => { el.click() })
}
// The tab label carries the pending badge, so match on the leading text.
const buttonByText = (text) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text))
const setValue = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set
const setInputValue = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set
const type = async (el, value) => {
  await flush(() => {
    setValue.call(el, value)
    el.dispatchEvent(new w.Event('input', { bubbles: true }))
  })
}
// The temp form's title is an <input>, not a <textarea>; React listens on the
// same 'input' event either way.
const textType = async (el, value) => {
  await flush(() => {
    setInputValue.call(el, value)
    el.dispatchEvent(new w.Event('input', { bubbles: true }))
  })
}
// Fire the panel's poll. The polled load is async (`void loadTemp()`), so the
// interval handler returns before its state update commits: flush a couple more
// times so the test observes the panel the way the next frame would.
const poll = async () => {
  await flush(() => {
    intervals[intervals.length - 1].fn()
  })
  await flush()
  await flush()
}
const text = () => container.textContent || ''

items = [{ id: '7', file: 'rules-must.md', text: '回答短一点。', why: '用户说了三次', status: 'pending' }]
await flush(() => { root.render(React.createElement(Panel)) })

// The panel must not open on 必须遵守 just because it is the first file: the
// working set is what the user opens it for. (localStorage is empty here, so
// this is the first-visit default.)
check(
  'panel: opens on 临时记忆, not on the first file',
  text().includes('跨对话交接、阶段目标、等待项') && text().includes('临时记忆'),
  (container.querySelector('.umem-hintbar') || {}).textContent || 'MISSING',
)

// ---------- 1. the waiting area opens with a supplement box ----------
await click(buttonByText('待确认'))
check(
  'panel: the chosen tab is remembered for the next open',
  w.localStorage.getItem('dsh-user-memory:active-tab') === '__pending__',
  String(w.localStorage.getItem('dsh-user-memory:active-tab')),
)
const box = container.querySelector('.umem-note')
check('panel: pending card shows a 补充 textarea', box !== null && box.tagName === 'TEXTAREA')
check(
  'panel: the box explains itself and starts empty',
  box.placeholder.includes('补充说明') && box.placeholder.includes('以补充为准') && box.placeholder.includes('点「忽略」则什么都不发') && box.value === '',
)
check('panel: no read-only note line while nothing is written', container.querySelector('.umem-note-ro') === null)
check(
  'panel: a pending card offers 采纳 / 不采纳 / 忽略',
  buttonByText('采纳') !== undefined &&
    buttonByText('不采纳') !== undefined &&
    buttonByText('忽略') !== undefined,
)

// ---------- 2. typing alone writes nothing ----------
await type(box, '  就一句话，别用术语  ')
check('panel: typing sends no request at all', sent.every((p) => p.action !== 'resolveSuggestion'))

// ---------- 3. 采纳 carries the supplement ----------
await click(buttonByText('采纳'))
check(
  'panel: 采纳 sends the typed supplement',
  lastResolve !== null && lastResolve.decision === 'accept' && lastResolve.note === '  就一句话，别用术语  ',
  JSON.stringify(lastResolve),
)
check('panel: the confirmation says it can still be taken back', text().includes('随时可以撤销'))

// ---------- 4. an accepted item shows 撤销采纳 + the recorded supplement ----------
items = [
  {
    id: '7',
    file: 'rules-must.md',
    text: '回答短一点。',
    why: '用户说了三次',
    status: 'accepted',
    userNote: '就一句话，别用术语',
    decidedAt: '2026-10-13T00:00:00.000Z',
  },
]
await poll()
check('panel: an accepted card no longer offers an input box', container.querySelector('.umem-note') === null)
const ro = container.querySelector('.umem-note-ro')
check(
  'panel: the recorded supplement is shown read-only',
  ro !== null && ro.textContent.includes('用户的补充：') && ro.textContent.includes('就一句话，别用术语'),
  ro ? ro.textContent : 'MISSING',
)
check('panel: the accepted card offers 撤销采纳', buttonByText('撤销采纳') !== undefined)
check('panel: the stage label says it can be revoked', text().includes('可撤销'))

// ---------- 5. 撤销采纳 goes back to waiting ----------
await click(buttonByText('撤销采纳'))
check(
  'panel: 撤销采纳 sends decision=revoke',
  lastResolve !== null && lastResolve.decision === 'revoke' && lastResolve.id === '7',
  JSON.stringify(lastResolve),
)
check('panel: the revocation message names the way back', text().includes('已撤销 #7') && text().includes('重新采纳'))
const backBox = container.querySelector('.umem-note')
check(
  'panel: after revoking, the box is back and keeps what was typed',
  backBox !== null && backBox.value === '  就一句话，别用术语  ',
  backBox ? JSON.stringify(backBox.value) : 'MISSING',
)

// ---------- 6. the poll must not wipe a half-written supplement ----------
await type(backBox, '就一句话，别用术语。注意标点')
await poll()
check(
  'panel: the 5s poll keeps the draft the user is typing',
  container.querySelector('.umem-note').value === '就一句话，别用术语。注意标点',
  container.querySelector('.umem-note').value,
)

// ---------- 6.5 不采纳 keeps the supplement, 忽略 does not ----------
// Three decisions, not two: 不采纳 tells the AI "not this" (and why), 忽略 says
// nothing at all. The panel is the only place that distinction exists.
items = [
  {
    id: '8',
    file: 'agent.md',
    text: '少用列表。',
    why: '用户提过两次',
    status: 'pending',
  },
]
await poll()
check(
  'panel: a fresh pending card offers 不采纳 next to 采纳/忽略',
  container.querySelector('.umem-note') !== null && buttonByText('不采纳') !== undefined,
)
await type(container.querySelector('.umem-note'), '不是少用列表，是每条都要能独立看懂')
await click(buttonByText('不采纳'))
check(
  'panel: 不采纳 sends decision=decline with the typed supplement',
  lastResolve !== null &&
    lastResolve.decision === 'decline' &&
    lastResolve.id === '8' &&
    lastResolve.note === '不是少用列表，是每条都要能独立看懂',
  JSON.stringify(lastResolve),
)
check('panel: the message says the rejection reaches the AI', text().includes('不要写这条'))
await poll()
check('panel: a declined card offers 撤销不采纳', buttonByText('撤销不采纳') !== undefined)
check(
  'panel: the declined card promises no memory write',
  text().includes('不会写入记忆'),
  (container.querySelector('.umem-cardfoot') || {}).textContent || 'MISSING',
)

// ---------- 7. once delivered, revoking is gone ----------
items = [
  {
    id: '7',
    file: 'rules-must.md',
    text: '回答短一点。',
    why: '用户说了三次',
    status: 'delivered',
    userNote: '就一句话，别用术语',
    deliveredAt: '2026-10-13T00:10:00.000Z',
  },
]
await poll()
check('panel: a delivered card has no 撤销采纳 button', buttonByText('撤销采纳') === undefined)
check('panel: the delivered card explains why it cannot be revoked', text().includes('已经交给 AI 下一轮了'))

// ---------- 8. the auto-capture switch ----------
// The switch must be usable the moment the panel opens, and must never show a
// state it merely assumes: it renders what the host reported.
const switchButton = () => buttonByText('自动提议提醒：')
check('panel: the switch is visible without opening any tab', switchButton() !== undefined)
check('panel: it shows the state the host reported', switchButton().textContent.includes('已关闭'), switchButton().textContent)
check(
  'panel: a config-driven state says where it came from',
  text().includes('当前状态来自插件配置'),
)

const decidesBeforeSwitch = sent.filter((p) => p.action === 'resolveSuggestion').length
await click(switchButton())
check(
  'panel: clicking it sends on=true',
  sent.some((p) => p.action === 'autoCapture' && p.on === true),
  JSON.stringify(sent.filter((p) => p.action === 'autoCapture')),
)
check('panel: the button flips to 已开启', switchButton().textContent.includes('已开启'), switchButton().textContent)
check(
  'panel: it promises the change applies without a restart',
  text().includes('下一轮对话起'),
)

// An agent proposing something is independent of the switch: turning it on must
// not touch the waiting area.
check(
  'panel: flipping the switch sends no suggestion decision',
  sent.filter((p) => p.action === 'resolveSuggestion').length === decidesBeforeSwitch,
)

await click(switchButton())
check(
  'panel: clicking again sends on=false',
  sent.filter((p) => p.action === 'autoCapture').length === 2 && sent[sent.length - 1].on === false,
  JSON.stringify(sent[sent.length - 1]),
)
check('panel: the button is back to 已关闭', switchButton().textContent.includes('已关闭'), switchButton().textContent)
check('panel: a panel-driven state drops the config wording', !text().includes('当前状态来自插件配置'))

// ---------- 9. the 临时记忆 tab ----------
// It must sit before 待确认 (the pending tab is found by position), show the
// store the host reports, and route every action through the host.
const TAB_LABELS = ['必须遵守', '行为设定', '用户画像', '可选遵守', '变更日志', '临时记忆', '工作流 / 目标', '待确认']
const tabButtons = () =>
  [...container.querySelectorAll('button')].filter((b) =>
    TAB_LABELS.some((t) => b.textContent.trim().startsWith(t)),
  )
const tabIndex = (label) => tabButtons().findIndex((b) => b.textContent.trim().startsWith(label))
check(
  'panel: the 临时记忆 tab is a tab of its own, and 待确认 stays last',
  tabIndex('临时记忆') >= 0 && tabIndex('临时记忆') < tabIndex('待确认') && tabIndex('工作流 / 目标') < tabIndex('待确认') && tabButtons().length === TAB_LABELS.length,
  tabButtons().map((b) => b.textContent.trim()).join(' / '),
)

await click(buttonByText('临时记忆'))
check('panel: an empty store says so, and says why it stays empty', text().includes('临时记忆是空的') && text().includes('只在被明确要求时才写'))
check('panel: the form offers all three kinds', container.querySelectorAll('.umem-select option').length === 3)
const titleBox = container.querySelector('.umem-input')
const bodyBox = container.querySelector('.umem-bigt')
check(
  'panel: the form explains what a handoff entry is for',
  titleBox !== null && bodyBox !== null && bodyBox.placeholder.includes('交付文档'),
)

// Nothing may be written just by typing.
await textType(titleBox, '临时记忆面板')
await type(bodyBox, '## 交给谁\n下一步')
check('panel: typing sends no tempSave', sent.every((p) => p.action !== 'tempSave'))

await click(buttonByText('新增一条'))
check(
  'panel: 新增一条 sends kind+title+body to tempSave as a new entry',
  sent.some(
    (p) => p.action === 'tempSave' && p.id === '' && p.kind === 'handoff' && p.title === '临时记忆面板',
  ),
  JSON.stringify(sent.filter((p) => p.action === 'tempSave')),
)
check('panel: the confirmation names the id and how it goes away', text().includes('已新增 #1') && text().includes('标记完成'))
check('panel: the card renders the entry with its kind label', text().includes('#1') && text().includes('交接'))
check('panel: the open count is shown next to the store path', text().includes('当前活跃 1 条'))
check('panel: a card offers 标记完成 / 编辑 / 删除', buttonByText('标记完成') !== undefined && buttonByText('编辑') !== undefined && buttonByText('删除') !== undefined)

// 编辑 loads the card into the form instead of writing immediately.
await click(buttonByText('编辑'))
check(
  'panel: 编辑 loads the card into the form and says so',
  container.querySelector('.umem-input').value === '临时记忆面板' && text().includes('正在编辑 #1'),
)
check('panel: an editing form offers 保存修改 and 取消编辑', buttonByText('保存修改') !== undefined && buttonByText('取消编辑') !== undefined)
await click(buttonByText('取消编辑'))
check('panel: 取消编辑 restores the 新增 form', buttonByText('新增一条') !== undefined && container.querySelector('.umem-input').value === '')

// 标记完成 is the whole point: it must say the entry leaves the injection.
await click(buttonByText('标记完成'))
check(
  'panel: 标记完成 sends done=true for that id',
  sent.some((p) => p.action === 'tempDone' && p.id === '1' && p.done === true),
  JSON.stringify(sent.filter((p) => p.action === 'tempDone')),
)
check('panel: the message promises the entry leaves the injection but stays', text().includes('立刻从注入里消失') && text().includes('随时能恢复'))
check('panel: an archived card can be 恢复为活跃 again', buttonByText('恢复为活跃') !== undefined)
check('panel: archived entries are listed as no longer injected, with 清空归档', text().includes('归档 1 条（不再注入）') && buttonByText('清空归档') !== undefined)
check('panel: the store holds no open entry now', text().includes('当前活跃 0 条'))

await click(buttonByText('恢复为活跃'))
check(
  'panel: 恢复为活跃 sends done=false',
  sent.some((p) => p.action === 'tempDone' && p.id === '1' && p.done === false),
)
check('panel: the entry is open again', text().includes('当前活跃 1 条'))

await click(buttonByText('标记完成'))
await click(buttonByText('清空归档'))
check(
  'panel: 清空归档 sends tempCleanup and drops the archived card',
  sent.some((p) => p.action === 'tempCleanup') && !text().includes('#1'),
)

// The temp tab polls the host too, so changes made elsewhere show up.
tempStore.items.push({
  id: '9',
  kind: 'waiting',
  title: '等 CI 结果',
  body: '等流水线跑完再继续。',
  status: 'open',
  createdAt: '2026-10-16T00:30:00.000Z',
  updatedAt: '2026-10-16T00:30:00.000Z',
})
check('panel: the store changed behind the panel and nothing moved yet', !text().includes('等 CI 结果'))
await poll()
check('panel: the 5s poll on the temp tab picks up an entry written elsewhere', text().includes('等 CI 结果') && text().includes('等待项'))
check('panel: the tab badge carries the open count', buttonByText('临时记忆').textContent.includes('1'))

// 删除 is the only destructive one: it must say the archive goes too.
await click(buttonByText('删除'))
check(
  'panel: 删除 sends tempDelete and says the archive goes with it',
  sent.some((p) => p.action === 'tempDelete' && p.id === '9') && text().includes('连归档一起'),
)

// ---------- 10. the 工作流 / 短期目标 tab ----------
await click(buttonByText('工作流 / 目标'))
check(
  'panel: the modes tab explains that an empty list changes nothing',
  text().includes('还没有。点下面的按钮写第一条；不写就什么都不影响。') && text().includes('没有默认，不选就完全不加'),
)

await click(buttonByText('＋ 新建工作流'))
check('panel: 新建工作流 opens an empty authoring form', container.querySelector('.umem-input') !== null && container.querySelector('.umem-bigt') !== null)
await textType(container.querySelector('.umem-input'), '硬件模块验证')
await type(container.querySelector('.umem-bigt'), '一次只推进一个模块，用户自己接线。')
check('panel: typing a workflow writes nothing', sent.every((p) => p.action !== 'modeSave'))
await click(buttonByText('保存'))
check(
  'panel: 保存 sends the workflow to modeSave',
  sent.some((p) => p.action === 'modeSave' && p.kind === 'workflow' && p.id === '' && p.name === '硬件模块验证' && p.body.includes('一次只推进一个模块')),
  JSON.stringify(sent.filter((p) => p.action === 'modeSave')),
)
check('panel: the saved workflow is listed with its body', text().includes('硬件模块验证') && text().includes('一次只推进一个模块'))
check('panel: a workflow offers 编辑 / 设为默认 / 删除', buttonByText('设为默认') !== undefined && buttonByText('删除') !== undefined && buttonByText('编辑') !== undefined)

await click(buttonByText('设为默认'))
check(
  'panel: 设为默认 sends modeDefault',
  sent.some((p) => p.action === 'modeDefault' && p.id === 'w-1'),
  JSON.stringify(sent.filter((p) => p.action === 'modeDefault')),
)
check('panel: the default is announced and badged', text().includes('设为默认工作流') && text().includes('默认'))

await click(buttonByText('＋ 新建短期目标'))
await textType(container.querySelector('.umem-input'), '光电赛 A 题')
await type(container.querySelector('.umem-bigt'), '本届光电设计大赛 A 题，宿舍条件验证。')
await click(buttonByText('保存'))
check(
  'panel: a goal goes to modeSave with kind=goal',
  sent.some((p) => p.action === 'modeSave' && p.kind === 'goal' && p.name === '光电赛 A 题'),
)

// ---------- 10.5 the entry editor (0.8.2) ----------
// A file is no longer one big textarea: every 条 is its own card, so the panel can
// say which 条 actually made it into the context and which one did not.
await click(buttonByText('必须遵守'))
const cards = [...container.querySelectorAll('.umem-entry')]
check(
  'panel: a file opens as one card per entry',
  cards.length === 2 && cards.every((card) => card.querySelector('textarea') !== null),
  String(cards.length),
)
check(
  'panel: the entry that did not fit is marked, the one that did is not',
  cards[1].getAttribute('data-fit') === 'dropped' &&
    cards[1].textContent.includes('这次没进上下文') &&
    cards[0].getAttribute('data-fit') === 'full',
  cards.map((card) => card.getAttribute('data-fit')).join(','),
)
check('panel: the section meter states how much of it gets in', text().includes('保留 50%'), text().includes('保留 50%') ? 'ok' : 'missing')
const cardBoxes = [...container.querySelectorAll('.umem-entry textarea')]
await type(cardBoxes[1], '- 不许写假大空，也不许堆套话。')
check('panel: editing a card writes nothing yet', sent.every((p) => p.action !== 'saveDoc'))
await click(buttonByText('保存这一节'))
check(
  'panel: 保存 sends the whole doc through saveDoc',
  sent.some(
    (p) =>
      p.action === 'saveDoc' &&
      p.file === 'rules-must.md' &&
      p.doc.groups[0].entries[1].text === '- 不许写假大空，也不许堆套话。',
  ),
  JSON.stringify(sent.filter((p) => p.action === 'saveDoc')),
)
check('panel: the save message is the host injection report', text().includes('已生效：这一节 2 条'))
check(
  'panel: after saving, the stale "did not fit" badge is gone',
  container.querySelectorAll('.umem-entry')[1].getAttribute('data-fit') === 'full',
)

// ---------- 10.6 设置：隐藏只影响面板，不影响注入 ----------
await click(buttonByText('设置'))
const settingsBoxes = [...container.querySelectorAll('.umem-label input[type=checkbox]')]
check('panel: 设置 lists a checkbox per tab', settingsBoxes.length >= 8, String(settingsBoxes.length))
check('panel: the settings tab itself cannot be hidden', settingsBoxes.some((box) => box.disabled))
await click(buttonByText('简洁'))
check(
  'panel: the 简洁 preset hides 日志 and the working-set tab',
  buttonByText('日志') === undefined && buttonByText('临时记忆') === undefined,
)
check('panel: 设置 stays reachable after hiding things', buttonByText('设置') !== undefined)
check(
  'panel: hiding a tab writes nothing to memory',
  sent.every((p) => p.action !== 'saveDoc' || p.file !== 'log.md'),
)
check(
  'panel: the choice is remembered in localStorage',
  (w.localStorage.getItem('dsh-user-memory:ui') || '').includes('log.md'),
  String(w.localStorage.getItem('dsh-user-memory:ui')),
)
await click(buttonByText('全部'))
check('panel: 全部 brings the hidden tabs back', buttonByText('临时记忆') !== undefined)

// ---------- 10.7 红点开关：提醒归提醒，记忆归记忆 ----------
// The switch lives with the view settings, but it is not about tabs: it decides
// whether the sidebar icon may say "有东西在等你". Off must still keep the queue.
const dotLabel = () => [...container.querySelectorAll('.umem-label')].find((label) => label.textContent.includes('红点'))
check('panel: 设置 offers a red-dot switch', dotLabel() !== undefined)
check(
  'panel: the red-dot switch is the first thing in 设置, not below the fold',
  (container.querySelector('.umem-sectitle') || {}).textContent === '提示',
  (container.querySelector('.umem-sectitle') || {}).textContent || 'MISSING',
)
const dotBox = () => dotLabel() && dotLabel().querySelector('input[type=checkbox]')
check('panel: the red dot is on by default', dotBox() !== null && dotBox().checked === true)
const decidesBeforeDot = sent.filter((p) => p.action === 'resolveSuggestion').length
await flush(() => { dotBox().click() })
check(
  'panel: turning the red dot off is remembered in localStorage',
  (w.localStorage.getItem('dsh-user-memory:ui') || '').includes('"dot":false'),
  String(w.localStorage.getItem('dsh-user-memory:ui')),
)
check('panel: turning it off is not a suggestion decision', sent.filter((p) => p.action === 'resolveSuggestion').length === decidesBeforeDot)
await flush(() => { dotBox().click() })
check(
  'panel: turning it back on is remembered too',
  (w.localStorage.getItem('dsh-user-memory:ui') || '').includes('"dot":true'),
  String(w.localStorage.getItem('dsh-user-memory:ui')),
)

// ---------- 10.8 the sidebar icon carries the dot ----------
// The panel is usually closed; the icon is the only surface that can say "there
// is something waiting". The slot carries no badge prop, so the icon draws it.
items = [
  { id: '9', file: 'log.md', text: '一条待确认', why: '', status: 'pending', createdAt: '2026-11-12T00:00:00.000Z' },
]
const iconHost = document.createElement('div')
document.body.appendChild(iconHost)
const iconRoot = createRoot(iconHost)
await flush(() => { iconRoot.render(React.createElement(sidebarEntry.comp, { size: 16, active: false })) })
await flush()
await flush()
await flush()
check(
  'client: the sidebar icon shows a dot while a suggestion waits',
  iconHost.querySelector('.umem-badge') !== null,
  iconHost.innerHTML.slice(0, 240),
)
await flush(() => {
  w.localStorage.setItem('dsh-user-memory:ui', JSON.stringify({ hidden: [], preset: 'all', dot: false }))
  w.dispatchEvent(new w.Event('umem-ui-changed'))
})
await flush()
await flush()
check(
  'client: the off switch removes the dot but keeps the queue',
  iconHost.querySelector('.umem-badge') === null && items.length === 1,
)
await flush(() => { iconRoot.unmount() })
iconHost.remove()

// ---------- 11. the composer chip falls back to a select ----------
// The primitive menu is not resolvable in this test (and may be missing in an
// older shell), so the chip must still let the user switch modes.
const flowChip = registered.find((r) => r.def.id === 'user-memory-workflow')
check('client: registers a workflow chip in the composer', Boolean(flowChip))
const chipHost = document.createElement('div')
document.body.appendChild(chipHost)
const chipRoot = createRoot(chipHost)
await flush(() => { chipRoot.render(React.createElement(flowChip.comp, { sessionId: 'sess-1' })) })
const chipSelect = chipHost.querySelector('select')
check('panel: the chip falls back to a select without the primitive', chipSelect !== null && chipSelect.options.length >= 3, chipSelect ? chipSelect.options.length : 'MISSING')
const flowOption = [...chipSelect.options].find((o) => o.textContent.includes('硬件模块验证'))
check('panel: the chip lists the authored workflow', flowOption !== undefined)
await flush(() => {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value').set
  setter.call(chipSelect, flowOption.value)
  chipSelect.dispatchEvent(new w.Event('change', { bubbles: true }))
})
check(
  'panel: choosing in the chip sends sessionMode for that session',
  sent.some((p) => p.action === 'sessionMode' && p.sessionId === 'sess-1' && p.kind === 'workflow' && p.id === flowOption.value),
  JSON.stringify(sent.filter((p) => p.action === 'sessionMode')),
)

// ---------- reopen: the last tab survives a re-mount ----------
// The panel is closed and opened again constantly; coming back to 必须遵守 every
// time is what the 临时记忆 default exists to fix. Clicking a plain file tab
// must be remembered too, not only the pseudo-tabs.
await click(buttonByText('必须遵守'))
check(
  'panel: a plain file tab is remembered as well',
  w.localStorage.getItem('dsh-user-memory:active-tab') === 'rules-must.md',
  String(w.localStorage.getItem('dsh-user-memory:active-tab')),
)
await flush(() => { root.unmount() })
container.innerHTML = ''
w.localStorage.setItem('dsh-user-memory:active-tab', 'agent.md')
root = createRoot(container)
await flush(() => { root.render(React.createElement(Panel)) })
check(
  'panel: a reopened panel restores the remembered tab',
  ((container.querySelector('.umem-hintbar') || {}).textContent || '').includes('agent.md'),
  (container.querySelector('.umem-hintbar') || {}).textContent || 'MISSING',
)
w.localStorage.removeItem('dsh-user-memory:active-tab')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
