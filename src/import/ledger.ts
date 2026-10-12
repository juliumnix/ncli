import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface LedgerFile {
  fingerprints: string[];
}

export class ImportLedger {
  private seen = new Set<string>();
  private unsaved = 0;
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
    for (const fp of fingerprints) {
      if (this.seen.has(fp)) continue;
      this.seen.add(fp);
      this.unsaved += 1;
    }
    if (this.unsaved >= 256) this.save();
  }

  flush(): void {
    if (this.unsaved) this.save();
  }

  get path(): string {
    return this.file;
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
    const body: LedgerFile = { fingerprints: [...this.seen] };
    writeFileSync(this.file, `${JSON.stringify(body)}\n`, "utf8");
    this.unsaved = 0;
  }
}
