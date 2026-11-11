// S91 (ROADMAP #10, S76 §5 P4) — the living production board, pure half.
//
// "Expose production stages, script and storyboard, asset-generation
// progress, provider decisions, costs, approval checkpoints and production
// history through the project studio, backed by the existing database and
// job system." Backlot is the UX reference — studied, not copied.
//
// This module is the PURE derivation: given a video's facts (DB flags,
// probed artifact counts, the running-job snapshot, report presence), it
// produces the board's stage states and checkpoint states. No I/O — the
// route gathers, this decides, the pins hold the decision table still.
//
// THE HONESTY RULES:
//   • "running" outranks every artifact state (a stale done + a live job
//     shows running — the board reports what IS, not what was)
//   • "partial" is a first-class state (art 3/8 scenes) — never rounded up
//   • checkpoints never claim more than their evidence: a report present
//     but unreviewed is "pending", a hold is "attention", absent is n/a

export type BoardStageState = "done" | "partial" | "preview" | "running" | "missing";

export interface BoardStage {
  state: BoardStageState;
  label: string;
  detail?: string;
}

export interface BoardStages {
  script: BoardStage;
  storyboard: BoardStage;
  voiceover: BoardStage;
  render: BoardStage;
  publish: BoardStage;
}

export interface BoardInput {
  /** scenes parsed (story formats) — 0 for classic script format. */
  sceneCount: number;
  /** words of the script column (classic format) — null when absent. */
  wordCount: number | null;
  /** storyboard progress NUMBERS — the route decides what counts (scene
   *  art files for the image lanes, the whiteboard/slide doc for those
   *  lanes). done/total. */
  boardDone: number;
  boardTotal: number;
  stockMatched: number;
  hasVoiceover: boolean;
  voiceSource: string;
  hasVideo: boolean;
  hasPreview: boolean;
  renderMode: string;
  hasShort: boolean;
  youtubeUrl: string | null;
  running: {
    script: boolean;
    storyboard: boolean;
    stock: boolean;
    voiceover: boolean;
    render: boolean;
    whiteboard: boolean;
    qc: boolean;
    upload: boolean;
  };
}

/**
 * The five-stage strip. Precedence: running > done/partial > missing —
 * a job in flight is the live truth even over finished artifacts.
 */
export function deriveBoardStages(input: BoardInput): BoardStages {
  // Script: scenes for story formats, words for the classic format.
  const scriptDone = input.sceneCount > 0 || (input.wordCount ?? 0) > 0;
  const script: BoardStage = input.running.script
    ? { state: "running", label: "Script" }
    : scriptDone
      ? {
          state: "done",
          label: "Script",
          detail: input.sceneCount > 0 ? `${input.sceneCount} scenes` : `${input.wordCount} words`,
        }
      : { state: "missing", label: "Script" };

  // Storyboard: the boardDone/boardTotal numbers (lane-appropriate).
  let storyboard: BoardStage;
  if (input.running.storyboard || input.running.stock) {
    storyboard = { state: "running", label: "Storyboard" };
  } else if (input.boardTotal > 0 && input.boardDone >= input.boardTotal) {
    storyboard = {
      state: "done",
      label: "Storyboard",
      detail:
        input.stockMatched > 0
          ? `${input.boardDone}/${input.boardTotal} · ${input.stockMatched} stock`
          : `${input.boardDone}/${input.boardTotal}`,
    };
  } else if (input.boardDone > 0) {
    storyboard = {
      state: "partial",
      label: "Storyboard",
      detail: `${input.boardDone}/${input.boardTotal}`,
    };
  } else {
    storyboard = { state: "missing", label: "Storyboard" };
  }

  const voiceover: BoardStage = input.running.voiceover
    ? { state: "running", label: "Voice" }
    : input.hasVoiceover
      ? {
          state: "done",
          label: "Voice",
          detail: input.voiceSource === "custom" ? "custom audio" : undefined,
        }
      : { state: "missing", label: "Voice" };

  const render: BoardStage = input.running.render || input.running.whiteboard || input.running.qc
    ? { state: "running", label: "Render" }
    : input.hasVideo
      ? { state: "done", label: "Render", detail: input.renderMode }
      : input.hasPreview
        ? { state: "preview", label: "Render", detail: "preview only" }
        : { state: "missing", label: "Render" };

  const publish: BoardStage = input.running.upload
    ? { state: "running", label: "Publish" }
    : input.youtubeUrl
      ? { state: "done", label: "Publish", detail: "live" }
      : input.hasShort
        ? { state: "partial", label: "Publish", detail: "short ready" }
        : { state: "missing", label: "Publish" };

  return { script, storyboard, voiceover, render, publish };
}

// ---------- checkpoints ----------

export type CheckpointState = "ok" | "pending" | "attention" | "na";

export interface BoardCheckpoint {
  id: string;
  label: string;
  state: CheckpointState;
  detail: string;
}

export interface CheckpointInput {
  /** null = never run | "proposed" | "approved" | "dismissed" */
  directorState: string | null;
  hasQcReport: boolean;
  qcOverrideAt: string | null;
  hasVerifyReport: boolean;
  hasConsistencyReport: boolean;
  criticVerdict: string | null;
}

/**
 * The approval gates, each claiming exactly what its evidence supports:
 * an approved plan is ok; a PROPOSED plan needs the human (attention);
 * a critic hold needs the human; a QC report nobody reviewed is pending.
 */
export function deriveCheckpoints(input: CheckpointInput): BoardCheckpoint[] {
  const out: BoardCheckpoint[] = [];

  if (input.directorState === "approved")
    out.push({ id: "director", label: "Director plan", state: "ok", detail: "approved — steering prompts" });
  else if (input.directorState === "proposed")
    out.push({ id: "director", label: "Director plan", state: "attention", detail: "awaiting your approval" });
  else if (input.directorState === "dismissed")
    out.push({ id: "director", label: "Director plan", state: "na", detail: "dismissed" });
  else out.push({ id: "director", label: "Director plan", state: "pending", detail: "not run yet" });

  if (input.qcOverrideAt)
    out.push({ id: "qc", label: "QC ship gate", state: "ok", detail: "human ship override" });
  else if (input.hasQcReport)
    out.push({ id: "qc", label: "QC ship gate", state: "pending", detail: "report ready — review it" });
  else out.push({ id: "qc", label: "QC ship gate", state: "na", detail: "not run yet" });

  if (input.hasVerifyReport)
    out.push({ id: "verify", label: "Narration check", state: "ok", detail: "verified against ASR" });
  else out.push({ id: "verify", label: "Narration check", state: "na", detail: "not run yet" });

  if (input.hasConsistencyReport)
    out.push({ id: "consistency", label: "Continuity", state: "ok", detail: "checked" });
  else out.push({ id: "consistency", label: "Continuity", state: "na", detail: "not run yet" });

  if (input.criticVerdict === "ship")
    out.push({ id: "critic", label: "Video critic", state: "ok", detail: "ship" });
  else if (input.criticVerdict === "hold")
    out.push({ id: "critic", label: "Video critic", state: "attention", detail: "HOLD — repair proposed" });
  else if (input.criticVerdict === "insufficient-evidence")
    out.push({ id: "critic", label: "Video critic", state: "pending", detail: "insufficient evidence" });
  else out.push({ id: "critic", label: "Video critic", state: "na", detail: "not run yet" });

  return out;
}
