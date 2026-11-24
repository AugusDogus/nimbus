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

# Give the supervisor and the servers users of their own (see docs/updates.md), once: the config
# root becomes root:PGID with mode 1771, so the servers ($2:$3) still create their files in it but
# cannot rename or remove what they do not own, and nobody else can list it; the supervisor ($4)
# gets <config>/supervisor for the releases it installs, and the installation lock. Nothing is
# re-owned recursively. Anything already at <config>/supervisor that is not the supervisor's
# own folder, such as a link or a folder the servers' user made, is set aside and never trusted.
# Prints what it changed on standard error; returns non-zero if it could not.
prepare_split() {
  config=$1
  uid=$2
  gid=$3
  update=$4
  if [ "$(stat -c '%u:%g:%a' -- "$config")" != "0:$gid:1771" ]; then
    chown -h -- "0:$gid" "$config" && chmod 1771 -- "$config" || return 1
    printf 'Nimbus gave %s to root:%s with mode 1771, so its servers can no longer replace what the supervisor installs. An older image gives it back to %s.\n' "$config" "$gid" "$uid" >&2
  fi
  supervisor=$config/supervisor
  if [ -L "$supervisor" ] || { [ -e "$supervisor" ] && [ "$(stat -c '%u:%F' -- "$supervisor")" != "$update:directory" ]; }; then
    aside="$config/supervisor.untrusted-$(date -u +%Y%m%dT%H%M%SZ)"
    mv -- "$supervisor" "$aside" || return 1
    printf 'Nimbus set %s aside as %s: it was not made by the supervisor, so nothing in it is trusted. Remove it once you have looked at it.\n' "$supervisor" "$aside" >&2
  fi
  if [ ! -e "$supervisor" ]; then
    mkdir -m 755 -- "$supervisor" && chown -h -- "$update:$update" "$supervisor" || return 1
  fi
  if [ ! -d "$supervisor/releases" ] || [ -L "$supervisor/releases" ]; then
    rm -f -- "$supervisor/releases"
    mkdir -m 755 -- "$supervisor/releases" && chown -h -- "$update:$update" "$supervisor/releases" || return 1
  fi
  lock=$config/server.lock
  if [ -L "$lock" ] || { [ -e "$lock" ] && [ ! -f "$lock" ]; }; then rm -f -- "$lock" || return 1; fi
  [ -e "$lock" ] || : > "$lock" || return 1
  chown -h -- "$update:$gid" "$lock" && chmod 660 -- "$lock" || return 1
  rm -f -- "$config/server.lock-journal"
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

  # The supervisor's own user, which installs releases the servers must not be able to change.
  update=${NIMBUS_UPDATE_UID:-1100}
  split=1
  case "$update" in
    '' | *[!0-9]*) split=0 ;;
  esac
  if [ "$split" = 1 ] && { [ "$update" -lt 1 ] || [ "$update" = "$uid" ] || [ "$update" = "$gid" ]; }; then split=0; fi
  [ "$split" = 1 ] || printf 'In-app updates are off: NIMBUS_UPDATE_UID=%s is not a user of its own (a number other than 0, PUID and PGID), so the supervisor and the servers run as one user. Unset it, or set another number.\n' "$update" >&2

  check_roots "${NIMBUS_DATA_ROOT-/data}" "${NIMBUS_CONFIG_ROOT-/config}"
  mkdir -p -- "$config" "$data"

  # Only the data root itself is re-owned, so Nimbus can create .nimbus and the home folders.
  if [ "$(stat -c '%u:%g' -- "$data")" != "$uid:$gid" ] && ! chown -h -- "$uid:$gid" "$data"; then
    printf 'Nimbus could not give %s to %s:%s. Make sure that user can write to it.\n' "$data" "$uid" "$gid" >&2
  fi
  # Split, the config root itself is root's (prepare_split), not the servers'.
  state_entries "$uid" "$gid" "$config" "$data" | { if [ "$split" = 1 ]; then grep -zvxF -- "$config"; else cat; fi; } | xargs -0r chown -h -- "$uid:$gid" ||
    fail "could not give Nimbus's state in $config and $data/.nimbus to $uid:$gid. File contents are unchanged, but some ownership may have changed. Check the volume's permissions and ID mapping, then restart."

  export HOME=/tmp
  if [ "$split" = 1 ]; then
    # Only the rights to start the servers as PUID:PGID and to stop them; the supervisor drops
    # even those for them. Numbers and names only, so word splitting is safe.
    caps=-all,+setuid,+setgid,+kill
    privileges="--reuid=$update --regid=$update --clear-groups --inh-caps=$caps --ambient-caps=$caps --bounding-set=$caps --no-new-privs"
    if ! prepare_split "$config" "$uid" "$gid" "$update"; then
      printf 'In-app updates are off: Nimbus could not give its supervisor a user of its own in %s, so every process runs as %s:%s. Check that the config root can be re-owned (some network file systems refuse it).\n' "$config" "$uid" "$gid" >&2
    # Tried first, so a container without these capabilities still starts.
    # shellcheck disable=SC2086
    elif ! setpriv $privileges -- true 2>/dev/null; then
      printf 'In-app updates are off: this container cannot give its supervisor a user of its own with only the rights to start and stop servers (that needs CAP_SETPCAP, CAP_SETUID, CAP_SETGID and CAP_KILL, which a cap_drop may remove), so every process runs as %s:%s. Keep Docker'"'"'s default capabilities to turn them on.\n' "$uid" "$gid" >&2
    else
      # shellcheck disable=SC2086
      exec setpriv $privileges -- env NIMBUS_SERVER_UID="$uid" NIMBUS_SERVER_GID="$gid" "$@"
    fi
    # One user after all: the config root is that user's again. If even that fails, the server
    # says which folder it cannot write.
    chown -h -- "$uid:$gid" "$config" 2>/dev/null || true
  fi
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$@"
}

if [ "${NIMBUS_ENTRYPOINT_FUNCTIONS:-}" != 1 ]; then
  main "$@"
fi
