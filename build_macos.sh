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
#   APPLE_SIGN_ID        the certificate's common name
#                        (default: "Developer ID Application: (<team id>)")
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

TEAM_ID="${APPLE_TEAM_ID:-}"
SIGN_ID="${APPLE_SIGN_ID:-Developer ID Application: (${TEAM_ID})}"
NOTARY_PROFILE="${NOTARYTOOL_PROFILE:-notar}"

DO_SIGN=1
DO_CLEAN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-sign|--test) DO_SIGN=0; shift ;;
    --clean)          DO_CLEAN=1; shift ;;
    -h|--help)        sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

echo
echo "=== ia_workspaces macOS release build ==="
echo

fail() { echo "[x] $1"; exit 1; }

[[ "$(uname)" == "Darwin" ]] || fail "this script is for macOS; use build_linux.sh or build_windows.bat"
command -v npm >/dev/null 2>&1 || fail "npm not found on PATH. Nothing can be built without it."

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
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 \
    || fail "notarytool profile \"$NOTARY_PROFILE\" not found. See the header for how to create it, or use --test."
  # A different certificate from the one above: apps are signed with "Developer
  # ID Application", installer packages with "Developer ID Installer", and
  # having the first does not give you the second. Warned rather than fatal —
  # the .dmg is still signed and notarized, and an unsigned .pkg is worth
  # producing so the shape of the build can be checked.
  security find-identity -v 2>/dev/null | grep -q "Developer ID Installer" \
    || echo "[!] no \"Developer ID Installer\" certificate — the .pkg will be unsigned. Create one at developer.apple.com."
  export CSC_NAME="$SIGN_ID"
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

echo "[*] packaging (universal dmg)"
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
APP_BUNDLE=""
for candidate in out/electron-pack/mac-universal/ia_workspaces.app \
                 out/electron-pack/mac-arm64/ia_workspaces.app \
                 out/electron-pack/mac/ia_workspaces.app; do
  [[ -d "$candidate" ]] && APP_BUNDLE="$candidate" && break
done

if [[ -z "$APP_BUNDLE" ]]; then
  echo "[!] no .app found under out/electron-pack — skipping the .pkg"
else
  echo "[*] packaging installer (.pkg)"
  APP_VERSION="$(node -p "require('./package.json').version")"
  PKG_IDENTIFIER="net.attinom.iraisynn.ia_workspaces"
  INSTALLER_OUT="out/installer"
  PKG_ROOT="out/pkgroot"

  rm -rf "$PKG_ROOT" && mkdir -p "$PKG_ROOT" "$INSTALLER_OUT"
  # The publisher folder is part of the payload rather than the install
  # location, so it comes out the same under /Applications and ~/Applications.
  mkdir -p "$PKG_ROOT/iraisynn attinom"
  cp -R "$APP_BUNDLE" "$PKG_ROOT/iraisynn attinom/"

  pkgbuild --root "$PKG_ROOT" \
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
  PKG_SIGN=()
  if [[ $DO_SIGN -eq 1 ]]; then
    INSTALLER_ID="$(security find-identity -v | grep -o 'Developer ID Installer: [^"]*' | head -1)"
    [[ -n "$INSTALLER_ID" ]] && PKG_SIGN=(--sign "$INSTALLER_ID")
    [[ -z "$INSTALLER_ID" ]] && echo "[!] no Developer ID Installer identity — .pkg will be unsigned"
  fi

  productbuild --distribution "$INSTALLER_OUT/distribution.xml" \
               --package-path "$INSTALLER_OUT" \
               "${PKG_SIGN[@]}" \
               "$INSTALLER_OUT/ia_workspaces.pkg" \
    || fail "productbuild failed"

  rm -f "$INSTALLER_OUT/ia_workspaces-component.pkg"
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
