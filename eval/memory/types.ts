export type NeedleType = "simple" | "superseded" | "space" | "echo" | "sibling";

export interface Needle {
  id: string;
  type: NeedleType;
  tokens: string[];
  messageIndex: number;
  space?: string;
  supersededBy?: number;
  inEcho?: boolean;
  question: string;
  answer: string;
}

export interface TranscriptLine {
  kind: "user" | "talk" | "echo" | "note";
  text: string;
  space?: string;
}

export interface Transcript {
  seed: number;
  n: number;
  lines: TranscriptLine[];
  needles: Needle[];
}

export interface NeedleReport {
  id: string;
  type: NeedleType;
  inLog: boolean;
  inView: boolean;
  hops: number | null;
  reachedLeaf: boolean;
  levelHits: Record<string, boolean>;
}

export interface EvalReport {
  at: string;
  seed: number;
  n: number;
  compressor: string;
  viewBytes: number;
  nodeBytes: number;
  needles: NeedleReport[];
  recallAtLevel: Record<string, number>;
  viewPresence: number;
  reachability: number;
  invented: number;
  compactCalls: number;
  settled: boolean;
}
