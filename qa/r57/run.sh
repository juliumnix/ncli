#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ncli-r57-XXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

fail() { echo "FAIL $*" >&2; exit 1; }

echo "== 3. missing newline must not glue the next line"
dir="$tmp/nl"
mkdir -p "$dir"
printf '%s\n%s' '{"i":0,"kind":"user","text":"a","size":1,"date":"2020-01-01T00:00:00.000Z"}' '{"i":1,"kind":"user","text":"b","size":1,"date":"2020-01-01T00:00:00.000Z"}' > "$dir/log.jsonl"
bun -e '
import { Memory, mockCompressor } from "./src/memory/store.ts";
const mem = new Memory({ dir: process.argv[1], nodeBytes: 200, viewBytes: 800, compressor: mockCompressor() });
mem.append({ kind: "user", text: "c" });
const file = await Bun.file(process.argv[1] + "/log.jsonl").text();
if (file.includes("}{")) throw new Error("glued JSON: " + file.slice(0, 120));
const ids = file.trim().split("\n").map((l) => JSON.parse(l).i);
if (ids.join(",") !== "0,1,2") throw new Error("ids " + ids);
' "$dir"

echo "== 3. shrunk log 50 -> 5"
dir="$tmp/shrink"
mkdir -p "$dir"
bun -e '
import { writeFileSync } from "node:fs";
import { Memory, mockCompressor } from "./src/memory/store.ts";
const dir = process.argv[1];
const first = new Memory({ dir, nodeBytes: 200, viewBytes: 800, compressor: mockCompressor() });
first.ingest(Array.from({ length: 50 }, (_, i) => ({ kind: "user", text: "n " + i })));
const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ i, kind: "user", text: "k "+i, size: 4, date: "2020-01-01T00:00:00.000Z" }));
writeFileSync(dir + "/log.jsonl", lines.join("\n") + "\n");
const again = new Memory({ dir, nodeBytes: 200, viewBytes: 800, compressor: mockCompressor() });
const page = await again.logIndex.page({});
if (page.messageCount !== 5 || page.messages.length !== 5) throw new Error("page " + page.messageCount + " " + page.messages.length);
' "$dir"

echo "== 3. kill -9 after 100 appends"
dir="$tmp/crash"
mkdir -p "$dir"
bun -e '
import { Memory, mockCompressor } from "./src/memory/store.ts";
const dir = process.argv[1];
const first = new Memory({ dir, nodeBytes: 200, viewBytes: 800, compressor: mockCompressor() });
for (let i = 0; i < 100; i++) first.append({ kind: "user", text: "n " + i });
' "$dir"
bun -e '
import { Memory, mockCompressor } from "./src/memory/store.ts";
const again = new Memory({ dir: process.argv[1], nodeBytes: 200, viewBytes: 800, compressor: mockCompressor() });
const last = await again.logIndex.page({ limit: 10 });
if (last.messageCount !== 100 || last.messages.length !== 10 || last.messages[0]?.i !== 90) {
  throw new Error("crash page " + JSON.stringify({ n: last.messageCount, len: last.messages.length, first: last.messages[0]?.i }));
}
' "$dir"

echo "== 1. /api/state last window after index boot"
echo "run bun test tests/state-page.test.ts tests/log-index.test.ts tests/virt-100k.test.ts"

echo "qa/r57 ok"
