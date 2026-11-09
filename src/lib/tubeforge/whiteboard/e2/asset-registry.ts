// asset-registry.ts — starter library + lookup (E2).
//
// Loads the in-repo starter SVG library once at module load, validates +
// extracts each one, and exposes a typed lookup used by the animator,
// composer and tests. Future E5 fuzzy matching builds on this surface
// (with the "missing concept = visible error" contract from plan §3).

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WhiteboardAsset } from "./schemas";
import { extractAsset, type ExtractedPath, type ExtractedAsset } from "./path-extractor";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(HERE, "assets", "library");

interface RegistryEntry {
  asset: WhiteboardAsset;
  paths: Map<string, ExtractedPath>;
  extracted: ExtractedAsset;
  source: string;
}

class AssetRegistry {
  private byId = new Map<string, RegistryEntry>();

  /** Load every .svg under assets/library/. Idempotent. */
  load(): void {
    if (this.byId.size > 0) return;
    const files = readdirSync(LIB_DIR).filter((f) => f.endsWith(".svg")).sort();
    for (const file of files) {
      const id = file.replace(/\.svg$/, "");
      const full = join(LIB_DIR, file);
      const source = readFileSync(full, "utf8");
      const extracted = extractAsset(source, {
        id,
        name: prettify(id),
        category: categoryFor(id),
        tags: tagsFor(id),
      });
      this.byId.set(id, {
        asset: extracted.asset as WhiteboardAsset,
        paths: new Map(extracted.paths.map((p) => [p.id, p])),
        extracted,
        source,
      });
    }
  }

  has(id: string): boolean {
    this.load();
    return this.byId.has(id);
  }

  asset(id: string): WhiteboardAsset | undefined {
    this.load();
    return this.byId.get(id)?.asset;
  }

  /** Throws if the asset isn't registered — used where a missing asset is a hard error. */
  require(id: string): RegistryEntry {
    this.load();
    const e = this.byId.get(id);
    if (!e) {
      throw new Error(`AssetRegistry: asset "${id}" is not in the library`);
    }
    return e;
  }

  path(assetId: string, pathId: string): ExtractedPath {
    const entry = this.require(assetId);
    const p = entry.paths.get(pathId);
    if (!p) {
      throw new Error(
        `AssetRegistry: asset "${assetId}" has no path "${pathId}"`,
      );
    }
    return p;
  }

  source(assetId: string): string {
    return this.require(assetId).source;
  }

  extracted(assetId: string): ExtractedAsset {
    return this.require(assetId).extracted;
  }

  list(): WhiteboardAsset[] {
    this.load();
    return Array.from(this.byId.values()).map((e) => e.asset);
  }

  /** The hand illustration (special asset; see composer for placement). */
  handSvg(): string {
    return this.source("hand-right");
  }
}

function prettify(id: string): string {
  return id
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function categoryFor(id: string): string {
  if (id === "hand-right") return "system";
  return "concept";
}

function tagsFor(id: string): string[] {
  const base = id.split(/[-_]/);
  if (id === "bar-chart") return ["chart", "data", "graph", "growth", ...base];
  if (id === "arrow-growth") return ["arrow", "growth", "up", ...base];
  if (id === "check-badge") return ["check", "badge", "verified", "ok", ...base];
  if (id === "lightbulb") return ["idea", "light", "bulb", "innovation", ...base];
  if (id === "rocket") return ["rocket", "launch", "startup", ...base];
  if (id === "globe") return ["globe", "world", "earth", "international", ...base];
  if (id === "coin") return ["coin", "money", "currency", "dollar", ...base];
  if (id === "clock") return ["clock", "time", "watch", ...base];
  return base;
}

/** Singleton accessor. */
let _registry: AssetRegistry | null = null;
export function assetRegistry(): AssetRegistry {
  if (!_registry) {
    _registry = new AssetRegistry();
    _registry.load();
  }
  return _registry;
}

/** Test-only: reset the registry singleton. */
export function _resetRegistryForTests(): void {
  _registry = null;
}
