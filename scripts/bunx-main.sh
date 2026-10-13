#!/bin/sh
set -e
sha=$(git ls-remote https://github.com/juliumnix/ncli.git refs/heads/main | cut -f1)
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
wipe "$TMPDIR"
wipe /tmp
wipe /private/tmp
echo "NCLI: main $sha" >&2
export NCLI_REVISION=$sha
exec bunx "github:juliumnix/ncli#$sha" "$@"
