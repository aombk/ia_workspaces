// The interface, driven for real: the built app, its renderer, mouse and keys.
//
//   node tests/ui.e2e.mjs            (after a build — `npm run build` runs it)
//
// Everything else in this folder tests logic with the DOM left out, and that is
// where this app's worst bugs of one week were hiding: a rename field nobody
// could leave, split names that vanished on restart, a focus guard that could
// lock terminals out for good. Each was a fact about what happens on screen
// when a person clicks and types, and the only honest test of that is to click
// and type.
//
// Not named `*.test.mjs`: it needs the *built* app, so it runs after the build
// rather than with the suite that gates it. See `build.mjs`.
//
// ## Nothing of yours is touched
//
// The app is launched with its own home folder and its own Chromium profile, so
// its workspace file, its shell broker, its single-instance lock and the
// `~/.claude` it would read are all inside a temporary folder that is deleted
// afterwards. `IAW_UI_TEST=1` renders the window offscreen and never shows it,
// so a build does not throw a window over whatever you were doing.
//
// ## How it is driven
//
// Chrome's DevTools protocol, over the WebSocket Node already has: no Playwright,
// no Puppeteer, nothing to install. Input goes through `Input.dispatch*`, which
// is the browser's own input path — hit-testing, focus, blur, the lot — rather
// than events built in script, which would skip exactly the parts that broke.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The sandboxing leans on `HOME` deciding where the app keeps everything, and
// the broker clean-up on `ps` showing a process's environment. Both hold on
// macOS, which is where this app is built; elsewhere this says so and stops,
// rather than risk launching a copy that shares your real data folder.
if (process.platform !== 'darwin') {
  console.log('Interface tests skipped: they run on macOS only for now.')
  process.exit(0)
}
if (!fs.existsSync(path.join(root, 'out/electron/main/main.js'))) {
  console.error('Interface tests need a build first: npm run build')
  process.exit(1)
}

/** The Electron binary the project ships with — the one `require('electron')` names. */
const electron = createRequire(import.meta.url)('electron')

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ----------------------------------------------------------------- harness

/** A sandbox: a home folder and a Chromium profile nobody else uses. */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-ui-'))
  const home = path.join(dir, 'home')
  const profile = path.join(dir, 'profile')
  const data = path.join(home, 'Library', 'Application Support', 'ia_workspaces')
  fs.mkdirSync(data, { recursive: true })
  fs.mkdirSync(profile)
  return { dir, home, profile, data }
}

/**
 * One running copy of the app, and a line to its window.
 *
 * Every helper waits for the thing it needs rather than for a fixed time: the
 * renderer rebuilds parts of the page asynchronously, and a sleep long enough
 * for a slow machine is a sleep that makes the suite slow on every machine.
 */
