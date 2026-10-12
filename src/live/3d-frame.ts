export function ncli3dSrc(source: string): string {
  const body = String(source ?? "").trim() || "ncli3d.desk()";
  return `/ncli3d.html#${encodeURIComponent(body)}`;
}
