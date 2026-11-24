#!/bin/sh
# Whether CI may publish the manifest it built over what the channel publishes now (see
# docs/updates.md, Publishing): run under the publication lock, so a late run of an older commit
# never replaces a newer release, nor a different manifest one of the same build.
#
#   scripts/release-newest.sh <built manifest.json> [<published manifest.json>]
#
# Prints publish=true or publish=false (the same manifest is already published) for
# $GITHUB_OUTPUT, or says why not and exits 1. Without a published manifest, publishes.
set -eu
ours=$1
theirs=${2:-}
if [ -z "$theirs" ] || [ ! -s "$theirs" ]; then
  echo "publish=true"
  exit 0
fi
built=$(jq -er '.build.sequence | numbers' "$ours")
published=$(jq -er '.build.sequence | numbers' "$theirs")
if [ "$published" -gt "$built" ]; then
  echo "The channel already publishes build $published, newer than this build $built; nothing was published." >&2
  exit 1
fi
if [ "$published" -eq "$built" ]; then
  if cmp -s "$theirs" "$ours"; then
    echo "publish=false"
    exit 0
  fi
  echo "The channel publishes a different manifest for build $built; nothing was published." >&2
  exit 1
fi
echo "publish=true"
