import type { Spark } from "../../src/types";
import type { ViewPlugin } from "../../src/views/types";
import type { SparkResult } from "../../src/views/manifest";

const plugin: ViewPlugin = {
  id: "{{id}}",
  label: "{{id}}",
  description: "{{id}} view. Isolated package under views/{{id}}/.",
  tabs: ["Chat"],
  parseLink(params) {
    return params;
  },
  async createSpark(params) {
    return {
      title: params.title ?? "{{id}}",
      prompt: `View {{id}}. Isolated spark. Follow the declared flow, then finish.`,
      needsWorktree: false,
      flowStep: "spark",
    };
  },
  result(spark: Spark): SparkResult {
    return {
      summary: spark.summary ?? "{{id}} done",
      artifacts: [],
      decisions: [],
      links: [`view://{{id}}`],
    };
  },
};

export default plugin;
