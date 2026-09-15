// Follow-up questions. "And for RIL?" or "show me that template" mean nothing on their own; inside a chat they
// mean something exact. When a question leans on the conversation, one minimal-effort model call rewrites it
// into a standalone question using ONLY what earlier turns made explicit. The rewrite is what gets planned,
// retrieved and cached; the original stays what the person sees.
import { chat } from "./llm.mjs";

const LEADS = /^(and|also|what about|how about|then|so|but|now|ok(ay)?,?|next|same for|again)\b/i;
const ANAPHORA = /\b(that|this|it|its|those|these|them|same|also|too|again|above|previous|earlier|last one|the other|instead|as well|and for|what about|how about|more detail|elaborate|expand|drill|deeper|which one|the second|the first)\b/i;

/** Does this question need the conversation to be understood? Cheap heuristic; the rewrite call confirms. */
export function needsContext(question) {
  const qn = String(question || "").trim();
  if (!qn) return false;
  const words = qn.split(/\s+/).length;
  if (LEADS.test(qn)) return true;
  if (words <= 6) return true;
  return words <= 22 && ANAPHORA.test(qn);
}

const SYSTEM = `You rewrite a follow-up question into a standalone question using the conversation so far.
Rules:
- Keep the person's intent exactly. Resolve "that", "it", "the same", "and for X" from the conversation.
- Add ONLY names the conversation makes explicit (screens, templates, companies, branches, features, code names). Never add assumptions, opinions or answers.
- If the question already stands on its own, return it unchanged and set used_history false.
- One sentence, under 60 words, no preamble.
Output JSON only: {"standalone": "...", "used_history": true|false}`;

export async function resolveFollowUp({ question, history }) {
  if (!Array.isArray(history) || !history.length) return { standalone: question, used_history: false };
  const messages = [{ role: "system", content: SYSTEM },
                    { role: "user", content: `CONVERSATION (oldest first):\n${JSON.stringify(history, null, 0).slice(0, 6000)}\n\nQUESTION: ${question}` }];
  const r = await chat({ messages, max_tokens: 220, temperature: 0, reasoning_effort: "minimal" });
  const m = /\{[\s\S]*\}/.exec(r?.content || "");
  if (!m) return { standalone: question, used_history: false };
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return { standalone: question, used_history: false }; }
  const s = String(parsed.standalone || "").replace(/\s+/g, " ").trim();
  if (!parsed.used_history || s.length < 3 || s.length > 400 || s.toLowerCase() === question.trim().toLowerCase()) return { standalone: question, used_history: false };
  return { standalone: s, used_history: true };
}

/** The rule the answer model gets whenever a conversation is attached to the facts. */
export const CONVERSATION_RULE = `- "conversation" is what was asked and answered earlier in this chat. It is context for what the person means, never evidence:
  do not restate earlier answers as facts, do not cite it, and if the question says "that" or "it", it refers to the conversation's last subject.`;
