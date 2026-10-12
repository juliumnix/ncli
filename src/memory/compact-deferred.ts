export class CompactDeferred extends Error {
  constructor() {
    super("compact deferred");
    this.name = "CompactDeferred";
  }
}
