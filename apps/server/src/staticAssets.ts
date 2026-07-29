// Serving policy for the built web bundle (GET * static route): precompressed
// sidecar negotiation and cache headers. Sidecars (.br/.gz) are emitted at
// build time by apps/web's Vite precompress plugin — the server never
// compresses on the request path.

export const STATIC_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
// Non-hashed files (index.html, manifests) must revalidate so deploys take
// effect on the next load.
export const STATIC_REVALIDATE_CACHE_CONTROL = "no-cache";
// Icon sets have stable names but change only on dependency bumps, and the UI
// requests thousands of them per session; a bounded max-age keeps them out of
// the per-load revalidation path without an eternal-cache deploy hazard.
export const STATIC_ICON_CACHE_CONTROL = "public, max-age=86400";

const ICON_DIRECTORY_PREFIXES = ["central-icons-reversed/", "central-icons-fill/"];

// Vite writes content-hashed filenames under assets/; everything else
// (index.html, public/ files) keeps a stable name and must revalidate.
export function staticCacheControl(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("assets/")) return STATIC_IMMUTABLE_CACHE_CONTROL;
  if (ICON_DIRECTORY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return STATIC_ICON_CACHE_CONTROL;
  }
  return STATIC_REVALIDATE_CACHE_CONTROL;
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
// encodings is the server's choice. A missing header means only identity is
// reliably acceptable (RFC 9110 §12.5.3), and a specific `name;q=0` exclusion
// outranks a `*` wildcard.
export function negotiateStaticEncodings(
  acceptEncoding: string | undefined,
): readonly StaticEncodingCandidate[] {
  if (!acceptEncoding) return [];
  const accepted = new Set<string>();
  const excluded = new Set<string>();
  for (const rawEntry of acceptEncoding.split(",")) {
    const [rawName, ...rawParams] = rawEntry.trim().split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    const qParam = rawParams
      .map((param) => param.trim().toLowerCase())
      .find((param) => param.startsWith("q="));
    if (qParam && Number.parseFloat(qParam.slice(2)) === 0) {
      excluded.add(name);
      continue;
    }
    accepted.add(name);
  }
  return STATIC_ENCODING_CANDIDATES.filter(
    (candidate) =>
      !excluded.has(candidate.encoding) && (accepted.has(candidate.encoding) || accepted.has("*")),
  );
}

// Sidecars are a negotiation detail, never addressable resources: a direct
// request for one would serve compressed bytes with identity encoding and a
// misleading MIME type.
export function isSidecarRequestPath(relativePath: string): boolean {
  return relativePath.endsWith(".br") || relativePath.endsWith(".gz");
}

// RFC 9110 §13.1.2: If-None-Match is a comma-separated list of entity tags or
// the wildcard. Exact match against the tags we emit (always W/-prefixed).
export function ifNoneMatchSatisfies(headerValue: string | undefined, etag: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed === "*") return true;
  return trimmed.split(",").some((candidate) => candidate.trim() === etag);
}

// Weak validator derived from the served file's identity (size + mtime). Must
// be computed from the sidecar when a sidecar is served: a shared cache keyed
// on Vary: Accept-Encoding still requires validators to differ per encoding.
export function staticEtag(size: number, mtimeMs: number, encoding?: string): string {
  return `W/"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}${encoding ? `-${encoding}` : ""}"`;
}
