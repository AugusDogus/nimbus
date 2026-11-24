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

# The update store (see docs/updates.md): the image creates it; a fresh volume or bind mount there
# gets the same layout once. Only the store folder itself and its two folders are touched, none
# re-owned recursively: the store becomes root's, `releases` is created as root's, `staging` as
# the update user's ($2:0, mode 750). A store laid out otherwise is left as it is, and the
# supervisor says updates are off and why. Returns non-zero if it could not.
prepare_store() {
  store=$1
  update=$2
  if [ -L "$store" ]; then
    printf 'In-app updates are off: the update store %s is a link, which Nimbus does not follow; it was left as it is. Mount a folder there instead.\n' "$store" >&2
    return 0
  fi
  [ -d "$store" ] || mkdir -m 755 -- "$store" || return 1
  if [ "$(stat -c '%u:%g' -- "$store")" != 0:0 ]; then chown -h -- 0:0 "$store" || return 1; fi
  chmod go-w -- "$store" || return 1
  [ -e "$store/releases" ] || [ -L "$store/releases" ] || mkdir -m 755 -- "$store/releases" || return 1
  if [ ! -e "$store/staging" ] && [ ! -L "$store/staging" ]; then
    mkdir -m 750 -- "$store/staging" && chown -h -- "$update:0" "$store/staging" || return 1
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
      '' | *[!0-9]* | 0?*) fail "PUID and PGID must be numeric IDs without leading zeros; got PUID=$uid PGID=$gid." ;;
    esac
    if [ "${#id}" -gt 10 ] || [ "$id" -lt 1 ] || [ "$id" -gt 4294967294 ]; then
      fail "PUID and PGID must be between 1 and 4294967294; got PUID=$uid PGID=$gid. Running as root is not supported."
    fi
  done

  # What this container may do, read before anything is changed: the mode is chosen from it,
  # and nothing is half applied. Switching to PUID:PGID needs setuid (7) and setgid (6); the
  # supervisor's job as root also needs setpcap (8) and kill (5).
  effective=$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)
  holds() { [ $(((0x$effective >> $1) & 1)) -eq 1 ]; }
  if ! holds 6 || ! holds 7; then
    fail "this container cannot switch to PUID:PGID ($uid:$gid): it lacks CAP_SETUID or CAP_SETGID, so nothing was changed. Start it with --user $uid:$gid instead, with its volumes already writable by that user."
  fi
  split=0
  if holds 5 && holds 8; then split=1; fi

  check_roots "${NIMBUS_DATA_ROOT-/data}" "${NIMBUS_CONFIG_ROOT-/config}"
  mkdir -p -- "$config" "$data"

  # Only the data root itself is re-owned, so Nimbus can create .nimbus and the home folders.
  if [ "$(stat -c '%u:%g' -- "$data")" != "$uid:$gid" ] && ! chown -h -- "$uid:$gid" "$data"; then
    printf 'Nimbus could not give %s to %s:%s. Make sure that user can write to it.\n' "$data" "$uid" "$gid" >&2
  fi
  state_entries "$uid" "$gid" "$config" "$data" | xargs -0r chown -h -- "$uid:$gid" ||
    fail "could not give Nimbus's state in $config and $data/.nimbus to $uid:$gid. File contents are unchanged, but some ownership may have changed. Check the volume's permissions and ID mapping, then restart."

  export HOME=/tmp
  # The supervisor stays root with only what its job needs (see docs/updates.md, Privileges):
  # setuid and setgid to start servers as PUID:PGID and the installer as the update user,
  # setpcap for those children to empty their bounding sets, kill to signal them. It drops
  # privileges for every child it starts. Without setpcap or kill, everything runs as PUID:PGID.
  caps=-all,+setuid,+setgid,+setpcap,+kill
  if [ "$split" = 1 ]; then
    # 1100 is the image's update user (see the Dockerfile).
    prepare_store "${NIMBUS_TEST_STORE_DIR:-/var/lib/nimbus}" 1100 ||
      printf 'In-app updates are off: Nimbus could not prepare its update store %s. Installed releases still start if they verify.\n' "${NIMBUS_TEST_STORE_DIR:-/var/lib/nimbus}" >&2
    exec setpriv --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set="$caps" --no-new-privs \
      -- env NIMBUS_SERVER_UID="$uid" NIMBUS_SERVER_GID="$gid" "$@"
  fi
  printf 'In-app updates are off: this container cannot limit its supervisor to the capabilities it needs (CAP_SETUID, CAP_SETGID, CAP_SETPCAP and CAP_KILL, which a cap_drop may remove), so every process runs as %s:%s. Keep Docker'"'"'s default capabilities to turn them on.\n' "$uid" "$gid" >&2
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$@"
}

if [ "${NIMBUS_ENTRYPOINT_FUNCTIONS:-}" != 1 ]; then
  main "$@"
fi
