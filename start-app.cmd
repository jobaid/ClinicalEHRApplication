@echo off
REM Starts the whole medical billing stack: PostgreSQL, the Go API, and the Vite frontend.
REM Double-click this file, or run  start-app.cmd  from a terminal.
REM
REM PostgreSQL runs in the background. The API and the frontend each open their own window so
REM you can watch their logs and stop them with Ctrl+C.

cd /d "%~dp0"

echo.
echo   Medical Billing - starting up
echo   -----------------------------

REM ---- 1. PostgreSQL (port 5433) ----
echo   [1/3] PostgreSQL ...
call npm run --silent db:start
if errorlevel 1 (
  echo.
  echo   ERROR: PostgreSQL failed to start. See tools\pg.log
  pause
  exit /b 1
)

REM ---- 2. Go API (port 8080) ----
if not exist "server\medbill-server.exe" (
  echo   [2/3] building the API ...
  tools\go\bin\go.exe build -C server -o medbill-server.exe .
  if errorlevel 1 (
    echo   ERROR: API build failed.
    pause
    exit /b 1
  )
)
echo   [2/3] Go API on port 8080 ...
start "medbill API" cmd /k "cd /d "%~dp0" && server\medbill-server.exe"

REM Give the API a moment to bind before the frontend starts requesting from it.
timeout /t 3 /nobreak >nul

REM ---- 3. Frontend (port 5173) ----
echo   [3/3] frontend on port 5173 ...
start "medbill web" cmd /k "cd /d "%~dp0" && npm run dev"

timeout /t 3 /nobreak >nul
echo.
echo   Ready - open  http://localhost:5173
echo.
echo   Sign in with any seeded account, for example:
echo      admin@medbill.local     Admin@12345       (Super Admin)
echo      manager@medbill.local   Manager@12345     (Manager)
echo      biller@medbill.local    Biller@12345      (Biller)
echo      nurse@medbill.local     Nurse@12345       (Nurse)
echo      reception@medbill.local Reception@12345   (Receptionist)
echo.
echo   To stop: close the two windows that opened, then run  npm run db:stop
echo.
pause
