@echo off
title okMUSIC helper
cd /d "%~dp0"
where py >nul 2>nul && (py -3 okmusic-helper.py & goto :end)
where python >nul 2>nul && (python okmusic-helper.py & goto :end)
echo.
echo   Python isn't installed. Get it from https://www.python.org/downloads/
echo   (tick "Add python.exe to PATH" during install), then run this again.
echo.
pause
:end
