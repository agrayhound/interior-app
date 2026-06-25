"use client";

import { useState, useEffect, useTransition, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PinterestBoard {
  id: string;
  name: string;
  description?: string;
  pin_count: number;
  media?: { image_cover_url?: string };
}

interface PinterestPin {
  id: string;
  title?: string;
  description?: string;
  media?: {
    images?: {
      "600x"?: { url: string; width: number; height: number };
      "1200x"?: { url: string };
      "150x150"?: { url: string };
    };
  };
  link?: string;
}

interface Element {
  id: string;
  label: string;
  material: string;
  colors: string[];
  finish: string;
  category: string;
  is_tile: boolean;
}

interface SearchResult {
  id: number;
  name: string;
  sku: string;
  source_url: string;
  thumbnail_url: string;
  price_cad_min: number;
  supplier_id: string;
  style_tags: string[];
  material_look: string;
  color_palette: string[];
  similarity: number;
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function colorToCss(color: string): string {
  const map: Record<string, string> = {
    white: "#f5f5f0", cream: "#f0ead6", beige: "#d4c5a9", "warm white": "#f5f0e8",
    "light grey": "#c8c8c8", grey: "#9e9e9e", gray: "#9e9e9e", charcoal: "#4a4a4a",
    "dark grey": "#444", black: "#1a1a1a", brown: "#795548", terracotta: "#c1644a",
    green: "#5a7a5a", blue: "#4a6fa5", teal: "#2d7a7a", gold: "#c9a84c",
    pink: "#e8a0a0", concrete: "#8c8c84", sand: "#c2b280", silver: "#c0c0c0",
  };
  return map[color.toLowerCase().trim()] ?? "#888";
}

function supplierLabel(id: string) {
  const map: Record<string, string> = { stone_tile: "Stone Tile" };
  return map[id] ?? id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function Tag({ label }: { label: string }) {
  return (
    <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-neutral-800 text-neutral-300">
      {label}
    </span>
  );
}

function Spinner({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sz = { sm: "w-3 h-3 border", md: "w-6 h-6 border-2", lg: "w-10 h-10 border-2" }[size];
  return <div className={`${sz} border-stone-400 border-t-transparent rounded-full animate-spin`} />;
}

function TileCard({ tile }: { tile: SearchResult }) {
  const price = tile.price_cad_min ? `CA$${tile.price_cad_min.toFixed(2)}/ft²` : null;
  return (
    <div className="group bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden hover:border-neutral-600 transition-all duration-200">
      <div className="relative aspect-square bg-neutral-800 overflow-hidden">
        {tile.thumbnail_url ? (
          <Image src={tile.thumbnail_url} alt={tile.name} fill className="object-cover group-hover:scale-105 transition-transform duration-300" unoptimized />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-neutral-600 text-xs">No image</div>
        )}
        <div className="absolute top-2 right-2 bg-black/70 backdrop-blur-sm text-white text-xs font-semibold px-2 py-1 rounded-full">
          {Math.round(tile.similarity * 100)}%
        </div>
      </div>
      <div className="p-3 space-y-2">
        <p className="text-[10px] text-neutral-500 font-medium uppercase tracking-wider">{supplierLabel(tile.supplier_id)}</p>
        <h3 className="text-xs font-semibold text-neutral-100 leading-tight line-clamp-2">{tile.name}</h3>
        {tile.style_tags?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tile.style_tags.slice(0, 2).map(t => <Tag key={t} label={t} />)}
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          {price && <span className="text-xs font-medium text-neutral-300">{price}</span>}
          {tile.source_url && (
            <a href={tile.source_url} target="_blank" rel="noopener noreferrer"
              className="text-[10px] font-medium text-stone-400 hover:text-white transition-colors">
              View →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function ElementCard({ element, selected, loading, onClick }: {
  element: Element; selected: boolean; loading: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} disabled={loading}
      className={`text-left w-full rounded-xl border px-4 py-3 transition-all duration-150 ${
        selected ? "border-stone-400 bg-stone-900/60 ring-1 ring-stone-400/40"
                 : "border-neutral-700 bg-neutral-900 hover:border-neutral-500"
      } ${loading && !selected ? "opacity-40 cursor-not-allowed" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-100 leading-tight truncate">{element.label}</p>
          <p className="text-xs text-neutral-500 mt-0.5 capitalize">{element.material} · {element.finish}</p>
        </div>
        <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full mt-0.5 ${
          element.is_tile ? "bg-stone-800 text-stone-300" : "bg-neutral-800 text-neutral-400"}`}>
          {element.category}
        </span>
      </div>
      <div className="flex gap-1 mt-2">
        {element.colors.slice(0, 4).map(c => (
          <div key={c} title={c} className="w-4 h-4 rounded-full border border-neutral-700 shrink-0"
            style={{ backgroundColor: colorToCss(c) }} />
        ))}
      </div>
      {selected && loading && (
        <p className="text-xs text-stone-400 mt-2 flex items-center gap-1.5">
          <Spinner size="sm" /> Searching…
        </p>
      )}
    </button>
  );
}

// ── Pinterest API error notice ────────────────────────────────────────────────

function ApiNotApprovedBanner({ message }: { message: string }) {
  return (
    <div className="max-w-xl mx-auto mt-16 text-center">
      <div className="w-14 h-14 rounded-2xl bg-red-950/40 border border-red-800/40 flex items-center justify-center mx-auto mb-5">
        <svg className="w-7 h-7 text-red-400" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.26 13.5l-2.98-.929c-.648-.2-.66-.648.136-.961l11.647-4.494c.54-.194 1.01.131.832.105z"/>
        </svg>
      </div>
      <h2 className="text-lg font-semibold text-neutral-200 mb-2">Pinterest API Not Yet Approved</h2>
      <p className="text-sm text-neutral-400 mb-4">
        The Pinterest developer app (ID: {process.env.NEXT_PUBLIC_PINTEREST_CLIENT_ID ?? "1584653"}) is pending approval for the v5 API.
        Once approved, this page will display your boards and pins automatically.
      </p>
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 text-left text-xs text-neutral-500 font-mono">
        {message}
      </div>
      <p className="text-xs text-neutral-600 mt-4">
        In the meantime, use the{" "}
        <Link href="/" className="text-stone-400 hover:text-stone-300 underline">image URL search</Link>
        {" "}on the home page to paste Pinterest image URLs directly.
      </p>
    </div>
  );
}

// ── Pin search panel (shared between board view and direct pin click) ─────────

function PinSearchPanel({
  imageUrl,
  pinTitle,
  onClose,
}: {
  imageUrl: string;
  pinTitle: string;
  onClose: () => void;
}) {
  const [isIdentifying, startIdentify] = useTransition();
  const [elements, setElements] = useState<Element[] | null>(null);
  const [identifyError, setIdentifyError] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSearching, startSearch] = useTransition();
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searchError, setSearchError] = useState("");

  // Auto-identify on mount
  useEffect(() => {
    startIdentify(async () => {
      try {
        const res = await fetch("/api/identify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Identification failed");
        setElements(data.elements ?? []);
      } catch (e) {
        setIdentifyError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  function handleSelectElement(element: Element) {
    setSelectedId(element.id);
    setResults(null);
    setSearchError("");
    startSearch(async () => {
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ element, imageUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Search failed");
        setResults(data.results ?? []);
      } catch (e) {
        setSearchError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-start justify-center overflow-y-auto py-8 px-4">
      <div className="w-full max-w-5xl bg-neutral-950 border border-neutral-800 rounded-2xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-red-950/60 border border-red-800/40 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-red-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.26 13.5l-2.98-.929c-.648-.2-.66-.648.136-.961l11.647-4.494c.54-.194 1.01.131.832.105z"/>
              </svg>
            </div>
            <p className="text-sm font-semibold text-neutral-100 truncate">{pinTitle || "Pinterest Pin"}</p>
          </div>
          <button onClick={onClose} className="shrink-0 text-neutral-500 hover:text-neutral-200 transition-colors ml-4">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="flex gap-0 flex-col md:flex-row">
          {/* Pin image */}
          <div className="md:w-72 shrink-0 bg-neutral-900 border-b md:border-b-0 md:border-r border-neutral-800">
            <div className="relative aspect-square md:aspect-auto md:h-full min-h-48">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt={pinTitle} className="w-full h-full object-cover" />
            </div>
          </div>

          {/* Right panel: identify → select element → results */}
          <div className="flex-1 p-6 overflow-y-auto max-h-[80vh]">
            {/* Identifying */}
            {isIdentifying && (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <Spinner size="lg" />
                <p className="text-sm text-neutral-400">Identifying surfaces with Claude…</p>
              </div>
            )}

            {identifyError && (
              <div className="bg-red-950/40 border border-red-800/40 rounded-xl px-4 py-3 text-sm text-red-400">{identifyError}</div>
            )}

            {/* Element picker */}
            {elements && !isIdentifying && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-neutral-500 mb-3">
                  {elements.length} surface{elements.length !== 1 ? "s" : ""} identified — select one to search
                </p>
                {elements.length === 0 ? (
                  <p className="text-sm text-neutral-500 py-4">No tile surfaces found in this image.</p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 mb-6">
                    {elements.map(el => (
                      <ElementCard key={el.id} element={el} selected={selectedId === el.id}
                        loading={isSearching} onClick={() => handleSelectElement(el)} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {searchError && (
              <div className="bg-red-950/40 border border-red-800/40 rounded-xl px-4 py-3 text-sm text-red-400 mb-4">{searchError}</div>
            )}

            {/* Results */}
            {results && results.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
                    {results.length} matching tiles
                  </p>
                  <span className="text-xs text-neutral-600">Ranked by visual similarity</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {results.map(tile => <TileCard key={tile.id ?? tile.sku} tile={tile} />)}
                </div>
              </div>
            )}

            {results && results.length === 0 && (
              <p className="text-sm text-neutral-500 py-4">No matching tiles found. Try a different surface element.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Board grid ────────────────────────────────────────────────────────────────

function BoardCard({ board, onClick }: { board: PinterestBoard; onClick: () => void }) {
  const cover = board.media?.image_cover_url;
  return (
    <button onClick={onClick}
      className="group text-left bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden hover:border-neutral-600 transition-all duration-200 hover:shadow-xl hover:shadow-black/40">
      <div className="relative aspect-square bg-neutral-800 overflow-hidden">
        {cover ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={cover} alt={board.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg className="w-10 h-10 text-neutral-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
          </div>
        )}
      </div>
      <div className="p-4">
        <h3 className="text-sm font-semibold text-neutral-100 leading-tight line-clamp-1">{board.name}</h3>
        <p className="text-xs text-neutral-500 mt-1">{board.pin_count.toLocaleString()} pins</p>
        {board.description && (
          <p className="text-xs text-neutral-600 mt-1 line-clamp-2">{board.description}</p>
        )}
      </div>
    </button>
  );
}

// ── Pin grid ──────────────────────────────────────────────────────────────────

function PinCard({ pin, onClick }: { pin: PinterestPin; onClick: () => void }) {
  const img = pin.media?.images?.["600x"]?.url ?? pin.media?.images?.["150x150"]?.url;
  return (
    <button onClick={onClick}
      className="group relative bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden hover:border-stone-600 hover:border-2 transition-all duration-150 cursor-pointer">
      <div className="relative aspect-square bg-neutral-800 overflow-hidden">
        {img ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={img} alt={pin.title ?? "Pin"} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-neutral-600 text-xs">No image</div>
        )}
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors duration-200 flex items-center justify-center">
          <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-white text-xs font-semibold bg-stone-600/90 px-3 py-1.5 rounded-full">
            Find similar tiles
          </span>
        </div>
      </div>
      {pin.title && (
        <div className="p-2.5">
          <p className="text-xs text-neutral-400 line-clamp-2 text-left">{pin.title}</p>
        </div>
      )}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PinterestClient() {
  // Boards state
  const [boards, setBoards] = useState<PinterestBoard[] | null>(null);
  const [boardsLoading, setBoardsLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);

  // Board view
  const [activeBoard, setActiveBoard] = useState<PinterestBoard | null>(null);
  const [pins, setPins] = useState<PinterestPin[] | null>(null);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [pinsBookmark, setPinsBookmark] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Selected pin for search
  const [selectedPin, setSelectedPin] = useState<{ url: string; title: string } | null>(null);

  // Load boards on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/pinterest?action=boards");
        const data = await res.json();
        if (!res.ok) {
          setApiError(data.error ?? "Failed to load boards");
        } else {
          setBoards(data.items ?? []);
        }
      } catch {
        setApiError("Network error loading boards");
      } finally {
        setBoardsLoading(false);
      }
    })();
  }, []);

  const loadPins = useCallback(async (board: PinterestBoard, bookmark?: string) => {
    const url = bookmark
      ? `/api/pinterest?action=pins&boardId=${board.id}&bookmark=${encodeURIComponent(bookmark)}`
      : `/api/pinterest?action=pins&boardId=${board.id}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load pins");
    return data;
  }, []);

  async function handleBoardClick(board: PinterestBoard) {
    setActiveBoard(board);
    setPins(null);
    setPinsBookmark(null);
    setPinsLoading(true);
    try {
      const data = await loadPins(board);
      setPins(data.items ?? []);
      setPinsBookmark(data.bookmark ?? null);
    } catch (e) {
      setApiError(e instanceof Error ? e.message : "Failed to load pins");
    } finally {
      setPinsLoading(false);
    }
  }

  async function handleLoadMore() {
    if (!activeBoard || !pinsBookmark || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await loadPins(activeBoard, pinsBookmark);
      setPins(prev => [...(prev ?? []), ...(data.items ?? [])]);
      setPinsBookmark(data.bookmark ?? null);
    } catch {
      // silently fail load-more
    } finally {
      setLoadingMore(false);
    }
  }

  function handlePinClick(pin: PinterestPin) {
    const img = pin.media?.images?.["1200x"]?.url
      ?? pin.media?.images?.["600x"]?.url
      ?? pin.media?.images?.["150x150"]?.url;
    if (!img) return;
    setSelectedPin({ url: img, title: pin.title ?? pin.description ?? "Pinterest Pin" });
  }

  return (
    <div className="min-h-screen bg-neutral-950">
      {/* Header */}
      <header className="border-b border-neutral-800/60 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-stone-400 to-stone-600 flex items-center justify-center text-sm font-bold text-white">T</div>
              <span className="font-semibold text-neutral-100 tracking-tight">Design Matcher</span>
            </Link>
            <span className="text-neutral-700">/</span>
            <div className="flex items-center gap-1.5">
              <svg className="w-4 h-4 text-red-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.26 13.5l-2.98-.929c-.648-.2-.66-.648.136-.961l11.647-4.494c.54-.194 1.01.131.832.105z"/>
              </svg>
              <span className="text-sm font-medium text-neutral-300">Pinterest Boards</span>
            </div>
          </div>
          {activeBoard && (
            <button onClick={() => { setActiveBoard(null); setPins(null); }}
              className="text-xs text-neutral-500 hover:text-neutral-200 transition-colors flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
              </svg>
              All boards
            </button>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">
        {/* API error */}
        {apiError && <ApiNotApprovedBanner message={apiError} />}

        {/* Loading boards */}
        {boardsLoading && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <Spinner size="lg" />
            <p className="text-sm text-neutral-400">Loading your Pinterest boards…</p>
          </div>
        )}

        {/* Board grid */}
        {!boardsLoading && !apiError && !activeBoard && boards && (
          <>
            <div className="mb-8">
              <h1 className="text-2xl font-bold text-neutral-100 mb-1">Your Pinterest Boards</h1>
              <p className="text-sm text-neutral-500">Click a board to browse pins, then click any pin to find matching tiles.</p>
            </div>
            {boards.length === 0 ? (
              <p className="text-neutral-500 text-sm py-12 text-center">No boards found.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {boards.map(board => (
                  <BoardCard key={board.id} board={board} onClick={() => handleBoardClick(board)} />
                ))}
              </div>
            )}
          </>
        )}

        {/* Pin grid */}
        {activeBoard && (
          <>
            <div className="mb-8">
              <h1 className="text-2xl font-bold text-neutral-100 mb-1">{activeBoard.name}</h1>
              <p className="text-sm text-neutral-500">
                {activeBoard.pin_count.toLocaleString()} pins — click any image to find matching tiles
              </p>
            </div>

            {pinsLoading && (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <Spinner size="lg" />
                <p className="text-sm text-neutral-400">Loading pins…</p>
              </div>
            )}

            {pins && !pinsLoading && (
              <>
                {pins.length === 0 ? (
                  <p className="text-neutral-500 text-sm py-12 text-center">No pins in this board.</p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                    {pins.map(pin => (
                      <PinCard key={pin.id} pin={pin} onClick={() => handlePinClick(pin)} />
                    ))}
                  </div>
                )}

                {pinsBookmark && (
                  <div className="flex justify-center mt-8">
                    <button onClick={handleLoadMore} disabled={loadingMore}
                      className="px-6 py-3 bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 rounded-xl text-sm text-neutral-300 font-medium transition-colors disabled:opacity-40 flex items-center gap-2">
                      {loadingMore && <Spinner size="sm" />}
                      {loadingMore ? "Loading…" : "Load more pins"}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>

      {/* Pin search modal */}
      {selectedPin && (
        <PinSearchPanel
          imageUrl={selectedPin.url}
          pinTitle={selectedPin.title}
          onClose={() => setSelectedPin(null)}
        />
      )}
    </div>
  );
}
