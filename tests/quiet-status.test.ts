import { expect, test } from "bun:test";
import { formatElapsed, quietStatus, workedLabel } from "../src/live/quiet";
import type { Turn } from "../src/types";

function turn(partial: Partial<Turn> & Pick<Turn, "steps">): Turn {
  return {
    id: "t1",
    session: "main",
    seat: "claude",
    status: "running",
    startedAt: "2026-10-09T20:00:00.000Z",
    lastEventAt: "2026-10-09T20:00:12.000Z",
    ...partial,
  };
}

test("quietStatus maps a Read tool to Lendo o projeto without the raw name", () => {
  const q = quietStatus(turn({
    steps: [{
      id: "s1",
      kind: "tool",
      seat: "claude",
      title: "Read",
      text: "",
      status: "running",
      startedAt: "2026-10-09T20:00:01.000Z",
      tool: { name: "Read" },
    }],
  }), Date.parse("2026-10-09T20:00:12.000Z"));
  expect(q.phrase).toBe("Lendo o projeto…");
  expect(q.phrase).not.toContain("Read");
  expect(q.elapsedMs).toBe(12000);
  expect(q.stepCount).toBe(1);
});

test("ask to Codex says Consultando o Codex, never Cursor", () => {
  const q = quietStatus(turn({
    steps: [
      {
        id: "s1",
        kind: "ask",
        seat: "claude",
        title: "ask → Codex",
        text: "",
        status: "running",
        startedAt: "2026-10-09T20:00:02.000Z",
        to: "codex",
      },
    ],
  }), Date.parse("2026-10-09T20:00:12.000Z"));
  expect(q.phrase).toBe("Consultando o Codex…");
  expect(q.phrase).not.toContain("Cursor");
  expect(q.chips).toEqual([{ seat: "codex", label: "consultou Codex" }]);
});

test("quietStatus shows a Cursor chip and hides the tool dump", () => {
  const q = quietStatus(turn({
    steps: [
      {
        id: "s1",
        kind: "ask",
        seat: "cursor",
        title: "ask cursor",
        text: "",
        status: "running",
        startedAt: "2026-10-09T20:00:02.000Z",
        to: "cursor",
      },
    ],
  }), Date.parse("2026-10-09T20:00:12.000Z"));
  expect(q.phrase).toBe("Consultando o Cursor…");
  expect(q.chips).toEqual([{ seat: "cursor", label: "consultou Cursor" }]);
});

test("an empty running turn says Pensando, then stuck after 5s of silence", () => {
  const empty = turn({
    startedAt: "2026-10-09T20:00:00.000Z",
    lastEventAt: "2026-10-09T20:00:00.000Z",
    steps: [],
  });
  expect(quietStatus(empty, Date.parse("2026-10-09T20:00:00.080Z")).phrase).toBe("Pensando…");
  expect(quietStatus(empty, Date.parse("2026-10-09T20:00:05.000Z")).phrase).toContain("Sem resposta do Claude");
});

test("formatElapsed shows tenths under 10s", () => {
  expect(formatElapsed(80)).toBe("0.0s");
  expect(formatElapsed(340)).toBe("0.3s");
  expect(formatElapsed(12_000)).toBe("12s");
});

test("workedLabel counts seconds and steps", () => {
  expect(workedLabel(turn({
    status: "done",
    endedAt: "2026-10-09T20:00:42.000Z",
    steps: [
      {
        id: "s1",
        kind: "thinking",
        seat: "claude",
        title: "pensando",
        text: "hmm",
        status: "done",
        startedAt: "2026-10-09T20:00:00.000Z",
      },
    ],
  }))).toBe("Trabalhou por 42s · 1 passo");
});
