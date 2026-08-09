#!/usr/bin/env bash
#
# ia_workspaces — Linux installer
# by iraisynn attinom — https://iraisynn.attinom.net/
#
# Unpacks the app into iraisynn_attinom/ia_workspaces, either system-wide or
# for the current user, and writes a .desktop entry and a `ia_workspaces`
# command so it can be launched from a menu or a shell.
#
# The AppImage beside this archive needs none of that — it is one file and it
# runs. This is for a machine you keep: a fixed path, a menu entry, and an
# uninstaller that knows what it put where.

set -e

VERSION="@APP_VERSION@"
APP="ia_workspaces"
VENDOR="iraisynn_attinom"

echo ""
echo "  ia_workspaces — Linux Installer"
echo "  by iraisynn attinom"
echo "  version $VERSION"
echo "  ─────────────────────────────────────"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$SCRIPT_DIR/$APP"

if [[ ! -d "$PAYLOAD" ]]; then
    echo "  error: $APP/ not found next to this script." >&2
    echo "  (expected: $PAYLOAD)" >&2
    exit 1
fi

# /opt is where distributions put self-contained third-party applications, and
# ~/.local is the user-level mirror of /usr laid down by the XDG spec. Neither
# is a preference: they are the two paths a Linux user expects to find this at.
SYSTEM_DIR="/opt/$VENDOR/$APP"
USER_DIR="$HOME/.local/share/$VENDOR/$APP"

echo "  Install for:"
echo "    [1] All users           $SYSTEM_DIR   (sudo required)"
echo "    [2] Current user only   $USER_DIR"
echo ""
read -r -p "  Choose [1/2] (default 2): " choice
choice="${choice:-2}"

case "$choice" in
    1) INSTALL_DIR="$SYSTEM_DIR"
       BIN_DIR="/usr/local/bin"
       DESKTOP_DIR="/usr/share/applications"
       ICON_DIR="/usr/share/icons/hicolor/512x512/apps"
       SUDO="sudo" ;;
    2) INSTALL_DIR="$USER_DIR"
       BIN_DIR="$HOME/.local/bin"
       DESKTOP_DIR="$HOME/.local/share/applications"
       ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
       SUDO="" ;;
    *) echo "  invalid choice"; exit 1 ;;
esac

echo ""
read -r -p "  Install to $INSTALL_DIR? Enter another path, or press Enter to accept: " custom
if [[ -n "$custom" ]]; then
    INSTALL_DIR="${custom/#\~/$HOME}"
fi

echo ""
echo "  Installing to $INSTALL_DIR ..."

$SUDO mkdir -p "$INSTALL_DIR"
# Removed rather than copied over: an upgrade that leaves an old chunk of
# Electron behind is a mix of two builds, and it fails in ways nobody can read.
$SUDO rm -rf "${INSTALL_DIR:?}/"*
$SUDO cp -R "$PAYLOAD/." "$INSTALL_DIR/"
$SUDO chmod +x "$INSTALL_DIR/$APP"

# The launcher. A symlink rather than a wrapper script: the app reads its own
# location to find its resources, and a copy in $BIN_DIR would break that.
$SUDO mkdir -p "$BIN_DIR"
$SUDO ln -sf "$INSTALL_DIR/$APP" "$BIN_DIR/$APP"

$SUDO mkdir -p "$ICON_DIR"
if [[ -f "$SCRIPT_DIR/icon.png" ]]; then
    $SUDO cp "$SCRIPT_DIR/icon.png" "$ICON_DIR/$APP.png"
fi

# StartupWMClass matches the WM_CLASS Electron sets from the app name, without
# which the running window docks as a second, nameless icon.
$SUDO mkdir -p "$DESKTOP_DIR"
$SUDO tee "$DESKTOP_DIR/$APP.desktop" >/dev/null <<DESKTOP
[Desktop Entry]
Type=Application
Name=ia_workspaces
GenericName=Terminal
Comment=Workspace-oriented terminal with split panes, a browser, a tree and an editor
Exec=$INSTALL_DIR/$APP %U
Icon=$APP
Terminal=false
Categories=Development;System;TerminalEmulator;
StartupWMClass=ia_workspaces
DESKTOP

# Best effort: a desktop without these still finds the entry on next login.
command -v update-desktop-database >/dev/null 2>&1 && \
    $SUDO update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
    $SUDO gtk-update-icon-cache -f -t "$(dirname "$(dirname "$(dirname "$ICON_DIR")")")" >/dev/null 2>&1 || true

# An uninstaller that knows what this run wrote, rather than a page of
# instructions telling you to remember it.
UNINSTALL="$INSTALL_DIR/uninstall.sh"
$SUDO tee "$UNINSTALL" >/dev/null <<UNINST
#!/usr/bin/env bash
# Removes what install-linux.sh put on this machine.
set -e
echo "Removing $INSTALL_DIR"
rm -rf "$INSTALL_DIR"
rm -f "$BIN_DIR/$APP" "$DESKTOP_DIR/$APP.desktop" "$ICON_DIR/$APP.png"
rmdir --ignore-fail-on-non-empty "\$(dirname "$INSTALL_DIR")" 2>/dev/null || true
echo "Removed. Your workspaces and settings are in \$HOME/.config/ia_workspaces"
echo "and were left alone — delete that folder too if you are done with them."
UNINST
$SUDO chmod +x "$UNINSTALL"

echo "  ✓ Installed: $INSTALL_DIR"
echo "  ✓ Command:   $BIN_DIR/$APP"
echo "  ✓ Menu entry: $DESKTOP_DIR/$APP.desktop"
echo ""
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo "  note: $BIN_DIR is not on your PATH — add it to run 'ia_workspaces' from a shell."
    echo ""
fi
echo "  To remove later:  $UNINSTALL"
echo ""
echo "  Done! Thank you and enjoy :)"
echo ""
