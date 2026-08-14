@echo off
setlocal

rem ============================================================================
rem  build_windows.bat — release build of ia_workspaces for Windows.
rem
rem  Output:
rem    build\ia_workspaces.exe          portable — one file, runs from anywhere
rem    build\ia_workspaces-setup.exe    installer — Inno Setup wizard
rem
rem  Debug builds are what `npm run dev` / `npm start` do. This is the other
rem  thing: an optimised binary, gathered into build\ by tools\collect.mjs.
rem
rem  Two artifacts because they answer different questions. The portable exe is
rem  for running the thing right now, off a stick, on a machine you do not own.
rem  The installer is for a machine that is yours: a stable path under
rem  iraisynn_attinom\, a Start Menu entry, an uninstall entry, and somewhere
rem  Windows can find it. Neither replaces the other, and the installer is
rem  skipped rather than fatal when Inno Setup is absent.
rem
rem  Usage:
rem    build_windows.bat                 typecheck, test, bundle, package, collect
rem    build_windows.bat --fast          unpacked tree only — about ten seconds
rem    build_windows.bat --no-portable   installer only — about thirty seconds
rem    build_windows.bat --clean         wipe out\ first
rem    set SKIP_INSTALLER=1              portable exe only, no installer
rem
rem  --fast is the one to use while working. The full run spends eighty-five of
rem  its hundred-odd seconds inside NSIS, compressing a third of a gigabyte of
rem  Electron on one thread to make the portable exe; --fast stops after the
rem  unpacked tree, which is a runnable app at
rem  out\electron-pack\win-unpacked\ia_workspaces.exe. It still typechecks and
rem  still runs the tests — those are seven seconds between them and they are
rem  the two steps you would least want to skip. See tools\packWindows.mjs for
rem  the measurements and for why the portable exe and the installer are now
rem  built at the same time rather than one after the other.
rem
rem  This used to ask which runtimes to build, back when there were two. There
rem  is one now: Tauri was dropped, because its browser pane was a native view
rem  composited over the window with no z-order — it hid whenever a menu or a
rem  toast was up — and keeping a second host meant maintaining twelve
rem  subsystems twice, in two languages, for a four-megabyte binary nobody was
rem  downloading. Nothing signs anything here; see build_macos.sh, where
rem  Gatekeeper leaves no such choice.
rem ============================================================================

cd /d "%~dp0"

echo.
echo === ia_workspaces Windows release build ===
echo.

where npm >nul 2>&1 || (
  echo [x] npm not found on PATH. Nothing can be built without it.
  exit /b 1
)

set "FASTFLAG="
set "PACKFLAGS="
for %%a in (%*) do (
  if /i "%%~a"=="--fast" set "FASTFLAG=--fast"
  rem The middle gear: skip the portable exe, which is eighty-five of the
  rem hundred seconds, and still get the installer most people actually use.
  if /i "%%~a"=="--no-portable" set "PACKFLAGS=--no-portable"
  if /i "%%~a"=="--clean" (
    echo [*] cleaning out\
    call node tools\clean.mjs
  )
)

if not exist "node_modules\" (
  echo [*] installing dependencies
  call npm install || goto :fail_deps
)

echo [*] typecheck  (%TIME%)
call npm run typecheck || goto :fail_typecheck

echo [*] tests  (%TIME%)
call npm test || goto :fail_tests

echo [*] bundling  (%TIME%)
call node build.mjs || goto :fail_build

rem Packaging — the unpacked tree, then the portable exe and the Inno Setup
rem installer alongside each other. All of it lives in one script now, because
rem "run these two and wait for both" is not a thing batch can say without a
rem sentinel file and a polling loop, and because that script is where the
rem timings that justify the arrangement are written down.
rem
rem Inno Setup rather than electron-builder's NSIS for the installer: it is what
rem the rest of the range ships with, so one wizard, one publisher folder, one
rem uninstall entry style across ia glitch, ia pixelCam and this. ISCC is not a
rem dependency of the portable build, so a machine without it still produces the
rem exe and is told what it did not produce, rather than failing the run.
echo [*] packaging  (%TIME%)
call node tools\packWindows.mjs %FASTFLAG% %PACKFLAGS% || goto :fail_build

rem `^(` and `^)`, not `(` and `)`. Everything in a parenthesised block is
rem expanded when the block is *parsed*, so an unescaped `(%TIME%)` becomes
rem `(13:05:02.83)` and its closing bracket ends the `if` two lines early —
rem which quietly promoted the `exit /b 0` below to unconditional and skipped
rem the collect step on every full build. Same trap as the %APP_VERSION% note
rem this file used to carry: batch expands first and reads the brackets after.
if defined FASTFLAG (
  echo.
  echo === done ===  ^(%TIME%^)
  exit /b 0
)

echo.
echo [*] collecting artifacts into build\  (%TIME%)
call node tools\collect.mjs || goto :fail_collect

echo.
echo === done ===  (%TIME%)
dir /b build 2>nul
echo.
exit /b 0

rem ------------------------------------------------------------------ failures
:fail_deps
echo [x] npm install failed
exit /b 1
:fail_typecheck
echo [x] typecheck failed — fix the types before building a release
exit /b 1
:fail_tests
echo [x] tests failed — fix them before building a release
exit /b 1
:fail_build
echo [x] build failed
exit /b 1
:fail_collect
echo [x] collecting artifacts failed
exit /b 1
