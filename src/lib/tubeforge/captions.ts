// captions.ts — Stage 6 T-6.7: pure SRT <-> VTT conversion helpers.
//
// The render job writes `subtitles.srt` to the video's storage folder.
// /api/videos/[id]/captions serves either SRT (verbatim) or VTT (converted
// on the fly) from that file. The conversion is a syntactic transform —
// VTT and SRT use the same HH:MM:SS.mmm|,mmm format; the only differences
// are a "WEBVTT" header, an optional blank line, the `,` -> `.` fractional
// separator, and VTT cue identifiers being optional (we drop the bare SRT
// cue-number lines so a player doesn't read "1" as an identifier).

/** Convert an SRT body to WebVTT — header swap + fractional-separator change. */
export function srtToVtt(srt: string): string {
  const lines = srt.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = ["WEBVTT", ""];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip a bare cue-number line (an integer on its own line, followed by
    // a timestamp line). This is the SRT-only convention VTT doesn't need.
    if (/^\d+$/.test(line.trim()) && i + 1 < lines.length && lines[i + 1].includes("-->")) {
      continue;
    }
    // Replace `,` with `.` inside the timestamp separator only.
    if (line.includes("-->")) {
      out.push(line.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2"));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** Quick detection — does this string look like an SRT body? Used by the
 *  captions route to short-circuit a 404 when storage returned an HTML
 *  error page (a misconfigured s3 driver would otherwise serve that as
 *  captions). Not authoritative — the QC battery's `parseSrt` is the
 *  real validator. */
export function looksLikeSrt(s: string): boolean {
  return /-->/.test(s) && /\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(s);
}
