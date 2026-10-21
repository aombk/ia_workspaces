/**
 * Files on the operating system's clipboard — the kind Explorer copies.
 *
 * The file tree's Cut, Copy and Paste used to keep their own list and never
 * touch the real clipboard, so they worked between two trees in this app and
 * nowhere else: a file copied here could not be pasted in Explorer, and one
 * copied in Explorer pasted whatever the tree had copied last, or nothing.
 *
 * Electron reads and writes text, images and named custom formats, but not the
 * file list (`CF_HDROP`) or the "was this a cut" flag beside it (`Preferred
 * DropEffect`) — those are the formats Explorer uses. .NET's clipboard does
 * both, and every Windows has it, so the work is done by a short PowerShell
 * script. That costs a few hundred milliseconds per copy or paste, which a
 * deliberate gesture can afford, and it adds no native dependency.
 *
 * Windows only. Elsewhere these answer "not supported" (`null` / `false`) and
 * the tree carries on with its own list, exactly as before.
 */
import { execFile } from 'node:child_process'

/** Explorer's values for `Preferred DropEffect`: copy (with link allowed), and move. */
const EFFECT_COPY = 5
const EFFECT_MOVE = 2

function runPowerShell(script: string, env: Record<string, string>): Promise<string> {
  // `-EncodedCommand` rather than `-Command`: the script goes in as base64 of
  // UTF-16, so nothing in it is ever re-parsed by a command line. The paths
  // travel in the environment, as JSON, for the same reason — no file name,
  // whatever it contains, can become part of the script.
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      // STA: the Windows clipboard is an OLE object, and .NET refuses to touch
      // it from any other kind of thread.
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message))
        else resolve(stdout)
      }
    )
  })
}

const WRITE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$list = New-Object System.Collections.Specialized.StringCollection
foreach ($p in (ConvertFrom-Json $env:IAW_CLIP_PATHS)) { [void]$list.Add([string]$p) }
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($list)
$effect = [BitConverter]::GetBytes([int]$env:IAW_CLIP_EFFECT)
$data.SetData('Preferred DropEffect', (New-Object System.IO.MemoryStream(,$effect)))
# The paths as text as well, so pasting into a terminal or a text field types
# them — the thing this app's own panes always did with a copied file.
$data.SetText($env:IAW_CLIP_TEXT)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
`

const READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$files = [string[]]@([System.Windows.Forms.Clipboard]::GetFileDropList())
$effect = 0
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($data -and $data.GetDataPresent('Preferred DropEffect')) {
  $stream = $data.GetData('Preferred DropEffect')
  if ($stream -is [System.IO.MemoryStream]) {
    $bytes = $stream.ToArray()
    if ($bytes.Length -ge 4) { $effect = [BitConverter]::ToInt32($bytes, 0) }
  }
}
ConvertTo-Json -Compress -InputObject @{ files = $files; effect = $effect }
`

/**
 * Puts files on the clipboard the way Explorer does, cut or copy.
 *
 * False where that is not possible — not Windows, or the clipboard was held by
 * another program for longer than .NET would wait — so the caller knows the
 * copy only exists inside the app.
 */
export async function writeClipboardFiles(paths: string[], mode: 'copy' | 'cut', text: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const files = paths.filter((p) => typeof p === 'string' && p.trim())
  if (!files.length) return false
  try {
    await runPowerShell(WRITE_SCRIPT, {
      IAW_CLIP_PATHS: JSON.stringify(files),
      IAW_CLIP_EFFECT: String(mode === 'cut' ? EFFECT_MOVE : EFFECT_COPY),
      IAW_CLIP_TEXT: text,
    })
    return true
  } catch {
    return false
  }
}

/**
 * The files on the clipboard and whether they were cut, or null when this
 * cannot be known here — which is different from an empty list: an empty list
 * means the clipboard was read and holds no files.
 */
export async function readClipboardFiles(): Promise<{ paths: string[]; mode: 'copy' | 'cut' } | null> {
  if (process.platform !== 'win32') return null
  try {
    const out = (await runPowerShell(READ_SCRIPT, {})).trim()
    const parsed = JSON.parse(out) as { files?: string[] | string | null; effect?: number }
    // PowerShell 5 flattens a one-element array to the element, and a missing
    // list to null, depending on how it was built; take all three.
    const raw = parsed.files
    const paths = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((p) => typeof p === 'string' && p)
    return { paths, mode: (parsed.effect ?? 0) & EFFECT_MOVE ? 'cut' : 'copy' }
  } catch {
    return null
  }
}
