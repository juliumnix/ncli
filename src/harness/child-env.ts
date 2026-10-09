const STRIP = /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_CREDENTIALS|CLAUDE_.*TOKEN|CLAUDE_.*CREDENTIAL|ANTHROPIC_.*TOKEN)$/i;

export function childEnv(
  parent: Record<string, string | undefined>,
  opts: { allowAnthropicKey?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (STRIP.test(key)) {
      if (opts.allowAnthropicKey && key === "ANTHROPIC_API_KEY") out[key] = value;
      continue;
    }
    out[key] = value;
  }
  return out;
}
