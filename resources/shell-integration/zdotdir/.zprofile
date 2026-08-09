# Login shells only, read between .zshenv and .zshrc.
#
# Panes are spawned as login shells because that is how a Mac gets its PATH:
# /etc/zprofile runs path_helper, and /etc/zprofile is global so it runs whatever
# ZDOTDIR says. The user's own ~/.zprofile is not global, though, and pointing
# ZDOTDIR at us is exactly what would skip it — hence this passthrough.
#
# ZDOTDIR stays ours here for the same reason as in .zshenv: .zshrc has not been
# read yet.

if [ -n "$IAW_USER_ZDOTDIR" ] && [ -f "$IAW_USER_ZDOTDIR/.zprofile" ]; then
  __iaw_zdotdir="$ZDOTDIR"
  . "$IAW_USER_ZDOTDIR/.zprofile"
  ZDOTDIR="$__iaw_zdotdir"
  unset __iaw_zdotdir
fi
