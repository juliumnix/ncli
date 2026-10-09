export function toolActivityLine(names: string[]): string | undefined {
  if (!names.length) return undefined;
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  return `tools: ${parts.join(", ")}`;
}
