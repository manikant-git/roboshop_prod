#!/usr/bin/env bash
# Schema-validate the rendered manifests with kubeconform.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-ci/_rendered}"
KUBE_VERSION="${KUBE_VERSION:-1.30.0}"

# CRDs that are not part of the upstream Kubernetes schema set.
SCHEMA_LOCATIONS=(
  -schema-location default
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
)

kubeconform \
  -kubernetes-version "$KUBE_VERSION" \
  -strict \
  -summary \
  -ignore-missing-schemas \
  "${SCHEMA_LOCATIONS[@]}" \
  "$OUT"
