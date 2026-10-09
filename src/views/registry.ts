import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ViewInfo } from "../types";
import type { ViewPlugin } from "./types";

export class ViewRegistry {
  private plugins = new Map<string, ViewPlugin>();
  private files = new Map<string, string>();
  private watcher: FSWatcher | undefined;
  onChange: (views: ViewInfo[]) => void = () => {};

  constructor(private readonly dir: string) {}

  list(): ViewInfo[] {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      tabs: p.tabs,
      file: this.files.get(p.id) ?? `${p.id}.ts`,
    }));
  }

  get(id: string): ViewPlugin | undefined {
    return this.plugins.get(id);
  }

  async loadAll(): Promise<void> {
    const keep = new Set<string>();
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith(".ts") && !name.endsWith(".js")) continue;
        const plugin = await this.loadFile(join(this.dir, name));
        if (plugin) keep.add(plugin.id);
      }
    }
    for (const id of [...this.plugins.keys()]) {
      if (!keep.has(id)) {
        this.plugins.delete(id);
        this.files.delete(id);
      }
    }
  }

  watch(): void {
    if (!existsSync(this.dir)) return;
    this.watcher = watch(this.dir, async (_event, filename) => {
      if (!filename || !(filename.endsWith(".ts") || filename.endsWith(".js"))) return;
      await this.loadFile(join(this.dir, String(filename)));
      this.onChange(this.list());
    });
  }

  close(): void {
    this.watcher?.close();
  }

  async loadFile(full: string): Promise<ViewPlugin | null> {
    if (!existsSync(full)) {
      const id = basename(full).replace(/\.(ts|js)$/, "");
      this.plugins.delete(id);
      this.files.delete(id);
      return null;
    }
    const href = `${pathToFileURL(full).href}?t=${Date.now()}`;
    const mod = (await import(href)) as { default?: ViewPlugin } & Partial<ViewPlugin>;
    const plugin: ViewPlugin | undefined = mod.default ?? (mod.id && mod.createFork ? (mod as ViewPlugin) : undefined);
    if (!plugin?.id || !plugin.createFork) return null;
    this.plugins.set(plugin.id, plugin);
    this.files.set(plugin.id, basename(full));
    return plugin;
  }
}
