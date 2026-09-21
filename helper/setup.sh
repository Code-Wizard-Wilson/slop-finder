#!/bin/sh
set -eu

cd "$(dirname "$0")"
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo
echo "Setup complete."
echo "Start the helper with: ./run.sh"
