if ($env:IAW_SHELL_INTEGRATION -eq '0') { return }

# Constrained Language Mode (AppLocker / WDAC) blocks method calls on non-core
# types, which is exactly what the PSReadLine hook below does. A blocked call
# there raises on every single Enter keystroke, so on a locked down machine the
# whole integration is skipped: losing folder tracking is a far better outcome
# than an error per keypress.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { return }

try {
  if (-not $global:__iaw) {
    $global:__iaw = $true
    $global:__iawInner = $function:prompt
    $global:__iawRan = $false
    function global:prompt {
      $__ok = $?
      $__lec = $global:LASTEXITCODE
      $e = [char]27; $b = [char]7
      $out = ''
      if ($global:__iawRan) {
        $code = if ($null -ne $__lec) { $__lec } elseif ($__ok) { 0 } else { 1 }
        $out += "$e]133;D;$code$b"
      }
      $global:__iawRan = $true
      $p = (Get-Location).Path
      $out += "$e]9;9;`"$p`"$b"
      $out += "$e]133;A$b"
      $inner = try { & $global:__iawInner } catch { "PS " + (Get-Location).Path + "> " }
      # The prompt body just ran arbitrary user code - oh-my-posh and starship
      # both invoke cmdlets - which leaves $LASTEXITCODE holding whatever they
      # did last. Put the user's value back, or the next thing they inspect
      # reports on our prompt instead of on their command.
      $global:LASTEXITCODE = $__lec
      $out + $inner + "$e]133;B$b"
    }

    # C marks the submission of a line, which is the only honest way to know a
    # command started: watching the input stream for Enter also fires for every
    # Enter pressed inside a full-screen program. PSReadLine's AcceptLine is the
    # documented hook, and wrapping it leaves custom bindings working.
    if (Get-Module -ListAvailable -Name PSReadLine) {
      Import-Module PSReadLine -ErrorAction SilentlyContinue
      try {
        Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
          # Read before accepting: AcceptLine clears the buffer, and the text of
          # the line is the whole point of the E marker below.
          $__l = $null
          $__c = 0
          try {
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$__l, [ref]$__c)
          } catch { }
          # AcceptLine is the actual Enter behaviour and must not be retried on
          # failure: a second call would submit the line twice. Only the markers
          # are best-effort.
          [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
          # A submitted line ends any walk, so the next Up starts from the
          # newest entry rather than resuming halfway down from where the last
          # one stopped.
          $global:__iawHistAt = -1
          try {
            $__e = [char]27
            $__b = [char]7
            $__o = "$__e]133;C$__b"
            # E carries the line itself, so a reopened pane can put it back on
            # its prompt. Multi-line buffers are skipped rather than flattened:
            # a here-string is not something to hand back as one line.
            if ($__l -and $__l.Length -le 512 -and
                $__l.IndexOf([char]10) -lt 0 -and $__l.IndexOf([char]13) -lt 0) {
              $__o += "$__e]133;E;" + $__l + "$__b"
            }
            [Console]::Write($__o)
          } catch { }
        } -ErrorAction SilentlyContinue

        # ------------------------------------------------------------ history
        #
        # The arrows walk the app's own history rather than PSReadLine's, when
        # the app has written a list for this pane. This is the whole reason the
        # binding lives in here: RevertLine and Insert are the line editor
        # replacing its own line, which is exact. Doing it from outside means
        # writing bytes that look like typing, and then having to send whatever
        # key *this* edit mode reads as "clear the line" — a guess that differs
        # per shell, per mode, and is ambiguous for Escape.
        #
        # Falls back to PSReadLine's own recall whenever there is nothing to
        # walk: no file, an empty file, or a walk that has run off the end. A
        # pane whose shell integration is on but whose history is empty behaves
        # exactly as it did before any of this existed.
        $global:__iawHistFile = if ($env:IAW_HISTORY_DIR -and $env:IAW_PANE_ID) {
          Join-Path $env:IAW_HISTORY_DIR ($env:IAW_PANE_ID + '.txt')
        } else { $null }
        $global:__iawHist = @()
        $global:__iawHistAt = -1

        function global:__iawHistLoad {
          # Re-read at the start of each walk rather than caching for the
          # session: the app rewrites this file when you flip all/this, and a
          # cached list would keep walking the old scope until the pane closed.
          $global:__iawHist = @()
          if ($global:__iawHistFile -and (Test-Path -LiteralPath $global:__iawHistFile)) {
            try {
              $global:__iawHist = @(Get-Content -LiteralPath $global:__iawHistFile -ErrorAction Stop)
            } catch { }
          }
        }

        function global:__iawHistStep([int]$delta) {
          if ($global:__iawHistAt -lt 0) { __iawHistLoad }
          if ($global:__iawHist.Count -eq 0) { return $false }

          $next = $global:__iawHistAt + $delta
          if ($next -lt 0) {
            # Back past the newest entry: the walk is over and the line goes
            # empty, which is where it was before the first Up.
            $global:__iawHistAt = -1
            [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
            return $true
          }
          # Off the oldest end: stay put rather than returning false, which
          # would hand the key to PSReadLine and silently continue the walk
          # through *its* history from the bottom of ours.
          if ($next -ge $global:__iawHist.Count) { $next = $global:__iawHist.Count - 1 }

          $global:__iawHistAt = $next
          [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
          [Microsoft.PowerShell.PSConsoleReadLine]::Insert($global:__iawHist[$next])
          return $true
        }

        try {
          Set-PSReadLineKeyHandler -Key UpArrow -ScriptBlock {
            if (-not (__iawHistStep 1)) {
              [Microsoft.PowerShell.PSConsoleReadLine]::PreviousHistory()
            }
          } -ErrorAction SilentlyContinue

          Set-PSReadLineKeyHandler -Key DownArrow -ScriptBlock {
            if (-not (__iawHistStep -1)) {
              [Microsoft.PowerShell.PSConsoleReadLine]::NextHistory()
            }
          } -ErrorAction SilentlyContinue
        } catch { }
      } catch {
        # PSReadLine too old to have Set-PSReadLineKeyHandler.
      }
    }
  }
} catch {}
