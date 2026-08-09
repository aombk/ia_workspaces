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
rem    build_windows.bat            typecheck, test, bundle, package, collect
rem    build_windows.bat --clean    wipe out\ first
rem    set SKIP_INSTALLER=1         portable only, for fast iteration
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

if /i "%~1"=="--clean" (
  echo [*] cleaning out\
  call node tools\clean.mjs
)

if not exist "node_modules\" (
  echo [*] installing dependencies
  call npm install || goto :fail_deps
)

echo [*] typecheck
call npm run typecheck || goto :fail_typecheck

echo [*] tests
call npm test || goto :fail_tests

echo [*] bundling
call node build.mjs || goto :fail_build

echo [*] packaging (portable exe + unpacked tree)
call npx electron-builder --win || goto :fail_build

rem ── Installer ──────────────────────────────────────────────────────────────
rem Inno Setup rather than electron-builder's NSIS: it is what the rest of the
rem range ships with, so one wizard, one publisher folder, one uninstall entry
rem style across ia glitch, ia pixelCam and this. ISCC is not a dependency of
rem the portable build, so a machine without it still produces the exe and is
rem told what it did not produce, rather than failing the run.
set "ISCC="
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if exist "C:\Program Files\Inno Setup 6\ISCC.exe"       set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
if exist "C:\Program Files (x86)\Inno Setup 7\ISCC.exe" set "ISCC=C:\Program Files (x86)\Inno Setup 7\ISCC.exe"
if exist "C:\Program Files\Inno Setup 7\ISCC.exe"       set "ISCC=C:\Program Files\Inno Setup 7\ISCC.exe"

rem The version is read out here, at the top level, and not inside the block
rem below. Everything in a parenthesised block is expanded when the block is
rem parsed, so a %APP_VERSION% set inside one is still empty on the line that
rem uses it — the installer would have been stamped with nothing at all.
for /f "tokens=2 delims=:, " %%v in ('findstr /r "\"version\":" package.json') do (
  if not defined APP_VERSION set APP_VERSION=%%~v
)
if not defined APP_VERSION set APP_VERSION=0.0.0

if "%SKIP_INSTALLER%"=="1" (
  echo [*] skipping installer ^(SKIP_INSTALLER=1^)
) else if "%ISCC%"=="" (
  echo [!] Inno Setup not found — portable exe only.
  echo     Install it from https://jrsoftware.org/isdl.php to build the installer.
) else (
  echo [*] packaging installer %APP_VERSION%
  "%ISCC%" /Q /DMyAppVersion=%APP_VERSION% installer\ia_workspaces.iss || goto :fail_installer
)

echo.
echo [*] collecting artifacts into build\
call node tools\collect.mjs || goto :fail_collect

echo.
echo === done ===
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
:fail_installer
echo [x] Inno Setup failed to build the installer
exit /b 1
:fail_collect
echo [x] collecting artifacts failed
exit /b 1
