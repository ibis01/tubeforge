// S31 unit probe — topic-world fidelity for storyboard art.
//
// The owner rule: storyboard images must ALWAYS belong to the video's
// story. A video about Arab history paints Arab culture in every scene —
// architecture, dress, artifacts, people of that world; a finance story
// paints the financial world the narration is actually telling. Never a
// generic stand-in that could sit just as well in a different video.
//
// Four layers enforce it; this probe pins each:
//   A. topicWorldClause — the paint-time anchor's pure law
//   B. TOPIC_FIDELITY_RULES / TOPIC_FIDELITY_AUDIT_RULE — the taught
//      wording (script layer + auditor layer)
//   C. the weaves — every consumer site actually interpolates its layer:
//      the scene-package prompt, the audit prompt (renumbered), the
//      artPrompt, the VLM gate context, the extra-shot prompt, and the
//      one-way import edge (shots → story, never back)
//   D. the Director's BASE rules carry the imagePrompt story-world rule
//
// Run: node --import tsx scripts/s31-unit-probe.mts

import fsp from "node:fs/promises";
import path from "node:path";

const { TOPIC_FIDELITY_AUDIT_RULE, TOPIC_FIDELITY_RULES, topicWorldClause } =
  await import("../src/lib/tubeforge/story");
const { directorSystemPrompt, resolveProfile } = await import(
  "../src/lib/tubeforge/director"
);

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  ok ? pass++ : fail++;
};

const src = {
  story: await fsp.readFile(path.join(process.cwd(), "src/lib/tubeforge/story.ts"), "utf8"),
  shots: await fsp.readFile(path.join(process.cwd(), "src/lib/tubeforge/shots.ts"), "utf8"),
};

// ---- A. topicWorldClause (the paint-time anchor, pure) ----
{
  const culture = topicWorldClause({ topic: "The Golden Age of Baghdad", niche: "History" });
  check("A.1 null world → empty clause (the absent net, never a blocker)", topicWorldClause(null) === "");
  check("A.2 whitespace topic → empty clause", topicWorldClause({ topic: "   ", niche: "History" }) === "");
  check(
    "A.3 culture topic carries topic + niche + the anchor law",
    culture.startsWith("Story world:") &&
      culture.includes('"The Golden Age of Baghdad"') &&
      culture.includes("(History)") &&
      culture.includes("authentic to that story's culture, era and subject") &&
      culture.includes("never a generic or mismatched stand-in"),
    culture
  );
  const domain = topicWorldClause({ topic: "Compound interest, explained", niche: "" });
  check(
    "A.4 domain topic without niche → no parenthetical, topic intact",
    domain.includes('"Compound interest, explained"') && !domain.includes("("),
    domain
  );
  const trimmed = topicWorldClause({ topic: "How money grows", niche: "  Finance  " });
  check("A.5 the niche is trimmed into the clause", trimmed.includes("(Finance)") && !trimmed.includes("(  Finance"), trimmed);
}

// ---- B. the taught wording (script + auditor layers) ----
{
  const lines = TOPIC_FIDELITY_RULES.split("\n");
  check(
    "B.1 three script-layer rules, each a bullet",
    lines.length === 3 && lines.every((l) => l.startsWith("- ")),
    lines
  );
  check(
    "B.2 the culture anchor names the owner's example (Arab history)",
    TOPIC_FIDELITY_RULES.includes("Arab history") &&
      TOPIC_FIDELITY_RULES.includes("authentic markers") &&
      TOPIC_FIDELITY_RULES.includes("never a caricature")
  );
  check(
    "B.3 the domain anchor names the owner's example (finance) with concrete domain objects",
    TOPIC_FIDELITY_RULES.includes("finance") && TOPIC_FIDELITY_RULES.includes("trading floor")
  );
  check(
    "B.4 the auditor rule is rule 6 and carries both mismatch traps",
    TOPIC_FIDELITY_AUDIT_RULE.startsWith("6.") &&
      TOPIC_FIDELITY_AUDIT_RULE.includes("European plaza in an Arab-history video") &&
      TOPIC_FIDELITY_AUDIT_RULE.includes("a random landscape in a finance story")
  );
}

// ---- C. the weaves (every consumer site interpolates its layer) ----
{
  check(
    "C.1 scene-package prompt: VISUAL RULES close with the topic-fidelity block",
    src.story.includes("${TOPIC_FIDELITY_RULES}\n\nRETENTION RULES:")
  );
  check(
    "C.2 audit prompt: rule 6 interpolated, the meta-rule renumbered to 7",
    src.story.includes("${TOPIC_FIDELITY_AUDIT_RULE}\n7. Never touch title")
  );
  check(
    "C.3 artPrompt: the anchor is woven straight after the scene visual",
    src.story.includes("${scene.visual}.${topicClause ? ` ${topicClause}.` : \"\"}${styleClause")
  );
  check(
    "C.4 VLM gate context names the video's topic and demands world authenticity",
    src.story.includes('about "${topicWorld.topic}"') &&
      src.story.includes("stay authentic to that story's world")
  );
  check(
    "C.5 extra shots: the anchor is read once per scene and appended to the prompt",
    src.shots.includes("topicWorldClause(await getVideoTopicWorld(opts.videoId))") &&
      src.shots.includes("prompt: anchor ? `${shot.prompt!} ${anchor}.` : shot.prompt!")
  );
  check(
    "C.6 the import edge stays one-way (story never imports shots)",
    !/from "\.\/shots"/.test(src.story)
  );
}

// ---- D. the Director layer ----
{
  const sys = directorSystemPrompt(resolveProfile("narrative"));
  check(
    "D.1 BASE rules teach the imagePrompt story-world rule",
    sys.includes("imagePrompt (shots):") &&
      sys.includes("story world") &&
      sys.includes("Arab history, finance")
  );
  check(
    "D.2 the M1 golden shape survives the additive rule (Rules block still leads)",
    sys.includes("Rules:\n- Shot length:")
  );
}

console.log(fail === 0 ? `S31 UNIT PROBE: ALL PASS (${pass} passed)` : `S31 UNIT PROBE: ${fail} FAILED of ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
