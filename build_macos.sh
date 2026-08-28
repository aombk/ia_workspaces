#!/usr/bin/env bash
# =============================================================================
# build_macos.sh — Configure, build, sign, notarize and package for macOS
# =============================================================================
#
# Output:
#   build/ia_workspaces.dmg   drag-to-Applications disk image
#   build/ia_workspaces.pkg   installer with a destination page — only with --pkg
#
# The .dmg is the deliverable: it is what the updater feed (latest-mac.yml)
# serves, so it is the only artifact anything consumes after first install. The
# .pkg is off by default because it costs a second notarization upload — a few
# minutes a release — to produce something nothing downstream reads. Ask for it
# with --pkg when you want managed deployment (Jamf, Munki, `installer -pkg`)
# or an install-time destination page, and see the installer section below.
#
# The .dmg is a universal binary — one artifact that runs natively on Apple
# Silicon and Intel — so there is nothing to pick between at download time.
#
# By default this produces SIGNED, NOTARIZED and STAPLED artifacts: Developer ID
# Application, hardened runtime, then `xcrun notarytool submit --wait` and
# `stapler staple`.
#
# Signing needs an Apple Developer account, and this script takes what it needs
# from the environment rather than hardcoding anyone's identity:
#
#   APPLE_TEAM_ID        your 10-character team id           (required to sign)
#   APPLE_SIGN_ID        the certificate's common name (default: read out of
#                        the keychain; only needed when it holds more than one
#                        Developer ID Application certificate for the team)
#   NOTARYTOOL_PROFILE   keychain profile to notarize with   (default: notar)
#
# Notarization uploads to Apple and waits for a verdict, a few minutes. To
# (re)create the profile:
#
#   xcrun notarytool store-credentials "notar" \
#       --apple-id "<you@example.com>" --team-id "<your team id>" \
#       --password "<app-specific-password>"
#
# With no Apple account, `--test` builds an unsigned .app that runs on this
# machine and nowhere else.
#
# Flags:
#   --no-sign     UNSIGNED build; no codesign, notarize or staple.
#   --test        Alias for --no-sign.
#   --pkg         Also build the .pkg installer. Adds a pkgbuild plus a second
#                 220MB notarization upload and staple — roughly three minutes.
#   --no-pkg      Accepted and does nothing; skipping the .pkg is the default.
#   --clean       Wipe out/ first.
#
# An unsigned .app is refused by Gatekeeper on any machine that did not build
# it. For your own use, right-click → Open gets past that once, which is what
# --test is for; anything you intend to move to another Mac wants the default.
#
# Signing is left to electron-builder because the .app has to be signed before
# it goes into the .dmg, and only electron-builder can sequence that.
# Notarization is done here, afterwards, to the finished .dmg — which is the
# thing that actually leaves this machine.
#
# One thing about that signing step is worth knowing before you touch it, and
# it lives in package.json where no comment can explain it:
#
#     "signIgnore": ["\\.pak$"]
#
# @electron/osx-sign signs every *file* it walks, not every binary. The bundle
# holds 307 files of which ~50 are Mach-O; the other 223 are Chromium's
# per-language `locale.pak` translation tables. Notarization requires a secure
# timestamp on each signature, and every timestamp is a separate round trip to
# Apple's server — so signing the .pak files meant ~230 requests fired inside
# two minutes. Apple rate-limits that service: the burst got throttled, codesign
# sat on a dead connection for 15m54s, then failed with
#
#     -67885 The timestamp service is not available
#
# which electron-builder reported only as "Above command failed, retrying".
# Signing a .pak individually was always redundant — the framework's own
# _CodeSignature/CodeResources already seals a SHA-256 of all 220 of them, so
# tampering with one still fails verification with "a sealed resource is missing
# or invalid". Ignoring them removed ~180 requests and took signing from 25
# minutes to under one, with the same integrity coverage and notarization
# accepting the result unchanged.
#
# So: if a future Electron ships new non-code resources and signing starts
# crawling again, widen that pattern rather than assuming the network is at
# fault. And do not try to solve it by dropping --timestamp — notarization
# rejects signatures without one.
set -uo pipefail

