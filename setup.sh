#!/bin/bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# --- Find an existing Python virtual environment, whatever it's named ---
VENV_DIR=""
for candidate in venv .venv env .env virtualenv; do
    if [ -f "$candidate/bin/activate" ]; then
        VENV_DIR="$candidate"
        break
    fi
done

# Fallback: search one level deep for any dir containing bin/activate
if [ -z "$VENV_DIR" ]; then
    found=$(find . -maxdepth 2 -type f -name "activate" -path "*/bin/activate" 2>/dev/null | head -n 1)
    if [ -n "$found" ]; then
        VENV_DIR="$(dirname "$(dirname "$found")")"
    fi
fi

# Still nothing? Create one.
if [ -z "$VENV_DIR" ]; then
    echo "No virtual environment found — creating one at ./venv"
    python3 -m venv venv
    VENV_DIR="venv"
fi

echo "Using virtual environment: $VENV_DIR"
source "$VENV_DIR/bin/activate"

# --- Install Python dependencies (best-effort; never blocks startup) ---
if [ -f "requirements.txt" ]; then
    echo "Checking Python dependencies..."
    pip install -q -r requirements.txt || echo "Warning: pip install had issues, continuing anyway."
else
    echo "No requirements.txt found, skipping Python dependency install."
fi

# --- Install Node dependencies (best-effort; never blocks startup) ---
if [ -d "backend" ]; then
    echo "Checking backend dependencies..."
    (cd backend && npm install --silent) || echo "Warning: npm install had issues, continuing anyway."
else
    echo "No backend/ directory found, skipping npm install."
fi

# --- Launch both servers ---
cleanup() {
    echo ""
    echo "Stopping servers..."
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    exit 0
}
trap cleanup INT TERM

echo "Starting backend (port 3000)..."
(cd "$ROOT_DIR/backend" && npm run start) &
BACKEND_PID=$!

echo "Starting Flask app (port 5000)..."
python3 app.py &
FRONTEND_PID=$!

echo ""
echo "Both running. Visit http://127.0.0.1:5000"
echo "Press Ctrl+C to stop both."

wait