// This local fork has no release feed. Never replace it with an upstream build.
export type UpdateStatus =
  | { state: "idle" | "checking" | "up-to-date" | "installing" | "ready" }
  | { state: "available"; version: string; notes?: string }
  | { state: "downloading"; percent: number }
  | { state: "error"; message: string };
export function useUpdater() {
  return {
    status: { state: "idle" } as UpdateStatus,
    checkForUpdate: async () => {},
    installUpdate: async () => {},
  };
}