cd "$(dirname "$0")"

# Named up here rather than beside pkgbuild, because the preflight below quotes
# it in the advice it gives about an installer that has already run.
PKG_IDENTIFIER="net.attinom.iraisynn.ia_workspaces"

TEAM_ID="${APPLE_TEAM_ID:-}"
SIGN_ID="${APPLE_SIGN_ID:-}"
NOTARY_PROFILE="${NOTARYTOOL_PROFILE:-notar}"

DO_SIGN=1
DO_PKG=0
DO_CLEAN=0
ASSUME_YES=0
WANT_HOSTS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-sign|--test) DO_SIGN=0; shift ;;
    --pkg) DO_PKG=1; shift ;;
    --no-pkg) DO_PKG=0; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --hosts)  WANT_HOSTS=1; shift ;;
    --clean)          DO_CLEAN=1; shift ;;
    -h|--help)        sed -n '2,53p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

echo
echo "=== ia_workspaces macOS release build ==="
echo

fail() { echo "[x] $1"; exit 1; }

[[ "$(uname)" == "Darwin" ]] || fail "this script is for macOS; use build_linux.sh or build_windows.bat"
command -v npm >/dev/null 2>&1 || fail "npm not found on PATH. Nothing can be built without it."

# ---------------------------------------------------------------- which hosts
# Three runtimes now: Electron, the Tauri host (Rust) and the Wails host (Go).
# Enter takes the default, which is yes. --yes skips the asking, as does a run
# with no terminal attached. Only the Electron artifacts are signed and
# notarized below; the other two are unsigned and Gatekeeper will say so.
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


# ------------------------------------------------------------------ preflight
# Two ways the packaging step dies an hour in, with a message that names neither
# cause. Both are about the staging directory, so both are checked here — before
# --clean, which walks into the first of them itself.
#
# The first is a staging directory left behind by a run made under sudo.
# electron-builder empties it before unpacking Electron, and a root-owned tree
# in there stops it with `unlinkat ... permission denied` under a Go stack trace
# from app-builder, which says nothing about ownership. Nothing in this build
# needs root, and a run made with it leaves artifacts the next run cannot clear.
#
# The second is packaging over a copy that is *running* from that directory —
# easy to do once you use the thing you build. Electron reads app.asar and
# Frameworks/ lazily, so replacing them under a live process takes it down, and
# if the terminal was launched from that app it takes this script with it.
PACK_DIR="out/electron-pack"
if [[ -d "$PACK_DIR" ]]; then
  FOREIGN="$(find "$PACK_DIR" ! -user "$(id -un)" -print -quit 2>/dev/null)"
  if [[ -n "$FOREIGN" ]]; then
    fail "$PACK_DIR holds files owned by $(stat -f %Su "$FOREIGN" 2>/dev/null || echo 'another user'), and electron-builder cannot clear them. Remove it with:

      sudo rm -rf \"$PWD/$PACK_DIR\"

    Two ways this happens. Either a build was run under sudo — don't; nothing
    here needs it. Or an .pkg built before bundle relocation was turned off was
    installed for all users: the installer followed Launch Services back to the
    copy in $PACK_DIR and rewrote it as root, rather than installing where it
    said it would. If it was the installer, also clear what it left behind:

      sudo pkgutil --forget $PKG_IDENTIFIER
      sudo rmdir \"/Applications/iraisynn attinom\" \"\$HOME/Applications/iraisynn attinom\"

    then rebuild — this script now ships a non-relocatable component."
  fi
  if pgrep -f "$PWD/$PACK_DIR" >/dev/null 2>&1; then
    fail "ia_workspaces is running from $PACK_DIR, and packaging replaces that app while it runs. Quit it first. If your terminal is running inside it, install build/ia_workspaces.dmg to /Applications and build from there, or from Terminal.app."
  fi
fi

