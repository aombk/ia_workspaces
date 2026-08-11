/**
 * The places a project's copy can live, and what each of them is called.
 *
 * The git panes said "GitHub" in eighty-five places, and for someone whose work
 * is on GitLab every one of them was a lie — a button reading "Send to GitHub"
 * that pushes to a company GitLab is worse than the jargon it was written to
 * avoid, because it is confidently wrong rather than merely opaque. The panes
 * needed a name for "the copy that is not on this machine", and the honest one
 * is whatever the remote actually points at.
 *
 * So: one table, read from the remote's own address. Everything the panes want
 * to say or do about a host comes from here —
 *
 * - **what to call it** in a sentence, so the buttons stop guessing,
 * - **where its "new project" page is**, for the publish flow,
 * - **where one save is on the web**, so a row can be opened in a browser,
 * - **which command-line tool speaks to it**, if any.
 *
 * Deliberately not an API client. Nothing here makes a network request or holds
 * a token; it is string handling over an address git already knows. The one
 * place that talks to a host is `createOnline` in `src/main/git.ts`, and it does
 * it by running the host's own signed-in CLI rather than by holding credentials
 * of ours.
 *
 * `unknown` is a first-class entry rather than a failure. Self-hosted GitLab,
 * Gitea on a NAS, a bare repository on a server over SSH — these are ordinary,
 * and a pane that refuses to name a host it does not recognise is a pane that
 * breaks for exactly the people running their own. An unrecognised host is
 * called by its domain, which is both true and useful.
 */

/** Which known service a remote points at, or `unknown` for everything else. */
export type GitHostId = 'github' | 'gitlab' | 'bitbucket' | 'codeberg' | 'unknown'

export interface GitHost {
  id: GitHostId
  /** What to call it in a sentence: "Send to GitHub". */
  name: string
  /** The domain its hosted service lives on, for matching and for the picker. */
  domain: string
  /**
   * Its page for making a new, empty project.
   *
   * A function rather than a string because most of them accept the name up
   * front, and a page that arrives with the box already filled in is one fewer
   * chance to type a name that does not match the folder.
   */
  newRepoUrl(name: string): string
  /**
   * The command-line tool that can make a project there without a browser.
   *
   * Only two of these exist, and where one is installed and signed in it
   * collapses the whole publish flow into a single button — see `createOnline`.
   */
  cli?: { command: string; label: string }
  /**
   * Whether an unauthenticated visitor can be shown a save at a guessable URL.
   *
   * All four of the hosted services can; a self-hosted one we have never heard
   * of might use any layout at all, and inventing one produces a link that 404s.
   */
  webPaths: boolean
}

/**
 * The hosts the picker offers, in the order it offers them.
 *
 * GitHub first because it is where most first projects go, and `unknown` last
 * because choosing it is a deliberate act — you pick it when you already know
 * the address you are pushing to.
 */
export const GIT_HOSTS: readonly GitHost[] = [
  {
    id: 'github',
    name: 'GitHub',
    domain: 'github.com',
    // `?name=` fills the box. There is no parameter for "make it empty" —
    // empty is already the default, and the publish flow says so in words
    // because ticking "add a README" is the single mistake that turns this
    // whole thing into an error message.
    newRepoUrl: (name) => `https://github.com/new?name=${encodeURIComponent(name)}`,
    cli: { command: 'gh', label: 'GitHub CLI' },
    webPaths: true,
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    domain: 'gitlab.com',
    newRepoUrl: (name) => `https://gitlab.com/projects/new?name=${encodeURIComponent(name)}#blank_project`,
    cli: { command: 'glab', label: 'GitLab CLI' },
    webPaths: true,
  },
  {
    id: 'bitbucket',
    name: 'Bitbucket',
    domain: 'bitbucket.org',
    newRepoUrl: () => 'https://bitbucket.org/repo/create',
    webPaths: true,
  },
  {
    id: 'codeberg',
    name: 'Codeberg',
    domain: 'codeberg.org',
    newRepoUrl: (name) => `https://codeberg.org/repo/create?repo_name=${encodeURIComponent(name)}`,
    webPaths: true,
  },
  {
    id: 'unknown',
    name: 'somewhere else',
    domain: '',
    newRepoUrl: () => '',
    webPaths: false,
  },
]

export function hostById(id: GitHostId): GitHost {
  return GIT_HOSTS.find((h) => h.id === id) ?? GIT_HOSTS[GIT_HOSTS.length - 1]
}

