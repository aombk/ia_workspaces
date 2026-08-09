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
      } catch {
        # PSReadLine too old to have Set-PSReadLineKeyHandler.
      }
    }
  }
} catch {}
