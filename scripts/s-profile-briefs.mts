// Shared per-profile validation briefs — the seeded script scenes the
// profile-validation lanes (S62 full-chain, S63 motion re-measure) feed the
// production pipeline. Extracted verbatim from s62-i2v-validation.mts so the
// lanes can never drift apart: the S63 re-measure reuses the S62 plans, and
// that attribution is only honest if the seed scenes are byte-identical.
import type { Scene } from "../src/lib/tubeforge/types";

export interface ProfileBrief {
  id: string;
  title: string;
  topic: string;
  niche: string;
  tone: string;
  contentPolicy?: "islamic-history";
  scenes: Scene[];
}

function seedScene(index: number, title: string, narration: string, visual: string, mood: string): Scene {
  return {
    index,
    title,
    narration,
    visual,
    camera: "static",
    mood,
    caption: title.slice(0, 45),
    hostInScene: false,
    rehook: false,
    sfx: "none",
  };
}

export const BRIEFS: ProfileBrief[] = [
  {
    id: "narrative",
    title: "The Lighthouse Keeper of Biarritz",
    topic: "A lone lighthouse keeper's quiet nightly ritual and the storm that tested it",
    niche: "history",
    tone: "reflective",
    scenes: [
      seedScene(1, "The ritual begins", "Every night at sundown, Elias climbed the one hundred and eight steps of the Biarritz light, checking the wick, winding the clockwork, and speaking to the sea as if it could answer.", "A weathered stone lighthouse interior at dusk, an old keeper climbing a spiral iron staircase with a lantern, warm amber light against deep blue shadows", "warm amber, nostalgic, soft dusk light"),
      seedScene(2, "The storm arrives", "That October, a storm came off the Bay of Biscay with a fury the coast had not seen in thirty years, and the lamp — his lamp — was the only thing between the fishing fleet and the rocks.", "Massive storm waves crashing against a lighthouse at night, spray exploding upward, the beam cutting through rain and chaos", "cold steel blue, violent, high contrast"),
    ],
  },
  {
    id: "documentary",
    title: "The Suez Shortcut",
    topic: "How the Suez Canal reshaped global trade routes and the economics of shipping",
    niche: "economics",
    tone: "neutral",
    scenes: [
      seedScene(1, "A canal between two seas", "In 1869, engineers joined the Mediterranean to the Red Sea, and the map of world trade was redrawn in a single century-defining decade.", "Aerial documentary shot of the Suez Canal cutting through desert, a massive container ship passing between sand banks, real daylight footage", "documentary natural color, clear daylight"),
      seedScene(2, "Eight percent of everything", "Today roughly twelve percent of global trade — containers, oil, and liquefied gas — squeezes through this one hundred and ninety kilometer corridor.", "Historical archive footage style: cargo ships and cranes at Port Said harbor, containers stacked in rows, workers on the dock", "archival, slightly desaturated, factual"),
    ],
  },
  {
    id: "explainer",
    title: "How a 4-Stroke Engine Works",
    topic: "The four strokes of an internal combustion engine, explained step by step",
    niche: "engineering",
    tone: "clear",
    scenes: [
      seedScene(1, "Suck, squeeze", "An engine breathes in four beats. First the piston falls, pulling a mix of air and fuel into the cylinder — the intake stroke.", "Cutaway diagram of a car engine cylinder, piston sliding down, intake valve open, blue air-fuel mixture flowing in, clean technical illustration", "clean, bright, technical"),
      seedScene(2, "Bang, blow", "Then the spark ignites the mixture, driving the piston down with real force — and on the way back up, the spent gases are pushed out the exhaust.", "Cutaway engine cylinder with spark plug firing, orange combustion explosion driving the piston down, exhaust valve opening, technical illustration", "high contrast orange flash, technical"),
    ],
  },
  {
    id: "advertisement",
    title: "Aurora Cold Brew",
    topic: "Launch ad for Aurora, a premium cold-brew coffee in a frosted glass bottle",
    niche: "beverage",
    tone: "energetic",
    scenes: [
      seedScene(1, "Meet Aurora", "Meet Aurora. Single-origin Colombian beans, steeped slow for eighteen hours, bottled cold — coffee the way it tastes at origin.", "Hero product shot of a frosted glass cold-brew coffee bottle on wet slate, condensation droplets, coffee beans scattered around, dramatic backlight", "rich brown and gold, premium, moody"),
      seedScene(2, "Your morning, upgraded", "Skip the line. Skip the wait. Tap the link, order your first twelve-pack, and taste what patience tastes like.", "A hand reaching for the cold brew bottle on a kitchen counter at sunrise, bottle label facing camera, warm morning light with space for a CTA overlay", "warm sunrise gold, inviting"),
    ],
  },
  {
    id: "animation",
    title: "The Paper Dragon",
    topic: "An animated short about a folded paper dragon who learns to fly in a rainstorm",
    niche: "animation",
    tone: "whimsical",
    scenes: [
      seedScene(1, "Folded small", "Ping was folded from a single sheet of arithmetic paper — small, creased, and certain he would never fly like the painted dragons on the temple wall.", "A tiny origami paper dragon standing on a wooden desk beside colored ink bottles, looking up longingly at a painted dragon poster on the wall, animated film style", "soft pastel, storybook, warm desk lamp"),
      seedScene(2, "The window opens", "Then a storm flung the window wide — and the same wind that terrifies lanterns lifted a paper wing for the very first time.", "The origami dragon leaping from a windowsill into a rainy night wind, paper wings catching the gust, rain streaks and glowing city lights below, dynamic animated action", "electric blue night, kinetic, glowing"),
    ],
  },
  {
    id: "podcast",
    title: "Deep Work, Real Talk",
    topic: "Why four focused hours beat twelve distracted ones — a talking-head podcast segment",
    niche: "productivity",
    tone: "conversational",
    scenes: [
      seedScene(1, "The four-hour truth", "Here's the uncomfortable math: the average knowledge worker gets four real hours a week. Not a day. A week. Everything else is coordination dressed up as work.", "A host in a warm home studio sitting close to a broadcast microphone, soft bokeh shelves behind, intimate medium shot, natural podcast lighting", "warm amber, intimate, shallow depth of field"),
      seedScene(2, "Protect the block", "So here's the move: one ninety-minute block tomorrow morning. Phone in a drawer. One tab. Watch what your brain does when nobody interrupts it for ninety minutes.", "Close-up of the podcast host leaning in with a slight smile, hand gesturing one finger up to emphasize a point, studio microphone in frame", "warm amber, close, engaged"),
    ],
  },
  {
    id: "social",
    title: "3 Sleep Wreckers",
    topic: "Three evening habits quietly wrecking your sleep — a scroll-stopping short",
    niche: "wellness",
    tone: "punchy",
    scenes: [
      seedScene(1, "The 2am scroll", "Stop scrolling — this is why you're tired. Habit one: that 'quick' phone check in bed costs you forty minutes of real sleep. Every night.", "Extreme close-up of a face lit harshly by phone glow in a dark bedroom at night, eyes wide awake, dramatic side lighting, vertical video energy", "dark blue with harsh phone glow, dramatic"),
      seedScene(2, "The nightcap lie", "Habit two: the nightcap. Alcohol knocks you out, then steals your REM two hours later. And habit three? Your 10pm 'protein shake' is an espresso in disguise.", "A glass of whiskey and a shaker bottle side by side on a nightstand, clock showing 10pm in the background, moody noir lighting", "moody noir, amber and shadow"),
    ],
  },
  {
    id: "islamic-history",
    title: "The House of Wisdom",
    topic: "Bayt al-Hikma in Abbasid Baghdad — the translation movement that preserved ancient knowledge",
    niche: "history",
    tone: "reverent",
    contentPolicy: "islamic-history",
    scenes: [
      seedScene(1, "A library for the world", "In ninth-century Baghdad, the House of Wisdom gathered scholars of many faiths around a single task: carry the knowledge of earlier ages safely into the future.", "Sunlit Abbasid library interior, towering wooden shelves of manuscripts, scholars in period dress reading at low desks, calligraphy scrolls, dust motes in light beams, no faces shown", "golden daylight, reverent, dusty light beams"),
      seedScene(2, "Ink and translation", "Page by page, the works of Aristotle and Ptolemy moved from Greek into Arabic — reed pens scratching through the nights, one careful copy at a time.", "Close pan across an open manuscript with elegant Arabic calligraphy, a reed pen and brass inkwell on a wooden rehal book stand, lamplight on parchment, no people", "lamplight gold on parchment, intimate, reverent"),
    ],
  },
];