/** What a remote address turns out to be, once it has been read. */
export interface RemoteInfo {
  /** The address exactly as git has it. */
  url: string
  host: GitHost
  /** The domain it actually points at — which for a self-hosted GitLab is not `gitlab.com`. */
  domain: string
  /** `owner/project`, when the address has that shape. */
  owner?: string
  repo?: string
  /** The project's page on the web, when one can be worked out. */
  webUrl?: string
}

/**
 * Reads a git remote address.
 *
 * Three shapes have to work, because git accepts all three and people paste all
 * three:
 *
 *   git@github.com:owner/repo.git        the scp-like one, which is not a URL
 *   ssh://git@github.com/owner/repo.git
 *   https://github.com/owner/repo.git
 *
 * The first is why this is hand-written rather than `new URL()`: `git@host:path`
 * has no scheme and a colon that is not a port, so a URL parser either rejects
 * it or — worse — reads `github.com:owner` as a host and a port number.
 *
 * A domain is matched by suffix so that a company's `gitlab.example.com` is
 * recognised as GitLab, which is the case that matters: those are the users
 * every hardcoded "GitHub" was wrong for.
 */
export function readRemote(url: string): RemoteInfo | null {
  const raw = url.trim()
  if (!raw) return null

  let domain = ''
  let path = ''

  const scp = /^(?:([^@/]+)@)?([^:/@]+):(.+)$/.exec(raw)
  if (raw.includes('://')) {
    const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(raw)
    if (!m) return null
    domain = m[1]
    path = m[2]
  } else if (scp && !raw.startsWith('/') && !/^[a-z]:[\\/]/i.test(raw)) {
    // The Windows guard is not theoretical: `C:/code/thing` is a perfectly good
    // git remote (a folder on this disk), and it matches the scp shape exactly.
    domain = scp[2]
    path = scp[3]
  } else {
    // A plain path — a remote that is another folder. Real, and not a host.
    return null
  }

  const clean = path.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const parts = clean.split('/').filter(Boolean)
  const host =
    GIT_HOSTS.find((h) => h.domain && (domain === h.domain || domain.endsWith(`.${h.domain}`))) ??
    // A self-hosted GitLab is usually called `gitlab.something`, and naming it
    // GitLab is more useful than calling it by its domain — the buttons then
    // say a word the user recognises. Same for the others, harmlessly.
    GIT_HOSTS.find((h) => h.domain && domain.split('.').includes(h.domain.split('.')[0])) ??
    hostById('unknown')

  const owner = parts.length >= 2 ? parts.slice(0, -1).join('/') : undefined
  const repo = parts.length >= 1 ? parts[parts.length - 1] : undefined

  return {
    url: raw,
    host,
    domain,
    owner,
    repo,
    webUrl: owner && repo ? `https://${domain}/${owner}/${repo}` : undefined,
  }
}

/**
 * What to call the copy that is not on this machine, in a sentence.
 *
 * "GitHub" when it is GitHub, the domain when it is a host we do not know, and
 * a deliberately vague phrase when there is no remote at all — because at that
 * point the pane is talking about a place that does not exist yet, and naming
 * one would be picking for the user.
 */
export function hostLabel(remote: RemoteInfo | null | undefined): string {
  if (!remote) return 'the copy online'
  if (remote.host.id !== 'unknown') return remote.host.name
  return remote.domain || 'the copy online'
}

/**
 * Where one save is on the web, or null when there is no way to know.
 *
 * The four hosted services agree on `/<owner>/<repo>/commit/<sha>` — except
 * Bitbucket, which says `commits`. Null rather than a guess for anything else:
 * a link that goes nowhere costs more trust than an absent button.
 */
export function commitWebUrl(remote: RemoteInfo | null | undefined, sha: string): string | null {
  if (!remote?.webUrl || !remote.host.webPaths || !sha) return null
  const segment = remote.host.id === 'bitbucket' ? 'commits' : 'commit'
  return `${remote.webUrl}/${segment}/${sha}`
}

/**
 * A folder name turned into something a host will accept as a project name.
 *
 * Every one of them allows letters, digits, dot, dash and underscore, and none
 * of them allows a space — so a folder called "my new thing" becomes
 * "my-new-thing" rather than being rejected after the user has already left for
 * the browser.
 */
export function suggestRepoName(folder: string): string {
  const base = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return (
    base
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'project'
  )
}
