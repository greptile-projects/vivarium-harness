#!/usr/bin/env bash
# Build the fixed arm image as an OCI template, then import it into Docker
# Sandboxes' private image store. The host Docker daemon is only a builder; arm
# execution never uses it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template="vivarium-arm:latest"
archive="$(mktemp -t vivarium-arm-template-XXXXXX.tar)"

cleanup() {
  rm -f "$archive"
}
trap cleanup EXIT

docker build --pull -t "$template" "$root"
docker image save "$template" -o "$archive"
sbx template rm "$template" >/dev/null 2>&1 || true
sbx template load "$archive"

echo "built and imported Docker Sandbox template: $template"