if [[ $DO_CLEAN -eq 1 ]]; then
  echo "[*] cleaning out/"
  node tools/clean.mjs || true
fi

# Checked before the slow part rather than after: a missing certificate an hour
# into a build is the worst possible time to find out.
if [[ $DO_SIGN -eq 1 ]]; then
  # Checked before the grep below, which would match every identity in the
  # keychain against an empty string and report success with nothing set.
  [[ -n "$TEAM_ID" ]] \
    || fail "APPLE_TEAM_ID is not set, so there is no identity to sign with. Set it (see the header), or use --test for an unsigned build."
  security find-identity -v -p codesigning 2>/dev/null | grep -q "$TEAM_ID" \
    || fail "no Developer ID certificate for team $TEAM_ID in the keychain. Use --test for an unsigned build."
  # The common name carries the account holder's name between the type and the
  # team id — "Developer ID Application: Some Name (TEAMID)" — so it cannot be
  # constructed from the team id alone. Read the real one out of the keychain,
  # and leave APPLE_SIGN_ID for the case of several certificates for one team.
  if [[ -z "$SIGN_ID" ]]; then
    SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null \
                 | grep -o "Developer ID Application: [^\"]*(${TEAM_ID})" | head -1)"
    [[ -n "$SIGN_ID" ]] \
      || fail "no \"Developer ID Application\" certificate for team $TEAM_ID in the keychain — only that kind can sign the .app. Set APPLE_SIGN_ID to its common name if it is named unusually."
  fi
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 \
    || fail "notarytool profile \"$NOTARY_PROFILE\" not found. See the header for how to create it, or use --test."
  # A different certificate from the one above: apps are signed with "Developer
  # ID Application", installer packages with "Developer ID Installer", and
  # having the first does not give you the second. Warned rather than fatal —
  # the .dmg is still signed and notarized, and an unsigned .pkg is worth
  # producing so the shape of the build can be checked.
  if [[ $DO_PKG -eq 1 ]]; then
    security find-identity -v 2>/dev/null | grep -q "Developer ID Installer" \
      || echo "[!] no \"Developer ID Installer\" certificate — the .pkg will be unsigned. Create one at developer.apple.com."
  fi
  # Without the "Developer ID Application: " prefix: electron-builder picks the
  # certificate type itself and refuses outright a CSC_NAME that names one.
  # Stripped here rather than asked for stripped, because the prefix is part of
  # what `security find-identity` prints and what everyone calls the certificate.
  export CSC_NAME="${SIGN_ID#Developer ID Application: }"
  echo "[*] signing as: $SIGN_ID"
else
  # electron-builder signs whenever it finds an identity, so opting out has to
  # be explicit rather than merely leaving CSC_NAME unset.
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  echo "[-] unsigned build (--test): Gatekeeper will refuse this on another Mac"
fi

[[ -d node_modules ]] || { echo "[*] installing dependencies"; npm install || fail "npm install failed"; }

echo "[*] typecheck"
npm run typecheck || fail "typecheck failed — fix the types before building a release"

echo "[*] tests"
npm test || fail "tests failed — fix them before building a release"

echo "[*] bundling"
node build.mjs || fail "bundle failed"

# Before packaging, not before the tests: this only matters to what gets packed,
# and npm prunes the foreign-architecture prebuild on every install — so doing it
# here means the last word belongs to this script rather than to whichever npm
# command ran most recently.
echo "[*] node-pty prebuilds (universal needs both architectures)"
node tools/ensurePtyArches.mjs || fail "could not assemble the node-pty prebuilds"

echo "[*] packaging (universal dmg — runs on Apple Silicon and Intel)"
if [[ $DO_ELECTRON -eq 1 ]]; then
  npx electron-builder --mac || fail "packaging failed"
fi

# The other two hosts, unsigned. A missing toolchain is a skip, not a failure.
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

# Before the .pkg is cut and long before anything is notarized, because both of
# those would happily wrap a bundle that only runs on this machine's
# architecture. See the file for what goes wrong without it.
echo "[*] verifying the bundle is universal"
node tools/verifyUniversal.mjs || fail "the packaged app is not universal — see above; do not ship this build"