class App {
  static async launch(sandbox) {
    // `.` from the project folder, the way `npm start` launches it — not the
    // absolute path. An absolute folder on the command line means "open this
    // folder" to the app (it is how Finder and Explorer hand one over), so the
    // test would find itself in a new workspace for the repository instead of
    // the one it seeded.
    const child = spawn(electron, ['.', `--user-data-dir=${sandbox.profile}`, '--remote-debugging-port=0'], {
      cwd: root,
      env: { ...process.env, HOME: sandbox.home, IAW_UI_TEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the app never opened its DevTools port\n${log}`)), 30_000)
      const read = (chunk) => {
        log += chunk
        const found = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(log)
        if (found) {
          clearTimeout(timer)
          resolve(found[1])
        }
      }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.on('exit', (code) => reject(new Error(`the app exited (${code}) before it started\n${log}`)))
    })

    const app = new App(child, sandbox)
    try {
      await app.connect(port)
    } catch (error) {
      await app.quit()
      throw error
    }
    return app
  }

  constructor(child, sandbox) {
    this.child = child
    this.sandbox = sandbox
    this.nextId = 0
    this.waiting = new Map()
  }

  async connect(port) {
    this.port = port
    let target
    for (let i = 0; i < 200 && !target; i++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.url.endsWith('renderer/index.html'))
      if (!target) await sleep(100)
    }
    if (!target) throw new Error('the app never opened its window')

    this.ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const settle = this.waiting.get(message.id)
      if (!settle) return
      this.waiting.delete(message.id)
      settle(message)
    })

    // An offscreen page is never the focused window, and a page without focus
    // holds back focus and blur events — which are the very events a rename
    // field lives on. This makes the page behave as the focused one, which it
    // is for anybody actually using the app.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true })

    // Ready means the workspace has been loaded and drawn, not merely that the
    // page exists.
    await this.waitFor(`document.querySelectorAll('.tab').length > 0`, 'the tab strip to be drawn')
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      this.waiting.set(id, (message) =>
        message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)
      )
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Runs an expression in the window and returns its value. */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) {
      throw new Error(`in the window: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
    }
    return res.result.value
  }

  /** Polls an expression until it is truthy. `what` is for the failure message. */
  async waitFor(expression, what, timeout = 8000) {
    const until = Date.now() + timeout
    for (;;) {
      const value = await this.eval(expression).catch(() => undefined)
      if (value) return value
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }

  /** The middle of the first visible element matching `selector`. */
  async centre(selector) {
    const box = await this.waitFor(
      `(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })()`,
      `${selector} to be on screen`
    )
    return box
  }

  async mouse(type, x, y, button = 'left', clickCount = 1) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount })
  }

  async click(selector, { button = 'left', count = 1 } = {}) {
    const { x, y } = await this.centre(selector)
    await this.mouse('mouseMoved', x, y)
    // A double-click is two clicks, the second carrying a count of two —
    // which is what the browser itself sends, and what fires `dblclick`.
    for (let n = 1; n <= count; n++) {
      await this.mouse('mousePressed', x, y, button, n)
      await this.mouse('mouseReleased', x, y, button, n)
    }
  }

  /** Types text as a person would, into whatever has focus. */
  async type(text) {
    await this.send('Input.insertText', { text })
  }

  async press(key) {
    const codes = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, F2: 113 }
    const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /**
   * Makes the store change, and waits until the window has drawn the change.
   *
   * Several of the bugs below only showed while something *else* was changing
   * the store — an agent printing, a shell reporting its folder — and the
   * whole page redrew underneath whatever you were doing. This is the most
   * neutral change a person can make without moving the focus: Cmd+scroll over
   * the workspace list, which zooms the list and saves the setting. Alternates
   * direction so it never runs into either end of the zoom.
   */
  async nudgeStore() {
    const read = `(document.getElementById('workspace-list').style.zoom || '1')`
    const before = await this.eval(read)
    const { x, y } = await this.centre('#workspace-list')
    const deltaY = Number(before) > 1 ? 120 : -120
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 4 })
    await this.waitFor(`${read} !== ${JSON.stringify(before)}`, 'the store change to be drawn')
  }

  /** Waits until the visible tab is split `n` ways. */
  headers(n) {
    return this.waitFor(
      `[...document.querySelectorAll('.pane-header')].filter((h) => h.offsetParent).length === ${n}`,
      `${n} pane headers`
    )
  }

  /** The names on the split's headers, top to bottom. */
  paneTitles() {
    return this.eval(
      `[...document.querySelectorAll('.pane-header')].filter((h) => h.offsetParent).map((h) => h.querySelector('.pane-title')?.textContent ?? null)`
    )
  }

  /**
   * Quits and cleans up after it — including the shell broker.
   *
   * The broker outlives the app by design: it is what keeps your shells running
   * across a restart. So quitting the app leaves it behind, and it is found and
   * ended here by the one thing that is certainly ours — a HOME inside this
   * sandbox. Nothing is killed on a name match alone.
   */
  async quit() {
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
    if (this.child.exitCode === null) {
      const exited = new Promise((r) => this.child.once('exit', r))
      this.child.kill('SIGTERM')
      await Promise.race([exited, sleep(5000)])
      if (this.child.exitCode === null) this.child.kill('SIGKILL')
    }
    killSandboxBrokers(this.sandbox)
  }
}

