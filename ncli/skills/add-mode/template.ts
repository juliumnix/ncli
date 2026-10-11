const plugin = {
  id: "{{id}}",
  label: "{{id}}",
  description: "{{id}} mode: holds until the user acts, then merges.",
  tabs: ["Chat"],
  parseLink(params) {
    return params;
  },
  async createSpark(params) {
    const title = params.title ?? "{{id}}";
    const ui = { kind: "{{id}}", title, note: "waiting" };
    return {
      title,
      prompt: `Mode {{id}}. Wait for the user. Do not invent extra phases.`,
      needsWorktree: true,
      hold: true,
      ui,
      needsUser: { kind: "question", label: "sua vez", count: 1 },
    };
  },
  applyAction(spark, action) {
    if (action.type === "say" || action.type === "done") {
      return {
        ui: { ...spark.ui, note: action.value ?? "ok" },
        needsUser: null,
        merge: true,
        summary: action.value ?? "ok",
      };
    }
    return;
  },
  render(spark) {
    const ui = spark.ui ?? { title: "{{id}}", note: "" };
    return `<div class="mh"><b>{{id}} #${spark.seq}</b> ${ui.title}<button class="x" id="closeModal" type="button">✕</button></div>
      <div class="mbody"><p>${ui.note}</p></div>
      <form class="mi" id="sparkForm"><input name="t" placeholder="responde e volta pro chat" autocomplete="off" /></form>`;
  },
};

export default plugin;
