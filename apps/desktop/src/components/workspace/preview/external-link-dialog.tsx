import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const EVENT = "lemlio-open-link";
const ALLOWED = new Set(["http:", "https:", "mailto:"]);

/** The link as a URL if Lemlio may open it in a browser or mail app, else null. */
export function openableLink(href: string): URL | null {
  try {
    const url = new URL(href);
    return ALLOWED.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** Ask the user whether to open a link from a document in their browser. */
export function requestOpenLink(href: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { href } }));
}

/** One dialog for the whole app: links in a PDF never open without a yes. */
export function ExternalLinkDialog() {
  const [href, setHref] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const show = (event: Event) => {
      setCopied(false);
      setHref((event as CustomEvent<{ href: string }>).detail.href);
    };
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);
  if (!href) return null;
  const url = openableLink(href);
  const close = () => setHref(null);
  return (
    <Dialog open onOpenChange={(value) => !value && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {url?.protocol === "mailto:"
              ? "Write an email?"
              : "Open this link?"}
          </DialogTitle>
          <DialogDescription>
            {url
              ? "This link leaves Lemlio. Check the address, then choose whether to open it in your browser."
              : "Lemlio can only open web and email links."}
          </DialogDescription>
        </DialogHeader>
        <p className="max-h-28 overflow-auto break-all rounded-[10px] bg-muted px-3 py-2 font-mono text-[13px]">
          {url ? (
            <>
              <span className="text-muted-foreground">
                {url.protocol}
                {"//"}
              </span>
              <strong className="font-semibold">{url.host}</strong>
              {url.pathname + url.search + url.hash}
            </>
          ) : (
            href
          )}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(href)
                .then(() => setCopied(true))
                .catch(() =>
                  toast.error("Could not copy the link", { description: href }),
                )
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy link"}
          </Button>
          {url && (
            <Button
              autoFocus
              onClick={() => {
                close();
                void open(url.href).catch((error) =>
                  toast.error("Could not open the link", {
                    description: `${String(error)} — you can copy it instead: ${url.href}`,
                  }),
                );
              }}
            >
              <ExternalLinkIcon />
              Open in browser
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
