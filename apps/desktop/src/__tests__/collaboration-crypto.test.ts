import { webcrypto } from "node:crypto";
import { invoke } from "@tauri-apps/api/core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  authentication,
  decryptMessage,
  encryptMessage,
  makeInvitation,
  parseInvitation,
} from "@/lib/collaboration/crypto";
beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());
const id = "48b69ae1-ea1a-4718-8fc5-385757d4b8b5",
  key = "12".repeat(32);
it("encrypts content and rejects altered data, another key and another project", async () => {
  const body = await encryptMessage(id, key, {
    type: "state",
    text: "private offline contribution",
  });
  expect(body).not.toContain("private offline contribution");
  expect(await decryptMessage(id, key, body)).toEqual({
    type: "state",
    text: "private offline contribution",
  });
  await expect(decryptMessage(id, "34".repeat(32), body)).rejects.toThrow();
  await expect(decryptMessage("another-project", key, body)).rejects.toThrow();
  const value = JSON.parse(body);
  value.data = `${value.data[0] === "A" ? "B" : "A"}${value.data.slice(1)}`;
  await expect(
    decryptMessage(id, key, JSON.stringify(value)),
  ).rejects.toThrow();
  expect(await authentication(key)).toHaveLength(64);
});
it("round-trips invitations without putting keys in an HTTP request URL", () => {
  const invite = makeInvitation({
    id,
    key,
    endpoint: "ws://100.64.0.1:46317",
    title: "Shared manuscript",
  });
  expect(parseInvitation(invite)).toEqual({
    id,
    key,
    endpoint: "ws://100.64.0.1:46317",
    title: "Shared manuscript",
  });
  expect(new URL(invite).search).toBe("");
  expect(() => parseInvitation("https://example.com")).toThrow();
  expect(() =>
    parseInvitation(makeInvitation({ id, key, endpoint: "file:///private" })),
  ).toThrow();
});
it("uses the native encrypted bridge when a desktop WebView has no SubtleCrypto", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  });
  vi.mocked(invoke).mockImplementation(async (command, args: any = {}) => {
    if (command === "collaboration_authenticate") return "native-auth-hash";
    if (command === "collaboration_encrypt")
      return JSON.stringify({ schema: 1, iv: "nonce", data: args.plaintext });
    if (command === "collaboration_decrypt")
      return JSON.stringify({ message: "native decoded" });
  });
  try {
    expect(await authentication(key)).toBe("native-auth-hash");
    expect(
      JSON.parse(await encryptMessage(id, key, { message: "native encoded" }))
        .schema,
    ).toBe(1);
    expect(await decryptMessage(id, key, "encrypted native envelope")).toEqual({
      message: "native decoded",
    });
    expect(invoke).toHaveBeenCalledWith("collaboration_decrypt", {
      id,
      key,
      body: "encrypted native envelope",
    });
  } finally {
    vi.stubGlobal("crypto", webcrypto);
  }
});
