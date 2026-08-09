#!/usr/bin/env bash
# A shell script, for a third comment marker and a different keyword set.
set -euo pipefail

ROOT="${1:-.}"
COUNT=0

for file in "$ROOT"/*.md; do
  if [ -f "$file" ]; then
    echo "found $file"
    COUNT=$((COUNT + 1))
  fi
done

echo "total: $COUNT"
