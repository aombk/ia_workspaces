# Changelog

All notable changes to this project.

## [Unreleased]

### Added

- **A PDF opens in the reader.** Right-click one in the file tree — *Open PDF* —
  and it appears in a pane beside what you were looking at, rather than in a
  window the system drops on top of everything you had arranged. A datasheet, a
  spec, a drawing set: reading, which is what that pane is already for.

  The pages, the toolbar and the find bar in it belong to the engine's own PDF
  viewer — the pane points it at the file and gets out of the way. **Reload**
  re-fetches for real, which is what a set of drawings that gets regenerated
  wants, and **Open in editor** does what it always did.

  The file is streamed to the pane rather than read into it, so a
  hundred-megabyte drawing set costs the renderer no more than a note does.
  Electron only for now: a host with no viewer of its own keeps the pane, says
  so, and points at the PDF reader the machine already has.

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
