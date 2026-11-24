#!/usr/bin/env bash
# Checks a built image the way it is run (see README and docs/updates.md), in CI only:
#
#   scripts/image-check.sh <image> [<previous image>]
#
# 1. Started as root with PUID and PGID: the supervisor stays root with setuid, setgid, setpcap
#    and kill only, the servers run as PUID:PGID with none, the update store is root's with
#    staging the update user's, the config root is the servers' as on main, and neither the
#    servers' user nor the update user can write what runs.
# 2. Restarted: it serves again, the same way. A fresh bind mount and a named volume at the
#    store get the image's layout. A root folder made world-writable, as btrfs leaves it, is
#    made root's alone and the store accepted.
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
volumes=()
images=()
port=39300
secret=image-check-secret-0123456789abcdef0123

cleanup() {
  for name in "${containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  for name in "${volumes[@]}"; do docker volume rm -f "$name" >/dev/null 2>&1 || true; done
  for name in "${images[@]}"; do docker rmi -f "$name" >/dev/null 2>&1 || true; done
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
[ "$(credentials nimbus-check-split supervisor/main.ts)" = "0 00000000000001e0 1" ] ||
  fail "the supervisor runs as $(credentials nimbus-check-split supervisor/main.ts), not root with setuid, setgid, setpcap and kill only"
[ "$(credentials nimbus-check-split server/start.ts)" = "1000 0000000000000000 1" ] ||
  fail "a server runs as $(credentials nimbus-check-split server/start.ts), not 1000 without capabilities"
layout=$(docker exec nimbus-check-split stat -c '%u:%g:%a' /var/lib/nimbus /var/lib/nimbus/releases /var/lib/nimbus/staging | tr '\n' ' ')
[ "$layout" = "0:0:755 0:0:755 1100:0:750 " ] || fail "the update store's layout is $layout"
[ "$(docker exec nimbus-check-split stat -c '%u:%g' /config)" = "1000:1000" ] || fail "the config root is not the servers' as on main"
for attempt in 'touch /var/lib/nimbus/releases/planted' 'ls /var/lib/nimbus/staging' 'touch /var/lib/nimbus/staging/planted'; do
  ! docker exec -u 1000:1000 nimbus-check-split sh -c "$attempt" 2>/dev/null || fail "the servers' user could: $attempt"
done
! docker exec -u 1100:1100 nimbus-check-split sh -c 'touch /var/lib/nimbus/releases/planted' 2>/dev/null ||
  fail "the update user could write the releases"
logs=$(docker logs nimbus-check-split 2>&1)
! grep -q 'every Nimbus process runs as one user' <<< "$logs" || fail "updates are off for one user although the users are split"
! grep -q 'update store' <<< "$logs" || fail "the image's own update store was refused"

echo "2. restarted"
docker restart -t 20 nimbus-check-split >/dev/null
healthy nimbus-check-split
[ "$(credentials nimbus-check-split server/start.ts)" = "1000 0000000000000000 1" ] || fail "after a restart a server runs as $(credentials nimbus-check-split server/start.ts)"
stop nimbus-check-split

echo "2b. a fresh bind mount and a named volume at the store"
mkdir -p "$work/volumes/store-bind"
start nimbus-check-bind "$image" "$work/volumes/bind" -e PUID=1000 -e PGID=1000 -v "$work/volumes/store-bind:/var/lib/nimbus"
healthy nimbus-check-bind
layout=$(docker exec nimbus-check-bind stat -c '%u:%g:%a' /var/lib/nimbus /var/lib/nimbus/releases /var/lib/nimbus/staging | tr '\n' ' ')
[ "$layout" = "0:0:755 0:0:755 1100:0:750 " ] || fail "a bind-mounted store was laid out as $layout"
stop nimbus-check-bind
docker volume create nimbus-check-store >/dev/null
volumes+=(nimbus-check-store)
start nimbus-check-volume "$image" "$work/volumes/volume" -e PUID=1000 -e PGID=1000 -v nimbus-check-store:/var/lib/nimbus
healthy nimbus-check-volume
layout=$(docker exec nimbus-check-volume stat -c '%u:%g:%a' /var/lib/nimbus /var/lib/nimbus/releases /var/lib/nimbus/staging | tr '\n' ' ')
[ "$layout" = "0:0:755 0:0:755 1100:0:750 " ] || fail "a named volume store was laid out as $layout"
stop nimbus-check-volume

echo "2c. a root folder the storage driver left world-writable, as btrfs does"
printf 'FROM %s\nRUN chmod 777 /\n' "$image" | docker build -q -t nimbus-check-rootfs - >/dev/null
images+=(nimbus-check-rootfs)
if [ "$(docker run --rm --entrypoint stat nimbus-check-rootfs -c %a /)" != 777 ]; then
  echo "2c. skipped: this storage driver does not keep a world-writable root folder in a container"
else
  start nimbus-check-rootfs nimbus-check-rootfs "$work/volumes/rootfs" -e PUID=1000 -e PGID=1000
  healthy nimbus-check-rootfs
  [ "$(docker exec nimbus-check-rootfs stat -c %a /)" = 755 ] || fail "the container's root folder was left writable by others"
  logs=$(docker logs nimbus-check-rootfs 2>&1)
  [ "$(grep -c 'writable by root only' <<< "$logs")" = 1 ] || fail "securing the root folder was not logged once"
  ! grep -q 'not laid out' <<< "$logs" || fail "the update store was refused after the root folder was secured"
  ! grep -q 'left the owner' <<< "$logs" || fail "ownership was reported although nothing needed changing"
  stop nimbus-check-rootfs
fi

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
  [ "$(credentials nimbus-check-again server/start.ts)" = "1000 0000000000000000 1" ] ||
    fail "after the previous image a server runs as $(credentials nimbus-check-again server/start.ts)"
  stop nimbus-check-again
else
  echo "4. skipped: no previous image to pull"
fi

echo "image check passed"
