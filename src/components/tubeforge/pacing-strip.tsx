"use client";

// S92 (ROADMAP #11) — the measured pacing strip: one line in the Script tab
// header where the ESTIMATED read already lives, carrying the MEASURED
// truth (real WAV durations ÷ real word counts) and the advisory proposal.
// ADVISORY ONLY: it never re-synthesizes anything.

import { useCallback, useEffect, useState } from "react";

interface PacingSceneRow {
  index: number;
  role: "hook" | "body" | "close";
  wpm: number | null;
  band: "dragging" | "measured" | "brisk" | "rushed" | "unmeasured";
  hint: "slow" | "normal" | "fast";
  projectedWpm: number | null;
}

interface PacingData {
  summary: {
    measured: number;
    unmeasured: number;
    medianWpm: number | null;
    inBand: number;
    toSpeedUp: number;
    toSlowDown: number;
  };
  perScene: PacingSceneRow[];
  planApproved: boolean;
}

const BAND_DOT: Record<PacingSceneRow["band"], string> = {
  dragging: "bg-amber-400",
  measured: "bg-emerald-400",
  brisk: "bg-sky-400",
  rushed: "bg-rose-400",
  unmeasured: "bg-zinc-600",
};

export function PacingStrip({ videoId }: { videoId: string }) {
  const [data, setData] = useState<PacingData | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/videos/${videoId}/pacing`, { cache: "no-store" });
      if (!res.ok) return;
      setData((await res.json()) as PacingData);
    } catch {
      /* advisory context — never a blocker */
    }
  }, [videoId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  if (!data || data.summary.measured === 0) return null;
  const { summary } = data;
  const issues = summary.toSpeedUp + summary.toSlowDown;
  const worst = data.perScene
    .filter((r) => r.band === "dragging" || r.band === "rushed")
    .sort((a, b) => (a.wpm ?? 0) - (b.wpm ?? 0));

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5"
        title={
          `${summary.measured} measured scenes, median ${summary.medianWpm?.toFixed(0)} wpm · ` +
          `${issues === 0 ? "all in band" : `${summary.toSpeedUp} drag, ${summary.toSlowDown} rush`}` +
          (data.planApproved ? " · the approved plan's hints steer the read" : "")
        }
      >
        <span className="inline-flex items-center gap-1">
          measured pacing:{" "}
          <b className="text-foreground tf-num">{summary.medianWpm?.toFixed(0)} wpm</b> median
        </span>
        {issues === 0 ? (
          <span className="inline-flex items-center gap-1 text-emerald-300">
            · all {summary.inBand} in band
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-amber-300">
            · {summary.toSpeedUp > 0 && `${summary.toSpeedUp} drag`}
            {summary.toSpeedUp > 0 && summary.toSlowDown > 0 && " · "}
            {summary.toSlowDown > 0 && `${summary.toSlowDown} rush`}
          </span>
        )}
        {data.summary.unmeasured > 0 && (
          <span className="text-zinc-500">· {data.summary.unmeasured} unmeasured</span>
        )}
      </button>
      {open && worst.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {worst.map((r) => (
            <div key={r.index} className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className={`h-1.5 w-1.5 rounded-full ${BAND_DOT[r.band]}`} />
              <span>
                scene {r.index} ({r.role}) — {r.wpm?.toFixed(0)} wpm, {r.band} ·{" "}
                <span className="text-foreground">
                  suggest: plan pacing “{r.hint}”
                  {r.projectedWpm != null ? ` → ${r.projectedWpm.toFixed(0)} wpm` : ""}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
