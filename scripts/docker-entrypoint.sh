#!/bin/sh
# Start Nimbus as PUID:PGID so files on bind mounts belong to the host user.
# Started as root: adjust ownership of Nimbus's own state, then drop privileges with setpriv
# and exec, keeping Bun as PID 1 so SIGTERM reaches it. Started with --user: run as given.
set -eu

fail() {
  printf 'Nimbus did not start: %s\n' "$*" >&2
  exit 1
}

mask=${UMASK:-022}
case "$mask" in
  [0-7][0-7][0-7] | 0[0-7][0-7][0-7]) ;;
  *) fail "UMASK=$mask is not an octal mask such as 022 or 002." ;;
esac
umask "$mask"

if [ "$(id -u)" -ne 0 ]; then
  exec "$@"
fi

uid=${PUID:-1000}
gid=${PGID:-1000}
for id in "$uid" "$gid"; do
  case "$id" in
    '' | *[!0-9]*) fail "PUID and PGID must be numeric IDs; got PUID=$uid PGID=$gid." ;;
  esac
  if [ "${#id}" -gt 10 ] || [ "$id" -lt 1 ] || [ "$id" -gt 4294967294 ]; then
    fail "PUID and PGID must be between 1 and 4294967294; got PUID=$uid PGID=$gid. Running as root is not supported."
  fi
done

owned() { [ "$(stat -c '%u:%g' -- "$1")" = "$uid:$gid" ]; }

config=${NIMBUS_CONFIG_ROOT:-/config}
data=${NIMBUS_DATA_ROOT:-/data}
mkdir -p -- "$config" "$data"

# The config root and the reserved .nimbus folder hold only Nimbus state (database, caches,
# trash, upload staging), so they are re-owned in full after a PUID or PGID change.
for state in "$config" "$data/.nimbus"; do
  if [ -d "$state" ] && ! owned "$state"; then
    chown -R --no-dereference "$uid:$gid" "$state" ||
      fail "could not give $state to $uid:$gid. File contents are unchanged, but some ownership may have changed. Check the volume's permissions and ID mapping, then restart."
  fi
done

# User files are never re-owned. Only the data root itself is, so Nimbus can create .nimbus.
if ! owned "$data" && ! chown --no-dereference "$uid:$gid" "$data"; then
  printf 'Nimbus could not give %s to %s:%s. Make sure that user can write to it.\n' "$data" "$uid" "$gid" >&2
fi

export HOME=/tmp
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$@"