function killSandboxBrokers(sandbox) {
  let listing = ''
  try {
    listing = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  } catch {
    return
  }
  for (const line of listing.split('\n')) {
    const pid = Number.parseInt(line, 10)
    if (!pid || !line.includes('out/electron/host/host.js')) continue
    try {
      const withEnv = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      if (withEnv.includes(`HOME=${sandbox.home}`)) process.kill(pid, 'SIGTERM')
    } catch {
      // Gone between the listing and the look.
    }
  }
}

// ----------------------------------------------------------------- the suite

/** A workspace with one tab split in two, the top pane already named. */
function seedSplit(sandbox) {
  const doc = {
    version: 4,
    activeWorkspaceId: 'w',
    workspaces: [
      {
        id: 'w',
        name: 'ui test',
        cwd: sandbox.home,
        color: '#7fb069',
        tabs: [
          {
            id: 't',
            customTitle: null,
            panes: [
              { id: 'top', kind: 'terminal', cwd: sandbox.home, autoTitle: '', customTitle: 'seeded-top' },
              { id: 'bottom', kind: 'terminal', cwd: sandbox.home, autoTitle: '' },
            ],
            layout: {
              kind: 'split',
              direction: 'column',
              children: [
                { kind: 'leaf', paneId: 'top' },
                { kind: 'leaf', paneId: 'bottom' },
              ],
              sizes: [0.5, 0.5],
            },
            activePaneId: 'bottom',
          },
          // A terminal beside two panes that are not terminals: a text box to
          // type into and a timer to click. Not shown until a check opens it.
          {
            id: 'f',
            customTitle: 'mixed',
            panes: [
              { id: 'fa', kind: 'terminal', cwd: sandbox.home, autoTitle: '' },
              { id: 'fb', kind: 'search', cwd: sandbox.home, autoTitle: '' },
              { id: 'fc', kind: 'focus', cwd: sandbox.home, autoTitle: '' },
            ],
            layout: {
              kind: 'split',
              direction: 'row',
              children: [
                { kind: 'leaf', paneId: 'fa' },
                { kind: 'leaf', paneId: 'fb' },
                { kind: 'leaf', paneId: 'fc' },
              ],
              sizes: [0.4, 0.3, 0.3],
            },
            activePaneId: 'fa',
          },
        ],
        activeTabId: 't',
      },
      // A second workspace, for walking the list with the arrow keys.
      {
        id: 'w2',
        name: 'second',
        cwd: sandbox.home,
        color: '#5b8bd9',
        tabs: [
          {
            id: 't2',
            customTitle: null,
            panes: [{ id: 'only', kind: 'terminal', cwd: sandbox.home, autoTitle: '' }],
            layout: { kind: 'leaf', paneId: 'only' },
            activePaneId: 'only',
          },
        ],
        activeTabId: 't2',
      },
    ],
  }
  fs.writeFileSync(path.join(sandbox.data, 'workspace.json'), JSON.stringify(doc), 'utf8')
}

const TOP = '.pane-shell[data-pane-id="top"] .pane-title'
const BOTTOM = '.pane-shell[data-pane-id="bottom"] .pane-title'
const INPUT = '.pane-title-input'
const fieldOpen = `!!document.querySelector('${INPUT}')`

const sandbox = makeSandbox()
let app

