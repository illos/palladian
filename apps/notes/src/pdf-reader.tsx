import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  openPdf,
  PRIORITY,
  type OpenedPdf,
  type PdfPageSize,
} from "./pdf-engine";
import {
  buildMatches,
  pagePlainText,
  splitItemForRender,
  type PdfMatch,
  type PdfPageText,
} from "./pdf-search";
import "./pdf.css";

/**
 * The PDF reader (plan 08 B4), ported from Deltos `views/pdf/PdfReader.tsx`:
 * pages drawn only near the view (virtualized), a thumbnail rail, page
 * jump, search in the document, and selectable text. It shows bytes it is
 * given; pdf-host.tsx mounts it, inline in a file note or full screen, and
 * takes it off the page when the bytes may no longer show. This module and
 * pdf.js load only then.
 */

export interface PdfReaderProps {
  name: string;
  /** The file's bytes, already read through the app's fenced path. */
  data: Blob;
  /** Download the file instead ("Download to view"). */
  onDownload: () => void;
}

/** How far beyond the view pages are drawn, so a quick scroll finds them ready. */
const WINDOW_PX = 1200;
const PAGE_GAP = 12;
/** Pages are fitted to the width, up to this many CSS pixels. */
const MAX_PAGE_WIDTH = 1400;
/** A page's height for its width until its size is read (A4 portrait). */
const DEFAULT_ASPECT = 1.4142;
const THUMB_WIDTH = 96;
const THUMB_GAP = 10;
const THUMB_WINDOW_PX = 600;
/** Below this width the rail opens over the pages instead of beside them. */
const DOCKED_RAIL_MIN = 640;

const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>) =>
  a.size === b.size && [...a].every((value) => b.has(value));

/** Heights and offsets of every page at one width, read or estimated. */
function useLayout(
  sizes: ReadonlyArray<PdfPageSize | null>,
  width: number,
  gap: number,
) {
  const aspect = useMemo(() => {
    const known = sizes
      .filter((size): size is PdfPageSize => !!size)
      .map((size) => size.height / size.width)
      .sort((a, b) => a - b);
    return known[Math.floor(known.length / 2)] ?? DEFAULT_ASPECT;
  }, [sizes]);
  return useMemo(() => {
    const heights: number[] = [];
    const offsets: number[] = [];
    const scales: number[] = [];
    let y = 0;
    sizes.forEach((size, index) => {
      const height = (size ? size.height / size.width : aspect) * width;
      offsets[index] = y;
      heights[index] = height;
      scales[index] = size && width ? width / size.width : 0;
      y += height + gap;
    });
    return { heights, offsets, scales, total: y };
  }, [sizes, aspect, width, gap]);
}

/** The pages whose box comes within `margin` of the visible part of `element`. */
function windowOf(
  element: HTMLElement,
  layout: { offsets: number[]; heights: number[] },
  margin: number,
) {
  const top = element.scrollTop - margin;
  const bottom = element.scrollTop + element.clientHeight + margin;
  const shown = new Set<number>();
  layout.offsets.forEach((offset, index) => {
    if (offset + (layout.heights[index] ?? 0) >= top && offset <= bottom)
      shown.add(index + 1);
  });
  if (!shown.size) shown.add(1);
  return shown;
}

