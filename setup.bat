@echo off
setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%"

REM --- Find an existing Python virtual environment, whatever it's named ---
set "VENV_DIR="
for %%C in (venv .venv env .env virtualenv) do (
    if exist "%%C\Scripts\activate.bat" (
        set "VENV_DIR=%%C"
        goto :found_venv
    )
)

REM Fallback: search one level deep for any dir containing Scripts\activate.bat
for /d %%D in (*) do (
    if exist "%%D\Scripts\activate.bat" (
        set "VENV_DIR=%%D"
        goto :found_venv
    )
)

REM Still nothing? Create one.
echo No virtual environment found — creating one at .\venv
python -m venv venv
set "VENV_DIR=venv"

:found_venv
echo Using virtual environment: %VENV_DIR%
call "%VENV_DIR%\Scripts\activate.bat"

REM --- Install Python dependencies (best-effort; never blocks startup) ---
if exist "requirements.txt" (
    echo Checking Python dependencies...
    pip install -q -r requirements.txt
    if errorlevel 1 echo Warning: pip install had issues, continuing anyway.
) else (
    echo No requirements.txt found, skipping Python dependency install.
)

REM --- Install Node dependencies (best-effort; never blocks startup) ---
if exist "backend\" (
    echo Checking backend dependencies...
    pushd backend
    call npm install --silent
    if errorlevel 1 echo Warning: npm install had issues, continuing anyway.
    popd
) else (
    echo No backend\ directory found, skipping npm install.
)

REM --- Launch both servers in separate windows ---
echo Starting backend (port 3000)...
start "Backend" cmd /k "cd /d "%ROOT_DIR%backend" && npm run start"

echo Starting Flask app (port 5000)...
start "Frontend" cmd /k "cd /d "%ROOT_DIR%" && call "%VENV_DIR%\Scripts\activate.bat" && python app.py"

echo.
echo Both running in separate windows. Visit http://127.0.0.1:5000
echo Close each window to stop that server.

endlocal