try {
  console.log('Renaming split panes')
  seedSplit(sandbox)
  app = await App.launch(sandbox)

  // Everything below drives the interface; this is the one check that the
  // thing the interface is for is actually there. Read from the app's own
  // output stream rather than off the screen, because the terminal draws with
  // WebGL and its text is not in the page to be read.
  await check('each pane runs a real shell that answers a command', async () => {
    await app.eval(`window.__shellOut = {}; window.iaw.on.ptyData((p) => { window.__shellOut[p.paneId] = (window.__shellOut[p.paneId] || '') + p.data }); 1`)
    for (const pane of ['top', 'bottom']) {
      await app.waitFor(`window.iaw.pty.write('${pane}', '')`, `a shell in the ${pane} pane`)
      // Arithmetic, so the answer appears nowhere in what was typed: the
      // terminal echoes the command line back, and a check for text the command
      // itself contains would pass without any shell running it.
      await app.eval(`window.iaw.pty.write('${pane}', 'echo $((40+2))-answered\\r')`)
      await app.waitFor(`(window.__shellOut['${pane}'] || '').includes('42-answered')`, `the ${pane} shell to answer`)
    }
  })

  // One pane reaching into another through `iaw`, the way an agent would.
  // The asking pane is the top one; what it asks is to read the bottom one.
  const prompt = `!!document.querySelector('.choice-dialog')`
  const answer = (value) => app.click(`.choice-dialog button[data-choice="${value}"]`)
  const runInTop = (command) => app.eval(`window.iaw.pty.write('top', ${JSON.stringify(command + '\r')})`)
  const topSaid = (text) => `(window.__shellOut['top'] || '').includes(${JSON.stringify(text)})`

  await check('a pane asking to read another waits for you, and Deny refuses it', async () => {
    await runInTop('iaw read-screen --pane bottom; echo "exit-$((1+0))-$?"')
    await app.waitFor(prompt, 'the permission prompt')
    const body = await app.eval(`document.querySelector('.choice-dialog').textContent`)
    assert.match(body, /wants to read what is on the screen of/)
    await answer('deny')
    await app.waitFor(`!${prompt}`, 'the prompt to close')
    // The command failed: `$?` after it was non-zero.
    await app.waitFor(topSaid('exit-1-1'), 'iaw to report it was refused')
  })

  await check('"Always allow" lets it through, and it does not ask again', async () => {
    await runInTop('iaw read-screen --pane bottom >/dev/null; echo "second-$((2+0))-$?"')
    await app.waitFor(prompt, 'the permission prompt')
    await answer('always')
    await app.waitFor(topSaid('second-2-0'), 'the read to succeed')
    await runInTop('iaw read-screen --pane bottom >/dev/null; echo "third-$((3+0))-$?"')
    await app.waitFor(topSaid('third-3-0'), 'the second read to succeed')
    assert.equal(await app.eval(prompt), false, 'it asked again after "always"')
  })

  await check('a name given to a split comes back when the app starts', async () => {
    await app.waitFor(`document.querySelectorAll('.pane-header').length === 2`, 'both headers')
    assert.equal((await app.paneTitles())[0], 'seeded-top')
  })

  await check('double-clicking a name opens a field that has the focus', async () => {
    await app.click(TOP, { count: 2 })
    await app.waitFor(fieldOpen, 'the rename field')
    assert.equal(await app.eval(`document.activeElement?.className`), 'pane-title-input')
  })

  // The bug this suite was started for: the name was saved and the field
  // stayed on screen, already finished, with nothing able to dismiss it.
  await check('Enter keeps the new name and closes the field', async () => {
    await app.type('build')
    await app.press('Enter')
    await app.waitFor(`!${fieldOpen}`, 'the field to close')
    assert.equal((await app.paneTitles())[0], 'build')
  })

  // And its second half: after renaming one pane, the other could not be
  // renamed at all.
  await check('the other pane can be renamed straight after', async () => {
    await app.click(BOTTOM, { count: 2 })
    await app.waitFor(fieldOpen, 'the rename field on the bottom pane')
    await app.type('logs')
    await app.press('Enter')
    await app.waitFor(`!${fieldOpen}`, 'the field to close')
    assert.deepEqual(await app.paneTitles(), ['build', 'logs'])
  })

  await check('Escape leaves the name as it was', async () => {
    await app.click(TOP, { count: 2 })
    await app.waitFor(fieldOpen, 'the rename field')
    await app.type('never kept')
    await app.press('Escape')
    await app.waitFor(`!${fieldOpen}`, 'the field to close')
    assert.deepEqual(await app.paneTitles(), ['build', 'logs'])
  })

  await check('clicking away keeps what was typed, like every rename field', async () => {
    await app.click(TOP, { count: 2 })
    await app.waitFor(fieldOpen, 'the rename field')
    await app.type('server')
    await app.click('.pane-shell[data-pane-id="bottom"] .xterm-screen')
    await app.waitFor(`!${fieldOpen}`, 'the field to close')
    assert.deepEqual(await app.paneTitles(), ['server', 'logs'])
  })

  await check('"Rename pane…" from the right-click menu works the same way', async () => {
    await app.click(BOTTOM, { button: 'right' })
    await app.waitFor(
      `[...document.querySelectorAll('.context-menu button')].some((b) => b.textContent.includes('Rename pane'))`,
      'the context menu'
    )
    await app.eval(
      `[...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.includes('Rename pane')).setAttribute('data-ui-test', 'rename')`
    )
    await app.click('.context-menu button[data-ui-test="rename"]')
    await app.waitFor(fieldOpen, 'the rename field')
    await app.type('tests')
    await app.press('Enter')
    await app.waitFor(`!${fieldOpen}`, 'the field to close')
    assert.deepEqual(await app.paneTitles(), ['server', 'tests'])
  })

  // The guard that keeps a terminal from grabbing focus out of a rename field
  // used to be a counter that a rebuild could leave stuck — after which no
  // terminal could take focus again for the life of the window.
  await check('a terminal can take the focus again after all that renaming', async () => {
    await app.click('.pane-shell[data-pane-id="top"] .xterm-screen')
    await app.waitFor(
      `document.activeElement?.classList.contains('xterm-helper-textarea') && !!document.activeElement.closest('[data-pane-id="top"]')`,
      'the top terminal to have the focus'
    )
  })

  await check('a tab can be renamed the same way', async () => {
    await app.click('.tab .tab-title', { count: 2 })
    await app.waitFor(`!!document.querySelector('.tab-title-input')`, 'the tab rename field')
    await app.type('ui tab')
    await app.press('Enter')
    await app.waitFor(`!document.querySelector('.tab-title-input')`, 'the tab field to close')
    assert.equal(await app.eval(`document.querySelector('.tab .tab-title')?.textContent`), 'ui tab')
  })

  // The other bug of the week: the names were written to disk all along and
  // dropped on the way back in.
  await check('every name survives quitting and starting again', async () => {
    const file = path.join(sandbox.data, 'workspace.json')
    // Saving is debounced; wait until the file says what the screen says.
    const until = Date.now() + 8000
    for (;;) {
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      if (['server', 'tests', 'ui tab'].every((name) => text.includes(`"${name}"`))) break
      if (Date.now() > until) throw new Error('the names never reached the workspace file')
      await sleep(100)
    }
    await app.quit()

    app = await App.launch(sandbox)
    await app.waitFor(`document.querySelectorAll('.pane-header').length === 2`, 'both headers after restart')
    assert.deepEqual(await app.paneTitles(), ['server', 'tests'])
    assert.equal(await app.eval(`document.querySelector('.tab .tab-title')?.textContent`), 'ui tab')
  })

  console.log('\nWhile the store keeps changing')

  // Everything from here runs with the page being redrawn underneath it, the
  // way it is all day while an agent is printing.

  await check('a name being typed for a tab survives the store changing', async () => {
    await app.click('.tab[data-tab-id="f"] .tab-title', { count: 2 })
    await app.waitFor(`!!document.querySelector('.tab-title-input')`, 'the tab rename field')
    await app.type('half typed')
    await app.nudgeStore()
    await app.nudgeStore()
    assert.equal(await app.eval(`document.querySelector('.tab-title-input')?.value`), 'half typed')
    assert.equal(await app.eval(`document.activeElement?.className`), 'tab-title-input')
    await app.press('Escape')
    await app.waitFor(`!document.querySelector('.tab-title-input')`, 'the tab field to close')
  })

  await check('and so does one being typed for a workspace', async () => {
    await app.click('.workspace[data-workspace-id="w"] .workspace-name', { count: 2 })
    await app.waitFor(`!!document.querySelector('.workspace-name-input')`, 'the workspace rename field')
    await app.type('half typed')
    await app.nudgeStore()
    assert.equal(await app.eval(`document.querySelector('.workspace-name-input')?.value`), 'half typed')
    assert.equal(await app.eval(`document.activeElement?.className`), 'workspace-name-input')
    await app.press('Escape')
    await app.waitFor(`!document.querySelector('.workspace-name-input')`, 'the workspace field to close')
  })

  await check('a split of a terminal, a search box and a timer opens', async () => {
    await app.click('.tab[data-tab-id="f"] .tab-title')
    await app.headers(3)
  })

  // The terminal is the active pane and the text box is in the pane beside it.
  // Every store change re-asserted the active pane, and anything inside a pane
  // counted as fair game — so the terminal took the caret back mid-word.
  await check("a store change leaves the caret in another pane's text box", async () => {
    await app.click('.pane-shell[data-pane-id="fb"] .search-input')
    await app.waitFor(`document.activeElement?.classList.contains('search-input')`, 'the search box to have the focus')
    await app.type('needle')
    await app.nudgeStore()
    await sleep(100)
    assert.equal(await app.eval(`document.activeElement?.classList.contains('search-input')`), true)
    assert.equal(await app.eval(`document.querySelector('.pane-shell[data-pane-id="fb"] .search-input').value`), 'needle')
  })

  // A button replaced between the mouse going down and coming up never sees
  // the click, and the timer's pane rebuilt itself on every store change.
  await check('a click held across a store change still lands', async () => {
    const start = '.pane-shell[data-pane-id="fc"] .focus-buttons .btn'
    const { x, y } = await app.centre(start)
    await app.mouse('mouseMoved', x, y)
    await app.mouse('mousePressed', x, y)
    await app.nudgeStore()
    await app.mouse('mouseReleased', x, y)
    await app.waitFor(`!!document.querySelector('.pane-shell[data-pane-id="fc"] .focus-clock.running')`, 'the timer to start')
    await app.click(start)
    await app.waitFor(`!document.querySelector('.pane-shell[data-pane-id="fc"] .focus-clock.running')`, 'the timer to stop')
  })

  await check('the header of the pane you pick lights up, and only that one', async () => {
    const lit = `[...document.querySelectorAll('.pane-shell')].filter((s) => s.offsetParent && s.querySelector(':scope > .pane-header.active')).map((s) => s.dataset.paneId)`
    assert.deepEqual(await app.eval(lit), ['fa'])
    await app.click('.pane-shell[data-pane-id="fb"] .pane-header .pane-grip')
    await app.waitFor(`JSON.stringify(${lit}) === '["fb"]'`, 'only the search pane header to be lit')
  })

  // Resizing wrote the new sizes into the layout without a rebuild, and the
  // tree remembered the layout it was built from — sizes and all — so the next
  // visit found them different and rebuilt everything. A browser pane in the
  // tab reloaded its page for it.
  await check('dragging a divider does not rebuild the tab when you come back to it', async () => {
    await app.eval(`document.querySelector('.pane-shell[data-pane-id="fa"]').dataset.uiMark = 'kept'`)
    const { x, y } = await app.centre('.pane-divider.row')
    await app.mouse('mouseMoved', x, y)
    await app.mouse('mousePressed', x, y)
    await app.mouse('mouseMoved', x + 40, y)
    await app.mouse('mouseReleased', x + 40, y)
    await app.click('.tab[data-tab-id="t"] .tab-title')
    await app.headers(2)
    await app.click('.tab[data-tab-id="f"] .tab-title')
    await app.headers(3)
    assert.equal(await app.eval(`document.querySelector('.pane-shell[data-pane-id="fa"]')?.dataset.uiMark`), 'kept')
  })

  await check('tabs can be walked, opened and renamed from the keyboard', async () => {
    const focused = `(document.activeElement?.dataset?.tabId ?? null)`
    await app.eval(`document.querySelector('.tab[data-tab-id="f"]').focus({ focusVisible: true })`)
    await app.press('ArrowLeft')
    await app.waitFor(`${focused} === 't'`, 'the first tab to have the focus')
    // The strip is rebuilt on every store change; the focus must come back to
    // the tab that had it rather than drop to the page.
    await app.nudgeStore()
    assert.equal(await app.eval(focused), 't')
    await app.press('Enter')
    await app.waitFor(`document.querySelector('.tab.active')?.dataset.tabId === 't'`, 'the first tab to open')
    await app.headers(2)
    assert.equal(await app.eval(focused), 't')
    await app.press('F2')
    await app.waitFor(`document.querySelector('.tab-title-input')?.closest('.tab')?.dataset.tabId === 't'`, 'the rename field on that tab')
    await app.press('Escape')
    await app.waitFor(`!document.querySelector('.tab-title-input')`, 'the tab field to close')
  })

  await check('workspaces can be walked from the keyboard too', async () => {
    const focused = `(document.activeElement?.dataset?.workspaceId ?? null)`
    await app.eval(`document.querySelector('.workspace[data-workspace-id="w"]').focus({ focusVisible: true })`)
    await app.press('ArrowDown')
    await app.waitFor(`${focused} === 'w2'`, 'the second workspace to have the focus')
    await app.nudgeStore()
    assert.equal(await app.eval(focused), 'w2')
    assert.equal(await app.eval(`document.querySelector('.workspace[data-workspace-id="w2"]').tabIndex`), 0)
    await app.press('ArrowUp')
    await app.waitFor(`${focused} === 'w'`, 'the first workspace to have the focus again')
  })
} finally {
  await app?.quit()
  // Retried, and never allowed to replace a real failure: the broker and the
  // GPU process can still be letting go of files for a moment after they are
  // told to stop, and an error about a temporary folder would otherwise be the
  // only thing printed for a test that actually failed above.
  try {
    fs.rmSync(sandbox.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (error) {
    console.warn(`(could not remove ${sandbox.dir}: ${error.code})`)
  }
}

// ------------------------------------------------- the edges of the app
//
// A second sandbox, for the things that only show at the boundary: what a
// web page in the browser pane is allowed to do, and what survives the app
// being closed in the middle of something.

/**
 * A line to a page other than the app's own window — the browser pane's guest.
 * Just enough of `App` to evaluate expressions there.
 */
async function attachGuest(app, matches) {
  let target
  for (let i = 0; i < 100 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${app.port}/json/list`)).json()
    target = list.find((t) => t.type === 'webview' && matches(t.url))
    if (!target) await sleep(100)
  }
  if (!target) throw new Error('the browser pane never loaded its page')
  const guest = Object.create(App.prototype)
  guest.nextId = 0
  guest.waiting = new Map()
  guest.ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    guest.ws.addEventListener('open', resolve, { once: true })
    guest.ws.addEventListener('error', reject, { once: true })
  })
  guest.ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const settle = guest.waiting.get(message.id)
    if (!settle) return
    guest.waiting.delete(message.id)
    settle(message)
  })
  return guest
}

const edge = makeSandbox()
// A page for the browser pane to show, served from this process: the pane
// only loads web addresses, and a page we wrote is one whose every request we
// know about.
const site = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>ui test page</title><p>hello</p>')
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const siteUrl = `http://127.0.0.1:${site.address().port}/`
let edgeApp
let guest

try {
  fs.writeFileSync(
    path.join(edge.data, 'workspace.json'),
    JSON.stringify({
      version: 4,
      activeWorkspaceId: 'e',
      workspaces: [
        {
          id: 'e',
          name: 'edges',
          cwd: edge.home,
          color: '#7fb069',
          activeTabId: 'web',
          tabs: [
            {
              id: 'web',
              customTitle: 'web',
              panes: [{ id: 'page', kind: 'browser', cwd: edge.home, autoTitle: '', url: siteUrl }],
              layout: { kind: 'leaf', paneId: 'page' },
              activePaneId: 'page',
            },
          ],
        },
      ],
    }),
    'utf8'
  )
  edgeApp = await App.launch(edge)

  console.log('\nA web page in the browser pane')

  // Electron's default is to grant every one of these, silently. In an app
  // whose clipboard holds tokens copied out of terminals, the first is the
  // one that matters most.
  await check('is refused the clipboard, camera, microphone, location and notifications', async () => {
    guest = await attachGuest(edgeApp, (url) => url.startsWith(siteUrl))
    await guest.waitFor(`document.title === 'ui test page'`, 'the page to load')
    const states = await guest.eval(`Promise.all(
      ['clipboard-read', 'camera', 'microphone', 'geolocation', 'notifications'].map((name) =>
        navigator.permissions.query({ name }).then((s) => name + ':' + s.state, () => name + ':unsupported')
      )
    )`)
    for (const state of states) assert.match(state, /:(denied|unsupported)$/, state)
    assert.equal(await guest.eval(`Notification.permission`), 'denied')
  })

  await check('cannot leave the web for a file on disk', async () => {
    await guest.eval(`location.href = 'file:///etc/hosts'; 1`).catch(() => {})
    await sleep(500)
    assert.ok((await guest.eval(`location.href`)).startsWith(siteUrl), 'the page navigated to a file')
  })

  console.log('\nClosing the app in the middle of something')

  const file = path.join(edge.data, 'workspace.json')
  const onDisk = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')

  // A quit asks the window for this by name and quits as soon as it returns;
  // the change must be on disk by then, not 250ms later.
  await check('a change still waiting to be saved is saved the moment the app asks', async () => {
    await edgeApp.click('.tab .tab-title', { count: 2 })
    await edgeApp.waitFor(`!!document.querySelector('.tab-title-input')`, 'the tab rename field')
    await edgeApp.type('flushed')
    await edgeApp.press('Enter')
    await edgeApp.eval(`window.__iawFlushState()`)
    // Read at once — no waiting for the debounce, which is the whole point.
    assert.ok(onDisk().includes('"flushed"'), 'the rename was not on disk when the flush returned')
  })

  await check('closing the window saves a change made a moment before', async () => {
    await edgeApp.click('.tab .tab-title', { count: 2 })
    await edgeApp.waitFor(`!!document.querySelector('.tab-title-input')`, 'the tab rename field')
    await edgeApp.type('closed in a hurry')
    await edgeApp.press('Enter')
    // At once, inside the save's 250ms debounce: the window closes, the app
    // quits, and nothing else gets a chance to run.
    await edgeApp.eval(`window.iaw.window.close(); 1`).catch(() => {})
    const exited = new Promise((r) => edgeApp.child.once('exit', r))
    await Promise.race([exited, sleep(8000)])
    assert.ok(onDisk().includes('"closed in a hurry"'), 'the last change was lost when the window closed')
  })
} finally {
  try {
    guest?.ws?.close()
  } catch {
    /* already closed */
  }
  await edgeApp?.quit()
  site.close()
  try {
    fs.rmSync(edge.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (error) {
    console.warn(`(could not remove ${edge.dir}: ${error.code})`)
  }
}

console.log(`\n${passed} checks passed`)