# ---------------------------------------------------------------- installer
# A .pkg beside the .dmg, and they are not the same offer. A disk image asks you
# to drag the app somewhere; the installer puts it in an `iraisynn attinom`
# folder inside Applications and lets you choose, on its destination page,
# whether that is the whole machine or only your account.
#
# pkgbuild wraps the .app that electron-builder just made and signed; the
# distribution file is what turns a component package into a wizard with a
# destination page. Both are skipped rather than fatal if the .app is missing,
# because a --dir run has not produced one.
#
# The universal build first, which is what the mac target now produces and is
# right on every machine. The per-architecture directories are kept as fallbacks
# because they are still what a `--dir` run or an older staging tree leaves
# behind, and host architecture is preferred among them for the same reason
# tools/collect.mjs picks the .dmg that way: both artifacts are made in one run
# from one staging directory, and a fixed order would have them disagree — an
# arm64 .pkg beside an Intel .dmg, which is what this used to produce.
APP_BUNDLE=""
case "$(uname -m)" in
  arm64) NATIVE_DIR="mac-arm64"; OTHER_DIR="mac" ;;
  *)     NATIVE_DIR="mac";       OTHER_DIR="mac-arm64" ;;
esac
for candidate in out/electron-pack/mac-universal/ia_workspaces.app \
                 "out/electron-pack/$NATIVE_DIR/ia_workspaces.app" \
                 "out/electron-pack/$OTHER_DIR/ia_workspaces.app"; do
  [[ -d "$candidate" ]] && APP_BUNDLE="$candidate" && break
done

if [[ $DO_PKG -eq 0 ]]; then
  # Both copies have to go, and neither is optional. tools/collect.mjs keeps
  # `ia_workspaces.pkg` in its keep-list unconditionally and copies it from
  # out/installer, so a .pkg left behind by an earlier run would survive this
  # one: collected into build/ as though this run had made it, then notarized
  # and stapled below. That is a stale installer shipped under a new version
  # number, which is worse than no installer at all.
  rm -f "out/installer/ia_workspaces.pkg" "build/ia_workspaces.pkg"
  echo "[-] .dmg only — pass --pkg for the installer"
elif [[ -z "$APP_BUNDLE" ]]; then
  echo "[!] no .app found under out/electron-pack — skipping the .pkg"
