# Changelog

All notable changes to this project.

## [Unreleased]

### Added

- **Reconnect a copied folder with git.** A project backed
  up or carried to another machine without its `.git` used to be a dead end —
  download it again, or `git init` a second history that the copy online
  refuses. The Git pane now offers *reconnect with git*:
  it brings the history back and links the branch, without changing a single
  file, so whatever differs shows up in Changes to keep or throw away. The
  address is filled in from `gh` when the folder is named like one of your
  repositories. If anything fails, the folder is left exactly as it was.
- **Rail.** `.rail` files open in the code view with colours made for the
  language: a function's card — `returns:`, `access:`, `requires:` … — sits on
  a faint band of its own so it reads as a label rather than code, `{…}` inside
  text is coloured as the code it is, words like `to` and `result` are keywords
  only where Rail says they are, and the symbols Rail refuses (`==`, `%`, `;` …)
  are marked as errors while you type.

### Fixed

- **Claude Code saves its conversations again.** When the app was restarted
  from inside a Claude Code session, every terminal it opened afterwards
  inherited that session's markers. A `claude` started there took itself for a
  helper of another session and saved nothing, so `/resume` showed only old
  conversations, in every project. New terminals now start without those
  markers. Your own Claude Code settings still pass through.

## [1.2.0] — 2026-10-07

### Added

- **New tab kinds.** The `+` button now opens a menu (Ctrl+T still makes a
  terminal straight away):
  - **Focus** — time spent per project, counted only while the workspace is on
    screen and the window has focus, with the `- [ ]` items of the project's
    `TODO.md` as a to-do list and a 25/5 pomodoro.
  - **Today** — the day across projects: time, commands, failures, commits.
    Opens scoped to this project, with a tick box to widen it.
  - **Canvas** — connected notes saved as Obsidian JSON Canvas `.canvas` files:
    groups, links, colours, search, canvases inside canvases, markdown text.
  - **Prompts** — every prompt you have sent Claude Code, searchable
    (`"phrase"`, `-word`, `project:`, `after:`, `before:`, `has:image`). Picking
    one types it into the terminal without sending it. Read from Claude Code's
    own transcripts; nothing leaves the machine.
- **Command history of its own.** `Ctrl+Alt+H`, or *Command history…* on a
  terminal's right-click. It survives the shell exiting, knows which pane and
  project each line came from, and shows how it went last time — *failed last
  time (exit 1), 2 of 7 runs*. Up/Down at a prompt walk it, and a small control
  in each terminal's corner picks *this terminal*, *this machine* or
  *everywhere*; the choice is kept per pane. Shift+Delete (or the ✕ on a row)
  forgets a command.
  - The **runbook** view inside it ranks this project's commands worst first:
    failing, then flaky, then most used.
  - **Everywhere** means your other machines too, when *Share the commands you
    run between machines* is on. Commands are stripped of obvious secrets and
    encrypted with a passphrase you set; off by default.
- **Relay warnings.** A ⚠ on a workspace when another of your machines has
  unpushed commits or uncommitted files in it — hover for which machine, branch
  and files. Only descriptions travel, never file contents. Uses the same
  *A folder your machines share* setting as shared token counts (renamed from
  *Share token counts between machines*).
- **Image notes.** Paste a screenshot, click or drag to pin numbered notes on
  it, and the terminal gets the path of a marked-up copy plus the notes as
  text — positions included — ready for an agent to read. From the tab's
  right-click, or on every pasted picture with *Pasting a picture opens the
  notes editor*.
- **Turn summary.** When a Claude agent finishes a turn, the pane's top-right
  corner shows the model, context used, files changed, tools run, time taken
  and an estimated cost. *Settings → Agents* turns it off.
- **Programs menu.** A workspace can own desktop programs: launch them, attach
  a running window, and have it leave the screen when you switch away — or sit
  over a chosen pane. macOS (needs Accessibility), Windows, and Linux on X11
  with `xdotool`.
- **Reader pane: PDFs, audio and video.** *Open PDF* opens a PDF in a tab of
  its own with the engine's viewer, streamed so a large drawing set costs no
  more than a note. *Play audio* / *Play video* do the same for common media
  files.
- **Git: sizes before you send.** Every changed file shows its size, warned
  above 50 MB and red above 100 MB — where GitHub stops taking them. Group
  totals, an *Order: name | size* toggle, the push size on the *send* button,
  and a progress bar with files, objects and rate.
  - **Stop** on a running push or fetch, which leaves everything as it was.
  - **On this machine only** in History lists the saves not yet pushed.
  - **Write a first message** drafts a commit message from the picked files,
    locally. Early days — edit what it gives you.
- **Screenplays.** `.fountain` files get their own editor mode with an
  *Outline* of scenes and characters and an *Insert* menu of screenplay
  elements.
