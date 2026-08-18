#!/usr/bin/env bash
set -euo pipefail

SCRAPERS=(glints jooble seek pintarnya kitalulus)
LOG_DIR="$(dirname "$0")/logs"
TS_NODE="$(dirname "$0")/node_modules/.bin/ts-node"
SERVER="$(dirname "$0")/src/server.ts"

mkdir -p "$LOG_DIR"

# Check that config files exist for each scraper
MISSING=()
for name in "${SCRAPERS[@]}"; do
  cfg="$(dirname "$0")/${name}.json"
  if [[ ! -f "$cfg" ]]; then
    MISSING+=("$name (missing ${name}.json — copy from ${name}.json.sample)")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "WARNING: The following scrapers are not configured and will be skipped:"
  for m in "${MISSING[@]}"; do echo "  - $m"; done
  echo ""
fi

echo "Starting scrapers in parallel..."
echo "Logs → $LOG_DIR/"
echo ""

PIDS=()
NAMES=()

for name in "${SCRAPERS[@]}"; do
  cfg="$(dirname "$0")/${name}.json"
  [[ ! -f "$cfg" ]] && continue

  log="$LOG_DIR/${name}.log"
  echo "[$(date +%H:%M:%S)] Starting $name → $log"
  "$TS_NODE" "$SERVER" "$name" > "$log" 2>&1 &
  PIDS+=($!)
  NAMES+=("$name")
done

if [[ ${#PIDS[@]} -eq 0 ]]; then
  echo "No scrapers to run. Copy *.json.sample files to *.json and fill in your credentials."
  exit 1
fi

echo ""
echo "Running: ${NAMES[*]}"
echo "Press Ctrl+C to stop all."
echo ""

# Wait for all and report exit codes
FAILED=()
for i in "${!PIDS[@]}"; do
  pid=${PIDS[$i]}
  name=${NAMES[$i]}
  if wait "$pid"; then
    echo "[$(date +%H:%M:%S)] $name finished OK"
  else
    echo "[$(date +%H:%M:%S)] $name exited with error (see logs/$name.log)"
    FAILED+=("$name")
  fi
done

echo ""
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "All scrapers finished successfully."
else
  echo "Failed: ${FAILED[*]}"
  exit 1
fi
