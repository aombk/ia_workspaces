# Shell integration for zsh and bash, on macOS and Linux.
#
# Emits the same five OSC sequences as powershell.ps1 beside it, which is the
# entire contract with the app — oscScanner.ts and osc.rs parse bytes and do not
# care which shell produced them:
#
#   OSC 9;9;"<path>"  current directory, so a restored pane reopens in place
#   OSC 133;D;<code>  the previous command finished, with its exit code
#   OSC 133;A         a new prompt is starting
#   OSC 133;B         end of prompt, start of the input region
#   OSC 133;C         a line was submitted
#   OSC 133;E;<line>  the text of that line, for the terminal-resume setting
#
# One file for two shells and two platforms. The hook mechanism is the only real
# difference — zsh has precmd/preexec built in, bash has PROMPT_COMMAND and a
# DEBUG trap — and keeping that branch here, next to the thing it varies, beats
# a second file to keep in sync. macOS and Linux differ in nothing at all.
#
# Sourced *after* the user's own rc file, so anything their prompt does has
# already happened by the time we look at it.

# Interactive shells only. A scp or a `ssh host command` sources rc files in
# some configurations, and writing escape sequences into that byte stream
# corrupts the transfer.
case $- in
  *i*) ;;
  *) return 0 2>/dev/null || exit 0 ;;
esac

[ "$IAW_SHELL_INTEGRATION" = "0" ] && return 0
[ -n "$__iaw_loaded" ] && return 0
__iaw_loaded=1

# Has a command actually run yet? Without this the first prompt reports a D
# marker for a command that never happened, and the pane shows an exit code
# before the user has typed anything.
__iaw_ran=0

__iaw_esc=$(printf '\033')
__iaw_bel=$(printf '\007')

# The B marker has to sit at the very end of PS1 rather than being printed,
# because it marks the boundary the *input* starts at. Both shells need it
# wrapped in their zero-width markers or every prompt redraw, every reverse
# search and every line wrap miscounts the cursor column by the length of the
# escape sequence.
if [ -n "$ZSH_VERSION" ]; then
  __iaw_b_marker="%{${__iaw_esc}]133;B${__iaw_bel}%}"
else
  __iaw_b_marker="\[${__iaw_esc}]133;B${__iaw_bel}\]"
fi

# Appended on every prompt rather than once at startup, and guarded so it cannot
# accumulate. starship and oh-my-posh rebuild PS1 from scratch inside their own
# precmd hook, which would silently drop a marker we appended only at load time.
# Ours registers last, so it runs last, so it gets the final word.
__iaw_mark_prompt() {
  case "$PS1" in
    *133\;B*) ;;
    *) PS1="${PS1}${__iaw_b_marker}" ;;
  esac
}

__iaw_report_prompt() {
  __iaw_code=$1
  __iaw_out=""

  if [ "$__iaw_ran" = "1" ]; then
    __iaw_out="${__iaw_esc}]133;D;${__iaw_code}${__iaw_bel}"
  fi
  __iaw_ran=1

  # Quoted to match what the PowerShell side emits; stripQuotes handles both.
  __iaw_out="${__iaw_out}${__iaw_esc}]9;9;\"${PWD}\"${__iaw_bel}"
  __iaw_out="${__iaw_out}${__iaw_esc}]133;A${__iaw_bel}"

  printf '%s' "$__iaw_out"
  __iaw_mark_prompt
}

# C says a command started; E carries the line so a reopened pane can put it
# back on the prompt. Multi-line buffers are skipped rather than flattened — a
# heredoc is not something to hand back as one line — and anything long is
# dropped, mirroring the 512-character limit on the PowerShell side.
__iaw_report_command() {
  __iaw_line=$1
  __iaw_out="${__iaw_esc}]133;C${__iaw_bel}"

  case "$__iaw_line" in
    *"$(printf '\n')"*) __iaw_line="" ;;
  esac
  if [ -n "$__iaw_line" ] && [ "${#__iaw_line}" -le 512 ]; then
    __iaw_out="${__iaw_out}${__iaw_esc}]133;E;${__iaw_line}${__iaw_bel}"
  fi

  printf '%s' "$__iaw_out"
}

if [ -n "$ZSH_VERSION" ]; then
  # ------------------------------------------------------------------- zsh

  autoload -Uz add-zsh-hook 2>/dev/null || return 0

  # $? must be read as the very first thing in the hook. Anything else — a
  # local, a test, an assignment — resets it, and the pane would then report
  # success for a command that failed.
  __iaw_zsh_precmd() {
    __iaw_report_prompt $?
  }

  # preexec is handed the full command line as typed, which is exactly what the
  # E marker wants. bash has no equivalent and has to go digging in history.
  __iaw_zsh_preexec() {
    __iaw_report_command "$1"
  }

  add-zsh-hook precmd __iaw_zsh_precmd
  add-zsh-hook preexec __iaw_zsh_preexec

elif [ -n "$BASH_VERSION" ]; then
  # ------------------------------------------------------------------ bash

  # The DEBUG trap fires before every simple command, including each one inside
  # PROMPT_COMMAND, so it needs a latch: arm it when the prompt is drawn, fire
  # once, disarm. Without that, a three-command PROMPT_COMMAND reports three
  # commands started per prompt.
  __iaw_armed=0

  __iaw_bash_debug() {
    # Programmable completion runs commands through this trap too, and a Tab
    # keypress is not a submitted line.
    [ -n "$COMP_LINE" ] && return 0
    [ "$__iaw_armed" = "1" ] || return 0
    __iaw_armed=0

    # `history 1` is the line as typed; BASH_COMMAND is the expanded simple
    # command, which loses pipelines and is wrong for the resume feature. Fall
    # back to it anyway when history is off, since a wrong line beats no C
    # marker — the C is what drives busy-state detection.
    __iaw_raw=$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)
    __iaw_raw=${__iaw_raw#"${__iaw_raw%%[![:space:]]*}"}
    __iaw_raw=${__iaw_raw#* }
    __iaw_report_command "${__iaw_raw:-$BASH_COMMAND}"
  }

  __iaw_bash_prompt() {
    # Same rule as zsh: first statement, before anything can clobber it.
    __iaw_saved=$?
    __iaw_report_prompt $__iaw_saved
    __iaw_armed=1
    # bash 5.0 and earlier let PROMPT_COMMAND's exit status leak into the $?
    # the next command sees. Returning the saved value puts it back.
    return $__iaw_saved
  }

  trap '__iaw_bash_debug' DEBUG

  # Appended, not assigned: a user's existing PROMPT_COMMAND has to keep working,
  # and running after it means we observe the PS1 it may have just rewritten.
  # bash 5.1+ takes an array, which is the form that survives a value containing
  # semicolons.
  if [ "${BASH_VERSINFO[0]}" -gt 5 ] || { [ "${BASH_VERSINFO[0]}" = "5" ] && [ "${BASH_VERSINFO[1]}" -ge 1 ]; }; then
    PROMPT_COMMAND+=(__iaw_bash_prompt)
  else
    PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}__iaw_bash_prompt"
  fi
fi
