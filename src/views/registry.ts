import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ViewInfo } from "../types";
import { loadManifest, skillDirsOf, type ViewPackage } from "./manifest";
import type { ViewPlugin } from "./types";

export class ViewRegistry {
  private plugins = new Map<string, ViewPlugin>();
  private files = new Map<string, string>();
  private packs = new Map<string, ViewPackage>();
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

  packageOf(id: string): ViewPackage | undefined {
    return this.packs.get(id);
  }

  async loadAll(): Promise<void> {
    const keep = new Set<string>();
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir)) {
        const full = join(this.dir, name);
        if (statSync(full).isDirectory()) {
          const plugin = await this.loadPack(full);
          if (plugin) keep.add(plugin.id);
          continue;
        }
        if (!name.endsWith(".ts") && !name.endsWith(".js")) continue;
        const plugin = await this.loadFile(full);
        if (plugin) keep.add(plugin.id);
      }
    }
    for (const id of [...this.plugins.keys()]) {
      if (!keep.has(id)) {
        this.plugins.delete(id);
        this.files.delete(id);
        this.packs.delete(id);
      }
    }
  }

  watch(): void {
    if (!existsSync(this.dir)) return;
    this.watcher = watch(this.dir, { recursive: true }, async (_event, filename) => {
      if (!filename) return;
      const name = String(filename);
      if (name.includes("skills/") || name.endsWith("PACK.json")) return;
      const top = name.split(/[\\/]/)[0] ?? name;
      const full = join(this.dir, top);
      if (existsSync(full) && statSync(full).isDirectory()) {
        await this.loadPack(full);
      } else if (name.endsWith(".ts") || name.endsWith(".js")) {
        await this.loadFile(join(this.dir, name.includes("/") ? top : name));
      }
      this.onChange(this.list());
    });
  }

  close(): void {
    this.watcher?.close();
  }

  async loadFile(full: string): Promise<ViewPlugin | null> {
    if (!existsSync(full) || (existsSync(full) && statSync(full).isDirectory())) {
      const id = basename(full).replace(/\.(ts|js)$/, "");
      this.plugins.delete(id);
      this.files.delete(id);
      this.packs.delete(id);
      return null;
    }
    const plugin = await importPlugin(full);
    if (!plugin) return null;
    this.plugins.set(plugin.id, plugin);
    this.files.set(plugin.id, basename(full));
    this.packs.delete(plugin.id);
    return plugin;
  }

  async loadPack(dir: string): Promise<ViewPlugin | null> {
    const viewFile = existsSync(join(dir, "view.ts")) ? join(dir, "view.ts") : join(dir, "view.js");
    if (!existsSync(join(dir, "manifest.json")) || !existsSync(viewFile)) return null;
    const manifest = loadManifest(dir);
    const plugin = await importPlugin(viewFile);
    if (!plugin) return null;
    if (plugin.id !== manifest.name) {
      throw new Error(`view id ${plugin.id} ≠ manifest.name ${manifest.name}`);
    }
    this.plugins.set(plugin.id, plugin);
    this.files.set(plugin.id, join(basename(dir), basename(viewFile)));
    this.packs.set(plugin.id, { dir, manifest, skillDirs: skillDirsOf(dir, manifest) });
    return plugin;
  }
}

async function importPlugin(full: string): Promise<ViewPlugin | null> {
  const href = `${pathToFileURL(full).href}?t=${Date.now()}`;
  const mod = (await import(href)) as { default?: ViewPlugin } & Partial<ViewPlugin>;
  const plugin: ViewPlugin | undefined = mod.default ?? (mod.id && mod.createFork ? (mod as ViewPlugin) : undefined);
  if (!plugin?.id || !plugin.createFork) return null;
  return plugin;
}
