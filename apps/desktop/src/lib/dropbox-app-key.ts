export type AppKeyCheck =
  | { ok: true; key: string }
  | { ok: false; reason: string };

/**
 * A Dropbox app key is a short public identifier of letters and digits. Anything
 * with spaces, punctuation or a long string is a secret or token pasted by
 * mistake. Messages never repeat what was typed.
 */
export function checkAppKey(raw: string): AppKeyCheck {
  const key = raw.trim();
  if (!key) return { ok: false, reason: "Paste your Dropbox app key." };
  if (/\s/.test(key))
    return {
      ok: false,
      reason: "An app key has no spaces. Copy only the key.",
    };
  if (key.length > 24 || /[^A-Za-z0-9]/.test(key))
    return {
      ok: false,
      reason:
        "That looks like a secret or token, not an app key. The App key is a short string of letters and digits. Never paste the App secret.",
    };
  if (key.length < 10)
    return { ok: false, reason: "That is too short to be an app key." };
  return { ok: true, key };
}
