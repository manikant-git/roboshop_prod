#!/usr/bin/env bash
# Render every chart for every environment into ci/_rendered/<env>/<chart>.yaml
set -euo pipefail
cd "$(dirname "$0")/.."

CHARTS=(platform catalogue user cart shipping payment frontend mongodb mysql redis rabbitmq)
ENVS=(dev qa staging production)
OUT="${1:-ci/_rendered}"
rm -rf "$OUT"

for c in "${CHARTS[@]}"; do
  helm dependency build "charts/$c" >/dev/null
done

for e in "${ENVS[@]}"; do
  mkdir -p "$OUT/$e"
  for c in "${CHARTS[@]}"; do
    [[ -f "charts/$c/values-$e.yaml" ]] || continue
    helm template "$c" "charts/$c" \
      -f "environments/$e/global-values.yaml" \
      -f "charts/$c/values-$e.yaml" \
      > "$OUT/$e/$c.yaml"
  done
  echo "rendered $e -> $OUT/$e"
done
