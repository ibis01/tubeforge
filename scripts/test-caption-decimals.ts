// Unit proof: captionChunks must never split a decimal number.
import { captionChunks } from "../src/lib/tubeforge/captions.ts";

const real = [
  "Benjamin Franklin left 1,000 pounds to Boston and Philadelphia in 1791. 200 years later, it grew to $6.5 million each. This isn't luck. It's mathematics.",
  "10% return turns $10,000 into $25,937 in 10 years. But in 30 years? It becomes $174,494. Time is the multiplier that makes interest truly compound.",
  "Credit card debt at 20% APR. $5,000 balance becomes $12,440 in just 5 years. Compounding works against you when you borrow.",
];

let bad = 0;
for (const text of real) {
  const chunks = captionChunks(text);
  for (const c of chunks) {
    // a chunk ending in a bare "$6." or starting with "5 million" = broken
    if (/\$\d+\.$/.test(c.text) || /^\d+\s+(million|thousand|billion)/.test(c.text)) {
      bad++;
      console.log("BROKEN CHUNK:", JSON.stringify(c.text));
    }
  }
  console.log(chunks.map((c) => c.text).join(" | "));
}
console.log(bad === 0 ? "\nOK: no decimal splits" : `\nFAIL: ${bad} broken chunks`);
process.exit(bad === 0 ? 0 : 1);
