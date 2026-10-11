import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Harness, HarnessEvent, RunOpts } from "./types";
import { mockWriteSeat } from "./seats";
import { demoUiFence } from "../live/ui-demo";
import { parseViewLink } from "../util";

export interface MockScript {
  tools?: Array<{ name: string; input?: unknown }>;
  seats?: Array<{ seat: "codex" | "cursor"; text: string }>;
  text: string;
  hops?: string;
}

export class MockHarness implements Harness {
  readonly id = "mock";
  readonly lastCwds: string[] = [];
  readonly lastPrompts: string[] = [];
  readonly lastSystems: string[] = [];
  private steers: string[] = [];
  constructor(private readonly scriptFor: (prompt: string, session?: string) => MockScript = defaultScript) {}

  steer(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    this.steers.push(t);
    return true;
  }

  async *run(opts: RunOpts): AsyncIterable<HarnessEvent> {
    this.lastCwds.push(opts.cwd ?? "");
    this.lastPrompts.push(opts.prompt);
    this.lastSystems.push(opts.system ?? "");
    const script = this.scriptFor(opts.prompt, opts.session);
    let extras = "";
    const drain = async function* (this: MockHarness): AsyncGenerator<HarnessEvent> {
      while (this.steers.length) {
        const s = this.steers.shift()!;
        const piece = `\n\n${steerLine(s)}`;
        extras += piece;
        yield { type: "text", text: piece, seat: "claude" };
        await delay(8);
      }
    }.bind(this);
    yield { type: "model", model: "mock" };
    if (/^(quota|limite de uso)\b/i.test(lastUserBlock(opts.prompt).trim())) {
      yield {
        type: "error",
        error: "429 rate_limit quota exceeded. Usage limit resets at 15:00.",
      };
      return;
    }
    yield { type: "thinking", text: "lendo o contexto…", seat: "claude" };
    await delay(20);
    yield* drain();
    for (const t of script.tools ?? []) {
      yield { type: "tool", name: t.name, input: t.input ?? {}, id: t.name, seat: "claude" };
      await delay(15);
      yield { type: "tool_result", id: t.name, content: "ok" };
      yield* drain();
    }
    const seatDir = join(opts.cwd ?? "/tmp", ".ncli-seats");
    mkdirSync(seatDir, { recursive: true });
    for (const s of script.seats ?? []) {
      const out = join(seatDir, `${s.seat}.out`);
      yield { type: "seat", seat: s.seat, status: "start" };
      mockWriteSeat(out, s.seat, s.text, [`${s.seat} running`, s.text]);
      yield { type: "seat", seat: s.seat, status: "delta", text: s.text };
      yield { type: "seat", seat: s.seat, status: "done", text: s.text };
      await delay(20);
      yield* drain();
    }
    const text = script.text;
    for (const chunk of chunks(text, 24)) {
      yield { type: "text", text: chunk, seat: "claude" };
      await delay(12);
      yield* drain();
    }
    yield* drain();
    yield { type: "done", text: `${text}${extras}` };
  }
}

function defaultScript(prompt: string, session?: string): MockScript {
  const user = lastUserBlock(prompt);
  const links = parseViewLink(user);
  if (session && session !== "main") {
    return {
      tools: [{ name: "Read", input: { path: session } }],
      text: `Spark ${session} concluído. Resumo: trabalho isolado neste contexto.`,
    };
  }
  if (links.length) {
    const chips = links.map((l) => `view://${l.id}${qs(l.params)}`).join(" e ");
    return {
      tools: [{ name: "spark", input: { n: links.length } }],
      seats: [
        { seat: "codex", text: "applyTax() já recebe o subtotal com desconto. Bate." },
        { seat: "cursor", text: "Confirmo, e só aplica pra member desde o commit a3f9." },
      ],
      text: `Confirmei pelos dois: desconto antes do imposto, só member. Abri ${chips}, te chamo quando precisarem de você.`,
    };
  }
  if (/ncli-ui|mini-app|visualiz|\babas?\b|\btabs?\b|gr[aá]fico|como um card|card com|mostra .*card/i.test(user)) {
    return {
      text: `Aqui o recorte do plano B.\n\n${demoUiFence()}`,
    };
  }
  if (/desconto|discount|member/i.test(user)) {
    return {
      tools: [
        { name: "zoom", input: { id: 12, n: 16 } },
        { name: "date", input: { id: 12 } },
      ],
      hops: "zoom(12,16)→(12,8)→(12,4)→(12,2)→(12,1)",
      text: "Na msg #12 (FACT_MEMBER_DISCOUNT_BEFORE_TAX) ficou decidido que o desconto entra antes do imposto e só pra member.",
    };
  }
  return {
    text: `Ok. ${user.slice(0, 180) || "Pode mandar o próximo."}`,
  };
}

function steerLine(text: string): string {
  const body = text.replace(/^(ajuste|ajusta)\s*:\s*/i, "").trim();
  return `ajuste: ${body}`;
}

function lastUserBlock(prompt: string): string {
  const parts = prompt.split("\n\n");
  return parts[parts.length - 1] ?? prompt;
}

function qs(params: Record<string, string>): string {
  const sp = new URLSearchParams(params);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function delay(ms: number): Promise<void> {
  const extra = Number(process.env.NCLI_MOCK_STEP_MS || 0);
  const wait = ms + (Number.isFinite(extra) && extra > 0 ? extra : 0);
  return new Promise((r) => setTimeout(r, wait));
}

function chunks(text: string, n: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}
