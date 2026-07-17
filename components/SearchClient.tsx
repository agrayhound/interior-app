"use client";

import { useState, useTransition, useRef, useCallback, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Tile } from "@/lib/getFeaturedTiles";

interface Element {
  id: string;
  label: string;
  material: string;
  colors: string[];
  color_hexes?: string[];
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
  finish_look?: string;
  room_suitability?: string[];
  color_palette: string[];
  similarity: number;
}

const SUPPLIER_LABELS: Record<string, string> = {
  stone_tile:    "Stone Tile",
  ames:          "Ames Tile",
  centura:       "Centura Tile",
  tierra_sol:    "Tierra Sol",
  cs_tile:       "C&S Tile",
  julian:        "Julian Tile",
  centanni:      "Centanni Tile",
  artistic_tile: "Artistic Tile",
  inax:          "INAX Tile",
  ann_sacks:     "Ann Sacks",
};

// Primary city shown on product card
const SUPPLIER_CITY: Record<string, string> = {
  stone_tile:    "Vancouver · Calgary · Toronto",
  ames:          "Vancouver · Calgary",
  centura:       "Vancouver · Calgary · Toronto",
  tierra_sol:    "Vancouver · Calgary",
  cs_tile:       "Burnaby",
  julian:        "Vancouver · Calgary",
  centanni:      "Burnaby",
  ann_sacks:     "Vancouver",
  artistic_tile: "Vancouver",
  inax:          "Vancouver",
};

// Supplier → cities they serve (mirrors API route — used for client-side result filtering)
const SUPPLIER_LOCATIONS: Record<string, string[]> = {
  stone_tile:    ["Toronto","Montreal","Calgary","Vancouver"],
  ames:          ["Vancouver","Burnaby","Calgary","Edmonton","Winnipeg"],
  centura:       ["Calgary","Edmonton","Halifax","Hamilton","London","Montreal","Ottawa","Peterborough","Quebec City","St. Johns","Toronto","Vancouver"],
  tierra_sol:    ["Calgary","Vancouver"],
  cs_tile:       ["Burnaby"],
  julian:        ["Langley","Burnaby","Calgary","Edmonton","Winnipeg"],
  centanni:      ["Burnaby"],
  ann_sacks:     ["Vancouver"],
  artistic_tile: ["Vancouver"],
  inax:          ["Vancouver"],
};

// Vancouver metro: Burnaby/Langley/etc. all count as "Vancouver"
const VANCOUVER_METRO = new Set(["Vancouver","Burnaby","Langley","North Vancouver","Surrey","Richmond"]);

function supplierServesLocation(supplierId: string, location: string): boolean {
  const cities = SUPPLIER_LOCATIONS[supplierId] ?? [];
  if (location === "Vancouver") return cities.some(c => VANCOUVER_METRO.has(c));
  return cities.includes(location);
}

const LOCATION_PILLS = ["All", "Vancouver", "Calgary", "Edmonton", "Toronto"] as const;
type LocationFilter = typeof LOCATION_PILLS[number];

const PRICE_MAX = 200; // sentinel for "no price filter set"

function toggleSet(set: Set<string>, item: string): Set<string> {
  const next = new Set(set);
  if (next.has(item)) next.delete(item); else next.add(item);
  return next;
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-3">{title}</h4>
      {children}
    </div>
  );
}

function ChipGroup({ options, selected, onChange }: {
  options: Array<{ value: string; count: number }>;
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(({ value, count }) => (
        <button key={value} onClick={() => onChange(toggleSet(selected, value))}
          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
            selected.has(value)
              ? "bg-stone-600 text-white"
              : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
          }`}>
          {value} <span className="opacity-50">({count})</span>
        </button>
      ))}
    </div>
  );
}

function DualRangeSlider({ min, max, value, onChange }: {
  min: number; max: number; value: [number, number]; onChange: (v: [number, number]) => void;
}) {
  const [lo, hi] = value;
  const pLo = ((lo - min) / (max - min)) * 100;
  const pHi = ((hi - min) / (max - min)) * 100;
  return (
    <div>
      <style>{`
        .dr input[type=range]{-webkit-appearance:none;appearance:none;background:transparent;pointer-events:none;position:absolute;inset:0;width:100%;height:100%;}
        .dr input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#a8a29e;border:2px solid #171717;cursor:pointer;pointer-events:auto;margin-top:-7px;}
        .dr input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#a8a29e;border:2px solid #171717;cursor:pointer;pointer-events:auto;}
        .dr input[type=range]::-webkit-slider-runnable-track{background:transparent;height:2px;}
        .dr input[type=range]::-moz-range-track{background:transparent;}
      `}</style>
      <div className="relative mt-3" style={{ height: 24 }}>
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-neutral-700">
          <div className="absolute h-full rounded-full bg-stone-500"
            style={{ left: `${pLo}%`, right: `${100 - pHi}%` }} />
        </div>
        <div className="dr relative h-full">
          <input type="range" min={min} max={max} step={5} value={lo}
            onChange={e => onChange([Math.min(+e.target.value, hi - 5), hi])}
            style={{ zIndex: lo > max - 10 ? 5 : 3 }} />
          <input type="range" min={min} max={max} step={5} value={hi}
            onChange={e => onChange([lo, Math.max(+e.target.value, lo + 5)])}
            style={{ zIndex: 4 }} />
        </div>
      </div>
      <div className="flex justify-between text-xs text-neutral-500 mt-2">
        <span>${lo}/ft²</span>
        <span>${hi}{hi >= max ? "+" : ""}/ft²</span>
      </div>
    </div>
  );
}

function supplierLabel(id: string) {
  return SUPPLIER_LABELS[id] ?? id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function Tag({ label, color = "neutral" }: { label: string; color?: string }) {
  const colors: Record<string, string> = {
    neutral: "bg-neutral-800 text-neutral-300",
    amber:   "bg-amber-900/40 text-amber-300 border border-amber-700/40",
    blue:    "bg-blue-900/40 text-blue-300 border border-blue-700/40",
    green:   "bg-green-900/40 text-green-300 border border-green-700/40",
  };
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[color] ?? colors.neutral}`}>
      {label}
    </span>
  );
}

