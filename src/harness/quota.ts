export function isQuotaError(text: string): boolean {
  return /rate[\s_-]?limit|\bquota\b|too many requests|\b429\b|usage limit|out of extra usage|credit(?:s)? (?:exhausted|exceeded)|overloaded/i.test(
    text,
  );
}
