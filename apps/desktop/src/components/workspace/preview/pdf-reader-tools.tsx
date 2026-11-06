import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { PdfSearchHit } from "@/lib/mupdf/types";

export function PdfFindBar({
  docId,
  onResults,
  onJump,
  onClose,
}: {
  docId: number;
  onResults: (hits: PdfSearchHit[], active: number) => void;
  onJump: (hit: PdfSearchHit) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PdfSearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(false);
  const callbacks = useRef({ onResults, onJump });
  callbacks.current = { onResults, onJump };
  useEffect(() => {
    let cancelled = false;
    setSearching(Boolean(query.trim()));
    setError(false);
    setHits([]);
    callbacks.current.onResults([], 0);
    const timer = setTimeout(async () => {
      try {
        const result =
          query.trim() && docId > 0
            ? await getMupdfClient().searchDocument(docId, query.trim())
            : [];
        if (cancelled) return;
        setHits(result);
        setActive(0);
        callbacks.current.onResults(result, 0);
        if (result[0]) callbacks.current.onJump(result[0]);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [docId, query]);
  const move = (delta: number) => {
    if (!hits.length) return;
    const next = (active + delta + hits.length) % hits.length;
    setActive(next);
    onResults(hits, next);
    onJump(hits[next]);
  };
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-background px-2 py-1.5"
      role="search"
      aria-label="Find in PDF"
    >
      <SearchIcon className="mx-1 size-3.5 text-muted-foreground" />
      <Input
        autoFocus
        aria-label="Find in PDF"
        placeholder="Find in PDF"
        value={query}
        className="h-7 min-w-24 flex-1 text-xs"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            move(e.shiftKey ? -1 : 1);
          }
          if (e.key === "Escape") onClose();
        }}
      />
      <span
        className="px-1 text-muted-foreground text-xs tabular-nums"
        role="status"
      >
        {searching
          ? "Searching…"
          : error
            ? "Search unavailable"
            : query.trim()
              ? hits.length
                ? `${active + 1} / ${hits.length}${hits.length === 2000 ? "+" : ""}`
                : "No matches"
              : ""}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!hits.length}
        onClick={() => move(-1)}
        aria-label="Previous match"
      >
        <ChevronUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!hits.length}
        onClick={() => move(1)}
        aria-label="Next match"
      >
        <ChevronDownIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        aria-label="Close PDF search"
      >
        <XIcon />
      </Button>
    </div>
  );
}

function PageThumbnail({
  docId,
  page,
  ratio,
  active,
  onClick,
}: {
  docId: number;
  page: number;
  ratio: number;
  active: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState("");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { root: el.closest("aside"), rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || docId <= 0) return;
    let cancelled = false;
    let objectUrl = "";
    setUrl("");
    void getMupdfClient()
      .renderThumbnail(docId, page - 1, 72)
      .then((bytes) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: "image/png" }),
        );
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [docId, page, visible]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={`Go to page ${page}`}
      aria-current={active ? "page" : undefined}
      className={`flex w-full flex-col items-center gap-1 rounded-md p-2 text-xs tabular-nums transition-colors hover:bg-muted focus-visible:outline-ring ${active ? "bg-muted text-foreground" : "text-muted-foreground"}`}
    >
      <div
        className={`w-[72px] overflow-hidden bg-white shadow-sm ${active ? "ring-2 ring-primary" : "ring-1 ring-border"}`}
        style={{ aspectRatio: ratio }}
      >
        {url && <img src={url} alt="" className="h-full w-full" />}
      </div>
      {page}
    </button>
  );
}

export function PdfPageRail({
  docId,
  sizes,
  current,
  onPage,
}: {
  docId: number;
  sizes: { width: number; height: number }[];
  current: number;
  onPage: (page: number) => void;
}) {
  return (
    <aside
      aria-label="PDF page thumbnails"
      className="w-[104px] shrink-0 overflow-y-auto border-r bg-background p-1"
    >
      {sizes.map((s, i) => (
        <PageThumbnail
          key={i}
          docId={docId}
          page={i + 1}
          ratio={s.width / s.height}
          active={current === i + 1}
          onClick={() => onPage(i + 1)}
        />
      ))}
    </aside>
  );
}
