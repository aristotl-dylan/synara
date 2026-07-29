// Serving policy for the built web bundle (GET * static route): precompressed
// sidecar negotiation and cache headers. Sidecars (.br/.gz) are emitted at
// build time by apps/web's Vite precompress plugin — the server never
// compresses on the request path.

export const STATIC_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
// Non-hashed files (index.html, manifests) must revalidate so deploys take
// effect on the next load.
export const STATIC_REVALIDATE_CACHE_CONTROL = "no-cache";

// Vite writes content-hashed filenames under assets/; everything else
// (index.html, public/ files) keeps a stable name and must revalidate.
export function staticCacheControl(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.startsWith("assets/")
    ? STATIC_IMMUTABLE_CACHE_CONTROL
    : STATIC_REVALIDATE_CACHE_CONTROL;
}

export interface StaticEncodingCandidate {
  readonly encoding: "br" | "gzip";
  readonly sidecarExtension: ".br" | ".gz";
}

// Server preference order: brotli beats gzip when both are accepted.
const STATIC_ENCODING_CANDIDATES: readonly StaticEncodingCandidate[] = [
  { encoding: "br", sidecarExtension: ".br" },
  { encoding: "gzip", sidecarExtension: ".gz" },
];

// Returns the sidecar encodings the client accepts, in server preference
// order. q-values only matter as q=0 exclusions; ranking between the accepted
// encodings is the server's choice.
export function negotiateStaticEncodings(
  acceptEncoding: string | undefined,
): readonly StaticEncodingCandidate[] {
  if (!acceptEncoding) return [];
  const accepted = new Set<string>();
  for (const rawEntry of acceptEncoding.split(",")) {
    const [rawName, ...rawParams] = rawEntry.trim().split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    const qParam = rawParams
      .map((param) => param.trim().toLowerCase())
      .find((param) => param.startsWith("q="));
    if (qParam && Number.parseFloat(qParam.slice(2)) === 0) continue;
    accepted.add(name);
  }
  return STATIC_ENCODING_CANDIDATES.filter(
    (candidate) => accepted.has(candidate.encoding) || accepted.has("*"),
  );
}
