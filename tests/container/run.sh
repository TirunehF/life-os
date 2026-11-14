#!/usr/bin/env bash
# Test deploy/install.sh, lifeos-update (with rollback), lifeos-reset-password
# and deploy/uninstall.sh on a throwaway machine: an ordinary, unprivileged
# Docker container. Nothing is installed on your own computer.
#
#   tests/container/run.sh [base image]      default: debian:12
#
# The container has no systemd; a stand-in for systemctl starts and stops the
# processes (see fake-systemctl). So this covers the scripts' logic: users,
# ownership, the checkout, options, snapshots, update and rollback, reset,
# uninstall. The systemd sandbox itself can only be checked on a real machine;
# README.md lists the commands.
set -euo pipefail

BASE=${1:-debian:12}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(cd "$HERE/../.." && pwd -P)
IMAGE=lifeos-install-test:$(printf '%s' "$BASE" | tr -c 'a-z0-9.' '-')
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# A snapshot of the working tree (committed or not) as a small git repository.
mkdir "$WORK/src"
(cd "$ROOT" && git ls-files -co --exclude-standard -z | xargs -0 cp --parents -t "$WORK/src")
git -C "$WORK/src" init -q -b main
git -C "$WORK/src" -c user.name=test -c user.email=test@example.com add -A
git -C "$WORK/src" -c user.name=test -c user.email=test@example.com commit -q -m "working tree under test"

docker build -q --build-arg BASE="$BASE" -t "$IMAGE" "$HERE" >/dev/null
# No --privileged, no init, no extra capabilities, no host devices.
docker run --rm -v "$WORK/src:/src:ro" -v "$HERE/inside.sh:/inside.sh:ro" "$IMAGE" bash /inside.sh
