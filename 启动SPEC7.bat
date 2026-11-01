@rem SPDX-License-Identifier: GPL-3.0-or-later
@rem Copyright (C) 2026 LucasHe1015
@echo off
rem S.P.E.C. 7 // STATION FOR PROMPT EDITING AND COMPOSITION - exe launcher
rem Use this when double-clicking SPEC7.exe does nothing: it pins the working
rem directory to the exe folder so the onefile build unpacks into .runtime\
rem beside the exe instead of into an unwritable current directory.
setlocal
cd /d "%~dp0"
title S.P.E.C. 7 Station for Prompt Editing and Composition

if not exist "%~dp0SPEC7.exe" (
  echo [SPEC7] SPEC7.exe not found next to this script.
  echo        Keep SPEC7.exe, .runtime\ and this file in the same folder.
  pause
  exit /b 1
)

"%~dp0SPEC7.exe" %*