export function PdfReader({ name, data, onDownload }: PdfReaderProps) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [pdf, setPdf] = useState<OpenedPdf | null>(null);
  const [sizes, setSizes] = useState<Array<PdfPageSize | null>>([]);
  const [texts, setTexts] = useState<Array<PdfPageText | null>>([]);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]));
  const [page, setPage] = useState(1);
  const [railOpen, setRailOpen] = useState(false);
  const [docked, setDocked] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const reading = useRef(new Set<number>());

  // Open the document; it, its worker and its pages go with the reader,
  // even while it is still opening (review round 1, F1).
  useEffect(() => {
    const unmounted = new AbortController();
    const alive = () => !unmounted.signal.aborted;
    let opened: OpenedPdf | null = null;
    openPdf(data, unmounted.signal).then(
      (document) => {
        if (!alive()) return document.destroy();
        opened = document;
        setPdf(document);
        setSizes(new Array<PdfPageSize | null>(document.pages).fill(null));
        setTexts(new Array<PdfPageText | null>(document.pages).fill(null));
        setPhase("ready");
      },
      () => {
        if (alive()) setPhase("error");
      },
    );
    return () => {
      unmounted.abort();
      opened?.destroy();
    };
  }, [data]);

  // Page sizes, a dozen at a time: cheap reads that fix the layout.
  useEffect(() => {
    if (!pdf) return;
    let alive = true;
    void (async () => {
      for (let start = 1; start <= pdf.pages && alive; start += 12) {
        const end = Math.min(start + 11, pdf.pages);
        const read = await Promise.all(
          Array.from({ length: end - start + 1 }, (_, offset) =>
            pdf.pageSize(start + offset).catch(() => null),
          ),
        );
        if (!alive) return;
        setSizes((previous) => {
          const next = previous.slice();
          read.forEach((size, offset) => (next[start - 1 + offset] = size));
          return next;
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [pdf]);

  // The reader's own width: pages fit it, and the rail docks when it is
  // wide. The rail starts open where it docks, closed where it would cover
  // the pages; after that it stays as the person leaves it.
  const wideRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const scroll = scroller.current;
    const outer = box.current;
    if (!scroll || !outer) return;
    const measure = () => {
      setWidth(Math.max(0, scroll.clientWidth - 2 * PAGE_GAP));
      const wide = outer.clientWidth >= DOCKED_RAIL_MIN;
      if (wide === wideRef.current) return;
      wideRef.current = wide;
      setDocked(wide);
      setRailOpen(wide);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [phase]);

  const pageWidth = Math.min(width, MAX_PAGE_WIDTH);
  const layout = useLayout(sizes, pageWidth, PAGE_GAP);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const recompute = useCallback(() => {
    const scroll = scroller.current;
    if (!scroll || !layout.heights.length) return;
    const next = windowOf(scroll, layout, WINDOW_PX);
    setVisible((previous) => (sameSet(previous, next) ? previous : next));
    // The page across the middle of the view.
    const middle = scroll.scrollTop + scroll.clientHeight / 2;
    let current = 1;
    layout.offsets.forEach((offset, index) => {
      if (offset <= middle) current = index + 1;
    });
    setPage(current);
  }, [layout]);
  useEffect(recompute, [recompute]);

  /** Scroll to a page (1-based, clamped). */
  const jump = useCallback(
    (target: number) => {
      const scroll = scroller.current;
      if (!scroll || !pdf) return;
      const clamped = Math.max(1, Math.min(pdf.pages, Math.round(target)));
      scroll.scrollTop = layout.offsets[clamped - 1] ?? 0;
      recompute();
    },
    [pdf, layout, recompute],
  );

  // Text: of the pages near the view (selection), and of every page while
  // searching. Each page is read once.
  const textsRef = useRef(texts);
  textsRef.current = texts;
  const readText = useCallback(
    (number: number) => {
      if (!pdf || textsRef.current[number - 1] || reading.current.has(number))
        return;
      reading.current.add(number);
      pdf
        .text(number)
        .then((text) =>
          setTexts((previous) => {
            if (previous[number - 1]) return previous;
            const next = previous.slice();
            next[number - 1] = text;
            return next;
          }),
        )
        .catch(() => undefined)
        .finally(() => reading.current.delete(number));
    },
    [pdf],
  );
  useEffect(() => {
    for (const number of visible) readText(number);
  }, [visible, readText]);
  useEffect(() => {
    if (!pdf || !searching || !query.trim()) return;
    for (let number = 1; number <= pdf.pages; number++) readText(number);
  }, [pdf, searching, query, readText]);

  const matches = useMemo(
    () => (searching ? buildMatches(texts, query) : []),
    [searching, texts, query],
  );
  const matchesByPage = useMemo(() => {
    const byPage = new Map<number, PdfMatch[]>();
    for (const match of matches)
      byPage.set(match.pageIndex, [
        ...(byPage.get(match.pageIndex) ?? []),
        match,
      ]);
    return byPage;
  }, [matches]);
  const current = matches.length
    ? Math.min(Math.max(active, 0), matches.length - 1)
    : -1;
  const activeMatch = current >= 0 ? (matches[current] ?? null) : null;
  const indexing =
    searching && !!query.trim() && texts.some((text) => text === null);

  /** Show a match: its page, then its line in the middle of the view. */
  const showMatch = useCallback(
    (match: PdfMatch) => {
      jump(match.pageIndex + 1);
      const scroll = scroller.current;
      const text = textsRef.current[match.pageIndex];
      const { scales, offsets } = layoutRef.current;
      const scale = scales[match.pageIndex] ?? 0;
      if (!scroll || !text || scale <= 0) return;
      const { itemStarts } = pagePlainText(text.items);
      let index = 0;
      itemStarts.forEach((start, at) => {
        if (start <= match.charStart) index = at;
      });
      const item = text.items[index];
      if (!item) return;
      const top = (offsets[match.pageIndex] ?? 0) + item.top * scale;
      scroll.scrollTop = Math.max(
        0,
        top - scroll.clientHeight / 2 + (item.height * scale) / 2,
      );
      recompute();
    },
    [jump, recompute],
  );
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const select = useCallback(
    (index: number) => {
      const list = matchesRef.current;
      if (!list.length) return;
      const wrapped = ((index % list.length) + list.length) % list.length;
      setActive(wrapped);
      showMatch(list[wrapped]!);
    },
    [showMatch],
  );
  // The first match of a new query, once it is found.
  const shownQuery = useRef("");
  useEffect(() => {
    if (!searching || !query.trim()) {
      shownQuery.current = "";
      return;
    }
    if (!matches.length || shownQuery.current === query) return;
    shownQuery.current = query;
    select(0);
  }, [searching, query, matches, select]);
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
    setActive(0);
    shownQuery.current = "";
  };

  if (phase === "error")
    return (
      <div
        className="pdf-reader pdf-reader-error"
        role="group"
        aria-label={`PDF: ${name}`}
      >
        <p>This PDF could not be opened here.</p>
        <button type="button" className="pdf-download" onClick={onDownload}>
          Download to view
        </button>
      </div>
    );

  const showRail = railOpen && !!pdf;
  return (
    <div
      ref={box}
      className={[
        "pdf-reader",
        docked ? "is-docked" : "is-narrow",
        showRail && "rail-open",
      ]
        .filter(Boolean)
        .join(" ")}
      role="group"
      aria-label={`PDF: ${name}`}
    >
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF reader">
        <button
          type="button"
          className="pdf-tool"
          aria-pressed={showRail}
          aria-label={
            showRail ? "Hide page thumbnails" : "Show page thumbnails"
          }
          title="Page thumbnails"
          disabled={!pdf}
          onClick={() => setRailOpen((open) => !open)}
        >
          <ToolGlyph name="pages" />
        </button>
        <PageControl page={page} pages={pdf?.pages ?? 0} onJump={jump} />
        <button
          type="button"
          className="pdf-tool pdf-search-toggle"
          aria-pressed={searching}
          aria-label={searching ? "Close search" : "Search in document"}
          title="Search in document"
          disabled={!pdf}
          onClick={() => (searching ? closeSearch() : setSearching(true))}
        >
          <ToolGlyph name="search" />
        </button>
      </div>
      {searching && pdf && (
        <SearchBar
          query={query}
          onQuery={(value) => {
            setQuery(value);
            setActive(0);
          }}
          count={matches.length}
          current={current}
          indexing={indexing}
          onNext={() => select(current + 1)}
          onPrevious={() => select(current - 1)}
          onClose={closeSearch}
        />
      )}
      <div className="pdf-body">
        {showRail && (
          <>
            {!docked && (
              <div
                className="pdf-rail-backdrop"
                aria-hidden="true"
                onClick={() => setRailOpen(false)}
              />
            )}
            <ThumbnailRail
              pdf={pdf}
              sizes={sizes}
              page={page}
              onJump={(target) => {
                jump(target);
                if (!docked) setRailOpen(false);
              }}
            />
          </>
        )}
        <div
          ref={scroller}
          className="pdf-scroll"
          tabIndex={0}
          aria-label="Pages"
          onScroll={recompute}
        >
          {phase === "loading" && (
            <p className="pdf-status" role="status">
              Opening…
            </p>
          )}
          {pdf && (
            <div
              className="pdf-pages"
              style={{
                height: layout.total || undefined,
                width: pageWidth || undefined,
              }}
            >
              {Array.from({ length: pdf.pages }, (_, index) => {
                const number = index + 1;
                const scale = layout.scales[index] ?? 0;
                const live = visible.has(number) && scale > 0;
                const text = texts[index] ?? null;
                return (
                  <div
                    key={number}
                    className="pdf-page"
                    data-page={number}
                    aria-label={`Page ${number}`}
                    style={{
                      top: layout.offsets[index] ?? 0,
                      width: pageWidth || undefined,
                      height: layout.heights[index] || undefined,
                    }}
                  >
                    {live && (
                      <>
                        <PageCanvas pdf={pdf} number={number} scale={scale} />
                        {text && (
                          <TextLayer
                            text={text}
                            scale={scale}
                            matches={matchesByPage.get(index) ?? NO_MATCHES}
                            active={
                              activeMatch?.pageIndex === index
                                ? activeMatch
                                : null
                            }
                          />
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolGlyph({ name }: { name: "pages" | "search" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "pages" ? (
        <>
          <rect x="4" y="3" width="7" height="8" rx="1" />
          <rect x="4" y="13" width="7" height="8" rx="1" />
          <path d="M15 6h5M15 16h5" />
        </>
      ) : (
        <>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </>
      )}
    </svg>
  );
}

/**
 * The page number: ‹ [n] / N ›. While the field is being edited it keeps
 * what is typed; Enter or leaving it jumps there.
 */
function PageControl({
  page,
  pages,
  onJump,
}: {
  page: number;
  pages: number;
  onJump: (page: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const number = Number.parseInt(draft, 10);
    if (Number.isFinite(number)) onJump(number);
    setDraft(null);
  };
  return (
    <span className="pdf-pageinfo">
      <button
        type="button"
        className="pdf-tool"
        aria-label="Previous page"
        disabled={!pages || page <= 1}
        onClick={() => onJump(page - 1)}
      >
        ‹
      </button>
      <input
        className="pdf-page-input"
        type="text"
        inputMode="numeric"
        aria-label="Page number"
        value={draft ?? (pages ? String(page) : "…")}
        disabled={!pages}
        onFocus={() => setDraft(String(page))}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
      <span className="pdf-page-total" aria-live="polite">
        / {pages || "…"}
      </span>
      <button
        type="button"
        className="pdf-tool"
        aria-label="Next page"
        disabled={!pages || page >= pages}
        onClick={() => onJump(page + 1)}
      >
        ›
      </button>
    </span>
  );
}

/** One page's canvas: drawn when it comes near the view, freed when it leaves. */
function PageCanvas({
  pdf,
  number,
  scale,
  priority = PRIORITY.page,
  className = "pdf-canvas",
}: {
  pdf: OpenedPdf;
  number: number;
  scale: number;
  priority?: (typeof PRIORITY)[keyof typeof PRIORITY];
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const render = pdf.render(number, element, scale, priority);
    render.done.catch(() => undefined);
    return () => {
      render.cancel();
      // Frees the bitmap now.
      element.width = 0;
      element.height = 0;
    };
  }, [pdf, number, scale, priority]);
  return <canvas ref={canvas} className={className} aria-hidden="true" />;
}

/**
 * The thumbnail rail: a button per page, small canvases only near the
 * rail's view, drawn after the pages being read.
 */
function ThumbnailRail({
  pdf,
  sizes,
  page,
  onJump,
}: {
  pdf: OpenedPdf | null;
  sizes: ReadonlyArray<PdfPageSize | null>;
  page: number;
  onJump: (page: number) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const layout = useLayout(sizes, THUMB_WIDTH, THUMB_GAP);
  const [shown, setShown] = useState<Set<number>>(() => new Set([1]));
  const recompute = useCallback(() => {
    const element = rail.current;
    if (!element || !layout.heights.length) return;
    const next = windowOf(element, layout, THUMB_WINDOW_PX);
    setShown((previous) => (sameSet(previous, next) ? previous : next));
  }, [layout]);
  useEffect(recompute, [recompute]);
  // Keep the current page's thumbnail in view.
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const top = layout.offsets[page - 1] ?? 0;
    const bottom = top + (layout.heights[page - 1] ?? 0);
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight)
      element.scrollTop = bottom - element.clientHeight;
  }, [page, layout]);
  if (!pdf) return null;
  return (
    <nav
      ref={rail}
      className="pdf-rail"
      aria-label="Page thumbnails"
      onScroll={recompute}
    >
      <div
        className="pdf-rail-track"
        style={{ height: layout.total || undefined }}
      >
        {Array.from({ length: pdf.pages }, (_, index) => {
          const number = index + 1;
          const scale = layout.scales[index] ?? 0;
          return (
            <button
              key={number}
              type="button"
              className="pdf-thumb"
              data-thumb={number}
              aria-label={`Go to page ${number}`}
              aria-current={number === page ? "page" : undefined}
              style={{
                top: layout.offsets[index] ?? 0,
                width: THUMB_WIDTH,
                height: layout.heights[index] || undefined,
              }}
              onClick={() => onJump(number)}
            >
              {shown.has(number) && scale > 0 && (
                <PageCanvas
                  pdf={pdf}
                  number={number}
                  scale={scale}
                  priority={PRIORITY.thumbnail}
                  className="pdf-thumb-canvas"
                />
              )}
              <span className="pdf-thumb-number">{number}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

const NO_MATCHES: readonly PdfMatch[] = Object.freeze([]);

/** Find in the document: the query, "2 of 7", previous, next and close. */
function SearchBar({
  query,
  onQuery,
  count,
  current,
  indexing,
  onNext,
  onPrevious,
  onClose,
}: {
  query: string;
  onQuery: (value: string) => void;
  count: number;
  /** 0-based, or -1 with no matches. */
  current: number;
  indexing: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const counter =
    count > 0
      ? `${current + 1} of ${count}`
      : query.trim()
        ? indexing
          ? "Searching…"
          : "No results"
        : "";
  return (
    <div className="pdf-search" role="search">
      <input
        ref={input}
        className="pdf-search-input"
        type="search"
        aria-label="Find in document"
        placeholder="Find in document"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="pdf-search-count" role="status">
        {counter}
      </span>
      <button
        type="button"
        className="pdf-tool"
        aria-label="Previous match"
        disabled={!count}
        onClick={onPrevious}
      >
        ‹
      </button>
      <button
        type="button"
        className="pdf-tool"
        aria-label="Next match"
        disabled={!count}
        onClick={onNext}
      >
        ›
      </button>
      <button
        type="button"
        className="pdf-tool"
        aria-label="Close search"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

/**
 * A page's text over its canvas: invisible, selectable runs placed on the
 * glyphs, with search matches marked. The text is the file's: it reaches
 * the page only as React text nodes, never as markup.
 */
function TextLayer({
  text,
  scale,
  matches,
  active,
}: {
  text: PdfPageText;
  scale: number;
  matches: readonly PdfMatch[];
  active: PdfMatch | null;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const starts = useMemo(() => pagePlainText(text.items).itemStarts, [text]);
  // Stretch each run to the width the file gives it, so selections cover
  // the glyphs drawn on the canvas.
  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    const spans = element.children;
    text.items.forEach((item, index) => {
      const span = spans[index];
      if (!(span instanceof HTMLElement)) return;
      span.style.transform = "";
      const natural = span.offsetWidth;
      const wanted = item.width * scale;
      if (natural > 0 && wanted > 0)
        span.style.transform = `scaleX(${wanted / natural})`;
    });
  }, [text, scale]);
  return (
    <div ref={layer} className="pdf-text">
      {text.items.map((item, index) => {
        const parts = splitItemForRender(
          item,
          starts[index] ?? 0,
          matches,
          active,
        );
        const size = item.height * scale;
        return (
          <span
            key={index}
            style={{
              left: item.left * scale,
              top: item.top * scale,
              fontSize: size > 0 ? size : undefined,
            }}
          >
            {parts.length === 1 && parts[0]!.kind === "plain"
              ? item.str
              : parts.map((part, at) =>
                  part.kind === "plain" ? (
                    <span key={at}>{part.text}</span>
                  ) : (
                    <mark
                      key={at}
                      className={
                        part.kind === "active" ? "is-active" : undefined
                      }
                    >
                      {part.text}
                    </mark>
                  ),
                )}
          </span>
        );
      })}
    </div>
  );
}
