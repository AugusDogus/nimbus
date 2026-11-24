#!/usr/bin/env bash
# Checks a built image the way it is run (see README and docs/updates.md), in CI only:
#
#   scripts/image-check.sh <image> [<previous image>]
#
# 1. Started as root with PUID and PGID: the supervisor runs as its own user with only the
#    capabilities to start and stop servers, the servers as PUID:PGID with none, and the config
#    root has the shared layout; the change is logged once.
# 2. Restarted: it serves again, and the layout is not changed or logged a second time.
# 3. Started with --user, the old way: it serves, as one user, with updates off and one line
#    saying why and how to turn them on.
# 4. With <previous image> (the channel's last published one): it runs on the new layout, or
#    refuses with its guard's instructions; then <image> serves on that state again.
#
# Each scenario has its own volumes under a temporary folder and its own container, removed at
# the end. Needs docker and permission to pull the images.
set -euo pipefail

image=$1
previous=${2:-}
work=$(mktemp -d)
containers=()
port=39300
secret=image-check-secret-0123456789abcdef0123

cleanup() {
  for name in "${containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  # Volumes hold files of the container's users; remove them as root, from a container.
  docker run --rm --entrypoint rm -v "$work:/work" "$image" -rf /work/volumes >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "image check failed: $*" >&2
  for name in "${containers[@]}"; do
    echo "--- docker logs $name" >&2
    docker logs "$name" >&2 2>&1 || true
  done
  exit 1
}

# Start container $1 from image $2 on volumes $3, with docker run options after that.
start() {
  local name=$1 from=$2 volumes=$3
  shift 3
  mkdir -p "$volumes/config" "$volumes/data"
  containers+=("$name")
  docker run -d --name "$name" -p "127.0.0.1:$port:3000" \
    --sysctl net.ipv4.tcp_migrate_req=1 \
    -e BETTER_AUTH_SECRET="$secret" -e BETTER_AUTH_URL="http://localhost:$port" \
    -v "$volumes/config:/config" -v "$volumes/data:/data" "$@" "$from" >/dev/null
}

# Wait until container $1 answers /api/health, at most 90 seconds, one request a second.
healthy() {
  for _ in $(seq 90); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/api/health"; then return 0; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$1")" = true ] || fail "$1 exited"
    sleep 1
  done
  fail "$1 did not answer /api/health within 90 seconds"
}

# "<uid> <capeff> <nonewprivs>" of the process in container $1 whose command line contains $2.
credentials() {
  docker exec "$1" sh -c '
    for status in /proc/[0-9]*/status; do
      dir=${status%/status}
      [ "$dir" != "/proc/$$" ] || continue
      tr "\0" " " < "$dir/cmdline" 2>/dev/null | grep -q -- "$0" || continue
      awk "/^Uid:/ {u=\$2} /^CapEff:/ {c=\$2} /^NoNewPrivs:/ {n=\$2} END {print u, c, n}" "$status"
      exit 0
    done
    exit 1' "$2"
}

stop() {
  docker stop -t 20 "$1" >/dev/null
}

echo "1. root with PUID and PGID"
split="$work/volumes/split"
start nimbus-check-split "$image" "$split" -e PUID=1000 -e PGID=1000
healthy nimbus-check-split
[ "$(credentials nimbus-check-split supervisor/main.ts)" = "1100 00000000000000e0 1" ] ||
  fail "the supervisor runs as $(credentials nimbus-check-split supervisor/main.ts), not 1100 with setuid, setgid and kill only"
[ "$(credentials nimbus-check-split server/start.ts)" = "1000 0000000000000000 1" ] ||
  fail "a server runs as $(credentials nimbus-check-split server/start.ts), not 1000 without capabilities"
layout=$(docker exec nimbus-check-split stat -c '%u:%g:%a' /config /config/supervisor /config/supervisor/releases /config/server.lock | tr '\n' ' ')
[ "$layout" = "0:1000:1771 1100:1100:755 1100:1100:755 1100:1000:660 " ] || fail "the config layout is $layout"
logs=$(docker logs nimbus-check-split 2>&1)
[ "$(grep -c 'with mode 1771' <<< "$logs")" = 1 ] || fail "the layout change was not logged once"
! grep -q 'every Nimbus process runs as one user' <<< "$logs" || fail "updates are off for one user although the users are split"

echo "2. restarted"
docker restart -t 20 nimbus-check-split >/dev/null
healthy nimbus-check-split
[ "$(docker logs nimbus-check-split 2>&1 | grep -c 'with mode 1771')" = 1 ] || fail "the layout change was made again after a restart"
[ "$(credentials nimbus-check-split server/start.ts)" = "1000 0000000000000000 1" ] || fail "after a restart a server runs as $(credentials nimbus-check-split server/start.ts)"
stop nimbus-check-split

echo "3. --user, the old way"
user="$work/volumes/user"
mkdir -p "$user/config" "$user/data"
docker run --rm --entrypoint chown -v "$user:/v" "$image" -R 1000:1000 /v >/dev/null
start nimbus-check-user "$image" "$user" --user 1000:1000
healthy nimbus-check-user
[ "$(docker logs nimbus-check-user 2>&1 | grep -c 'every Nimbus process runs as one user')" = 1 ] ||
  fail "under --user the reason updates are off was not logged once"
[ "$(credentials nimbus-check-user server/start.ts | cut -d' ' -f1)" = 1000 ] || fail "under --user a server does not run as 1000"
stop nimbus-check-user

if [ -n "$previous" ] && docker pull -q "$previous" >/dev/null 2>&1; then
  echo "4. the previous image on the new layout, then this one again"
  start nimbus-check-previous "$previous" "$split" -e PUID=1000 -e PGID=1000
  if ! (healthy nimbus-check-previous) 2>/dev/null; then
    docker logs nimbus-check-previous 2>&1 | grep -q 'a newer Nimbus release migrated this database' ||
      fail "the previous image neither ran on the new layout nor refused with instructions"
  fi
  stop nimbus-check-previous || true
  start nimbus-check-again "$image" "$split" -e PUID=1000 -e PGID=1000
  healthy nimbus-check-again
  layout=$(docker exec nimbus-check-again stat -c '%u:%g:%a' /config /config/supervisor/releases | tr '\n' ' ')
  [ "$layout" = "0:1000:1771 1100:1100:755 " ] || fail "after the previous image the config layout is $layout"
  stop nimbus-check-again
else
  echo "4. skipped: no previous image to pull"
fi

echo "image check passed"
