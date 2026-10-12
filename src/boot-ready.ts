import { existsSync, mkdirSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CliPresence } from "./ui/chrome";

export type ReadyNotice = {
  url: string;
  clis: CliPresence;
};

export function readyUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function formatClis(clis: CliPresence): string {
  const one = (name: keyof CliPresence) => `${name} ${clis[name] ? "ok" : "missing"}`;
  return `clis  ${one("claude")}, ${one("codex")}, ${one("cursor")}`;
}

export function formatReady(notice: ReadyNotice): string {
  return `NCLI rodando em ${notice.url}\n${formatClis(notice.clis)}`;
}

export function flushText(text: string, fd = 1): void {
  writeSync(fd, text.endsWith("\n") ? text : `${text}\n`);
}

export function announceReady(notice: ReadyNotice, fd = 1): void {
  flushText(formatReady(notice), fd);
}

export function noOpen(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.NCLI_NO_OPEN ?? "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

export function browserOpenedPath(dataDir: string): string {
  return join(dataDir, "browser-opened");
}

export function shouldOpenBrowser(
  env: Record<string, string | undefined> = process.env,
  opened = false,
): boolean {
  if (opened) return false;
  if (noOpen(env)) return false;
  return true;
}

export function markBrowserOpened(dataDir: string): string {
  const path = browserOpenedPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${new Date().toISOString()}\n`);
  return path;
}

export function openCommand(url: string, platform = process.platform): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

export function openReadyBrowser(opts: {
  url: string;
  dataDir: string;
  env?: Record<string, string | undefined>;
  spawn?: (cmd: string[]) => void;
}): boolean {
  const env = opts.env ?? process.env;
  const opened = existsSync(browserOpenedPath(opts.dataDir));
  if (!shouldOpenBrowser(env, opened)) return false;
  const spawn = opts.spawn ?? defaultOpenSpawn;
  try {
    spawn(openCommand(opts.url));
  } catch {
    return false;
  }
  markBrowserOpened(opts.dataDir);
  return true;
}

function defaultOpenSpawn(cmd: string[]): void {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  proc.unref();
}