function colorToCss(color: string): string {
  const map: Record<string, string> = {
    white: "#f5f5f0", cream: "#f0ead6", beige: "#d4c5a9", "warm white": "#f5f0e8",
    "light grey": "#c8c8c8", grey: "#9e9e9e", gray: "#9e9e9e", "warm grey": "#b5aca0",
    charcoal: "#4a4a4a", "dark grey": "#444", black: "#1a1a1a",
    "warm brown": "#8b6355", brown: "#795548", terracotta: "#c1644a",
    green: "#5a7a5a", "sage green": "#87a878", "forest green": "#2d5a27",
    blue: "#4a6fa5", "navy blue": "#1a3a5c", teal: "#2d7a7a",
    gold: "#c9a84c", brass: "#b08d57", copper: "#b87333",
    pink: "#e8a0a0", blush: "#e8c4b8", rose: "#c97b7b",
    concrete: "#8c8c84", sand: "#c2b280", taupe: "#9c8b75",
    silver: "#c0c0c0", "warm beige": "#d6c4a8",
  };
  return map[color.toLowerCase().trim()] ?? "#888";
}

function ColorSwatch({ colors, hexes }: { colors: string[]; hexes?: string[] }) {
  return (
    <div className="flex gap-1 mt-2">
      {colors.slice(0, 4).map((c, i) => (
        <div
          key={c}
          title={c}
          className="w-4 h-4 rounded-full border border-neutral-700 shrink-0"
          style={{ backgroundColor: hexes?.[i] ?? colorToCss(c) }}
        />
      ))}
    </div>
  );
}

function ElementCard({
  element,
  selected,
  loading,
  onClick,
}: {
  element: Element;
  selected: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`text-left w-full rounded-xl border px-4 py-3 transition-all duration-150 ${
        selected
          ? "border-stone-400 bg-stone-900/60 ring-1 ring-stone-400/40"
          : "border-neutral-700 bg-neutral-900 hover:border-neutral-500"
      } ${loading && !selected ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-100 leading-tight truncate">{element.label}</p>
          <p className="text-xs text-neutral-500 mt-0.5 capitalize">
            {element.material} · {element.finish}
          </p>
        </div>
        <span
          className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full mt-0.5 ${
            element.is_tile
              ? "bg-stone-800 text-stone-300"
              : "bg-neutral-800 text-neutral-400"
          }`}
        >
          {element.category}
        </span>
      </div>
      <ColorSwatch colors={element.colors} hexes={element.color_hexes} />
      {selected && loading && (
        <p className="text-xs text-stone-400 mt-2 flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 border border-stone-400 border-t-transparent rounded-full animate-spin" />
          Searching…
        </p>
      )}
    </button>
  );
}

function TileCard({ tile }: { tile: SearchResult | Tile }) {
  const r = tile as SearchResult;
  const price = tile.price_cad_min ? `CA$${tile.price_cad_min.toFixed(2)}/ft²` : null;
  const card = (
    <div className="group bg-neutral-900 border border-white/20 rounded-2xl overflow-hidden transition-all duration-200 hover:border-white/60 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/40 cursor-pointer">
      <div className="relative aspect-square bg-neutral-800 overflow-hidden">
        {tile.thumbnail_url ? (
          <Image
            src={tile.thumbnail_url}
            alt={tile.name}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-300"
            unoptimized
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-neutral-600 text-sm">No image</div>
        )}
        {r.similarity !== undefined && (
          <div className="absolute top-2 right-2 bg-black/70 backdrop-blur-sm text-white text-xs font-semibold px-2 py-1 rounded-full">
            {Math.round(r.similarity * 100)}% match
          </div>
        )}
      </div>
      <div className="p-4 space-y-3">
        <div>
          <p className="text-xs text-neutral-500 font-medium uppercase tracking-wider mb-0.5">
            {supplierLabel(tile.supplier_id)}
          </p>
          {SUPPLIER_CITY[tile.supplier_id] && (
            <p className="text-xs text-neutral-600 mb-1">{SUPPLIER_CITY[tile.supplier_id]}</p>
          )}
          <h3 className="text-sm font-semibold text-neutral-100 leading-tight line-clamp-2">{tile.name}</h3>
        </div>
        {tile.style_tags && tile.style_tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tile.style_tags.slice(0, 3).map((t) => (
              <Tag key={t} label={t} color="neutral" />
            ))}
          </div>
        )}
        {price && (
          <p className="text-sm font-medium text-neutral-300 pt-1">{price}</p>
        )}
      </div>
    </div>
  );

  if (!r.source_url) return card;

  return (
    <a href={r.source_url} target="_blank" rel="noopener noreferrer" className="block">
      {card}
    </a>
  );
}

interface Rect { x: number; y: number; w: number; h: number }

function isPinterestPinUrl(u: string): boolean {
  try {
    const p = new URL(u);
    if (p.host === "pin.it") return p.pathname.length > 1;
    if (/^([a-z]{2,3}\.)?pinterest\.com$/i.test(p.host)) return p.pathname.startsWith("/pin/");
    return false;
  } catch {
    return false;
  }
}

