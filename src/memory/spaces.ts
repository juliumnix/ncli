import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assemble, type AssembledContext } from "./assemble";
import { Memory, type Compressor } from "./store";

export type SpaceId = "global" | "inbox" | `proj:${string}` | `spark:${string}`;

export interface SpaceRegistryOptions {
  dataDir: string;
  nodeBytes: number;
  viewBytes: number;
  compressor: Compressor;
  cwd: string;
  pumpBatch?: number;
}

export function spaceFor(cwd: string): SpaceId {
  const root = gitProjectRoot(cwd) ?? resolve(cwd);
  return `proj:${idOf(root)}`;
}

export function isSpaceId(value: string): value is SpaceId {
  return value === "global" || value === "inbox" || value.startsWith("proj:") || value.startsWith("spark:");
}

export class SpaceRegistry {
  readonly currentId: SpaceId;
  private readonly main: Memory;
  private readonly cache = new Map<string, Memory>();

  constructor(private readonly opts: SpaceRegistryOptions) {
    this.currentId = spaceFor(opts.cwd);
    this.main = this.open(join(opts.dataDir, "main"));
    this.cache.set(this.currentId, this.main);
  }

  of(id: string): Memory {
    if (id === this.currentId || id === "main") return this.main;
    const key = isSpaceId(id) ? id : `proj:${idOf(id)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const mem = this.open(join(this.opts.dataDir, "spaces", dirOf(key)));
    this.cache.set(key, mem);
    return mem;
  }

  current(): Memory {
    return this.main;
  }

  global(): Memory {
    return this.of("global");
  }

  inbox(): Memory {
    return this.of("inbox");
  }

  assemble(cwd: string): AssembledContext {
    const id = spaceFor(cwd);
    const proj = this.of(id);
    const ctx = assemble(proj);
    const view = [
      tagSpace(this.global().renderView(), "global"),
      tagSpace(proj.renderView(), id),
    ].join("\n");
    return { ...ctx, view };
  }

  private open(dir: string): Memory {
    return new Memory({
      dir,
      nodeBytes: this.opts.nodeBytes,
      viewBytes: this.opts.viewBytes,
      compressor: this.opts.compressor,
      pumpBatch: this.opts.pumpBatch,
    });
  }
}

function gitProjectRoot(cwd: string): string | null {
  const abs = resolve(cwd);
  if (!existsSync(abs)) return null;
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: abs,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const common = r.stdout.trim();
  if (!common) return null;
  const gitDir = resolve(abs, common);
  return dirname(gitDir);
}

function idOf(root: string): string {
  const real = existsSync(root) ? realpathSync(root) : resolve(root);
  return createHash("sha256").update(real).digest("hex").slice(0, 12);
}

function dirOf(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function tagSpace(view: string, space: string): string {
  return view.replace("<chat>", `<chat space="${space}">`);
}
