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

export type CompactHoldReason = "budget" | "limit" | "cli-error";

export class CompactHold extends CompactDeferred {
  constructor(
    readonly reason: CompactHoldReason,
    readonly detail = "",
  ) {
    super(detail || `compact hold ${reason}`);
    this.name = "CompactHold";
  }
}

export class ProviderLimitError extends CompactHold {
  constructor(detail = "provider limit") {
    super("limit", detail);
    this.name = "ProviderLimitError";
  }
}

export class CompactCliError extends CompactHold {
  constructor(detail: string) {
    super("cli-error", detail);
    this.name = "CompactCliError";
  }
}

export function isProviderLimitMessage(msg: string): boolean {
  return /rate.?limit|quota|usage limit|too many requests|insufficient.?quota|out of credits|billing|limit exceeded/i.test(msg);
}

export function isCliMissingMessage(msg: string): boolean {
  return /ENOENT|not found|not installed|cannot find|no such file/i.test(msg);
}

export function isCliAuthMessage(msg: string): boolean {
  return /not logged in|login required|unauthorized|401|please run.*login|auth(?:entication)? (?:failed|required)/i.test(msg);
}