export default function SearchClient({ featured }: { featured: Tile[] }) {
  const searchParams = useSearchParams();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState("");
  // When user pastes a Pinterest pin URL, we resolve it to the underlying image URL
  // and use that for preview + identify. Keeps the pin URL visible in the input.
  const [resolvedImageUrl, setResolvedImageUrl] = useState<string | null>(null);
  const [isResolvingPin, setIsResolvingPin] = useState(false);
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveRequestId = useRef(0);

  const [isIdentifying, startIdentify] = useTransition();
  const [elements, setElements] = useState<Element[] | null>(null);
  const [identifyError, setIdentifyError] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSearching, startSearch] = useTransition();
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [resultOffset, setResultOffset] = useState(0);
  const [colorWeight, setColorWeight] = useState(0.5);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterLocation, setFilterLocation] = useState<LocationFilter>("All");
  const [priceRange, setPriceRange] = useState<[number, number]>([0, PRICE_MAX]);
  const [filterMaterials, setFilterMaterials] = useState<Set<string>>(new Set());
  const [filterFinishes, setFilterFinishes] = useState<Set<string>>(new Set());
  const [filterRooms, setFilterRooms] = useState<Set<string>>(new Set());
  const [filterStyles, setFilterStyles] = useState<Set<string>>(new Set());
  const [filterSuppliers, setFilterSuppliers] = useState<Set<string>>(new Set());
  // Stored query params so load more can re-use them without re-analysing
  const lastQuery = useRef<{ element: Element; imageUrl?: string; imageData?: string; colorWeight: number } | null>(null);
  // Cache of the last /api/identify response, keyed on the exact image source.
  // Stores the in-flight promise so it's populated synchronously — this both
  // prevents duplicate Claude calls when two clicks fire before the first
  // finishes, and simplifies the hit/miss test (no reliance on state timing).
  // Invalidated whenever the URL changes; a new crop cache-misses automatically
  // because its imageData key differs.
  const identifyCache = useRef<{ imageUrl?: string; imageData?: string; promise: Promise<Element[]> } | null>(null);

  // Pre-load image from ?image= query param (e.g. when navigating from Pinterest board browser)
  useEffect(() => {
    const imageUrl = searchParams.get("image");
    if (imageUrl) handleUrlChange(imageUrl);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearAllFilters() {
    setFilterLocation("All");
    setPriceRange([0, PRICE_MAX]);
    setFilterMaterials(new Set());
    setFilterFinishes(new Set());
    setFilterRooms(new Set());
    setFilterStyles(new Set());
    setFilterSuppliers(new Set());
    setFiltersOpen(false);
  }

  function identifyOrReuse(params: { imageUrl?: string; imageData?: string }): Promise<Element[]> {
    const cached = identifyCache.current;
    if (cached && cached.imageUrl === params.imageUrl && cached.imageData === params.imageData) {
      console.log("[identify] using cached analysis");
      return cached.promise;
    }
    console.log("[identify] calling Claude API - new image");
    const promise = (async () => {
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Identification failed");
      return (data.elements ?? []) as Element[];
    })();
    // Set synchronously so concurrent callers hit the same in-flight promise.
    identifyCache.current = { imageUrl: params.imageUrl, imageData: params.imageData, promise };
    // If the request fails, drop this cache entry so the next click can retry.
    promise.catch(() => {
      if (identifyCache.current?.promise === promise) identifyCache.current = null;
    });
    return promise;
  }

  // Re-run the previous search with the current colorWeight. Called by the
  // button when results are already visible — no auto-rerank on slider drag;
  // the search only fires on an explicit button click.
  const rerunSearch = useCallback(() => {
    const q = lastQuery.current;
    if (!q) return;
    const query = { ...q, colorWeight };
    lastQuery.current = query;
    setResults(null);
    clearAllFilters();
    setHasMore(false);
    setResultOffset(0);
    setSearchError("");
    startSearch(async () => {
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ element: query.element, imageUrl: query.imageUrl, imageData: query.imageData, colorWeight, offset: 0 }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Search failed");
        lastQuery.current = query;
        setResultOffset(10);
        setHasMore(data.hasMore ?? false);
        setResults(data.results ?? []);
      } catch (e) {
        setSearchError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }, [colorWeight]);

  // Region selection state
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPt, setStartPt] = useState<{ x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [croppedDataUrl, setCroppedDataUrl] = useState<string | null>(null);
  // Stable ref holding the same value as croppedDataUrl state. Closures in
  // handleSearchSelection and the button onClick read from here so the cache
  // key is always the exact string generated at mouseUp — never a re-encoded copy.
  const croppedDataRef = useRef<string | null>(null);

  function getCanvasPoint(e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  function drawSelectionRect(rect: Rect) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Dim outside selection
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Clear (brighten) inside selection
    ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    // Border
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
    // Corner handles
    const hs = 8;
    ctx.fillStyle = "white";
    [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]].forEach(([cx, cy]) => {
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
    });
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
  }

  function syncCanvasSize() {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    canvas.width = img.offsetWidth;
    canvas.height = img.offsetHeight;
  }

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    syncCanvasSize();
    const pt = getCanvasPoint(e);
    setIsDrawing(true);
    setStartPt(pt);
    setSelection(null);
    croppedDataRef.current = null;
    setCroppedDataUrl(null);
    clearCanvas();
  }, []);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !startPt) return;
    const pt = getCanvasPoint(e);
    const rect: Rect = {
      x: Math.min(startPt.x, pt.x),
      y: Math.min(startPt.y, pt.y),
      w: Math.abs(pt.x - startPt.x),
      h: Math.abs(pt.y - startPt.y),
    };
    drawSelectionRect(rect);
  }, [isDrawing, startPt]);

  const handleCanvasMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !startPt) return;
    setIsDrawing(false);
    const pt = getCanvasPoint(e);
    const rect: Rect = {
      x: Math.min(startPt.x, pt.x),
      y: Math.min(startPt.y, pt.y),
      w: Math.abs(pt.x - startPt.x),
      h: Math.abs(pt.y - startPt.y),
    };
    if (rect.w < 10 || rect.h < 10) {
      clearCanvas();
      setSelection(null);
      return;
    }
    setSelection(rect);
    drawSelectionRect(rect);

    // Crop the natural image to this canvas rect.
    // Image must be loaded via /api/image-proxy with crossOrigin="anonymous" or
    // toDataURL() will throw a SecurityError on cross-origin images.
    const img = imgRef.current;
    if (!img) return;
    const canvas = canvasRef.current!;
    const scaleX = img.naturalWidth / canvas.width;
    const scaleY = img.naturalHeight / canvas.height;
    const crop = document.createElement("canvas");
    crop.width = Math.round(rect.w * scaleX);
    crop.height = Math.round(rect.h * scaleY);
    const cropCtx = crop.getContext("2d")!;
    cropCtx.drawImage(
      img,
      Math.round(rect.x * scaleX), Math.round(rect.y * scaleY),
      crop.width, crop.height,
      0, 0, crop.width, crop.height,
    );
    try {
      const dataUrl = crop.toDataURL("image/jpeg", 0.92);
      croppedDataRef.current = dataUrl;
      setCroppedDataUrl(dataUrl);
    } catch (err) {
      console.error("[canvas crop] toDataURL failed — image may not be CORS-proxied yet:", err);
    }
  }, [isDrawing, startPt]);

  function clearSelection() {
    setSelection(null);
    croppedDataRef.current = null;
    setCroppedDataUrl(null);
    clearCanvas();
    setElements(null);
    setResults(null);
    setSearchError("");
    setSelectedId(null);
    setHasMore(false);
    setResultOffset(0);
    lastQuery.current = null;
  }

  function handleUrlChange(val: string) {
    setUrl(val);
    const trimmed = val.trim();
    identifyCache.current = null; // new URL invalidates the cached vision analysis
    setElements(null);
    setSelectedId(null);
    setResults(null);
    setIdentifyError("");
    setSearchError("");
    setHasMore(false);
    setResultOffset(0);
    lastQuery.current = null;
    clearSelection();

    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    setResolvedImageUrl(null);

    if (isPinterestPinUrl(trimmed)) {
      // Debounce: only resolve once the user stops typing/pasting
      setPreview("");
      setIsResolvingPin(true);
      const rid = ++resolveRequestId.current;
      resolveTimer.current = setTimeout(async () => {
        try {
          const res = await fetch("/api/resolve-pinterest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: trimmed }),
          });
          const data = await res.json();
          if (rid !== resolveRequestId.current) return; // stale
          if (!res.ok) {
            setIsResolvingPin(false);
            setIdentifyError(data.error ?? "Could not resolve Pinterest URL");
            return;
          }
          setResolvedImageUrl(data.imageUrl);
          setPreview(data.imageUrl);
          setIsResolvingPin(false);
        } catch (e) {
          if (rid !== resolveRequestId.current) return;
          setIsResolvingPin(false);
          setIdentifyError(e instanceof Error ? e.message : "Failed to fetch Pinterest URL");
        }
      }, 400);
    } else {
      setIsResolvingPin(false);
      setPreview(trimmed.startsWith("http") ? trimmed : "");
    }
  }

  // Mode A: no selection — identify all surfaces, show element picker
  function handleIdentify() {
    if (!url.trim()) return;
    if (isResolvingPin) return; // wait for resolution before firing
    const effectiveUrl = resolvedImageUrl ?? url.trim();
    setIdentifyError("");
    setElements(null);
    setSelectedId(null);
    setResults(null);
    startIdentify(async () => {
      try {
        const found = await identifyOrReuse({ imageUrl: effectiveUrl });
        setElements(found);
      } catch (e) {
        setIdentifyError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }

  // Mode B: selection drawn — identify crop, auto-pick best element, search directly
  function handleSearchSelection() {
    const imageData = croppedDataRef.current;
    if (!imageData) return;
    setSearchError("");
    setElements(null);
    setSelectedId(null);
    setResults(null);
    clearAllFilters();
    setHasMore(false);
    setResultOffset(0);
    lastQuery.current = null;
    startSearch(async () => {
      try {
        // Step 1: identify what's in the crop (cached per crop payload)
        const found = await identifyOrReuse({ imageData });
        const el = found.find((e) => e.is_tile) ?? found[0];
        if (!el) throw new Error("No surfaces identified in the selected area. Try a larger selection.");

        // Step 2: search with that element + the crop
        const searchRes = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ element: el, imageData, colorWeight }),
        });
        const searchData = await searchRes.json();
        if (!searchRes.ok) throw new Error(searchData.error ?? "Search failed");
        lastQuery.current = { element: el, imageData, colorWeight };
        setResultOffset(10);
        setHasMore(searchData.hasMore ?? false);
        setResults(searchData.results ?? []);
      } catch (e) {
        setSearchError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }

  function handleSelectElement(element: Element) {
    setSelectedId(element.id);
    setResults(null);
    clearAllFilters();
    setSearchError("");
    setHasMore(false);
    setResultOffset(0);
    lastQuery.current = null;
    startSearch(async () => {
      try {
        const imageUrl = resolvedImageUrl ?? url.trim();
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ element, imageUrl, colorWeight }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Search failed");
        lastQuery.current = { element, imageUrl, colorWeight };
        setResultOffset(10);
        setHasMore(data.hasMore ?? false);
        setResults(data.results ?? []);
      } catch (e) {
        setSearchError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }

  async function handleLoadMore() {
    if (!lastQuery.current || isLoadingMore) return;
    setIsLoadingMore(true);
    setSearchError("");
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...lastQuery.current, offset: resultOffset }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      setResults((prev) => [...(prev ?? []), ...(data.results ?? [])]);
      setResultOffset((o) => o + 10);
      setHasMore(data.hasMore ?? false);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setIsLoadingMore(false);
    }
  }

  const imageLoaded = !!preview;

  return (
    <div className="min-h-screen bg-neutral-950">
      <header className="border-b border-neutral-800/60 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-stone-400 to-stone-600 flex items-center justify-center text-[9px] font-bold text-white">DM</div>
            <span className="font-semibold text-neutral-100 tracking-tight">Design Matcher</span>
          </div>
          <p className="text-xs font-semibold uppercase tracking-widest text-stone-500">Powered by AI vision</p>
          <Link
            href="/pinterest"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-neutral-600 transition-all text-xs font-medium text-neutral-300"
          >
            <svg className="w-3.5 h-3.5 text-red-400 shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.26 13.5l-2.98-.929c-.648-.2-.66-.648.136-.961l11.647-4.494c.54-.194 1.01.131.832.105z"/>
            </svg>
            Browse Pinterest
          </Link>
        </div>
      </header>

      <main className={`max-w-6xl mx-auto px-6 ${imageLoaded ? "py-6" : "py-16"} transition-all duration-300`}>
        {!imageLoaded && (
          <div className="text-center mb-14">
            <h1 className="text-4xl sm:text-5xl font-bold text-neutral-100 leading-tight mb-4">
              Find tiles that match<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-stone-300 to-stone-500">any inspiration image</span>
            </h1>
            <p className="text-neutral-400 text-lg max-w-xl mx-auto">
              Paste a Pinterest, Houzz, or any image URL. Our AI identifies the surfaces — pick the one you want to source.
            </p>
            <div className="mt-6">
              <Link
                href="/pinterest"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-neutral-600 transition-all text-sm font-medium text-neutral-300"
              >
                <svg className="w-4 h-4 text-red-400 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.26 13.5l-2.98-.929c-.648-.2-.66-.648.136-.961l11.647-4.494c.54-.194 1.01.131.832.105z"/>
                </svg>
                Browse Pinterest boards
                <svg className="w-3.5 h-3.5 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
                </svg>
              </Link>
            </div>
          </div>
        )}

        {/* Search box */}
        <div className={`max-w-2xl mx-auto mb-3 ${imageLoaded ? "" : ""}`}>
          <input
            type="url"
            value={url}
            onChange={(e) => handleUrlChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (croppedDataUrl) handleSearchSelection();
                else handleIdentify();
              }
            }}
            placeholder="Paste a Pinterest pin link or direct image URL"
            className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3.5 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-stone-500 focus:ring-1 focus:ring-stone-500/50 transition-colors"
          />
          {isResolvingPin && (
            <p className="mt-3 text-sm text-neutral-400">Resolving Pinterest pin…</p>
          )}
          {identifyError && (
            <p className="mt-3 text-sm text-red-400 bg-red-950/40 border border-red-800/40 rounded-lg px-4 py-2">{identifyError}</p>
          )}
        </div>

        {/* Selection hint / status bar — sits directly below the input, above the preview.
            Only renders once an image is actually loaded. */}
        {preview && (
          <div className="max-w-2xl mx-auto mb-6">
            <div className="flex items-center justify-between px-1 min-h-[20px]">
              {croppedDataUrl ? (
                <div className="flex items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={croppedDataUrl}
                    alt="Selected region"
                    className="w-8 h-8 rounded object-cover border border-neutral-700 shrink-0"
                  />
                  <p className="text-xs text-stone-400 font-medium">Selection ready — click Search Selected Area</p>
                </div>
              ) : (
                <p className="text-xs text-neutral-500">
                  {selection
                    ? "Drawing… release to confirm"
                    : "Draw a selection to search a specific area, or identify all surfaces below"}
                </p>
              )}
              {croppedDataUrl && (
                <button
                  onClick={clearSelection}
                  className="text-xs text-neutral-500 hover:text-neutral-200 transition-colors ml-3 shrink-0"
                >
                  Clear ✕
                </button>
              )}
            </div>
          </div>
        )}

        {/* Image preview with region selection */}
        {preview && (
          <div className="max-w-2xl mx-auto mb-8">
            <div className="w-full rounded-xl overflow-hidden bg-black border border-neutral-800 flex items-center justify-center">
              {/* Inner wrapper sized exactly to the image so canvas overlays it precisely */}
              <div className="relative inline-block leading-[0]">
                {/* crossOrigin="anonymous" + proxy src allows canvas.toDataURL() on cross-origin images */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={`/api/image-proxy?url=${encodeURIComponent(preview)}`}
                  alt="Preview"
                  className="max-w-full max-h-[600px] w-auto object-contain block"
                  crossOrigin="anonymous"
                  onError={() => setPreview("")}
                  onLoad={syncCanvasSize}
                  draggable={false}
                />
                {/* Canvas overlay for drawing selection — always mounted so drawn state persists after search */}
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 cursor-crosshair"
                  style={{ touchAction: "none", pointerEvents: (isIdentifying || isSearching) ? "none" : "auto" }}
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onMouseLeave={(e) => { if (isDrawing && !croppedDataRef.current) handleCanvasMouseUp(e); }}
                />
                {(isIdentifying || isSearching) && (
                  <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-8 h-8 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
                      <p className="text-sm text-neutral-300">
                        {croppedDataUrl ? "Analysing selection…" : "Identifying materials with Claude…"}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {/* Color weight slider + button — stays visible after results so the user can
                tweak the slider and click to re-run without re-selecting the image */}
            <div className="flex items-center gap-3 mt-3 px-1">
              <span className="text-xs text-neutral-500 w-14 text-right shrink-0">Style</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={colorWeight}
                onChange={(e) => setColorWeight(parseFloat(e.target.value))}
                className="flex-1 accent-stone-400 cursor-pointer"
              />
              <span className="text-xs text-neutral-500 w-14 shrink-0">Color</span>
              <span className="text-xs text-neutral-600 w-8 text-right shrink-0">{Math.round(colorWeight * 100)}%</span>
              <button
                onClick={() => {
                  // Fast-path re-rank only when the source hasn't changed since the last search.
                  // A newly drawn selection or a different URL routes back through identify,
                  // which will either hit the identify cache or call Claude if truly new.
                  const currentImageData = croppedDataRef.current ?? undefined;
                  const currentImageUrl = croppedDataRef.current ? undefined : (resolvedImageUrl ?? (url.trim() || undefined));
                  const lq = lastQuery.current;
                  const sameSource =
                    lq !== null &&
                    lq.imageUrl === currentImageUrl &&
                    lq.imageData === currentImageData;
                  const route = results && sameSource ? "rerunSearch"
                    : croppedDataUrl ? "handleSearchSelection"
                    : "handleIdentify";
                  console.log("[click] route=" + route, {
                    hasResults: !!results,
                    hasLastQuery: !!lq,
                    sameSource,
                    urlEq: lq ? lq.imageUrl === currentImageUrl : null,
                    dataEq: lq ? lq.imageData === currentImageData : null,
                    currentImageDataLen: currentImageData?.length ?? 0,
                    lastImageDataLen: lq?.imageData?.length ?? 0,
                    currentImageUrl,
                    lastImageUrl: lq?.imageUrl,
                  });
                  if (route === "rerunSearch") rerunSearch();
                  else if (route === "handleSearchSelection") handleSearchSelection();
                  else handleIdentify();
                }}
                disabled={isIdentifying || isSearching || isResolvingPin || !url.trim()}
                className="px-5 py-2 bg-stone-600 hover:bg-stone-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                {isResolvingPin ? "Resolving…" : isIdentifying ? "Identifying…" : isSearching ? "Searching…" : croppedDataUrl ? "Search Selected Area" : "Identify Materials"}
              </button>
            </div>
          </div>
        )}

        {/* Element picker */}
        {elements && elements.length > 0 && (
          <div className="max-w-2xl mx-auto mb-10">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                {croppedDataUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={croppedDataUrl}
                    alt="Selected region"
                    className="w-12 h-12 rounded-lg object-cover border border-neutral-700 shrink-0"
                  />
                )}
                <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
                  {elements.length} surface{elements.length !== 1 ? "s" : ""} identified — select one to search
                </h2>
              </div>
              {selectedId && (
                <button
                  onClick={() => { setSelectedId(null); setResults(null); }}
                  className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                  Clear selection
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {elements.map((el) => (
                <ElementCard
                  key={el.id}
                  element={el}
                  selected={selectedId === el.id}
                  loading={isSearching}
                  onClick={() => handleSelectElement(el)}
                />
              ))}
            </div>
          </div>
        )}

        {elements && elements.length === 0 && (
          <div className="max-w-2xl mx-auto mb-10 text-center text-neutral-500 text-sm py-6">
            No surfaces identified in this image. Try a different photo.
          </div>
        )}

        {searchError && (
          <p className="max-w-2xl mx-auto mb-6 text-sm text-red-400 bg-red-950/40 border border-red-800/40 rounded-lg px-4 py-2">{searchError}</p>
        )}

        {/* Search results */}
        {results && results.length > 0 && (() => {
          // --- Price bounds from the full result set ---
          let rawPriceMin = Infinity, rawPriceMax = 0;
          for (const r of results) {
            if (r.price_cad_min) {
              if (r.price_cad_min < rawPriceMin) rawPriceMin = r.price_cad_min;
              if (r.price_cad_min > rawPriceMax) rawPriceMax = r.price_cad_min;
            }
          }
          const priceBoundsMin = rawPriceMin === Infinity ? 0 : Math.floor(rawPriceMin);
          const priceBoundsMax = rawPriceMax === 0 ? PRICE_MAX : Math.ceil(rawPriceMax);
          // priceRange [0, PRICE_MAX] is the sentinel meaning "no price filter"
          const isDefaultPrice = priceRange[0] === 0 && priceRange[1] === PRICE_MAX;
          const effectivePriceRange: [number, number] = isDefaultPrice
            ? [priceBoundsMin, priceBoundsMax]
            : [Math.max(priceRange[0], priceBoundsMin), Math.min(priceRange[1], priceBoundsMax)];

          // --- Per-dimension facet counts (each dimension excludes its own filter) ---
          function passesExcept(r: SearchResult, exclude: string): boolean {
            if (exclude !== "location" && filterLocation !== "All" && !supplierServesLocation(r.supplier_id, filterLocation)) return false;
            if (exclude !== "price" && !isDefaultPrice) {
              if (!r.price_cad_min || r.price_cad_min < priceRange[0] || r.price_cad_min > priceRange[1]) return false;
            }
            if (exclude !== "material" && filterMaterials.size > 0 && !filterMaterials.has(r.material_look ?? "")) return false;
            if (exclude !== "finish" && filterFinishes.size > 0 && !filterFinishes.has(r.finish_look ?? "")) return false;
            if (exclude !== "room" && filterRooms.size > 0 && !(r.room_suitability ?? []).some(s => filterRooms.has(s))) return false;
            if (exclude !== "style" && filterStyles.size > 0 && !(r.style_tags ?? []).some(s => filterStyles.has(s))) return false;
            if (exclude !== "supplier" && filterSuppliers.size > 0 && !filterSuppliers.has(r.supplier_id)) return false;
            return true;
          }

          const matCounts = new Map<string, number>();
          const finCounts = new Map<string, number>();
          const roomCounts = new Map<string, number>();
          const styleCounts = new Map<string, number>();
          const suppCounts = new Map<string, number>();

          for (const r of results) {
            if (passesExcept(r, "material") && r.material_look)
              matCounts.set(r.material_look, (matCounts.get(r.material_look) ?? 0) + 1);
            if (passesExcept(r, "finish") && r.finish_look)
              finCounts.set(r.finish_look, (finCounts.get(r.finish_look) ?? 0) + 1);
            if (passesExcept(r, "room"))
              for (const room of r.room_suitability ?? [])
                roomCounts.set(room, (roomCounts.get(room) ?? 0) + 1);
            if (passesExcept(r, "style"))
              for (const style of r.style_tags ?? [])
                styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
            if (passesExcept(r, "supplier"))
              suppCounts.set(r.supplier_id, (suppCounts.get(r.supplier_id) ?? 0) + 1);
          }

          function sortedFacet(m: Map<string, number>) {
            return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
          }
          const materialOptions = sortedFacet(matCounts);
          const finishOptions   = sortedFacet(finCounts);
          const roomOptions     = sortedFacet(roomCounts);
          const styleOptions    = sortedFacet(styleCounts);
          const supplierOptions = sortedFacet(suppCounts);

          // Location pill counts (exclude own filter when counting)
          const locCounts: Partial<Record<string, number>> = {};
          for (const loc of LOCATION_PILLS) {
            if (loc === "All") continue;
            locCounts[loc] = results.filter(r => passesExcept(r, "location") && supplierServesLocation(r.supplier_id, loc)).length;
          }

          // --- Apply all filters to get displayed set ---
          const displayedResults = results.filter(r => {
            if (filterLocation !== "All" && !supplierServesLocation(r.supplier_id, filterLocation)) return false;
            if (!isDefaultPrice) {
              if (!r.price_cad_min || r.price_cad_min < priceRange[0] || r.price_cad_min > priceRange[1]) return false;
            }
            if (filterMaterials.size > 0 && !filterMaterials.has(r.material_look ?? "")) return false;
            if (filterFinishes.size > 0 && !filterFinishes.has(r.finish_look ?? "")) return false;
            if (filterRooms.size > 0 && !(r.room_suitability ?? []).some(s => filterRooms.has(s))) return false;
            if (filterStyles.size > 0 && !(r.style_tags ?? []).some(s => filterStyles.has(s))) return false;
            if (filterSuppliers.size > 0 && !filterSuppliers.has(r.supplier_id)) return false;
            return true;
          });

          const activeFilterCount =
            (filterLocation !== "All" ? 1 : 0) +
            (!isDefaultPrice ? 1 : 0) +
            (filterMaterials.size > 0 ? 1 : 0) +
            (filterFinishes.size > 0 ? 1 : 0) +
            (filterRooms.size > 0 ? 1 : 0) +
            (filterStyles.size > 0 ? 1 : 0) +
            (filterSuppliers.size > 0 ? 1 : 0);

          return (
          <>
            {/* Filter panel overlay */}
            {filtersOpen && (
              <div className="fixed inset-0 z-40 bg-black/60" onClick={() => setFiltersOpen(false)} />
            )}

            {/* Filter panel */}
            <div className={`fixed inset-y-0 right-0 z-50 flex flex-col w-80 max-w-full bg-neutral-900 border-l border-neutral-700/60 shadow-2xl transition-transform duration-300 ease-in-out ${filtersOpen ? "translate-x-0" : "translate-x-full"}`}>
              <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-700/60 shrink-0">
                <button onClick={clearAllFilters} className="text-xs text-neutral-400 hover:text-neutral-100 transition-colors">
                  Clear all
                </button>
                <h3 className="text-sm font-semibold text-neutral-100">Filters</h3>
                <button onClick={() => setFiltersOpen(false)} className="text-neutral-400 hover:text-neutral-100 transition-colors p-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
                <FilterSection title="Location">
                  <div className="flex flex-wrap gap-2">
                    {LOCATION_PILLS.map(loc => {
                      const count = loc === "All" ? results.length : (locCounts[loc] ?? 0);
                      return (
                        <button key={loc} onClick={() => setFilterLocation(loc)}
                          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${filterLocation === loc ? "bg-stone-600 text-white" : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"}`}>
                          {loc === "All" ? "All locations" : loc}
                          {loc !== "All" && <span className="opacity-50 ml-1">({count})</span>}
                        </button>
                      );
                    })}
                  </div>
                </FilterSection>

                <FilterSection title="Price (CA$/ft²)">
                  <DualRangeSlider
                    min={priceBoundsMin}
                    max={priceBoundsMax}
                    value={effectivePriceRange}
                    onChange={setPriceRange}
                  />
                </FilterSection>

                {materialOptions.length > 0 && (
                  <FilterSection title="Material">
                    <ChipGroup options={materialOptions} selected={filterMaterials} onChange={setFilterMaterials} />
                  </FilterSection>
                )}

                {finishOptions.length > 0 && (
                  <FilterSection title="Finish">
                    <ChipGroup options={finishOptions} selected={filterFinishes} onChange={setFilterFinishes} />
                  </FilterSection>
                )}

                {roomOptions.length > 0 && (
                  <FilterSection title="Room">
                    <ChipGroup options={roomOptions} selected={filterRooms} onChange={setFilterRooms} />
                  </FilterSection>
                )}

                {styleOptions.length > 0 && (
                  <FilterSection title="Style">
                    <ChipGroup options={styleOptions} selected={filterStyles} onChange={setFilterStyles} />
                  </FilterSection>
                )}

                {supplierOptions.length > 0 && (
                  <FilterSection title="Supplier">
                    <div className="space-y-2.5">
                      {supplierOptions.map(({ value: id, count }) => (
                        <label key={id} className="flex items-center gap-2.5 cursor-pointer group">
                          <input type="checkbox" checked={filterSuppliers.has(id)}
                            onChange={() => setFilterSuppliers(toggleSet(filterSuppliers, id))}
                            className="accent-stone-500 w-3.5 h-3.5 cursor-pointer shrink-0" />
                          <span className={`text-xs transition-colors flex-1 ${filterSuppliers.has(id) ? "text-neutral-100" : "text-neutral-400 group-hover:text-neutral-200"}`}>
                            {supplierLabel(id)}
                          </span>
                          <span className="text-xs text-neutral-600">{count}</span>
                        </label>
                      ))}
                    </div>
                  </FilterSection>
                )}
              </div>

              <div className="px-5 py-4 border-t border-neutral-700/60 shrink-0">
                <button onClick={() => setFiltersOpen(false)}
                  className="w-full py-2.5 bg-stone-600 hover:bg-stone-500 text-white text-sm font-semibold rounded-lg transition-colors">
                  {activeFilterCount > 0 ? `Show ${displayedResults.length} results` : "Close"}
                </button>
              </div>
            </div>

            <div className="mb-20">
              <div className="flex items-center gap-3 mb-5">
                {croppedDataUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={croppedDataUrl} alt="Searched region"
                    className="w-10 h-10 rounded-lg object-cover border border-neutral-700 shrink-0" />
                )}
                <h2 className="text-lg font-semibold text-neutral-100 flex-1">
                  {activeFilterCount > 0 ? `${displayedResults.length} of ${results.length}` : results.length} matching tiles
                </h2>
                <button
                  onClick={() => setFiltersOpen(true)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                    activeFilterCount > 0
                      ? "bg-stone-700 border-stone-500 text-stone-200"
                      : "bg-neutral-900 border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18M7 8h10M11 12h2M13 16h-2" />
                  </svg>
                  {activeFilterCount > 0 ? `Filters (${activeFilterCount})` : "Filters"}
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {displayedResults.map((tile) => (
                  <TileCard key={tile.id ?? tile.sku} tile={tile} />
                ))}
              </div>
              {displayedResults.length === 0 && (
                <p className="text-center text-neutral-500 text-sm py-12">
                  No tiles match the active filters.{" "}
                  <button onClick={clearAllFilters} className="underline hover:text-neutral-300 transition-colors">Clear all filters</button>
                </p>
              )}
              {hasMore && (
                <div className="flex justify-center mt-8">
                  <button onClick={handleLoadMore} disabled={isLoadingMore}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 hover:border-neutral-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium text-neutral-300 transition-all duration-200">
                    {isLoadingMore ? (
                      <>
                        <span className="w-3.5 h-3.5 border border-neutral-400 border-t-transparent rounded-full animate-spin" />
                        Loading…
                      </>
                    ) : "Load more"}
                  </button>
                </div>
              )}
            </div>
          </>
          );
        })()}

        {results && results.length === 0 && (
          <div className="text-center py-12 text-neutral-500">
            <p className="text-lg mb-2">No matching tiles found</p>
            <p className="text-sm">Try selecting a different surface element.</p>
          </div>
        )}

        {/* Featured tiles */}
        {!imageLoaded && !elements && !isIdentifying && (
          <div className="mt-16">
            <div className="flex items-center gap-3 mb-6">
              <div className="h-px flex-1 bg-neutral-800" />
              <span className="text-xs font-semibold uppercase tracking-widest text-neutral-600">
                Example tiles from our catalogue
              </span>
              <div className="h-px flex-1 bg-neutral-800" />
            </div>
            {featured.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {featured.map((tile) => (
                  <TileCard key={tile.id} tile={tile as unknown as SearchResult} />
                ))}
              </div>
            ) : (
              <p className="text-center text-neutral-600 text-sm">No featured tiles available yet.</p>
            )}
          </div>
        )}
      </main>

      <footer className="border-t border-neutral-800/60 px-6 py-8 mt-8">
        <div className="max-w-6xl mx-auto flex items-center justify-between text-xs text-neutral-600">
          <span>© 2026 Design Matcher. For interior designers &amp; tile suppliers.</span>
          <span>Vancouver, BC</span>
        </div>
      </footer>
    </div>
  );
}
