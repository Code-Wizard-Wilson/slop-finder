#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ ! -x ".venv/bin/python" ]; then
  echo "Missing .venv. Run ./setup.sh first."
  exit 1
fi

exec .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
