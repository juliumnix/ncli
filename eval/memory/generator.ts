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

const PAD = " padding about billing lint chores and the sprint status of this repo.".repeat(6);

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
    lines.push({ kind, text: `synthetic filler ${i} ${FILLER[i % FILLER.length]}${PAD}` });
  }

  lines[simpleAt] = {
    kind: "user",
    text: `we decided the alpha file lives at /tmp/ncli/alpha.json (id 88421).${PAD}`,
  };
  needles.push({
    id: "simple",
    type: "simple",
    tokens: ["alpha file", "/tmp/ncli/alpha.json", "88421"],
    messageIndex: simpleAt,
    question: "Where does the alpha file live?",
    answer: "/tmp/ncli/alpha.json",
  });

  lines[oldAt] = { kind: "user", text: `the rate is ten for now.${PAD}` };
  lines[newAt] = { kind: "user", text: `correction: the rate is now 7, ignore the earlier ten.${PAD}` };
  needles.push({
    id: "superseded",
    type: "superseded",
    tokens: ["rate is now 7"],
    messageIndex: newAt,
    supersededBy: newAt,
    question: "What is the current rate?",
    answer: "rate is now 7",
  });

  lines[spaceAt] = {
    kind: "user",
    text: `in the other workspace the secret is other-space-token.${PAD}`,
    space: "proj:other",
  };
  needles.push({
    id: "space",
    type: "space",
    tokens: ["other-space-token"],
    messageIndex: spaceAt,
    space: "proj:other",
    question: "What is the other-workspace secret?",
    answer: "other-space-token",
  });

  needles.push({
    id: "echo",
    type: "echo",
    tokens: ["echo-only token", "/var/ncli/echo.log"],
    messageIndex: -1,
    inEcho: true,
    question: "What did the tool echo?",
    answer: "echo-only token /var/ncli/echo.log",
  });

  lines[siblingAt] = { kind: "user", text: `we hit a sibling bug in discount.ts:40.${PAD}` };
  lines[siblingAt + 1] = { kind: "talk", text: `fixed it: sibling bug closed by moving the tax check.${PAD}` };
  needles.push({
    id: "sibling",
    type: "sibling",
    tokens: ["sibling bug", "discount.ts:40"],
    messageIndex: siblingAt,
    question: "What happened to the sibling bug?",
    answer: "sibling bug closed",
  });

  return { seed, n, lines, needles };
}
