import { describe, expect, it } from "vitest";

import { containsControlCharacter, isValidReleaseId, normalizeReleaseId } from "./releaseId";

describe("containsControlCharacter", () => {
  it.each([
    ["NUL", "\0"],
    ["a newline", "\n"],
    ["a carriage return", "\r"],
    ["a tab", "\t"],
    ["a vertical tab", "\v"],
    ["a form feed", "\f"],
    ["an escape", "\u001B"],
    ["DEL", "\u007F"],
  ])("detects %s", (_label, character) => {
    expect(containsControlCharacter(`/home/deploy/x${character}y`)).toBe(true);
  });

  it.each(["/home/deploy/.synara", "0.6.3-rc.1", "项目", "", " "])(
    "accepts %j as control-free",
    (value) => {
      expect(containsControlCharacter(value)).toBe(false);
    },
  );
});

describe("release id validation", () => {
  it.each(["0.6.3", "0.6.3-rc.1", "v1", "abc_123", "A-B.C"])("accepts %s", (value) => {
    expect(isValidReleaseId(value)).toBe(true);
    expect(normalizeReleaseId(` ${value} `)).toBe(value);
  });

  // Each of these is a distinct escape a mutation of the pattern would reopen.
  it.each([
    ["path traversal", ".."],
    ["nested traversal", "../../etc"],
    ["a bare dot", "."],
    ["a leading dot", ".hidden"],
    ["a path separator", "a/b"],
    ["a backslash", "a\\b"],
    ["a newline", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a NUL byte", "a\0b"],
    ["a systemd specifier", "a%nb"],
    ["a shell metacharacter", "a;rm -rf /"],
    ["command substitution", "$(id)"],
    ["a space", "a b"],
    ["a quote", "a'b"],
    ["an empty string", ""],
    ["an over-long value", "a".repeat(65)],
  ])("refuses %s", (_label, value) => {
    expect(isValidReleaseId(value)).toBe(false);
    expect(() => normalizeReleaseId(value)).toThrow(/Invalid remote release id/);
  });

  it("refuses an embedded traversal that passes the character class", () => {
    expect(isValidReleaseId("a..b")).toBe(false);
  });
});
