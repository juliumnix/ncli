#!/bin/sh
set -e
sha=$NCLI_REVISION
if [ -z "$sha" ]; then
  sha=$(curl -fsSL -H "Accept: application/vnd.github.sha" -H "User-Agent: ncli" https://api.github.com/repos/juliumnix/ncli/commits/main)
fi
if [ -z "$sha" ]; then
  echo "NCLI: não achei o tip do main." >&2
  exit 1
fi
uid=$(id -u)
wipe() {
  dir=$1
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  for extract in "$dir"/bunx-"$uid"-ncli@github@*; do
    [ -e "$extract" ] || continue
    rm -rf "$extract"
  done
}
if [ -n "$NCLI_BUNX_TMPDIRS" ]; then
  old_ifs=$IFS
  IFS=:
  for dir in $NCLI_BUNX_TMPDIRS; do
    wipe "$dir"
  done
  IFS=$old_ifs
else
  wipe "$TMPDIR"
  wipe /tmp
  wipe /private/tmp
fi
echo "NCLI: main $sha" >&2
export NCLI_REVISION=$sha
exec bunx "github:juliumnix/ncli#$sha" "$@"
