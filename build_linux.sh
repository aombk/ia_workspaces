#!/usr/bin/env bash
# =============================================================================
# build_linux.sh — Configure, build and package ia_workspaces for Linux
# =============================================================================
#
# Output:
#   build/ia_workspaces.AppImage
#
# AppImage rather than .deb or .rpm: it runs on any distribution without being
# installed, which is the same deal the Windows build offers with its portable
# .exe. Nothing here signs anything — Linux has no Gatekeeper equivalent, so
# there is no signing step to skip and no --no-sign flag.
#
# Flags:
#   --clean     Wipe out/ first.
set -uo pipefail

cd "$(dirname "$0")"

DO_CLEAN=0
ASSUME_YES=0
WANT_HOSTS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)   DO_CLEAN=1; shift ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    --hosts)   WANT_HOSTS=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

echo
echo "=== ia_workspaces Linux release build ==="
echo

fail() { echo "[x] $1"; exit 1; }

command -v npm >/dev/null 2>&1 || fail "npm not found on PATH. Nothing can be built without it."

# ---------------------------------------------------------------- which hosts
# Three runtimes now: Electron, the Tauri host (Rust) and the Wails host (Go).
# Enter takes the default, which is yes. --yes skips the asking, and so does a
# run with no terminal attached, so CI builds everything without being told.
DO_ELECTRON=1
# The parked hosts are off unless --hosts asks for them: they are kept in the
# tree and not developed. See src-tauri/README.md.
DO_TAURI=0
DO_WAILS=0

ask() {
  local reply=""
  if [[ $ASSUME_YES -eq 0 && -t 0 ]]; then
    read -r -p "$1 [Y/n] " reply
  fi
  case "$reply" in
    [nN]*) printf -v "$2" '%s' 0 ;;
    *) printf -v "$2" '%s' 1 ;;
  esac
}

if [[ $WANT_HOSTS -eq 1 ]]; then
  DO_TAURI=1
  DO_WAILS=1
  ask "Build the Electron host?" DO_ELECTRON
  ask "Build the Tauri host (Rust, parked)?" DO_TAURI
  ask "Build the Wails host (Go, parked)?" DO_WAILS
fi
[[ $DO_ELECTRON -eq 1 || $DO_TAURI -eq 1 || $DO_WAILS -eq 1 ]] || fail "nothing selected — nothing to build"


if [[ $DO_CLEAN -eq 1 ]]; then
  echo "[*] cleaning out/"
  node tools/clean.mjs || true
fi

[[ -d node_modules ]] || { echo "[*] installing dependencies"; npm install || fail "npm install failed"; }

echo "[*] typecheck"
npm run typecheck || fail "typecheck failed — fix the types before building a release"

echo "[*] tests"
npm test || fail "tests failed — fix them before building a release"

echo "[*] bundling"
node build.mjs || fail "bundle failed"

if [[ $DO_ELECTRON -eq 1 ]]; then
  echo "[*] packaging (AppImage + unpacked tree)"
  npx electron-builder --linux || fail "packaging failed"
fi

# The Rust host, then the Go one. Each builds the renderer itself through its
# own config, so there is nothing to bundle first, and a missing toolchain is a
# skip rather than a failure — the Electron artifact is the one people download.
if [[ $DO_TAURI -eq 1 ]]; then
  if command -v cargo >/dev/null 2>&1; then
    echo "[*] packaging Tauri"
    node build.mjs --hosts && npx --yes @tauri-apps/cli@2 build || fail "the Tauri build failed"
  else
    echo "[!] cargo not found — skipping the Tauri host"
  fi
fi

if [[ $DO_WAILS -eq 1 ]]; then
  if command -v wails3 >/dev/null 2>&1; then
    echo "[*] packaging Wails"
    wails3 build || fail "the Wails build failed"
  else
    echo "[!] wails3 not found — go install github.com/wailsapp/wails/v3/cmd/wails3@latest"
  fi
fi


# ---------------------------------------------------------------- installer
# An archive with an install script beside the AppImage, and they answer
# different questions. The AppImage is one file that runs anywhere; this is for
# a machine you keep — a fixed path under iraisynn_attinom/, a .desktop entry,
# an `ia_workspaces` command, and an uninstaller that knows what it wrote.
#
# A tar.gz rather than a .deb and a .rpm: those are two packaging toolchains,
# two dependency vocabularies and two build hosts for an app that bundles
# everything it needs and depends on nothing the distribution provides.
UNPACKED=""
for candidate in out/electron-pack/linux-unpacked out/electron-pack/linux-x64-unpacked; do
  [[ -d "$candidate" ]] && UNPACKED="$candidate" && break
done

if [[ -z "$UNPACKED" ]]; then
  echo "[!] no unpacked tree under out/electron-pack — skipping the archive"
else
  echo "[*] packaging installer (tar.gz)"
  APP_VERSION="$(node -p "require('./package.json').version")"
  STAGE="out/linux-installer/ia_workspaces-$APP_VERSION"
  rm -rf "$(dirname "$STAGE")" && mkdir -p "$STAGE" out/installer

  cp -R "$UNPACKED" "$STAGE/ia_workspaces"
  cp packaging/icons/icon.png "$STAGE/icon.png" 2>/dev/null || true
  cp LICENSE "$STAGE/LICENSE" 2>/dev/null || true
  sed "s/@APP_VERSION@/$APP_VERSION/g" installer/install-linux.sh > "$STAGE/install-linux.sh"
  chmod +x "$STAGE/install-linux.sh"

  tar czf "out/installer/ia_workspaces-linux.tar.gz" \
      -C "$(dirname "$STAGE")" "$(basename "$STAGE")" \
    || fail "archiving failed"
  rm -rf "$(dirname "$STAGE")"
fi

echo "[*] collecting artifacts into build/"
node tools/collect.mjs || fail "collecting artifacts failed"

echo
echo "=== done ==="
ls -1 build 2>/dev/null
echo
