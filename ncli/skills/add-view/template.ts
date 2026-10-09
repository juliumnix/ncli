const plugin = {
  id: "{{id}}",
  label: "{{id}}",
  description: "{{id}} fork. Edit this file; the registry hot-reloads it.",
  tabs: ["Chat"],
  parseLink(params) {
    return params;
  },
  async createFork(params) {
    return {
      title: params.title ?? "{{id}}",
      prompt: `View {{id}}. Isolated fork. Do the user's task, then finish.`,
      needsWorktree: false,
    };
  },
};

export default plugin;
