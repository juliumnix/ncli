import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Memory, mockCompressor } from "../src/memory/store";

const FACT = "FACT_MEMBER_DISCOUNT_BEFORE_TAX";
const dir = process.env.NCLI_DATA ? join(process.env.NCLI_DATA, "main") : join(process.cwd(), "data", "main");
mkdirSync(dir, { recursive: true });

const mem = new Memory({
  dir,
  nodeBytes: Number(process.env.NCLI_NODE ?? 140),
  viewBytes: Number(process.env.NCLI_VIEW ?? 900),
  compressor: mockCompressor(),
});

if (mem.T > 0) {
  console.log(`already has ${mem.T} messages at ${dir}`);
  process.exit(0);
}

for (let i = 0; i < 300; i++) {
  const text = i === 12
    ? `we decided ${FACT} discount before tax member only`
    : `synthetic filler line ${i} about meetings repos and chores`;
  mem.append({ kind: i % 3 === 0 ? "user" : "talk", text });
}
await mem.pump();
console.log(`seeded ${mem.T} messages. view ${mem.viewBytesUsed()} bytes, levels ${mem.levels().join(" ")}`);
console.log(`msg #12: ${mem.log[12].text}`);
console.log(mem.renderView());
