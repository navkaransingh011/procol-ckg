// Calibrated confidence, computed from RETRIEVAL -- never from the model's tone. The writer is told the level and one
// reason, and its wording follows: assert on high, name the one weaker link on medium, state the missing piece on low.
//
// Three signals decide it:
//   1. how the subject was matched -- an exact name, a screen chain read in the order asked, a strong match by
//      meaning that stands clear of the runner-up, or only a fuzzy token;
//   2. how many independent sources agree -- code (exact nodes, source, complete lists), documents, screens,
//      live platform rows the planner asked for;
//   3. whether the question was about platform state and the data answered it directly (that alone is authoritative).
//
// clearTop() is the gate for the side channels (switches and platform rows found by meaning): at most two, the
// second only when it is close to the first, and none when the field is flat (three near-identical scores is noise).

const NAMEABLE = new Set(["FEATURE", "UI_ROUTE", "UI_ACTION", "DOCUMENT"]);   // safe to name for every role; code names are not

/**
 * Keep the top candidates that stand clear of the rest.
 *   close  -- the runner-up joins the first only within this distance
 *   margin -- the kept set must lead whatever follows by at least this much, else the field is flat
 *   lenient -- when the question is explicitly about this kind of data, a flat field still keeps the best two
 */
export function clearTop(items, score, { max = 2, close = 0.05, margin = 0.03, floor = 0, lenient = false } = {}) {
  const s = (items || []).filter(x => Number(score(x)) >= floor).sort((a, b) => score(b) - score(a));
  if (!s.length) return { kept: [], dropped: (items || []).length, flat: false };
  let kept = s.slice(0, s[1] && score(s[0]) - score(s[1]) <= close ? Math.min(2, max) : 1);
  while (kept.length) {
    const next = s[kept.length];
    if (!next || score(kept[kept.length - 1]) - score(next) >= margin) break;
    kept = kept.slice(0, -1);
  }
  const flat = kept.length === 0;
  if (flat && lenient) kept = s.slice(0, Math.min(2, max));
  return { kept, dropped: (items || []).length - kept.length, flat };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** One level, one reason, and (below high) the single thing that would raise it. */
export function assessConfidence({ lookups = [], screen_journey = null, screens = [], documents = [], live = [], source = [],
                                   effective_configuration = [], companies_with = [], lists = [], planned_sql = [], sem = [],
                                   planAskedLive = false, journeyQuestion = false, unresolved = 0, truncated = false } = {}) {
  const exactL = lookups.filter(l => l?.match === "exact");
  const approxL = lookups.filter(l => l?.match === "approximate");
  const noneL = lookups.filter(l => !l || l.match === "none");
  const journey = !!(screen_journey?.screens?.length >= 2);
  const journeyOrdered = journey && !!screen_journey.follows_question_order;
  // bge-small compresses scores: measured on this index, passages that answer the question score 0.70-0.73,
  // loosely related ones 0.65-0.69, unrelated ones about 0.50-0.56. 0.70 is the line between the first two
  // (the scores arrive rounded to two decimals, so 0.695 counts and 0.689 does not).
  const strongDocs = documents.filter(d => num(d?.score) >= 0.70);
  const liveRows = live.filter(l => l && !l.error && num(l.total) > 0);
  const stateAnswered = (planAskedLive && liveRows.length > 0) || effective_configuration.length > 0 || companies_with.length > 0;
  const completeList = lists.some(l => l && l.complete && num(l.total) > 0) || planned_sql.some(r => r && !r.error && num(r.row_count) > 0);
  const semTop = num(sem[0]?.score), semMargin = sem.length ? semTop - num(sem[1]?.score) : 0;
  const semStrong = semTop >= 0.72 && semMargin >= 0.04;

  // independent sources that agree on the subject
  const sources = [];
  if (exactL.length || source.length || completeList) sources.push("code");
  if (strongDocs.length) sources.push("documents");
  if (journey || screens.length) sources.push("screens");
  if (stateAnswered) sources.push("live data");

  const strong = exactL.length > 0 || (journeyQuestion && journeyOrdered) || semStrong || stateAnswered || completeList;
  const weak = !strong && !journey && !strongDocs.length && semTop < 0.6 && !approxL.length;
  // one source is enough when it is authoritative for the question: platform rows for a state question, a complete
  // set for a "which/how many" question, an exact code match whose trace was followed to the end, or a screen
  // chain read from the dashboard code in the order the journey question asked
  const cleanTrace = exactL.length > 0 && unresolved === 0 && !truncated;
  const authoritative = stateAnswered || completeList || cleanTrace || (journeyQuestion && journeyOrdered);
  let level;
  if (strong && (sources.length >= 2 || authoritative)) level = "high";
  else if (weak || noneL.length === lookups.length && !journey && !strongDocs.length && !stateAnswered) level = "low";
  else if (!exactL.length && approxL.length && sources.length <= 1 && !journey) level = "low";
  else level = "medium";
  if (level === "high" && (truncated || unresolved > 2) && !journeyOrdered && !stateAnswered) level = "medium";

  // the reason: the strongest signal first, then what agrees with it
  const safeName = (l) => (l?.anchor?.kind && NAMEABLE.has(l.anchor.kind) && l.anchor.name ? l.anchor.name : null);
  let primary;
  if (journeyQuestion && journeyOrdered) primary = "the screen chain was read from the dashboard code in the order asked";
  else if (exactL.length) { const n = safeName(exactL[0]); primary = n ? `an exact match on the ${exactL[0].anchor.kind === "FEATURE" ? "feature" : "screen"} ${n}` : "an exact match in the code"; }
  else if (stateAnswered) primary = "live platform rows answer it directly";
  else if (completeList) primary = "a complete set from the index answers it";
  else if (journey) primary = "a screen chain was found, though not in the order asked";
  else if (semStrong) primary = `a strong match by meaning (${semTop.toFixed(2)})`;
  else if (approxL.length) primary = `only a fuzzy name match on "${approxL[0].matched_on || "the question"}"`;
  else if (strongDocs.length) primary = "only documents cover it";
  else primary = "nothing matched by name and the matches by meaning are weak";
  const agreeing = [];
  if (strongDocs.length && primary !== "only documents cover it") agreeing.push(plural(strongDocs.length, "document passage"));
  if (source.length) agreeing.push("the source that was read");
  if (screens.length && !primary.includes("screen")) agreeing.push(plural(screens.length, "screen"));
  if (stateAnswered && !primary.includes("live")) agreeing.push("live platform rows");
  const list = (xs) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  const reason = agreeing.length ? `${primary}, confirmed by ${list(agreeing)}` : level === "high" ? primary : `${primary}, and nothing else confirms it`;

  // the one piece that would raise it
  let missing = null;
  if (level !== "high") {
    if (journeyQuestion && !journey) missing = "the screens involved were not matched, so the steps are not read from the dashboard code";
    else if (journeyQuestion && !journeyOrdered) missing = "the screens were matched, but not in the order the question asked";
    else if (exactL.length && (unresolved > 0 || truncated)) missing = "part of the code path could not be followed";
    else if (!strongDocs.length && !stateAnswered) missing = "no document covers this";
    else if (!exactL.length && !source.length && !stateAnswered) missing = "the code was matched only by a fuzzy name, not read";
    else if (unresolved > 0 || truncated) missing = "part of the code path could not be followed";
    else missing = "only one source covers it";
  }
  return { level, reason, ...(missing ? { missing } : {}),
           signals: { exact: exactL.length, approximate: approxL.length, none: noneL.length, journey, journey_in_order: journeyOrdered,
                      documents: strongDocs.length, sources, sem_top: Number(semTop.toFixed(2)), sem_margin: Number(semMargin.toFixed(2)) } };
}
