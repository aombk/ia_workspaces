#!/usr/bin/env bash
# =============================================================================
# build_macos.sh — Configure, build, sign, notarize and package for macOS
# =============================================================================
#
# Output:
#   build/ia_workspaces.dmg
#
# By default this produces a SIGNED, NOTARIZED and STAPLED .dmg: Developer ID
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
set -uo pipefail

cd "$(dirname "$0")"

# Named up here rather than beside pkgbuild, because the preflight below quotes
# it in the advice it gives about an installer that has already run.
PKG_IDENTIFIER="net.attinom.iraisynn.ia_workspaces"

TEAM_ID="${APPLE_TEAM_ID:-}"
SIGN_ID="${APPLE_SIGN_ID:-}"
NOTARY_PROFILE="${NOTARYTOOL_PROFILE:-notar}"

DO_SIGN=1
DO_CLEAN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-sign|--test) DO_SIGN=0; shift ;;
    --clean)          DO_CLEAN=1; shift ;;
    -h|--help)        sed -n '2,39p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

echo
echo "=== ia_workspaces macOS release build ==="
echo

fail() { echo "[x] $1"; exit 1; }

[[ "$(uname)" == "Darwin" ]] || fail "this script is for macOS; use build_linux.sh or build_windows.bat"
command -v npm >/dev/null 2>&1 || fail "npm not found on PATH. Nothing can be built without it."

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
  security find-identity -v 2>/dev/null | grep -q "Developer ID Installer" \
    || echo "[!] no \"Developer ID Installer\" certificate — the .pkg will be unsigned. Create one at developer.apple.com."
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

echo "[*] packaging (one dmg per architecture; collect takes this machine's)"
npx electron-builder --mac || fail "packaging failed"

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
# Host architecture first among the single-arch builds, and for the same reason
# tools/collect.mjs picks the .dmg that way: both artifacts are made in one run
# from one staging directory, and a fixed order would have them disagree — an
# arm64 .pkg beside an Intel .dmg, which is what this used to produce. A
# universal build wins outright, being right on every machine.
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

if [[ -z "$APP_BUNDLE" ]]; then
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
