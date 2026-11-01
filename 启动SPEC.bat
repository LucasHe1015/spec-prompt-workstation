@rem SPDX-License-Identifier: GPL-3.0-or-later
@rem Copyright (C) 2026 LucasHe1015
@echo off
rem S.P.E.C. 7 // STATION FOR PROMPT EDITING AND COMPOSITION - local launcher
rem Starts server.py on 127.0.0.1 and opens the console in your browser.
setlocal
cd /d "%~dp0"
title S.P.E.C. 7 Station for Prompt Editing and Composition

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
)
if not defined PY (
  if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
)
if not defined PY (
  echo.
  echo  Python 3 was not found on this machine.
  echo  Install Python 3.9+ from https://www.python.org/downloads/
  echo  then run this file again. S.P.E.C. 7 itself needs no extra packages.
  echo.
  pause
  exit /b 1
)

echo.
echo  S.P.E.C. 7 // STATION FOR PROMPT EDITING AND COMPOSITION
echo  starting local station ...
echo.

%PY% server.py --port 8765
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo  The station stopped with code %EXITCODE%.
  pause
)
endlocal
