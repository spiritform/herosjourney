@echo off
setlocal

REM Hero's Journey - start the local server.
REM   start.bat          serve on 8800 and open the page
REM   start.bat noopen   serve without opening a browser
REM   set PORT=8801 && start.bat      serve somewhere else
REM
REM Double-clicking this works: it moves to its own folder first, so it does
REM not matter what the shell's current directory was.

cd /d "%~dp0"

if not defined PORT set PORT=8800

REM NODE 22 IS NOT OPTIONAL. server.js uses global fetch and FormData, and on
REM anything older it dies with "fetch is not defined" halfway through a run
REM rather than at boot, which reads like a Comfy problem instead of a node one.
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   node is not on PATH. Install Node 22 or newer.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node --version') do set NODEMAJ=%%v
set NODEMAJ=%NODEMAJ:v=%
if %NODEMAJ% LSS 22 (
  echo.
  echo   node %NODEMAJ% is too old - server.js needs 22 or newer for global fetch.
  echo.
  pause
  exit /b 1
)

REM A SECOND INSTANCE DIES ON EADDRINUSE and the stack trace buries the reason,
REM so say it plainly and leave the running one alone.
netstat -ano | findstr /r /c:"LISTENING" | findstr /c:":%PORT% " >nul
if not errorlevel 1 (
  echo.
  echo   Something is already listening on %PORT%.
  echo   That is probably this server already running - open http://127.0.0.1:%PORT%
  echo   To restart it, close that window first, or:  set PORT=8801 ^&^& start.bat
  echo.
  pause
  exit /b 1
)

REM NO KEY IS NOT A REASON NOT TO START, and it is no longer a reason to go
REM and make a file either - the page has a button for it in the top right,
REM which writes this same .env after checking the key against Comfy.
if not exist ".env" (
  echo.
  echo   No .env yet - press the key in the top right of the page and paste
  echo   your Comfy key in. Everything free still works without one.
  echo.
)

echo.
echo   Hero's Journey  -^>  http://127.0.0.1:%PORT%
echo   Ctrl-C to stop.
echo.

REM THE PAGE OPENS ITSELF, and the server does the opening - from here it
REM could only be launched before node and would race the socket. HJ_OPEN is
REM the ask; setlocal keeps it out of the rest of the machine.
if /i not "%~1"=="noopen" set HJ_OPEN=1

REM RUNGS IS READ AT BOOT, so this is also how a new rung or a new input takes
REM effect. Run it in the foreground: the log is the point.
node server.js

REM Only reached if node exits on its own, which means it failed - hold the
REM window open so the reason is still on screen after a double-click.
echo.
echo   server stopped (exit %errorlevel%)
echo.
pause
