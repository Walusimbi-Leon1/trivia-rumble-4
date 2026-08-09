// Simulation test for the answer-letter randomization fix.
// Mirrors the live scenario: bank of 1000 questions, 95% with correctAnswer=1
// (B) — the reported exploit. Verifies normalizeBank + append chaining.
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/worker.js", "utf8");

// Extract the two functions without executing worker.js (it has exports/STATIC).
const fnRe = /function (reshuffle|normalizeBank)\([\s\S]*?\n}/g;
const fns = {};
let m;
while ((m = fnRe.exec(src))) {
  // naive brace balance: functions are at top level, single-line-arg, no nesting beyond braces
  let depth = 0, start = src.indexOf("{", m.index), i = start;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  const body = src.slice(m.index, i + 1);
  // eslint-disable-next-line no-eval
  eval(body);
}
if (typeof reshuffle !== "function" || typeof normalizeBank !== "function") {
  console.error("FAIL: could not extract functions"); process.exit(1);
}

const N = 1000;
// Reproduce the biased live bank
const bank = [];
for (let i = 0; i < N; i++) {
  const opts = ["opt" + i + "A", "opt" + i + "B", "opt" + i + "C", "opt" + i + "D"];
  bank.push({ question: "Q" + i, options: opts, correctAnswer: Math.random() < 0.95 ? 1 : Math.floor(Math.random() * 4) });
}

function check(prefix, arr) {
  let bad = 0, repeats = 0;
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < arr.length; i++) {
    const q = arr[i];
    const ca = q.correctAnswer;
    counts[ca]++;
    if (!Number.isInteger(ca) || ca < 0 || ca > 3) bad++;
    // correct option text must still be the ORIGINAL correct text
    const origCorrect = bank[i].options[bank[i].correctAnswer];
    if (q.options[ca] !== origCorrect) bad++;
    if (i > 0 && arr[i - 1].correctAnswer === ca) repeats++;
  }
  if (arr.length > 1 && arr[arr.length - 1].correctAnswer === arr[0].correctAnswer) repeats++; // wrap
  console.log(prefix, "→ total:", arr.length, "| repeats(incl wrap):", repeats, "| corrupt:", bad, "| dist:", counts.join(","));
  return repeats === 0 && bad === 0;
}

// Test 1: full normalizeBank on the biased bank (100 iterations for distribution)
let allOk = true, runRepeats = 0, distTotal = [0, 0, 0, 0];
for (let r = 0; r < 100; r++) {
  const out = normalizeBank(bank.map((q) => ({ ...q, options: q.options.slice() })));
  const ok = check("run " + r, out);
  if (!ok) runRepeats++;
  out.forEach((q) => distTotal[q.correctAnswer]++);
  allOk = allOk && ok;
}
console.log("100 runs failed:", runRepeats);
console.log("aggregate distribution (should be ~uniform, none at 0):", distTotal.join(","));

// Test 2: append chaining — simulate bank of 900, appending 100 with prevCorrect from last entry
const base = normalizeBank(bank.slice(0, 900).map((q) => ({ ...q, options: q.options.slice() })));
let prevCorrect = base[base.length - 1].correctAnswer;
const appended = bank.slice(900).map((q) => {
  const r = reshuffle({ ...q, options: q.options.slice() }, new Set([prevCorrect]));
  prevCorrect = r.correctAnswer;
  return r;
});
const full = base.concat(appended);
allOk = check("append-chain (900+100)", full) && allOk;

// Test 3: single-question bank + two-question bank edge cases
const one = normalizeBank([{ question: "x", options: ["a", "b", "c", "d"], correctAnswer: 2 }]);
console.log("single-entry bank:", JSON.stringify(one[0].options[one[0].correctAnswer]) === JSON.stringify("c") ? "OK" : "FAIL", "ca=" + one[0].correctAnswer);
const two = normalizeBank([
  { question: "x", options: ["a", "b", "c", "d"], correctAnswer: 1 },
  { question: "y", options: ["e", "f", "g", "h"], correctAnswer: 1 },
]);
console.log("two-entry bank differ:", two[0].correctAnswer !== two[1].correctAnswer ? "OK" : "FAIL", two[0].correctAnswer, two[1].correctAnswer);

// Test 4: reshuffle with all-but-one forbidden → must pick the only free slot
const forced = reshuffle({ question: "z", options: ["a", "b", "c", "d"], correctAnswer: 0 }, new Set([1, 2, 3]));
console.log("forced slot (must be 0):", forced.correctAnswer === 0 && forced.options[0] === "a" ? "OK" : "FAIL");

// Test 5: degenerate input safety
const deg = reshuffle({ question: "w", options: ["solo"] }, new Set([0]));
console.log("degenerate (1 option):", deg && deg.options && deg.options.length === 1 ? "OK" : "FAIL");

console.log(allOk && runRepeats === 0 ? "\nALL TESTS PASSED ✅" : "\nTESTS FAILED ❌");
process.exit(allOk && runRepeats === 0 ? 0 : 1);
