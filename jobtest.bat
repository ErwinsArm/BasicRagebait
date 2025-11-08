@echo off
setlocal

set TARGET=https://sabping.up.railway.app/jobs/next
title JobId Tester

:start
curl %TARGET%
echo.
echo Press any key to run again, or close this window when done.
pause >nul
goto start
