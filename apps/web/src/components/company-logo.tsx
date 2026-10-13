import { useState } from "react";

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(
      url.startsWith("http") ? url : `https://${url}`
    ).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Company mark — the record's logoUrl, then the domain's public logo,
 * then favicon, then a letter avatar. The Attio look for free. */
export function CompanyLogo({
  name,
  logoUrl,
  domain,
  url,
  size = 20,
}: {
  name: string;
  logoUrl?: string | null;
  domain?: string | null;
  url?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(0);
  const host = hostOf(domain ?? url);
  const candidates = [
    logoUrl ?? null,
    host ? `https://logo.clearbit.com/${host}` : null,
    host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null,
  ].filter((c): c is string => c !== null);
  const src = candidates[failed];

  if (!src) {
    return (
      <span
        className="bg-kumo-brand text-kumo-contrast flex shrink-0 items-center justify-center rounded font-semibold"
        style={{ width: size, height: size, fontSize: size * 0.55 }}
        aria-hidden
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed((f) => f + 1)}
      className="shrink-0 rounded object-contain"
      style={{ width: size, height: size }}
    />
  );
}
