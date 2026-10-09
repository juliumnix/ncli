import type { Memory } from "./memory/store";
import type { Fork } from "./types";

export interface DemoHost {
  memory: Memory;
  openLinks: (text: string) => Promise<Fork[]>;
  seedViewSeq: (view: string, last: number) => void;
}

function todayAt(h: number, m: number): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

export async function seedDemo(host: DemoHost): Promise<void> {
  host.memory.append({
    kind: "user",
    text: "confirma no código a regra do desconto e já abre review do PR 482 e refina o card de pickup",
    date: todayAt(12, 3),
  });
  host.memory.append({
    kind: "seat",
    text: "`applyTax()` recebe o subtotal já com desconto. Bate.",
    seat: "codex",
    date: todayAt(12, 4),
  });
  host.memory.append({
    kind: "seat",
    text: "Confirmo, e só aplica pra member desde o commit a3f9.",
    seat: "cursor",
    date: todayAt(12, 4),
  });
  host.memory.append({
    kind: "talk",
    text: "Confirmado pelos dois: desconto antes do imposto, só member. Abri a view://review?pr=482 e o view://refino?card=Pickup+scheduling, te chamo quando precisarem de você.",
    seat: "claude",
    date: todayAt(12, 5),
  });
  host.memory.append({
    kind: "merge",
    text: "review #2 voltou · aprovado, 1 sugestão de teste",
    date: todayAt(12, 5),
    seat: "claude",
  });
  host.memory.append({
    kind: "user",
    text: "e aquele bug do PDF?",
    date: todayAt(12, 6),
  });
  host.memory.append({
    kind: "talk",
    text: "É o cabeçalho quebrando quando o nome do cliente passa de 40 caracteres. Quer que eu corrija?",
    seat: "claude",
    date: todayAt(12, 6),
  });
  host.memory.append({
    kind: "user",
    text: "mostra o fluxo do desconto e um preview do card",
    date: todayAt(12, 7),
  });
  host.memory.append({
    kind: "talk",
    text: `Fluxo no núcleo, e o card. Abri a view://live.

\`\`\`ncli mermaid
graph TD
A[subtotal] --> B[member discount]
B --> C[tax]
C --> D[total]
\`\`\`

\`\`\`ncli html
<div style="font:14px sans-serif;padding:8px"><b>Pickup scheduling</b><p>customer picks a slot · confirmation in the app</p></div>
\`\`\``,
    seat: "claude",
    date: todayAt(12, 8),
  });
  host.seedViewSeq("review", 2);
  host.seedViewSeq("refino", 1);
  await host.openLinks(
    "view://refino?card=Pickup+scheduling view://review?pr=482 view://live",
  );
}
