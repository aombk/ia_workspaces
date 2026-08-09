@echo off
rem A batch file, for the one language whose comment marker is a word.
REM  Uppercase works too, and so does :: at the start of a line.
:: This is the other kind of comment.
setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
set /a COUNT=0

echo rem is a command here, not a comment
echo :: and this line is echoed as it stands

for %%f in ("%ROOT%*.md") do (
  echo found %%~nxf
  set /a COUNT+=1
)

if !COUNT! gtr 0 (
  echo total: !COUNT!
) else (
  echo nothing found
  exit /b 1
)

exit /b 0
