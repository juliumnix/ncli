export type ChatPaint = "full" | "live" | "tick" | "chrome";

export function chatPaintFor(kind: string, turnRunning: boolean): ChatPaint {
  switch (kind) {
    case "delta":
    case "step":
      return turnRunning ? "live" : "full";
    case "turn":
      return turnRunning ? "live" : "full";
    case "main":
    case "compact":
      return "chrome";
    case "hello":
    case "message":
    case "done":
      return "full";
    default:
      return "full";
  }
}
