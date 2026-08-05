#!/usr/bin/env bash
# Lint every Roboshop chart against every environment values file.
set -euo pipefail
cd "$(dirname "$0")/.."

CHARTS=(platform catalogue user cart shipping payment frontend mongodb mysql redis rabbitmq)
ENVS=(dev qa staging production)

echo "==> helm dependency build"
for c in "${CHARTS[@]}"; do
  helm dependency build "charts/$c" >/dev/null
done

echo "==> helm lint (strict)"
for c in "${CHARTS[@]}"; do
  helm lint "charts/$c" --strict
  for e in "${ENVS[@]}"; do
    [[ -f "charts/$c/values-$e.yaml" ]] || continue
    helm lint "charts/$c" --strict \
      -f "environments/$e/global-values.yaml" \
      -f "charts/$c/values-$e.yaml"
  done
done
echo "OK"
