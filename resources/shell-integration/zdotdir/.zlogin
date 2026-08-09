# Login shells only, read last of all — after .zshrc, which has already restored
# ZDOTDIR to the user's own directory. So this one needs no save-and-put-back:
# by now $ZDOTDIR is theirs, and sourcing their .zlogin from it is just the
# normal thing happening slightly later than usual.

if [ -f "$ZDOTDIR/.zlogin" ]; then
  . "$ZDOTDIR/.zlogin"
fi
