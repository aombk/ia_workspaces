# Read before .zshrc, and before zsh knows whether this is an interactive shell.
#
# ZDOTDIR is deliberately *not* restored here: it has to stay pointed at this
# directory until .zshrc has been read, or zsh would go looking for the user's
# .zshrc instead of ours and the integration would never load. .zshrc restores
# it, which is the earliest safe moment.
#
# The save-and-put-back around the user's file is for the case where their own
# .zshenv sets ZDOTDIR — rare, but if it happened we would lose the shell.

if [ -n "$IAW_USER_ZDOTDIR" ] && [ -f "$IAW_USER_ZDOTDIR/.zshenv" ]; then
  __iaw_zdotdir="$ZDOTDIR"
  . "$IAW_USER_ZDOTDIR/.zshenv"
  ZDOTDIR="$__iaw_zdotdir"
  unset __iaw_zdotdir
fi
