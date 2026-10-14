export function portPinned(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean((env.NCLI_PORT ?? "").trim());
}

export function isAddrInUse(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err && err.code === "EADDRINUSE") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /EADDRINUSE|already in use|port \d+ in use/i.test(msg);
}

export function nextPorts(start: number, n = 20): number[] {
  return Array.from({ length: n }, (_, i) => start + i);
}

export function listenCandidates(port: number, pinned: boolean): number[] {
  if (pinned) return [port];
  if (port === 0) return [0];
  return [...nextPorts(port), 0];
}

export function busyPortMessage(port: number): string {
  return `A porta ${port} está ocupada. Feche o outro NCLI ou use NCLI_PORT=${port + 1}.`;
}
