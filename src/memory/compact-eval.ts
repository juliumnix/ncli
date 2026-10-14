export const COMPOSER_EVAL_MODEL = "composer-2.5";

export type CompactEvalScore = {
  viewPresence: number;
  reachability: number;
};

export const COMPOSER_EVAL: CompactEvalScore = {
  viewPresence: 0.5,
  reachability: 1,
};

export const COMPACT_EVAL: Record<string, CompactEvalScore> = {
  [COMPOSER_EVAL_MODEL]: COMPOSER_EVAL,
};

export function evalDropVsComposer(
  model: string,
  scores: Record<string, CompactEvalScore> = COMPACT_EVAL,
): string | undefined {
  const id = model.trim();
  if (!id || id === COMPOSER_EVAL_MODEL) return undefined;
  const row = scores[id];
  if (!row) return undefined;
  const base = scores[COMPOSER_EVAL_MODEL] ?? COMPOSER_EVAL;
  if (row.reachability >= base.reachability && row.viewPresence >= base.viewPresence) return undefined;
  return `memory:eval deste modelo cai em relação ao Composer.`;
}
