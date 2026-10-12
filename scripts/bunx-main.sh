#!/bin/sh
set -e
sha=$(git ls-remote https://github.com/juliumnix/ncli.git refs/heads/main | cut -f1)
if [ -z "$sha" ]; then
  echo "NCLI: não achei o tip do main." >&2
  exit 1
fi
echo "NCLI: main $sha" >&2
export NCLI_REVISION=$sha
exec bunx "github:juliumnix/ncli#$sha" "$@"
