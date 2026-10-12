import type { Needle, Transcript, TranscriptLine } from "./types";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLER = [
  "status da sprint e chores do repo",
  "reunião curta sobre billing",
  "lint passou no pacote de views",
  "nada a reportar neste turno",
  "ajuste menor no README",
];

export function generateTranscript(seed: number, n: number): Transcript {
  const rand = mulberry32(seed);
  const lines: TranscriptLine[] = [];
  const needles: Needle[] = [];
  const pick = (lo: number, hi: number) => Math.min(n - 1, Math.max(0, Math.floor(lo + (hi - lo) * rand())));

  const simpleAt = pick(10, Math.min(40, n - 1));
  const oldAt = pick(15, Math.min(60, n - 2));
  let newAt = pick(oldAt + 8, Math.min(oldAt + 80, n - 1));
  if (newAt <= oldAt) newAt = Math.min(n - 1, oldAt + 1);
  const spaceAt = pick(20, Math.min(90, n - 1));
  const siblingAt = pick(30, Math.min(n - 2, 120));

  for (let i = 0; i < n; i++) {
    const kind = i % 3 === 0 ? "user" : "talk";
    lines.push({ kind, text: `synthetic filler ${i} ${FILLER[i % FILLER.length]}` });
  }

  lines[simpleAt] = {
    kind: "user",
    text: "we decided FACT_ALPHA_ID_88421 lives at /tmp/ncli/alpha.json",
  };
  needles.push({
    id: "simple",
    type: "simple",
    tokens: ["FACT_ALPHA_ID_88421", "/tmp/ncli/alpha.json"],
    messageIndex: simpleAt,
    question: "What is FACT_ALPHA_ID_88421 and where does it live?",
    answer: "FACT_ALPHA_ID_88421 /tmp/ncli/alpha.json",
  });

  lines[oldAt] = { kind: "user", text: "the rate is RATE_WAS=10 for now" };
  lines[newAt] = { kind: "user", text: "correction: the rate is RATE_NOW=7, ignore RATE_WAS=10" };
  needles.push({
    id: "superseded",
    type: "superseded",
    tokens: ["RATE_NOW=7"],
    messageIndex: newAt,
    supersededBy: newAt,
    question: "What is the current rate?",
    answer: "RATE_NOW=7",
  });

  lines[spaceAt] = {
    kind: "user",
    text: "in the other workspace the secret is OTHER_SPACE_TOKEN",
    space: "proj:other",
  };
  needles.push({
    id: "space",
    type: "space",
    tokens: ["OTHER_SPACE_TOKEN"],
    messageIndex: spaceAt,
    space: "proj:other",
    question: "What is the other-workspace secret?",
    answer: "OTHER_SPACE_TOKEN",
  });

  needles.push({
    id: "echo",
    type: "echo",
    tokens: ["ECHO_ONLY_TOKEN", "/var/ncli/echo.log"],
    messageIndex: -1,
    inEcho: true,
    question: "What did the tool echo?",
    answer: "ECHO_ONLY_TOKEN /var/ncli/echo.log",
  });

  lines[siblingAt] = { kind: "user", text: "we hit BUG_SIBLING_OPEN in discount.ts:40" };
  lines[siblingAt + 1] = { kind: "talk", text: "fixed it: BUG_SIBLING_FIXED by moving the tax check" };
  needles.push({
    id: "sibling",
    type: "sibling",
    tokens: ["BUG_SIBLING_OPEN", "BUG_SIBLING_FIXED"],
    messageIndex: siblingAt,
    question: "What happened to BUG_SIBLING_OPEN?",
    answer: "BUG_SIBLING_FIXED",
  });

  return { seed, n, lines, needles };
}
