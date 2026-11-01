@rem SPDX-License-Identifier: GPL-3.0-or-later
@rem Copyright (C) 2026 LucasHe1015
@echo off
rem S.P.E.C. 7 // STATION FOR PROMPT EDITING AND COMPOSITION - local launcher
rem Double-clicking this file always starts the station: it runs the bundled
rem SPEC7.exe when it sits next to this script, otherwise it falls back to
rem server.py through a local Python 3 interpreter. Both serve 127.0.0.1:8765.
setlocal
cd /d "%~dp0"
title S.P.E.C. 7 Station for Prompt Editing and Composition

if not exist "%~dp0SPEC7.exe" goto :source

echo.
echo  S.P.E.C. 7 // STATION FOR PROMPT EDITING AND COMPOSITION
echo  starting bundled station ...
echo.
"%~dp0SPEC7.exe" --port 8765
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo  The station stopped with code %EXITCODE%.
  pause
)
goto :end

:source
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
  echo  SPEC7.exe is not next to this script and Python 3 was not found.
  echo  Put SPEC7.exe in this folder, or install Python 3.9+ from
  echo  https://www.python.org/downloads/ and run this file again.
  echo  S.P.E.C. 7 itself needs no extra packages.
  echo.
  pause
  exit /b 1
)

echo.
echo  S.P.E.C. 7 // STATION FOR PROMPT EDITING AND COMPOSITION
echo  starting local station from source ...
echo.

%PY% server.py --port 8765
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo  The station stopped with code %EXITCODE%.
  pause
)

:end
endlocal
