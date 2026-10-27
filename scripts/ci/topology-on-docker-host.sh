#!/usr/bin/env bash
set -Eeuo pipefail

: "${ASTER_IMAGE:?Set the local application image}"
: "${ASTER_ROUTER_IMAGE:?Set the local router image}"
: "${ASTER_NETWORK_IMAGE:?Set the local firewall image}"
: "${VAULT_CI_IMAGE:?Set the local broker image}"
: "${ASTER_DEPLOYMENT_TOOLS_IMAGE:?Set the local disposable operator image}"

source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
run_root=$(mktemp -d "${TMPDIR:-/tmp}/aster-host-rehearsal-XXXXXXXX")
container="aster-host-rehearsal-${run_root##*-}"
cleanup() {
  local result=$?
  trap - EXIT
  if ! docker rm --force "$container" >/dev/null 2>&1; then
    # A successful --rm run has already removed its container.
    if ! docker container ls --all --format '{{.Names}}' > "$run_root/containers" 2>/dev/null \
      || grep -Fxq "$container" "$run_root/containers"; then
      printf 'Host rehearsal operator cleanup FAILED\n' >&2
      result=1
    fi
  fi
  rm -rf -- "$run_root"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$run_root/source/scripts/ci" "$run_root/runtime"
# Only public Compose definitions and synthetic fixtures enter the operator.
# Identical host/container paths let Docker resolve the generated bind sources.
for file in docker-compose.agent-vault.yml docker-compose.router.yml \
  scripts/ci/compose-topology.mjs scripts/ci/topology-fixture.mjs scripts/ci/topology-probe.mjs; do
  cp -- "$source_root/$file" "$run_root/source/$file"
done
for image in "$ASTER_IMAGE" "$ASTER_ROUTER_IMAGE" "$ASTER_NETWORK_IMAGE" "$VAULT_CI_IMAGE" "$ASTER_DEPLOYMENT_TOOLS_IMAGE"; do
  docker image inspect "$image" >/dev/null
done
docker run --rm --name "$container" --pull never --network none --read-only \
  --user 0:0 --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 512m \
  --env "TMPDIR=$run_root/runtime" \
  --env ASTER_IMAGE --env ASTER_ROUTER_IMAGE --env ASTER_NETWORK_IMAGE --env VAULT_CI_IMAGE \
  --env ASTER_DEPLOYMENT_TOOLS_IMAGE \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount "type=bind,source=$run_root/source,target=$run_root/source,readonly" \
  --mount "type=bind,source=$run_root/runtime,target=$run_root/runtime" \
  --entrypoint node "$ASTER_DEPLOYMENT_TOOLS_IMAGE" "$run_root/source/scripts/ci/compose-topology.mjs"
