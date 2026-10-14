import type { CompactChoice, CompactMode, CompactProvider } from "./compact-choice";
import { choiceLabel } from "./compact-choice";

export type CompactSettingsState = {
  choice: CompactChoice;
  models: string[];
  error?: string;
  paused?: "budget" | "limit";
  envModel?: string;
};

const PROVIDER_ICON: Record<CompactProvider, { src: string; label: string }> = {
  codex: { src: "/icons/openai.svg", label: "Codex" },
  claude: { src: "/icons/claude.svg", label: "Claude" },
  cursor: { src: "/icons/cursor.svg", label: "Cursor" },
};

export function compactPauseLabel(paused?: "budget" | "limit"): string {
  if (paused === "limit") return "Pausado no limite";
  if (paused === "budget") return "Pausado: limite diário";
  return "";
}

export function compactSettingsHtml(state: CompactSettingsState): string {
  const { choice } = state;
  const envLock = Boolean(state.envModel);
  const modes = (["sdk", "cli"] as CompactMode[]).map((mode) => {
    const on = choice.mode === mode ? " on" : "";
    const label = mode === "sdk" ? "SDK" : "CLI";
    return `<button type="button" class="ctx-chip${on}" data-compact-mode="${mode}">${label}</button>`;
  }).join("");
  const providers = (Object.keys(PROVIDER_ICON) as CompactProvider[]).map((id) => {
    const on = choice.provider === id && choice.mode === "cli" ? " on" : "";
    const { src, label } = PROVIDER_ICON[id];
    return `<button type="button" class="ctx-chip compact-prov${on}" data-compact-provider="${id}" ${choice.mode === "cli" ? "" : "disabled"}>
      <img alt="" src="${src}" width="12" height="12">${label}
    </button>`;
  }).join("");
  const modelOpts = state.models.length
    ? state.models.map((id) => `<option value="${escapeAttr(id)}"${id === choice.model ? " selected" : ""}>${escapeHtml(id)}</option>`).join("")
    : `<option value="${escapeAttr(choice.model)}">${escapeHtml(choice.model || "modelo do CLI")}</option>`;
  const err = state.error ? `<p class="compact-err" role="alert">${escapeHtml(state.error)}</p>` : "";
  const pause = compactPauseLabel(state.paused)
    ? `<p class="compact-pause">${escapeHtml(compactPauseLabel(state.paused))}</p>`
    : "";
  const env = envLock ? `<p class="muted">NCLI_COMPACT_MODEL sobrepõe o modelo.</p>` : "";
  return `<section class="compact-set" id="compactSet">
    <div class="dbg-h">compactação</div>
    <p class="muted">${escapeHtml(choiceLabel(choice))}</p>
    <div class="compact-row" role="group" aria-label="modo">${modes}</div>
    <div class="compact-row" role="group" aria-label="provedor">${providers}</div>
    <label class="compact-model">
      <span>modelo</span>
      <select id="compactModel" ${envLock ? "disabled" : ""}>${modelOpts}</select>
    </label>
    ${env}${err}${pause}
  </section>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
