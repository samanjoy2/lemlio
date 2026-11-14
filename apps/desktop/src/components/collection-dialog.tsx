import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { collectionIcon } from "@/lib/collection-icons";
import {
  MAX_COLLECTION_NAME,
  useCollectionsStore,
} from "@/stores/collections-store";

export type CollectionDialogState =
  | { mode: "create"; projectPath?: string }
  | { mode: "rename"; id: string }
  | { mode: "delete"; id: string }
  | null;

/** Opens the "new collection" dialog, optionally putting a project straight into it. */
export const requestNewCollection = (projectPath?: string) =>
  window.dispatchEvent(
    new CustomEvent("lemlio-new-collection", { detail: { projectPath } }),
  );

export function CollectionDialog({
  state,
  onClose,
  onCreated,
  onDeleted,
}: {
  state: CollectionDialogState;
  onClose: () => void;
  onCreated?: (id: string) => void;
  onDeleted?: (id: string) => void;
}) {
  const collections = useCollectionsStore((s) => s.collections);
  const create = useCollectionsStore((s) => s.create);
  const rename = useCollectionsStore((s) => s.rename);
  const remove = useCollectionsStore((s) => s.remove);
  const add = useCollectionsStore((s) => s.add);
  const target =
    state && state.mode !== "create"
      ? collections.find((c) => c.id === state.id)
      : undefined;
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    setName(state?.mode === "rename" ? (target?.name ?? "") : "");
  }, [state?.mode, target?.id]);
  if (!state) return null;
  const Icon = collectionIcon(name);

  const submit = () => {
    if (state.mode === "create") {
      const result = create(name);
      if ("error" in result) return setError(result.error);
      if (state.projectPath) add(result.id, state.projectPath);
      onCreated?.(result.id);
      onClose();
    } else if (state.mode === "rename") {
      const result = rename(state.id, name);
      if ("error" in result) return setError(result.error);
      onClose();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {state.mode === "delete" ? (
          <>
            <DialogHeader>
              <DialogTitle>Delete this collection?</DialogTitle>
              <DialogDescription>
                {target ? `“${target.name}” ` : "The collection "}
                will be removed. Your projects are not deleted or changed.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  remove(state.id);
                  onDeleted?.(state.id);
                  onClose();
                }}
              >
                Delete collection
              </Button>
            </div>
          </>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {state.mode === "create"
                  ? "New collection"
                  : "Rename collection"}
              </DialogTitle>
              <DialogDescription>
                Name it anything. Lemlio picks an icon that fits the name, such
                as a graduation cap for “Thesis” or a briefcase for “Job
                applications”.
              </DialogDescription>
            </DialogHeader>
            <label className="flex items-center gap-3 rounded-[10px] border border-input bg-background px-3 focus-within:border-primary/60 focus-within:ring-[3px] focus-within:ring-primary/20">
              <Icon className="size-4 shrink-0 text-primary" aria-hidden />
              <input
                autoFocus
                aria-label="Collection name"
                maxLength={MAX_COLLECTION_NAME + 10}
                className="h-10 w-full bg-transparent text-sm outline-none"
                placeholder="For example: Thesis, Grants, Job applications"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError("");
                }}
              />
            </label>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                {state.mode === "create" ? "Create collection" : "Save"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
