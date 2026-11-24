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

# Give root folder $1 itself, nothing in it, to $2:$3 (see docs/updates.md, Privileges), after
# resolving it physically, and only when no folder above it, up to one root owns, could be
# changed by that user: otherwise a link swapped in there could lead the change anywhere. Leaves
# it as it is and says so when it cannot. Ownership inside a root is never changed as root.
own_root() {
  dir=$1
  uid=$2
  gid=$3
  if ! real=$(cd -P -- "$dir" 2>/dev/null && pwd -P); then
    printf 'Nimbus left the owner of %s as it is: it could not resolve it.\n' "$dir" >&2
    return 0
  fi
  # Already the servers': nothing to change, and nothing to say, whatever is above it.
  [ "$(stat -c '%u:%g' -- "$real")" != "$uid:$gid" ] || return 0
  above=$real
  while [ "$above" != / ]; do
    above=$(dirname -- "$above")
    details=$(stat -c '%u %g %a' -- "$above")
    owner=${details%% *}
    rest=${details#* }
    group=${rest%% *}
    mode=$((0${rest#* }))
    if [ "$owner" = "$uid" ] || { [ "$group" = "$gid" ] && [ $((mode & 020)) -ne 0 ]; } || [ $((mode & 002)) -ne 0 ]; then
      printf 'Nimbus left the owner of %s as it is: %s above it can be changed by %s:%s, so changing ownership through it is not safe. Give %s to %s:%s yourself if Nimbus cannot write it.\n' "$real" "$above" "$uid" "$gid" "$real" "$uid" "$gid" >&2
      return 0
    fi
    [ "$owner" != 0 ] || break
  done
  if ! chown -- "$uid:$gid" "$real"; then
    printf 'Nimbus could not give %s to %s:%s. Make sure that user can write to it.\n' "$real" "$uid" "$gid" >&2
  fi
}

# Some storage drivers, such as btrfs, give a container's own root folder $1 mode 777: then the
# servers' user could rename /var or /app and put a tree of its own in its place. That folder is
# the container's own filesystem, never a mount of the host's, so taking group and other write
# off it changes nothing outside the container. No process of the servers' user exists yet: the
# entrypoint runs first at every start of the container, a restart having stopped every process
# of the run before, and only an operator's docker exec can run beside it. A root folder that is
# not root's, or cannot be changed (a read-only root filesystem), is left as it is, and in-app
# updates stay off, saying why.
secure_root_dir() {
  dir=$1
  details=$(stat -c '%u %a' -- "$dir") || return 0
  owner=${details%% *}
  mode=$((0${details#* }))
  [ $((mode & 022)) -ne 0 ] || return 0
  if [ "$owner" != 0 ]; then
    printf 'In-app updates are off: the container'"'"'s root folder %s may be changed by others (mode %o) and belongs to user %s, not root, so Nimbus left it as it is.\n' "$dir" "$mode" "$owner" >&2
  elif chmod go-w -- "$dir" 2>/dev/null; then
    printf 'Nimbus made the container'"'"'s root folder %s writable by root only (it was mode %o, as some storage drivers such as btrfs leave it), so no other user can replace the folders above the update store and the image'"'"'s code.\n' "$dir" "$mode" >&2
  else
    printf 'In-app updates are off: the container'"'"'s root folder %s may be changed by others (mode %o) and Nimbus could not change that (a read-only root filesystem?), so its update store cannot be trusted. Make it writable by root only, or let the container write it once.\n' "$dir" "$mode" >&2
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

  # Before anything looks at the folders above the roots or the store. A test root folder only
  # from a checkout, as the other test seams.
  root_dir=/
  if [ -n "${NIMBUS_TEST_ROOT_DIR:-}" ] && [ -e "$(dirname -- "$0")/../.git" ]; then
    root_dir=$NIMBUS_TEST_ROOT_DIR
  fi
  secure_root_dir "$root_dir"

  check_roots "${NIMBUS_DATA_ROOT-/data}" "${NIMBUS_CONFIG_ROOT-/config}"
  mkdir -p -- "$config" "$data"

  # Only the two roots themselves become PUID:PGID's, so Nimbus can create what it needs in them.
  own_root "$data" "$uid" "$gid"
  own_root "$config" "$uid" "$gid"

  # The supervisor stays root with only what its job needs (see docs/updates.md, Privileges):
  # setuid and setgid to start servers as PUID:PGID and the installer as the update user,
  # setpcap for those children to empty their bounding sets, kill to signal them. It drops
  # privileges for every child it starts. Without setpcap or kill, everything runs as PUID:PGID.
  caps=-all,+setuid,+setgid,+setpcap,+kill
  if [ "$split" = 1 ]; then
    # 1100 is the image's update user (see the Dockerfile). A test store only from a checkout,
    # as the supervisor's test seams (TestSeams).
    store=/var/lib/nimbus
    if [ -n "${NIMBUS_TEST_STORE_DIR:-}" ] && [ -e "$(dirname -- "$0")/../.git" ]; then
      store=$NIMBUS_TEST_STORE_DIR
    fi
    prepare_store "$store" 1100 ||
      printf 'In-app updates are off: Nimbus could not prepare its update store %s. Installed releases still start if they verify.\n' "$store" >&2
    # Root runs Bun with nothing a server could have left for it to load: no variable that
    # changes what Bun or the loader load, a home only root may write, no transpiler cache (which
    # would live in that home), a fixed PATH, and absolute commands. Servers get HOME=/tmp from
    # the supervisor, as before.
    for name in $(env | sed -n 's/^\(BUN_[A-Za-z0-9_]*\|LD_[A-Za-z0-9_]*\|NODE_OPTIONS\|NODE_PATH\|TMPDIR\|XDG_[A-Za-z0-9_]*\|BUNFIG[A-Za-z0-9_]*\)=.*/\1/p'); do
      unset "$name"
    done
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    export PATH
    command=$(command -v -- "$1") || fail "the command $1 is not installed in this image."
    shift
    exec /usr/bin/setpriv --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set="$caps" --no-new-privs \
      -- /usr/bin/env HOME=/root BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
      NIMBUS_SERVER_UID="$uid" NIMBUS_SERVER_GID="$gid" "$command" "$@"
  fi
  printf 'In-app updates are off: this container cannot limit its supervisor to the capabilities it needs (CAP_SETUID, CAP_SETGID, CAP_SETPCAP and CAP_KILL, which a cap_drop may remove), so every process runs as %s:%s. Keep Docker'"'"'s default capabilities to turn them on.\n' "$uid" "$gid" >&2
  export HOME=/tmp
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$@"
}

if [ "${NIMBUS_ENTRYPOINT_FUNCTIONS:-}" != 1 ]; then
  main "$@"
fi
