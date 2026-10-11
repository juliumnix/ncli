import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface LedgerFile {
  fingerprints: string[];
}

export class ImportLedger {
  private seen = new Set<string>();
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "import-seen.json");
    this.load();
  }

  has(fingerprint: string): boolean {
    return this.seen.has(fingerprint);
  }

  add(fingerprints: string[]): void {
    let grew = false;
    for (const fp of fingerprints) {
      if (this.seen.has(fp)) continue;
      this.seen.add(fp);
      grew = true;
    }
    if (grew) this.save();
  }

  size(): number {
    return this.seen.size;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as LedgerFile;
      for (const fp of raw.fingerprints ?? []) {
        if (typeof fp === "string" && fp) this.seen.add(fp);
      }
    } catch {
      this.seen.clear();
    }
  }

  private save(): void {
    const body: LedgerFile = { fingerprints: [...this.seen].sort() };
    writeFileSync(this.file, JSON.stringify(body, null, 2) + "\n", "utf8");
  }
}
