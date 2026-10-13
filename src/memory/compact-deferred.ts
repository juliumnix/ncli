export class CompactDeferred extends Error {
  constructor(message = "compact deferred") {
    super(message);
    this.name = "CompactDeferred";
  }
}

export class CompactBudgetPause extends CompactDeferred {
  constructor() {
    super("compact budget pause");
    this.name = "CompactBudgetPause";
  }
}
