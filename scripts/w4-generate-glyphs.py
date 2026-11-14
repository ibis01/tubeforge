#!/usr/bin/env python3
# W4 slice 2 — the glyph-outline table generator (S120 §3 W4, decision §10.3).
#
#   python3 scripts/w4-generate-glyphs.py            # writes the TS table
#   python3 scripts/w4-generate-glyphs.py --verify   # byte-verify only
#
# The law: ONE handwriting face (Caveat, OFL — the single-face route; no
# font picker), converted ONCE to SVG path outlines by THIS script, committed
# as `src/lib/tubeforge/whiteboard/glyphs.ts`. The runtime (text-draw.ts)
# never parses fonts — it reads the committed table, so every render on every
# machine draws byte-identical glyph geometry (the determinism pin). The
# generator is the only place fontTools exists; it is not an npm dependency.
#
# Inputs are PINNED: font file sha256, instantiated weight, charset, decimal
# precision. Re-running with the same inputs is byte-identical (checked by
# the unit battery through the table's own hash constant).
#
# The committed font ships under its OFL license (public/fonts/caveat/OFL.txt
# + the .ttf) — attribution + license text preserved, per the license's
# reserved-name requirements.

import argparse
import hashlib
import io
import json
import os
import sys
from hashlib import sha256

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen

# --- pinned inputs -----------------------------------------------------------
FONT_REL = "public/fonts/caveat/Caveat[wght].ttf"
FONT_SHA256 = None  # filled from the file itself; pinned via receipt below
WEIGHT = 500.0
# ASCII printable — the table's coverage contract (space carries advance only).
CHARSET = [chr(c) for c in range(0x20, 0x7F)]
PRECISION = 2
OUT_REL = "src/lib/tubeforge/whiteboard/glyphs.ts"
RECEIPT_REL = "docs/baselines/w4-glyph-table-receipt.json"
FONT_ID = "caveat-w500"


def fmt(v: float) -> str:
    s = f"{v:.{PRECISION}f}"
    s = s.rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    font_path = os.path.join(root, FONT_REL)
    out_path = os.path.join(root, OUT_REL)
    receipt_path = os.path.join(root, RECEIPT_REL)

    raw = open(font_path, "rb").read()
    font_sha = sha256(raw).hexdigest()

    f = TTFont(io.BytesIO(raw))
    name = f["name"].getDebugName(1)
    if "fvar" in f:
        instantiateVariableFont(f, {"wght": WEIGHT}, inplace=True)
    upem = f["head"].unitsPerEm
    cmap = f.getBestCmap()
    glyph_set = f.getGlyphSet()
    hmtx = f["hmtx"]

    rows = []
    for ch in CHARSET:
        code = ord(ch)
        gname = cmap.get(code)
        if gname is None:
            print(f"FAIL: charset char {ch!r} (U+{code:04X}) missing from the face", file=sys.stderr)
            return 1
        glyph = glyph_set[gname]
        adv = hmtx[gname][0]
        if ch == " ":
            rows.append({"char": ch, "d": "", "advance": adv})
            continue
        pen = SVGPathPen(glyph_set, ntos=fmt)
        glyph.draw(pen)
        d = pen.getCommands()
        if not d:
            print(f"FAIL: char {ch!r} produced empty outline", file=sys.stderr)
            return 1
        rows.append({"char": ch, "d": d, "advance": adv})

    # Deterministic serialization: sorted by codepoint (CHARSET already is),
    # fixed key order, compact JSON for the path data.
    payload = {
        "fontId": FONT_ID,
        "fontFile": FONT_REL,
        "fontSha256": font_sha,
        "weight": WEIGHT,
        "upem": upem,
        "precision": PRECISION,
        "charset": CHARSET,
        "glyphs": rows,
    }
    header = (
        "// W4 slice 2 — the committed glyph-outline table (GENERATED FILE).\n"
        f"// Source: {FONT_REL} (Caveat, OFL) — see public/fonts/caveat/OFL.txt.\n"
        "// Generator: scripts/w4-generate-glyphs.py — DO NOT EDIT BY HAND.\n"
        f"// font sha256: {font_sha}\n"
        f"// weight: {WEIGHT} · upem: {upem} · precision: {PRECISION} dp · charset: ASCII 0x20–0x7E\n"
        "// The runtime reads THIS table (no font parsing anywhere) — the\n"
        "// determinism pin's whole point: same commit, same glyphs, every machine.\n"
    )
    body = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=False)
    ts = header + "\nexport interface GlyphRow { char: string; d: string; advance: number }\n\n"
    ts += "const TABLE_JSON =\n"
    # chunk the JSON into quoted lines for a stable, reviewable diff
    for i in range(0, len(body), 100):
        ts += f"  {json.dumps(body[i:i+100])} +\n"
    ts = ts.rstrip(" +\n") + ";\n\n"
    ts += (
        "export const GLYPH_TABLE: { fontId: string; upem: number; glyphs: Map<string, GlyphRow> } = (() => {\n"
        "  const parsed = JSON.parse(TABLE_JSON) as { fontId: string; upem: number; glyphs: GlyphRow[] };\n"
        "  return { fontId: parsed.fontId, upem: parsed.upem, glyphs: new Map(parsed.glyphs.map((g) => [g.char, g])) };\n"
        "})();\n"
    )
    ts += (
        "\n/** The table's own content hash — the unit battery pins it so an\n"
        " *  accidental regeneration (different font, weight, precision) cannot\n"
        " *  land silently. Regenerate deliberately, update the pin, review the diff. */\n"
        f"export const GLYPH_TABLE_SHA256 = {json.dumps(sha256(body.encode()).hexdigest())};\n"
    )

    if args.verify:
        current = open(out_path, "r", encoding="utf-8").read()
        print("VERIFY:", "byte-identical" if current == ts else "DRIFTED")
        return 0 if current == ts else 1

    open(out_path, "w", encoding="utf-8").write(ts)
    receipt = {
        "fontId": FONT_ID,
        "fontFile": FONT_REL,
        "fontSha256": font_sha,
        "weight": WEIGHT,
        "upem": upem,
        "precision": PRECISION,
        "charset": "ASCII 0x20-0x7E",
        "glyphCount": len(rows),
        "tableSha256": sha256(body.encode()).hexdigest(),
    }
    open(receipt_path, "w", encoding="utf-8").write(json.dumps(receipt, indent=2) + "\n")
    print(f"wrote {OUT_REL} ({len(rows)} glyphs, table sha256 {receipt['tableSha256'][:12]}…)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
