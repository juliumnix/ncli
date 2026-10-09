const BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d+\.\s)/;
const SENTENCE_END = /[.!?…]$/;
const NEW_SENTENCE = /^[A-ZÁÉÍÓÚÂÊÔÃÕÀÜ]/;

export function joinText(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  if (/\s$/.test(prev) || /^\s/.test(next)) return prev + next;
  if (BLOCK_START.test(next)) return `${prev}\n\n${next}`;
  if (SENTENCE_END.test(prev) && NEW_SENTENCE.test(next)) return `${prev} ${next}`;
  return prev + next;
}
