// Unit coverage for static-serving policy: encoding negotiation edge cases,
// cache-control tiers, sidecar path detection, and ETag shape. The HTTP-level
// behavior is covered in http.test.ts; this table pins the pure logic.

import { describe, expect, it } from "vitest";

import {
  STATIC_ICON_CACHE_CONTROL,
  STATIC_IMMUTABLE_CACHE_CONTROL,
  STATIC_REVALIDATE_CACHE_CONTROL,
  ifNoneMatchSatisfies,
  isSidecarRequestPath,
  negotiateStaticEncodings,
  staticCacheControl,
  staticEtag,
} from "./staticAssets";

const encodings = (header: string | undefined) =>
  negotiateStaticEncodings(header).map((candidate) => candidate.encoding);

describe("negotiateStaticEncodings", () => {
  it("treats a missing or empty header as identity-only (RFC 9110 §12.5.3)", () => {
    expect(encodings(undefined)).toEqual([]);
    expect(encodings("")).toEqual([]);
  });

  it("prefers brotli over gzip when both are accepted", () => {
    expect(encodings("gzip, br")).toEqual(["br", "gzip"]);
    expect(encodings("br, gzip")).toEqual(["br", "gzip"]);
  });

  it("lets a specific q=0 exclusion outrank the wildcard", () => {
    expect(encodings("br;q=0, *")).toEqual(["gzip"]);
    expect(encodings("gzip;q=0, *")).toEqual(["br"]);
    expect(encodings("br;q=0, gzip;q=0, *")).toEqual([]);
  });

  it("honors q=0 exclusions without a wildcard", () => {
    expect(encodings("gzip, br;q=0")).toEqual(["gzip"]);
    expect(encodings("gzip;q=0, br;q=0")).toEqual([]);
  });

  it("accepts everything via wildcard and nothing via excluded wildcard", () => {
    expect(encodings("*")).toEqual(["br", "gzip"]);
    expect(encodings("*;q=0")).toEqual([]);
  });

  it("ignores unknown encodings and malformed q parameters", () => {
    expect(encodings("x-gzip, deflate")).toEqual([]);
    expect(encodings("gzip;q=")).toEqual(["gzip"]);
    expect(encodings("identity")).toEqual([]);
  });

  it("parses whitespace and case variations", () => {
    expect(encodings(" GZip ;q=1.0 , BR ")).toEqual(["br", "gzip"]);
  });
});

describe("staticCacheControl", () => {
  it("tiers hashed assets, icon sets, and revalidating files", () => {
    expect(staticCacheControl("assets/app-abc123.js")).toBe(STATIC_IMMUTABLE_CACHE_CONTROL);
    expect(staticCacheControl("central-icons-reversed/file.svg")).toBe(STATIC_ICON_CACHE_CONTROL);
    expect(staticCacheControl("central-icons-fill/file.svg")).toBe(STATIC_ICON_CACHE_CONTROL);
    expect(staticCacheControl("index.html")).toBe(STATIC_REVALIDATE_CACHE_CONTROL);
    expect(staticCacheControl("manifest.webmanifest")).toBe(STATIC_REVALIDATE_CACHE_CONTROL);
  });

  it("normalizes Windows separators before matching", () => {
    expect(staticCacheControl("assets\\app-abc123.js")).toBe(STATIC_IMMUTABLE_CACHE_CONTROL);
  });
});

describe("isSidecarRequestPath", () => {
  it("flags sidecar extensions and nothing else", () => {
    expect(isSidecarRequestPath("assets/app.js.br")).toBe(true);
    expect(isSidecarRequestPath("assets/app.js.gz")).toBe(true);
    expect(isSidecarRequestPath("assets/app.js")).toBe(false);
    expect(isSidecarRequestPath("archive.tar.gz.txt")).toBe(false);
  });
});

describe("ifNoneMatchSatisfies", () => {
  const etag = 'W/"3e8-18b2a4c5d00"';

  it("matches a single tag, a list member, and the wildcard", () => {
    expect(ifNoneMatchSatisfies(etag, etag)).toBe(true);
    expect(ifNoneMatchSatisfies(`W/"other", ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchSatisfies("*", etag)).toBe(true);
  });

  it("rejects absent headers and non-matching lists", () => {
    expect(ifNoneMatchSatisfies(undefined, etag)).toBe(false);
    expect(ifNoneMatchSatisfies("", etag)).toBe(false);
    expect(ifNoneMatchSatisfies('W/"other-a", W/"other-b"', etag)).toBe(false);
  });
});

describe("staticEtag", () => {
  it("differs per encoding so Vary-keyed caches never collide validators", () => {
    const identity = staticEtag(1000, 1_700_000_000_000);
    const brotli = staticEtag(1000, 1_700_000_000_000, "br");
    const gzipTag = staticEtag(1000, 1_700_000_000_000, "gzip");
    expect(new Set([identity, brotli, gzipTag]).size).toBe(3);
    expect(identity.startsWith('W/"')).toBe(true);
  });

  it("changes when size or mtime changes", () => {
    const base = staticEtag(1000, 1_700_000_000_000);
    expect(staticEtag(1001, 1_700_000_000_000)).not.toBe(base);
    expect(staticEtag(1000, 1_700_000_000_001)).not.toBe(base);
  });
});
