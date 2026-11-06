import { fromBase64, toBase64 } from "./document";
import { invoke } from "@tauri-apps/api/core";

export interface Invitation {
  id: string;
  key: string;
  endpoint?: string;
  title?: string;
}
export function parseInvitation(value: string): Invitation {
  const url = new URL(value.trim());
  if (url.protocol !== "lemlio-collab:" || url.hostname !== "join")
    throw Error("Paste a Lemlio collaboration invitation");
  const result = JSON.parse(
    new TextDecoder().decode(fromBase64(url.hash.slice(1))),
  ) as Invitation;
  if (
    !/^[0-9a-f-]{36}$/i.test(result.id) ||
    !/^[0-9a-f]{64}$/i.test(result.key)
  )
    throw Error("Invalid invitation");
  if (result.endpoint) validateEndpoint(result.endpoint);
  return result;
}
export function validateEndpoint(value: string) {
  const url = new URL(value);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error("Use a ws:// or wss:// host and port");
  return url.toString();
}
export function makeInvitation(value: Invitation) {
  return `lemlio-collab://join/#${toBase64(new TextEncoder().encode(JSON.stringify(value)))}`;
}
async function importKey(secret: string) {
  if (!/^[0-9a-f]{64}$/i.test(secret))
    throw Error("Reconnect using the original project invitation");
  const bytes = Uint8Array.from(secret.match(/../g)!, (h) =>
    Number.parseInt(h, 16),
  );
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function authentication(secret: string) {
  if (!globalThis.crypto?.subtle)
    return invoke<string>("collaboration_authenticate", { key: secret });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`Lemlio collaboration auth:${secret}`),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function encryptMessage(
  id: string,
  secret: string,
  value: unknown,
) {
  if (!globalThis.crypto?.subtle)
    return invoke<string>("collaboration_encrypt", {
      id,
      key: secret,
      plaintext: JSON.stringify(value),
    });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
    await importKey(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    schema: 1,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(ciphertext)),
  });
}
export async function decryptMessage(id: string, secret: string, body: string) {
  if (!globalThis.crypto?.subtle)
    return JSON.parse(
      await invoke<string>("collaboration_decrypt", { id, key: secret, body }),
    );
  const value = JSON.parse(body);
  if (
    value.schema !== 1 ||
    typeof value.iv !== "string" ||
    typeof value.data !== "string"
  )
    throw Error("Unsupported collaboration message");
  const iv = fromBase64(value.iv);
  if (iv.length !== 12) throw Error("Invalid collaboration message");
  const bytes = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: new TextEncoder().encode(id),
    },
    await importKey(secret),
    fromBase64(value.data) as Uint8Array<ArrayBuffer>,
  );
  return JSON.parse(new TextDecoder().decode(bytes));
}
