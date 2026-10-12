import { liveOrigin } from "./origin";

export function ncli3dSrc(source: string): string {
  const body = String(source ?? "").trim() || "ncli3d.desk()";
  const origin = liveOrigin()?.origin;
  return `${origin ? `${origin}/3d` : "/ncli3d.html"}#${encodeURIComponent(body)}`;
}