- **Markdown:** checklists tick through to the file, ```` ```mermaid ````
  flowcharts render, and `[[wikilinks]]` link notes, with backlinks under each.
- **File tree:** arrow keys move around it (←/→ fold and unfold, Enter opens),
  dragging a row onto a folder moves it (with undo), and hidden files are drawn
  dimmer than the rest.
- **Dragging a file out of the app** hands other programs the file itself, so
  it can go into an upload or an email. *Dragging a file out of the app*
  chooses file, path, or auto.
- **Keep the machine awake while an agent works** — never, on mains power only
  (the default), or always. The screen can still sleep.
- **Memory settings** for long sessions: trim the scrollback of panes you are
  not looking at, release an idle agent's shell (it resumes on the next
  keypress), and draw with the processor instead of the graphics card.
- **Window transparency** is back in the theme editor — terminals only, or the
  whole app — along with an interface font, text size and UI scale.
- **Keyboard:** tabs and workspaces can be reached and moved between with the
  arrow keys, and F2 renames the focused one. Ctrl+scroll (Cmd on macOS) over
  the workspace list zooms it.
- **`iaw open`** lets an agent put a file, page or tab in front of you, and
  `iaw report-agent --progress` / `--failed` draw progress and a red dot on the
  tab.
- **Monitor:** this app's own processes, an optional crypto-prices block, GPU
  memory as a percentage, and drive health on hover (SMART on macOS).
- A dismiss ✕ on the *waiting for you* bar, untitled editor tabs that survive a
  restart, and a new app icon.

### Changed

- The *waiting for you* bar no longer covers the bottom of the terminal.
- One *Delete…* in the file tree's menu; Shift+Del skips the bin.
- Menus say *Show in Finder* / *Reveal in Explorer* / *Show in file manager*
  depending on the platform.
- On macOS, the app finds Homebrew `git` and `gh` when started from the Dock or
  Finder, so publishing to GitHub uses `gh` when it is installed.
- Resizing a split no longer reloads a browser pane beside it, and typing in a
  commit box or editor is no longer pulled back to the terminal by agent output.
- The `claude --resume` lines the app types itself are kept out of history.

### Fixed

- **Token counts were nearly double.** Each reply was counted once per content
  block; totals are recomputed on first launch.
- Pasting a screenshot works on macOS, Windows and Linux, and in an agent pane
  Ctrl+V is left to the agent.
- Up-arrow history could skip the oldest command or recall the wrong one.
- A Claude pane could stay *working* forever after Ctrl+C, and idle panes showed
  a false *waiting for you*.
- The machine could sleep during one long tool call.
- Quitting right after a change could lose it; window size and position no
  longer snap back.
- Closing a pane while it started left an invisible shell running.
- macOS system monitor: no duplicate or hidden volumes, no disk images, network
  figures with a VPN up, and Apple GPU temperature and power.
- Git search results in subfolders opened nothing on macOS and Linux.
- Stopping a push on Windows left git running.
- Emoji such as ⚠️ garbled lines in full-screen programs.
- Pane rename could get stuck and block terminal focus.

### Security

- **One pane acting on another now asks you.** Each pane has its own `iaw`
  token, and reading, typing into or answering another pane's agent shows
  *Allow one pane to act on another?*
- **Browser panes are deny-by-default:** no camera, microphone, location,
  clipboard reads, `file:` URLs, popups or external-protocol launches.
- **Git can't be made to run a repository's programs** when the app reads it:
  `core.fsmonitor` and external diff tools are off for the app's own git calls.
- **Network paths in documents aren't followed**, so a markdown file can't make
  Windows offer your credentials to a server.
- Sockets, tokens, scrollback and closed-pane transcripts are private to your
  user; the renderer is sandboxed; the packaged app ignores `NODE_OPTIONS` and
  `--inspect`.

## [1.1.0] — 2026-08-20

### Added

- A **token stats** tab, per workspace, from the tab strip's right-click, the
  workspace menu or the command palette. It shows what Claude Code has spent in
  that project, counted from the conversation transcripts it already writes on
  this machine. Nothing is sent anywhere to work it out.

  The middle of it is Anthropic's own price table, read back: base input, 5m
  cache writes, 1h cache writes, cache hits & refreshes, and output — each with
  its token count, its published rate per million, and what it came to. Token
  counts are measured; every cost is marked `(est.)`.

  There is deliberately no total-tokens figure. Base input and cache hits are
  priced ten times apart, so adding them together gives a number that is true
  and meaningless — it is why a project could appear to have spent two billion
  of something. The column that adds up is the money.

  Also on the tab: today, this week, the busiest day and when the project was
  last active; which models did the work; the individual conversations, newest
  first, so an expensive chat can be found while you can still do something
  about it; and every folder that counted towards the total, because a session
  started in a subfolder counts towards the workspace above it.
- If you work on the same project from more than one machine, point each at a
  shared folder (Settings → *Share token counts between machines*) and the tab
  adds them up, with a row per machine and when each last reported. Projects are
  matched by their git remote, so the same repository lines up even when it
  lives at a different path on each machine. Only totals are written — a few
  dozen numbers per project, never a conversation. Off until you name a folder.
- **A WSL workspace asks before it starts WSL.** Clicking one whose distribution
  is not running now puts the question first — "Start WSL?", naming the
  distribution the workspace runs in — instead of quietly booting the utility VM
  because you wanted to look at a folder. A distribution that is already running
  is not worth a dialog, so there isn't one.
- **Start and stop WSL from the workspace menu.** Right-click a WSL workspace and
  there is a `WSL · <distro>…` entry: whether it is running, start it, stop it,
  or stop every distribution at once. The reason it exists is memory — a running
  distribution holds its RAM until something stops it, and until now the only way
  to give that back was a terminal and `wsl --shutdown`.
- **A service-status link beside the Claude usage limits**, in the sidebar footer
  and in the top right of the monitor's `claude` block. The percentages answer
  "have I used my limit up"; the other reason Claude goes quiet is an incident at
  Anthropic, and that has one published answer. Offered even when the limits
  cannot be read, which is itself a moment to go and look.

### Changed

- **Show git branch** and **Show tab counts** have moved out of Settings and
  into the sidebar's own right-click, under *Sidebar shows*. What that list
  shows is decided while looking at it.

## 1.0.0

First public release.