else
  echo "[*] packaging installer (.pkg)"
  APP_VERSION="$(node -p "require('./package.json').version")"
  INSTALLER_OUT="out/installer"
  PKG_ROOT="out/pkgroot"

  rm -rf "$PKG_ROOT" && mkdir -p "$PKG_ROOT" "$INSTALLER_OUT"
  # The publisher folder is part of the payload rather than the install
  # location, so it comes out the same under /Applications and ~/Applications.
  mkdir -p "$PKG_ROOT/iraisynn attinom"
  cp -R "$APP_BUNDLE" "$PKG_ROOT/iraisynn attinom/"

  # `BundleIsRelocatable` off, which pkgbuild will not do on its own — and left
  # on, the installer does not install where the payload says it will.
  #
  # A relocatable component is one the installer is allowed to move: before
  # writing anything it asks Launch Services where a bundle with this id already
  # lives, and if it finds one, it installs *over that copy* and leaves the
  # chosen destination an empty folder. Launch Services knows every copy you
  # have ever double-clicked, including the one in out/electron-pack — so a
  # developer's own machine is the one most likely to hit this, and installing
  # "for all users" then rewrites the build tree as root. That is where the
  # root-owned staging directory the preflight above refuses comes from.
  #
  # There is no pkgbuild flag for it; the setting lives in the component plist,
  # which has to be generated from the payload and then edited. `--analyze`
  # writes exactly the plist pkgbuild would have used, so the only difference is
  # the one line below.
  COMPONENT_PLIST="$INSTALLER_OUT/component.plist"
  pkgbuild --analyze --root "$PKG_ROOT" "$COMPONENT_PLIST" >/dev/null \
    || fail "pkgbuild --analyze failed"
  plutil -replace 0.BundleIsRelocatable -bool NO "$COMPONENT_PLIST" \
    || fail "could not turn off bundle relocation in $COMPONENT_PLIST"

  pkgbuild --root "$PKG_ROOT" \
           --component-plist "$COMPONENT_PLIST" \
           --identifier "$PKG_IDENTIFIER" \
           --version "$APP_VERSION" \
           --install-location "/Applications" \
           "$INSTALLER_OUT/ia_workspaces-component.pkg" \
    || fail "pkgbuild failed"

  sed -e "s/@APP_VERSION@/$APP_VERSION/g" \
      -e "s/@PKG_IDENTIFIER@/$PKG_IDENTIFIER/g" \
      installer/distribution.xml.in > "$INSTALLER_OUT/distribution.xml"

  # Signed with the *Installer* identity, which is a different certificate from
  # the Developer ID Application one the .app carries. Unsigned otherwise, so an
  # unsigned build still produces a .pkg you can install by hand.
  # Kept as an array so the identity survives as one argument however it is
  # spelled; expanded below through the "${a[@]+...}" hedge, because macOS ships
  # bash 3.2 and there an empty array under `set -u` is an unbound variable —
  # which is every unsigned build, and killed the script outright.
  PKG_SIGN=()
  if [[ $DO_SIGN -eq 1 ]]; then
    INSTALLER_ID="$(security find-identity -v | grep -o 'Developer ID Installer: [^"]*' | head -1)"
    [[ -n "$INSTALLER_ID" ]] && PKG_SIGN=(--sign "$INSTALLER_ID")
    [[ -z "$INSTALLER_ID" ]] && echo "[!] no Developer ID Installer identity — .pkg will be unsigned"
  fi

  productbuild --distribution "$INSTALLER_OUT/distribution.xml" \
               --package-path "$INSTALLER_OUT" \
               ${PKG_SIGN[@]+"${PKG_SIGN[@]}"} \
               "$INSTALLER_OUT/ia_workspaces.pkg" \
    || fail "productbuild failed"

  rm -f "$INSTALLER_OUT/ia_workspaces-component.pkg" "$COMPONENT_PLIST"
  rm -rf "$PKG_ROOT"
fi

echo "[*] collecting artifacts into build/"
node tools/collect.mjs || fail "collecting artifacts failed"

# --------------------------------------------------------------- notarization
# Last, and to the .dmg rather than the .app: the disk image is what leaves this
# machine, and stapling the ticket to it means a first launch on a machine with
# no network still passes Gatekeeper.
if [[ $DO_SIGN -eq 1 ]]; then
  shopt -s nullglob
  # Both artifacts, not just the disk image. A .pkg that is signed but not
  # notarized is refused by Gatekeeper on any machine but this one — the same
  # trap as an unnotarized .dmg, and easier to miss because the installer opens
  # far enough to look like it worked.
  for artifact in build/*.dmg build/*.pkg; do
    echo
    echo "=== Notarizing $(basename "$artifact") (uploads to Apple, waits) ==="
    xcrun notarytool submit "$artifact" --keychain-profile "$NOTARY_PROFILE" --wait \
      || fail "notarization failed for $artifact"
    xcrun stapler staple "$artifact" || fail "stapling failed for $artifact"
    # Proves the whole chain rather than just that the commands exited 0. A
    # .pkg is assessed as an installer; `open` is the policy for a disk image.
    if [[ "$artifact" == *.pkg ]]; then
      spctl --assess --type install -v "$artifact" \
        || echo "[!] spctl could not verify $artifact — check the signature before shipping it"
    else
      spctl --assess --type open --context context:primary-signature -v "$artifact" \
        || echo "[!] spctl could not verify $artifact — check the signature before shipping it"
    fi
  done
  shopt -u nullglob
fi

echo
echo "=== done ==="
ls -1 build 2>/dev/null
echo
