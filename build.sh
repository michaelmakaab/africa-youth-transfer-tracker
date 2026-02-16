#!/bin/bash
# ─── Africa Youth Transfer Tracker — Build Script ───
# Reads data/players.json + data/intel.json, injects into src/template.html
# Output: dist/index.html (deployable single file)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"
TEMPLATE="$SCRIPT_DIR/src/template.html"
DIST_DIR="$SCRIPT_DIR/dist"

for f in "$DATA_DIR/players.json" "$DATA_DIR/intel.json" "$TEMPLATE"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found. Cannot build."
    exit 1
  fi
done

mkdir -p "$DIST_DIR"

PLAYERS_JSON=$(cat "$DATA_DIR/players.json")
INTEL_JSON=$(cat "$DATA_DIR/intel.json")

echo "Building tracker..."

{
  while IFS= read -r line; do
    if [[ "$line" == *"/*__PLAYERS_DATA__*/"* ]]; then
      echo "const PLAYERS_DATA = $PLAYERS_JSON;"
    elif [[ "$line" == *"/*__INTEL_DATA__*/"* ]]; then
      echo "const INTEL_DATA = $INTEL_JSON;"
    else
      echo "$line"
    fi
  done < "$TEMPLATE"
} > "$DIST_DIR/index.html"

# Also copy to root for convenience
cp "$DIST_DIR/index.html" "$SCRIPT_DIR/index.html"

SIZE=$(wc -c < "$DIST_DIR/index.html" | tr -d ' ')
echo "Build complete: dist/index.html ($SIZE bytes)"
echo "Also copied to: index.html"
