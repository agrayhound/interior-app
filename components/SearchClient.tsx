"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import type { Tile } from "@/lib/getFeaturedTiles";

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

const SUPPLIER_LABELS: Record<string, string> = {
  stone_tile: "Stone Tile",
};

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

function ColorSwatch({ colors }: { colors: string[] }) {
  return (
    <div className="flex gap-1 mt-2">
      {colors.slice(0, 4).map((c) => (
        <div
          key={c}
          title={c}
          className="w-4 h-4 rounded-full border border-neutral-700 shrink-0"
          style={{ backgroundColor: colorToCss(c) }}
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
      <ColorSwatch colors={element.colors} />
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
  return (
    <div className="group bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden hover:border-neutral-600 transition-all duration-200 hover:shadow-xl hover:shadow-black/40">
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
          <p className="text-xs text-neutral-500 font-medium uppercase tracking-wider mb-1">
            {supplierLabel(tile.supplier_id)}
          </p>
          <h3 className="text-sm font-semibold text-neutral-100 leading-tight line-clamp-2">{tile.name}</h3>
        </div>
        {tile.style_tags && tile.style_tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tile.style_tags.slice(0, 3).map((t) => (
              <Tag key={t} label={t} color="neutral" />
            ))}
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          {price && <span className="text-sm font-medium text-neutral-300">{price}</span>}
          {r.source_url && (
            <a
              href={r.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-stone-400 hover:text-white transition-colors"
            >
              View Product →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SearchClient({ featured }: { featured: Tile[] }) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState("");

  const [isIdentifying, startIdentify] = useTransition();
  const [elements, setElements] = useState<Element[] | null>(null);
  const [identifyError, setIdentifyError] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSearching, startSearch] = useTransition();
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searchError, setSearchError] = useState("");

  function handleUrlChange(val: string) {
    setUrl(val);
    const trimmed = val.trim();
    setPreview(trimmed.startsWith("http") ? trimmed : "");
    setElements(null);
    setSelectedId(null);
    setResults(null);
    setIdentifyError("");
    setSearchError("");
  }

  function handleIdentify() {
    if (!url.trim()) return;
    setIdentifyError("");
    setElements(null);
    setSelectedId(null);
    setResults(null);
    startIdentify(async () => {
      try {
        const res = await fetch("/api/identify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl: url.trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Identification failed");
        setElements(data.elements ?? []);
      } catch (e) {
        setIdentifyError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  }

  function handleSelectElement(element: Element) {
    setSelectedId(element.id);
    setResults(null);
    setSearchError("");
    startSearch(async () => {
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ element, imageUrl: url.trim() }),
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
    <div className="min-h-screen bg-neutral-950">
      <header className="border-b border-neutral-800/60 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-stone-400 to-stone-600 flex items-center justify-center text-[9px] font-bold text-white">DM</div>
            <span className="font-semibold text-neutral-100 tracking-tight">Design Matcher</span>
          </div>
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

      <main className="max-w-6xl mx-auto px-6 py-16">
        <div className="text-center mb-14">
          <p className="text-xs font-semibold uppercase tracking-widest text-stone-500 mb-4">Powered by AI vision</p>
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

        {/* Search box */}
        <div className="max-w-2xl mx-auto mb-6">
          <div className="flex gap-3">
            <input
              type="url"
              value={url}
              onChange={(e) => handleUrlChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleIdentify()}
              placeholder="Paste an image URL from Pinterest, Houzz, or anywhere…"
              className="flex-1 bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3.5 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-stone-500 focus:ring-1 focus:ring-stone-500/50 transition-colors"
            />
            <button
              onClick={handleIdentify}
              disabled={isIdentifying || !url.trim()}
              className="px-6 py-3.5 bg-stone-600 hover:bg-stone-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors whitespace-nowrap"
            >
              {isIdentifying ? "Identifying…" : "Identify Materials"}
            </button>
          </div>
          {identifyError && (
            <p className="mt-3 text-sm text-red-400 bg-red-950/40 border border-red-800/40 rounded-lg px-4 py-2">{identifyError}</p>
          )}
        </div>

        {/* Image preview */}
        {preview && (
          <div className="max-w-2xl mx-auto mb-8">
            <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-neutral-900 border border-neutral-800">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview}
                alt="Preview"
                className="w-full h-full object-cover"
                onError={() => setPreview("")}
              />
              {isIdentifying && (
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-neutral-300">Identifying materials with Claude…</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Element picker */}
        {elements && elements.length > 0 && (
          <div className="max-w-2xl mx-auto mb-10">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
                {elements.length} surface{elements.length !== 1 ? "s" : ""} identified — select one to search
              </h2>
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
        {results && results.length > 0 && (
          <div className="mb-20">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-neutral-100">
                {results.length} matching tiles found
              </h2>
              <span className="text-xs text-neutral-500">Ranked by visual similarity</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {results.map((tile) => (
                <TileCard key={tile.id ?? tile.sku} tile={tile} />
              ))}
            </div>
          </div>
        )}

        {results && results.length === 0 && (
          <div className="text-center py-12 text-neutral-500">
            <p className="text-lg mb-2">No matching tiles found</p>
            <p className="text-sm">Try selecting a different surface element.</p>
          </div>
        )}

        {/* Featured tiles */}
        {!elements && !isIdentifying && (
          <div className="mt-4">
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
