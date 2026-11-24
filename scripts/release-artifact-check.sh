#!/bin/sh
# Whether the downloaded release artifact is the one the bundle job built (see docs/updates.md,
# Publishing): its manifest and its one bundle, at the top of <dir>, with the SHA-256 digests the
# bundle job reported. Says which file is missing, or which digest differs, and exits 1.
#
#   scripts/release-artifact-check.sh <dir> <manifest sha-256> <bundle sha-256>
set -eu
dir=$1
manifest=$2
bundle=$3
found() {
  printf 'What %s holds:\n' "$dir" >&2
  find "$dir" -maxdepth 3 2>/dev/null | head -20 >&2 || true
}
if [ ! -f "$dir/manifest.json" ]; then
  echo "$dir/manifest.json is missing: the artifact was not downloaded where this job reads it." >&2
  found
  exit 1
fi
set -- "$dir"/*.tar.gz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "$dir holds $# bundles where it should hold exactly one (*.tar.gz): the artifact was not downloaded where this job reads it." >&2
  found
  exit 1
fi
actual=$(sha256sum "$dir/manifest.json" | cut -d' ' -f1)
if [ "$actual" != "$manifest" ]; then
  echo "$dir/manifest.json has SHA-256 $actual, not the $manifest the bundle job built." >&2
  exit 1
fi
actual=$(sha256sum "$1" | cut -d' ' -f1)
if [ "$actual" != "$bundle" ]; then
  echo "$1 has SHA-256 $actual, not the $bundle the bundle job built." >&2
  exit 1
fi
echo "The artifact is the bundle the bundle job built."
