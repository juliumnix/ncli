export function sessionKey(session: string | undefined): string {
  const key = session?.trim();
  return key ? key : "main";
}

interface Opening<T> {
  fingerprint: string;
  promise: Promise<T>;
}

export class SessionHot<T extends { fingerprint: string; proc: { exitCode: number | null } }> {
  private readonly slots = new Map<string, T>();
  private readonly opening = new Map<string, Opening<T>>();

  async acquire(key: string, fingerprint: string, spawn: () => Promise<T>): Promise<{ hot: T; reused: boolean }> {
    for (;;) {
      const live = this.match(key, fingerprint);
      if (live) return { hot: live, reused: true };
      const pending = this.opening.get(key);
      if (pending) {
        const hot = await pending.promise.catch(() => undefined);
        if (hot && pending.fingerprint === fingerprint && this.match(key, fingerprint) === hot) {
          return { hot, reused: true };
        }
        if (this.opening.get(key) === pending) this.opening.delete(key);
        continue;
      }
      const rec = this.begin(key, fingerprint);
      try {
        const hot = await spawn();
        if (hot.fingerprint !== fingerprint) {
          throw new Error("refusing hot process with a different fingerprint");
        }
        this.slots.set(key, hot);
        rec.resolve(hot);
        return { hot, reused: false };
      } catch (err) {
        rec.reject(err);
        throw err;
      } finally {
        if (this.opening.get(key)?.promise === rec.promise) this.opening.delete(key);
      }
    }
  }

  take(key: string): T | undefined {
    const hot = this.slots.get(key);
    this.slots.delete(key);
    return hot;
  }

  takeAll(): T[] {
    const all = [...this.slots.values()];
    this.slots.clear();
    return all;
  }

  dropIf(key: string, hot: T): void {
    if (this.slots.get(key) === hot) this.slots.delete(key);
  }

  private match(key: string, fingerprint: string): T | undefined {
    const hot = this.slots.get(key);
    if (!hot) return undefined;
    if (hot.fingerprint !== fingerprint || hot.proc.exitCode !== null) return undefined;
    return hot;
  }

  private begin(key: string, fingerprint: string): Opening<T> & { resolve: (hot: T) => void; reject: (err: unknown) => void } {
    let resolve: (hot: T) => void = () => {};
    let reject: (err: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void promise.catch(() => {});
    const rec = { fingerprint, promise, resolve, reject };
    this.opening.set(key, rec);
    return rec;
  }
}
