# zsh has no --rcfile.
#
# bash can be handed an rc file on the command line, so its integration is one
# argument. zsh only reads from $ZDOTDIR, so the way in is to point ZDOTDIR at
# this directory, let zsh read these files, and have them hand control straight
# back to the user's real ones. That is what every terminal doing zsh shell
# integration does, for the same reason.
#
# Two environment variables carry the state, both set by the app when it spawns
# the shell: IAW_USER_ZDOTDIR is wherever zsh would have looked without us,
# and IAW_INTEGRATION_SCRIPT is the absolute path to posix.sh. Nothing here is
# templated or generated, so these files ship as-is.
#
# Order is load-bearing. The user's rc runs first and ours second, so that a
# prompt framework has already installed its hooks by the time we install ours —
# and ours, registering last, gets the last word on PS1.

ZDOTDIR="${IAW_USER_ZDOTDIR:-$HOME}"

if [ -f "$ZDOTDIR/.zshrc" ]; then
  . "$ZDOTDIR/.zshrc"
fi

if [ -n "$IAW_INTEGRATION_SCRIPT" ] && [ -f "$IAW_INTEGRATION_SCRIPT" ]; then
  . "$IAW_INTEGRATION_SCRIPT"
fi
