#!/usr/bin/env bash
set -euo pipefail
while IFS= read -r file; do
  node --check "$file" >/dev/null
done < <(find src test -name '*.js' -type f | sort)
