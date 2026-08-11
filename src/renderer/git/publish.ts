/**
 * Putting a project that only exists here somewhere it also exists.
 *
 * The workflow this replaces is one almost everybody invents on their own and
 * nobody enjoys: rename the folder, make a project on the website, clone the
 * empty thing back down, copy your files into it, and save. It is four extra
 * steps and a folder rename, and people do it because the direct route fails in
 * a way that cannot be read. The direct route is:
 *
 *   git init  →  a save  →  make an EMPTY project online  →  point at it  →  send
 *
 * and the step that ruins it is "empty". Every host offers to add a README, and
 * two of them tick it by default. Take the offer and the project online has a
 * save of its own that yours knows nothing about, so the push is refused with
 * "unrelated histories" — at which point copying your files into a fresh clone
 * genuinely is the shortest way out, and the habit is formed. So the one thing
 * this panel says loudest is: do not tick the README.
 *
 * Two routes, and which one is offered depends on what is installed:
 *
 * - **The tool route.** `gh` and `glab` already hold the user's credentials, so
 *   where one is present and signed in the whole thing is a button. The app
 *   never sees a token, never stores one, and never opens a browser.
 * - **The guided route,** which needs nothing installed and always works. The
 *   host's own "new project" page is opened with the name already filled in,
 *   and the address comes back by paste. This is deliberately the fallback
 *   rather than the thing to be embarrassed about: it is four fields and it
 *   works for a self-hosted Gitea on somebody's NAS.
 *
 * What this will not do is hold a personal access token. That means a secret at
 * rest, a place to put it, a way to revoke it, and a support burden — for a
 * saving of one browser tab over the guided route, on a machine where the two
 * official tools already solve it properly.
 */
import { backend } from '../../backend'
import { GIT_HOSTS, hostById, readRemote, suggestRepoName, type GitHost } from '../../shared/gitHosts'
import type { GitResult, HostTool, RepoStatus } from '../../shared/types'

export interface PublishHooks {
  /** The folder being published. */
  cwd(): string
  status(): RepoStatus | null
  /** Runs an operation with the pane locked and reports it, like every button. */
  run(work: () => Promise<GitResult>, success: string): Promise<void>
  /** Sends the user to the Changes view, for the "make a first save" step. */
  showChanges(): void
}

/**
 * Opens the panel and resolves when it closes.
 *
 * Built as one function holding its own state rather than as a class, because
 * it is a dialog: it exists between an opening and a closing, everything it
 * knows dies with it, and there is nothing to keep in sync with anything else.
 */
