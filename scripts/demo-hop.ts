import { join } from "node:path";
import { Memory, mockCompressor } from "../src/memory/store";

const FACT = "FACT_MEMBER_DISCOUNT_BEFORE_TAX";
const dir = process.env.NCLI_DATA ? join(process.env.NCLI_DATA, "main") : join(process.cwd(), "data", "main");

const mem = new Memory({
  dir,
  nodeBytes: Number(process.env.NCLI_NODE ?? 140),
  viewBytes: Number(process.env.NCLI_VIEW ?? 900),
  compressor: mockCompressor(),
});

if (mem.T < 13) {
  console.error("run bun run seed first (need >= 13 messages, #12 holds the fact)");
  process.exit(1);
}

const cover = mem.view.find((p) => p.start <= 12 && 12 < p.start + p.n);
if (!cover) {
  console.error("message 12 is not in the view cover");
  process.exit(1);
}

console.log("cover:", `${cover.start}+${cover.n}|${cover.text}`);
let start = cover.start;
let n = cover.n;
let hops = 0;
while (n > 1) {
  const r = mem.zoom(start, n);
  if (!r.ok) {
    console.error(r.error);
    process.exit(1);
  }
  hops += 1;
  console.log(`hop ${hops} zoom(${start}, ${n})\n  ${r.lines.join("\n  ")}`);
  const mid = start + n / 2;
  if (12 >= mid) start = mid;
  n = n / 2;
}
const leaf = mem.zoom(12, 1);
if (!leaf.ok) {
  console.error(leaf.error);
  process.exit(1);
}
console.log(`leaf zoom(12, 1)\n  ${leaf.lines[0]}`);
if (!leaf.lines[0].includes(FACT)) {
  console.error("failed to recover FACT_MEMBER_DISCOUNT_BEFORE_TAX");
  process.exit(1);
}
console.log(`recovered ${FACT} from message #12 in ${hops} hops (mock compressor, no Claude CLI)`);
