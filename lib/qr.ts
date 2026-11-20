export const TABLESERVE_PUBLIC_ORIGIN = "https://tableserve-mu.vercel.app";

export function tableQrUrl(shopId: string, token: string) {
  return `${TABLESERVE_PUBLIC_ORIGIN}/t/${encodeURIComponent(shopId)}/${encodeURIComponent(token)}`;
}

export function tablePathFromQr(value: string, origin: string): string | null {
  try {
    const base = new URL(origin);
    const url = new URL(value, base);
    if ((url.origin !== base.origin && url.origin !== TABLESERVE_PUBLIC_ORIGIN) || url.search || url.hash) return null;
    const match = url.pathname.match(/^\/t\/(?:([A-Za-z0-9_-]{1,128})\/)?([A-Za-z0-9_-]{32,64})\/?$/);
    if (!match) return null;
    return match[1] ? `/t/${match[1]}/${match[2]}` : `/t/${match[2]}`;
  } catch {
    return null;
  }
}