export function showPublish(hooks: PublishHooks): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('overlay') as HTMLElement
    const wasOverlayHidden = overlay.hidden
    overlay.hidden = false

    const panel = document.createElement('div')
    panel.className = 'settings-panel publish-panel'
    panel.hidden = false

    const head = document.createElement('div')
    head.className = 'settings-head'
    const title = document.createElement('h2')
    title.textContent = 'Put this project online'
    head.appendChild(title)

    const body = document.createElement('div')
    body.className = 'settings-body publish-body'
    panel.append(head, body)
    document.body.appendChild(panel)

    // -------------------------------------------------------------- state

    let host: GitHost = hostById('github')
    let tools: HostTool[] = []
    let repoName = suggestRepoName(hooks.cwd())
    let isPrivate = true
    let pasted = ''
    let working = false
    /**
     * Set when the user asks for the steps despite having the tool ready.
     *
     * Wanted more often than it looks: the tool is signed in to one account,
     * and this project is going under an organisation, or on the other account,
     * or on a self-hosted instance the tool knows nothing about.
     */
    let forceGuided = false

    const finish = () => {
      window.removeEventListener('keydown', onKey, true)
      panel.remove()
      overlay.hidden = wasOverlayHidden
      resolve()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !working) {
        e.stopPropagation()
        finish()
      }
    }
    window.addEventListener('keydown', onKey, true)

    /** Runs one step, keeping the panel locked and redrawing after. */
    const step = async (work: () => Promise<GitResult>, success: string) => {
      if (working) return
      working = true
      draw()
      try {
        await hooks.run(work, success)
      } finally {
        working = false
        draw()
      }
    }

    // Asked once, on the way in. The answer changes only when somebody installs
    // a program or signs in, neither of which happens while a dialog is open.
    void backend()
      .git.hostTools(hooks.cwd())
      .then((found) => {
        tools = found
        // Start on the host whose tool is ready, when there is one — it is the
        // route with no browser in it, and picking it by hand is a step.
        const ready = found.find((t) => t.signedIn)
        if (ready) host = hostById(ready.host)
        draw()
      })
      .catch(() => {})

    // --------------------------------------------------------------- draw

    function draw(): void {
      body.replaceChildren()
      const status = hooks.status()

      if (!status?.root) return drawUntracked()
      if (status.hasRemote) return drawAlready(status)
      if (!status.lastSave) return drawNoSaves()
      return drawPublish(status)
    }

    /** Step zero: git has never been told about this folder at all. */
    function drawUntracked(): void {
      body.appendChild(
        say(
          `Nothing in ${hooks.cwd()} is being tracked yet. Git is not watching this folder, so there are no saves to put anywhere — ` +
            'the first step is to start watching it. That only creates a hidden folder called .git beside your files. ' +
            'Not one of your files is changed, moved or renamed, and nothing leaves this machine.'
        )
      )
      const go = primary('Start tracking this folder', () =>
        step(() => backend().git.init(hooks.cwd()), 'Tracked. Now make your first save in Changes.')
      )
      body.appendChild(actions(go))
    }

    /** Step one: tracked, but nothing has ever been saved. */
    function drawNoSaves(): void {
      body.appendChild(
        say(
          'This project is being tracked, but nothing has been saved yet — and there is no point making a copy online of nothing. ' +
            'Pick the files you want in Changes and save them once. Then come back here and this will be one button.'
        )
      )
      const go = primary('Take me to Changes', async () => {
        hooks.showChanges()
        finish()
      })
      body.appendChild(actions(go))
    }

    /** Already published: say where, and offer the way to it. */
    function drawAlready(status: RepoStatus): void {
      const remote = readRemote(status.remoteUrl ?? '')
      body.appendChild(
        say(
          `This project already has a copy online, at ${status.remoteUrl}. ` +
            'Sending your saves there is the "Send" button in Changes — this panel is only for the first time.'
        )
      )
      const buttons: HTMLButtonElement[] = []
      if (remote?.webUrl) {
        buttons.push(
          plain('Open it in a browser', () => {
            void backend().openExternal(remote.webUrl!)
          })
        )
      }
      body.appendChild(actions(...buttons))
    }

    /** The real thing: saves exist, nowhere to send them. */
    function drawPublish(status: RepoStatus): void {
      const saves = status.unsent.length || 1
      body.appendChild(
        say(
          `Every save in this project is on this disk and nowhere else. Making a copy online is two things: ` +
            'an empty project on a host, and one line here telling git where it is. This does both, and then sends ' +
            `your ${saves === 1 ? 'save' : `${saves} saves`} to it.`
        )
      )

      body.appendChild(hostPicker())
      body.appendChild(nameRow())
      body.appendChild(visibilityRow())

      const tool = tools.find((t) => t.host === (host.id as 'github' | 'gitlab'))
      if (host.cli && tool?.signedIn && !forceGuided) drawToolRoute(tool)
      else drawGuidedRoute(tool)
    }

    /** One button, because the host's own tool is here and already signed in. */
    function drawToolRoute(tool: HostTool): void {
      body.appendChild(
        note(
          `${tool.label} is installed here and you are signed in, so none of this needs a browser. ` +
            `This makes the project on ${host.name} and sends everything to it in one go.`
        )
      )
      const go = primary(
        working ? 'Working…' : `Create it on ${host.name} and send everything`,
        () =>
          step(
            () =>
              backend().git.createOnline(hooks.cwd(), {
                command: host.cli!.command,
                name: repoName.trim(),
                private: isPrivate,
              }),
            `Done. ${repoName} is on ${host.name} and your saves are in it.`
          )
      )
      go.disabled = working || !repoName.trim()

      const other = plain('Do it step by step instead', () => {
        // Somebody may want the project under an organisation, or on a second
        // account the tool is not signed in to. The other route is always there.
        forceGuided = true
        draw()
      })
      body.appendChild(actions(go, other))
    }

    /** Two steps and a paste, needing nothing installed. */
    function drawGuidedRoute(tool: HostTool | undefined): void {
      if (host.id === 'unknown') {
        body.appendChild(
          note(
            'Make an empty project wherever it is going — your own server, a company GitLab, a Gitea — then paste its address below. ' +
              'The address is the one you would hand to `git clone`.'
          )
        )
      } else {
        if (tool?.installed && !tool.signedIn) {
          body.appendChild(
            note(
              `${tool.label} is installed here but not signed in. Run \`${host.cli?.command} auth login\` once in the terminal beside this pane ` +
                'and this becomes a single button. Until then, the steps below work.'
            )
          )
        }
        body.appendChild(warning())

        const open = plain(`Open ${host.name} and make an empty one`, () => {
          const url = host.newRepoUrl(repoName.trim() || 'project')
          if (url) void backend().openExternal(url)
        })
        open.classList.add('publish-step')
        body.appendChild(step1(open))
      }

      body.appendChild(pasteRow())

      const remote = readRemote(pasted.trim())
      const go = primary(working ? 'Working…' : 'Connect it and send everything', async () => {
        const url = pasted.trim()
        await step(async () => {
          const set = await backend().git.setOrigin(hooks.cwd(), url)
          if (!set.ok) return set
          return backend().git.send(hooks.cwd())
        }, `Done. Your saves are at ${url}.`)
        // Only close once it has actually worked — a panel that vanishes on a
        // failure takes the address the user just pasted with it.
        if (hooks.status()?.hasRemote) finish()
      })
      go.disabled = working || !remote

      body.appendChild(actions(go, plain('Not now', finish)))

      if (pasted.trim() && !remote) {
        body.appendChild(
          problem(
            'That does not look like a project address. It should look like https://github.com/you/thing.git or git@github.com:you/thing.git — ' +
              'the one the host shows you right after making it.'
          )
        )
      }
    }

    // ------------------------------------------------------------- pieces

    function hostPicker(): HTMLElement {
      const wrap = field('Where is it going?')
      const row = document.createElement('div')
      row.className = 'publish-hosts'
      for (const option of GIT_HOSTS) {
        const chip = document.createElement('button')
        chip.className = 'publish-host' + (option.id === host.id ? ' current' : '')
        chip.textContent = option.name
        const tool = tools.find((t) => t.host === (option.id as 'github' | 'gitlab'))
        if (tool?.signedIn) {
          const ready = document.createElement('span')
          ready.className = 'publish-host__ready'
          ready.textContent = 'one click'
          ready.title = `${tool.label} is signed in, so this needs no browser.`
          chip.appendChild(ready)
        }
        chip.addEventListener('click', () => {
          host = option
          forceGuided = false
          draw()
        })
        row.appendChild(chip)
      }
      wrap.appendChild(row)
      return wrap
    }

    function nameRow(): HTMLElement {
      const wrap = field('What should it be called there?')
      const input = document.createElement('input')
      input.className = 'text-input'
      input.value = repoName
      input.spellcheck = false
      input.addEventListener('input', () => {
        repoName = input.value
        // Not a redraw: that would take the box out from under the cursor. Only
        // the buttons that depend on the name are refreshed.
        for (const btn of body.querySelectorAll<HTMLButtonElement>('.publish-primary')) {
          btn.disabled = working || !repoName.trim()
        }
      })
      wrap.appendChild(input)
      wrap.appendChild(
        note(
          'The folder\'s own name, tidied. Keeping it the same as the folder is worth doing — it is what everything else will assume.'
        )
      )
      return wrap
    }

    function visibilityRow(): HTMLElement {
      const wrap = field('Who can see it?')
      const row = document.createElement('div')
      row.className = 'publish-hosts'
      const make = (label: string, value: boolean, hint: string) => {
        const chip = document.createElement('button')
        chip.className = 'publish-host' + (isPrivate === value ? ' current' : '')
        chip.textContent = label
        chip.title = hint
        chip.addEventListener('click', () => {
          isPrivate = value
          draw()
        })
        row.appendChild(chip)
      }
      // Private first and private by default. A project being published for the
      // first time is being published by somebody who has not thought about
      // whether its history contains a key, and the reversible mistake is the
      // one to default to.
      make('Only me (private)', true, 'Nobody else can see it until you say so. You can make it public later.')
      make('Anyone (public)', false, 'Visible to everybody, including every save you have ever made in it.')
      wrap.appendChild(row)
      return wrap
    }

    function warning(): HTMLElement {
      const el = document.createElement('div')
      el.className = 'publish-warn'
      const strong = document.createElement('strong')
      strong.textContent = 'Leave it completely empty. '
      el.appendChild(strong)
      el.append(
        document.createTextNode(
          `Do not tick "add a README", a licence or a .gitignore. Those make a save of their own on ${host.name}, ` +
            'and then your project and that one have nothing in common and git will refuse to join them. ' +
            'It is the single thing that makes this go wrong, and it is why people end up copying their files into a fresh download instead.'
        )
      )
      return el
    }

    function pasteRow(): HTMLElement {
      const wrap = field(
        host.id === 'unknown' ? 'Its address' : `Then paste the address ${host.name} shows you`
      )
      const input = document.createElement('input')
      input.className = 'text-input'
      input.value = pasted
      input.spellcheck = false
      input.placeholder = `https://${host.domain || 'your-host'}/you/${repoName.trim() || 'project'}.git`
      input.addEventListener('input', () => {
        const was = !!readRemote(pasted.trim())
        pasted = input.value
        const now = !!readRemote(pasted.trim())
        // Redrawn only when the answer to "is this usable" changed, so typing
        // does not rebuild the field being typed into.
        if (was !== now) {
          draw()
          const again = body.querySelector<HTMLInputElement>('.publish-paste')
          if (again) {
            again.focus()
            again.setSelectionRange(again.value.length, again.value.length)
          }
        }
      })
      input.classList.add('publish-paste')
      wrap.appendChild(input)
      return wrap
    }

    function step1(button: HTMLButtonElement): HTMLElement {
      const wrap = document.createElement('div')
      wrap.className = 'publish-actions publish-actions--step'
      wrap.appendChild(button)
      return wrap
    }

    function field(label: string): HTMLElement {
      const wrap = document.createElement('div')
      wrap.className = 'publish-field'
      const caption = document.createElement('div')
      caption.className = 'publish-field__label'
      caption.textContent = label
      wrap.appendChild(caption)
      return wrap
    }

    function say(value: string): HTMLElement {
      const el = document.createElement('p')
      el.className = 'publish-say'
      el.textContent = value
      return el
    }

    function note(value: string): HTMLElement {
      const el = document.createElement('div')
      el.className = 'publish-note'
      el.textContent = value
      return el
    }

    function problem(value: string): HTMLElement {
      const el = document.createElement('div')
      el.className = 'publish-warn'
      el.textContent = value
      return el
    }

    function primary(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
      const btn = document.createElement('button')
      btn.className = 'btn primary publish-primary'
      btn.textContent = label
      btn.addEventListener('click', () => void onClick())
      return btn
    }

    function plain(label: string, onClick: () => void): HTMLButtonElement {
      const btn = document.createElement('button')
      btn.className = 'btn'
      btn.textContent = label
      btn.addEventListener('click', onClick)
      return btn
    }

    function actions(...buttons: HTMLButtonElement[]): HTMLElement {
      const row = document.createElement('div')
      row.className = 'publish-actions'
      const close = plain('Close', finish)
      row.append(...buttons, close)
      return row
    }

    draw()
  })
}
