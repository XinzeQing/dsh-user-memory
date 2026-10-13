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

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
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

function route(payload) {
  sent.push(payload)
  if (payload.action === 'load') {
    return {
      ok: true,
      dir: 'C:\\Users\\Adler\\.dsh\\memory',
      files: FILES.map((file) => ({ file, content: '' })),
      autoCapture: capture,
    }
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
    } else if (payload.decision === 'revoke') {
      item.status = 'pending'
      delete item.decidedAt
    } else {
      item.status = 'dismissed'
    }
    return { ok: true, id: payload.id, status: item.status, userNote: item.userNote || '', pending: 0 }
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
const root = createRoot(container)

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
const type = async (el, value) => {
  await flush(() => {
    setValue.call(el, value)
    el.dispatchEvent(new w.Event('input', { bubbles: true }))
  })
}
const poll = () => flush(() => { intervals[intervals.length - 1].fn() })
const text = () => container.textContent || ''

items = [{ id: '7', file: 'rules-must.md', text: '回答短一点。', why: '用户说了三次', status: 'pending' }]
await flush(() => { root.render(React.createElement(Panel)) })

// ---------- 1. the waiting area opens with a supplement box ----------
await click(buttonByText('待确认'))
const box = container.querySelector('.umem-note')
check('panel: pending card shows a 补充 textarea', box !== null && box.tagName === 'TEXTAREA')
check(
  'panel: the box explains itself and starts empty',
  box.placeholder.includes('补充说明') && box.placeholder.includes('以你的补充为准') && box.value === '',
)
check('panel: no read-only note line while nothing is written', container.querySelector('.umem-note-ro') === null)

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
  ro !== null && ro.textContent.includes('你的补充：') && ro.textContent.includes('就一句话，别用术语'),
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
check('panel: the delivered card explains why it cannot be revoked', text().includes('已经交到我下一轮了'))

// ---------- 8. the auto-capture switch ----------
// The switch must be usable the moment the panel opens, and must never show a
// state it merely assumes: it renders what the host reported.
const switchButton = () => buttonByText('自动采集记忆：')
check('panel: the switch is visible without opening any tab', switchButton() !== undefined)
check('panel: it shows the state the host reported', switchButton().textContent.includes('已关闭'), switchButton().textContent)
check(
  'panel: a config-driven state says where it came from',
  text().includes('当前状态来自插件配置'),
)

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
check('panel: flipping the switch sends no suggestion decision', sent.every((p) => p.action !== 'resolveSuggestion' || p.id === '7'))

await click(switchButton())
check(
  'panel: clicking again sends on=false',
  sent.filter((p) => p.action === 'autoCapture').length === 2 && sent[sent.length - 1].on === false,
  JSON.stringify(sent[sent.length - 1]),
)
check('panel: the button is back to 已关闭', switchButton().textContent.includes('已关闭'), switchButton().textContent)
check('panel: a panel-driven state drops the config wording', !text().includes('当前状态来自插件配置'))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
