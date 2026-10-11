import type { Fork } from "../../src/types";
import type { ViewPlugin } from "../../src/views/types";
import type { ForkResult } from "../../src/views/manifest";

const plugin: ViewPlugin = {
  id: "{{id}}",
  label: "{{id}}",
  description: "{{id}} fork. Isolated package under views/{{id}}/.",
  tabs: ["Chat"],
  parseLink(params) {
    return params;
  },
  async createFork(params) {
    return {
      title: params.title ?? "{{id}}",
      prompt: `View {{id}}. Isolated fork. Follow the declared flow, then finish.`,
      needsWorktree: false,
      flowStep: "spark",
    };
  },
  result(fork: Fork): ForkResult {
    return {
      summary: fork.summary ?? "{{id}} done",
      artifacts: [],
      decisions: [],
      links: [`view://{{id}}`],
    };
  },
};

export default plugin;
