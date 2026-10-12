import type { Spark } from "../../src/types";
import type { SparkResult } from "../../src/views/manifest";
import type { ViewPlugin } from "../../src/views/types";

const plugin: ViewPlugin = {
  id: "team",
  label: "team",
  description: "Exemplo de view de empresa. As de verdade vêm de ncli view add <git privado>.",
  tabs: ["Chat"],
  parseLink(params) {
    return params;
  },
  async createSpark() {
    return {
      title: "team",
      prompt:
        "View team. Exemplo. Instale as views da empresa com `ncli view add git@github.com:acme/ncli-views.git#v1`.",
      needsWorktree: false,
      hold: true,
      needsUser: { kind: "review", label: "exemplo", count: 1 },
      flowStep: "spark",
    };
  },
  render(spark) {
    return `
      <div class="mh">
        <b>team #${spark.seq}</b> exemplo
        <button class="x" id="closeModal" type="button">✕</button>
      </div>
      <div class="mbody">
        <p>Views da empresa entram por cima do NCLI público:</p>
        <pre>bun run ncli view add git@github.com:acme/ncli-views.git#v1</pre>
      </div>
      <form class="mi" id="sparkForm">
        <input name="t" placeholder="Fala com o team…" autocomplete="off" />
      </form>`;
  },
  result(spark: Spark): SparkResult {
    return {
      summary: spark.summary ?? "team",
      artifacts: [],
      decisions: [],
      links: ["view://team"],
    };
  },
};

export default plugin;
