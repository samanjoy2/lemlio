import { expect, it } from "vitest";
import { checkAppKey } from "@/lib/dropbox-app-key";

it("accepts a short alphanumeric app key and trims it", () => {
  expect(checkAppKey("  abc123def456ghi \n")).toEqual({
    ok: true,
    key: "abc123def456ghi",
  });
});

it("rejects empty, spaced, long, punctuated and token-like values without echoing them", () => {
  const secretLike = "sl.BxQ7-secret_token.value";
  for (const bad of [
    "",
    "   ",
    "has a space inside",
    "ab1234",
    "a".repeat(25),
    "key-with-dash-123",
    secretLike,
  ]) {
    const result = checkAppKey(bad);
    expect(result.ok).toBe(false);
    if (!result.ok && bad.trim())
      expect(result.reason).not.toContain(bad.trim());
  }
  const rejected = checkAppKey(secretLike);
  expect(!rejected.ok && rejected.reason).toContain(
    "Never paste the App secret",
  );
});
