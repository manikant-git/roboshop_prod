#!/usr/bin/env bash
# Package every chart and push it to the OCI registry.
#   OCI_REGISTRY=oci://<acct>.dkr.ecr.<region>.amazonaws.com/roboshop ci/package.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CHARTS=(common platform catalogue user cart shipping payment frontend mongodb mysql redis rabbitmq)
DIST="${DIST:-dist}"
mkdir -p "$DIST"

for c in "${CHARTS[@]}"; do
  [[ "$c" == "common" ]] || helm dependency build "charts/$c" >/dev/null
  helm package "charts/$c" --destination "$DIST"
done

if [[ -n "${OCI_REGISTRY:-}" ]]; then
  for pkg in "$DIST"/*.tgz; do
    echo "pushing $pkg -> $OCI_REGISTRY"
    helm push "$pkg" "$OCI_REGISTRY"
  done
else
  echo "OCI_REGISTRY not set - packaged only, nothing pushed."
fi
