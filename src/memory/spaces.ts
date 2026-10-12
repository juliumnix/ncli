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
  deferCutAfter?: number;
  compressTimeoutMs?: number;
}

const gitRootByCwd = new Map<string, string | null>();

export function spaceFor(cwd: string): SpaceId {
  const abs = resolve(cwd);
  const root = gitProjectRoot(abs) ?? abs;
  return `proj:${idOf(root)}`;
}

export function isSpaceId(value: string): value is SpaceId {
  return value === "global" || value === "inbox" || /^proj:[a-f0-9]{12}$/.test(value) || /^spark:[A-Za-z0-9._-]+$/.test(value);
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
    if (id === this.currentId || id === "main" || id === "current") return this.main;
    if (!isSpaceId(id) || id.startsWith("spark:")) {
      const hit = this.cache.get(id);
      return hit ?? this.main;
    }
    const hit = this.cache.get(id);
    if (hit) return hit;
    const mem = this.open(join(this.opts.dataDir, "spaces", dirOf(id)));
    this.cache.set(id, mem);
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
      deferCutAfter: this.opts.deferCutAfter,
      compressTimeoutMs: this.opts.compressTimeoutMs,
    });
  }
}

function gitProjectRoot(cwd: string): string | null {
  const abs = resolve(cwd);
  const cached = gitRootByCwd.get(abs);
  if (cached) return cached;
  if (!existsSync(abs)) {
    gitRootByCwd.set(abs, null);
    return null;
  }
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: abs,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    gitRootByCwd.set(abs, null);
    return null;
  }
  const common = r.stdout.trim();
  if (!common) {
    gitRootByCwd.set(abs, null);
    return null;
  }
  const root = dirname(resolve(abs, common));
  gitRootByCwd.set(abs, root);
  return root;
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
