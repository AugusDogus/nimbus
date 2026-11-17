#!/bin/sh
# Start Nimbus as PUID:PGID so files on bind mounts belong to the host user.
# Started as root: give Nimbus's own state to that user, then drop privileges with setpriv
# and exec, keeping Bun as PID 1 so SIGTERM reaches it. Started with --user: run as given.
# User files are never re-owned. NIMBUS_ENTRYPOINT_FUNCTIONS=1 only defines the functions,
# for tests.
set -eu

fail() {
  printf 'Nimbus did not start: %s\n' "$*" >&2
  exit 1
}

# Refuse roots that would make startup change ownership outside Nimbus's state. Uses the
# rule the server applies (getConfigRoot in apps/web/server/storage-paths.ts): a config root
# inside the data root must be under its .nimbus. The rule holds both for the paths as written,
# normalized like Node's path.resolve, and for the directories symbolic links lead to.
check_roots() {
  for value in "$1" "$2"; do
    case "$value" in
      '') fail "NIMBUS_DATA_ROOT and NIMBUS_CONFIG_ROOT must not be empty. Unset one to use its default. Nothing was changed." ;;
      *[[:cntrl:]]*) fail "NIMBUS_DATA_ROOT and NIMBUS_CONFIG_ROOT must not contain control characters such as newlines. Nothing was changed." ;;
    esac
  done
  check_pair "$(realpath -m -s -- "$1")" "$(realpath -m -s -- "$2")"
  check_pair "$(realpath -m -- "$1")" "$(realpath -m -- "$2")"
  data=$(realpath -m -s -- "$1")
  config=$(realpath -m -s -- "$2")
}

check_pair() {
  [ "$1" != / ] || fail "NIMBUS_DATA_ROOT is /. Mount the folder Nimbus should manage, such as /data, and point NIMBUS_DATA_ROOT at it. Nothing was changed."
  [ "$2" != / ] || fail "NIMBUS_CONFIG_ROOT is /. Point it at a directory used only by Nimbus, such as /config. Nothing was changed."
  case "$2/" in
    "$1/.nimbus/"*) ;;
    "$1/"*) fail "NIMBUS_CONFIG_ROOT ($2) is inside the data root ($1), where its files could be browsed and shared. Set it outside the data root, such as /config, or under $1/.nimbus. Nothing was changed." ;;
  esac
  case "$1/" in
    "$2/"*) fail "NIMBUS_CONFIG_ROOT ($2) contains the data root ($1). Point it at a separate directory used only by Nimbus, such as /config. Nothing was changed." ;;
  esac
}

# Print, NUL-separated, the entries Nimbus writes itself that do not belong to $1:$2: the
# config root with its database, backups and thumbnail cache, and the .nimbus folder with
# its own directories, unfinished uploads, and a database kept there by DATABASE_URL.
# Trashed items and saved versions are user content and keep their owner. Regular files are
# listed only with a link count of 1, so an inode shared with a user file (a finished upload,
# a version) is never re-owned, and symbolic links are never followed.
state_entries() {
  uid=$1
  gid=$2
  config=$3
  internal=$4/.nimbus
  foreign() {
    find "$@" \( ! -uid "$uid" -o ! -gid "$gid" \) -print0
  }
  database() {
    for name in db.sqlite db.sqlite-wal db.sqlite-shm db.sqlite-journal; do
      [ ! -e "$1/$name" ] || foreign "$1/$name" -maxdepth 0 -type f -links 1
    done
  }
  [ ! -d "$config" ] || foreign "$config" -maxdepth 0 -type d
  database "$config"
  [ ! -d "$config/backups" ] || foreign "$config/backups" -maxdepth 1 \( -type d -o -type f -links 1 \)
  [ ! -d "$config/cache" ] || foreign "$config/cache" \( -type d -o -type f -links 1 \)
  if [ -d "$internal" ] && [ ! -L "$internal" ]; then
    foreign "$internal" -maxdepth 1 -type d
    [ "$internal" = "$config" ] || database "$internal"
    [ ! -d "$internal/versions" ] || foreign "$internal/versions" -mindepth 1 -maxdepth 1 -type d
    [ ! -d "$internal/uploads" ] || foreign "$internal/uploads" -mindepth 1 -maxdepth 1 -type f -links 1
  fi
}

main() {
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

  check_roots "${NIMBUS_DATA_ROOT-/data}" "${NIMBUS_CONFIG_ROOT-/config}"
  mkdir -p -- "$config" "$data"

  # Only the data root itself is re-owned, so Nimbus can create .nimbus and the home folders.
  if [ "$(stat -c '%u:%g' -- "$data")" != "$uid:$gid" ] && ! chown -h -- "$uid:$gid" "$data"; then
    printf 'Nimbus could not give %s to %s:%s. Make sure that user can write to it.\n' "$data" "$uid" "$gid" >&2
  fi
  state_entries "$uid" "$gid" "$config" "$data" | xargs -0r chown -h -- "$uid:$gid" ||
    fail "could not give Nimbus's state in $config and $data/.nimbus to $uid:$gid. File contents are unchanged, but some ownership may have changed. Check the volume's permissions and ID mapping, then restart."

  export HOME=/tmp
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$@"
}

if [ "${NIMBUS_ENTRYPOINT_FUNCTIONS:-}" != 1 ]; then
  main "$@"
fi
