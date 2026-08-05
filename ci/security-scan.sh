#!/usr/bin/env bash
# Checkov policy scan over the rendered Kubernetes manifests.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-ci/_rendered}"

checkov \
  --directory "$OUT" \
  --framework kubernetes \
  --compact \
  --quiet \
  --config-file ci/checkov.yaml
