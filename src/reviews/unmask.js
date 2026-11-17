/**
 * Putting back the words a marketplace's word filter starred out.
 *
 * Tokopedia and Shopee star out any stretch of a review that spells a blocked word, even
 * inside an innocent one and across a space: "cocok" holds "cok" and comes back "co***",
 * "cukup" holds "cuk" and comes back "***up", "darah tinggi" comes back "dara****nggi".
 * The storefront serves the starred text to everyone, us included, so the original is
 * not to be had; it can only be guessed.
 *
 * The guess comes from our own reviews. Every unstarred review is a sample of how buyers
 * write, so a starred stretch becomes the word, or pair of words, that fits it letter for
 * letter and that buyers actually use most, weighed by the words around it. A guess is
 * made only when the letters left visible narrow it down and one answer clearly beats the
 * rest; anything else - a stretch starred end to end, a word nobody else wrote - stays as
 * the marketplace sent it. Nothing is stored: the review keeps the marketplace's text and
 * the guess is made where the text leaves, so a better corpus tomorrow guesses better.
 */

const WORD = /[a-z0-9]+/g;
/** A starred stretch with the letters the filter left either side of it. */
const MASKED = /([A-Za-z0-9]*)(\*+)([A-Za-z0-9]*)/g;

/**
 * Stretches the filters are known to star, read off our own starred reviews: "co***"
 * (cocok), "***up" (cukup), "jel****ntuk" (jelas untuk), "keti****ang" (ketiga yang),
 * "dara****nggi" (darah tinggi). A guess whose starred letters spell one of these is far
 * likelier than one that does not, because the filter had a reason to star it.
 */
export const BLOCKED = new Set(['cok', 'cuk', 'asu', 'gay', 'hti']);
const BLOCKED_BONUS = Math.log(20);
/**
 * A filter stars across a space only when the letters either side spell a blocked word,
 * so a two-word guess whose starred letters spell nothing we know of is a long shot: one
 * word that fits ("ka*****" as "katanya") beats two that happen to ("kami ya").
 */
const ACROSS_SPACE_PENALTY = Math.log(100);

/** Letters the filter must have left visible; "***" alone could be anything. */
export const MIN_VISIBLE = 2;
/** How much likelier the best guess must be than the next, as a ratio. */
export const MARGIN = 2;

const words = (text) => String(text ?? '').toLowerCase().match(WORD) ?? [];

/**
 * How buyers write: how often each word appears, and how often each pair appears side by
 * side, from texts the filter left alone.
 */
export function buildVocab(texts) {
  const unigrams = new Map();
  const bigrams = new Map();
  let total = 0;
  const add = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const text of texts) {
    if (!text || String(text).includes('*')) continue;
    // Pairs only within a run of plain spacing: "darah tinggi", not "darah. Tinggi".
    for (const chunk of String(text).toLowerCase().split(/[^a-z0-9 ]+/)) {
      const ws = chunk.match(WORD) ?? [];
      ws.forEach((w, i) => {
        add(unigrams, w);
        total += 1;
        if (i > 0) add(bigrams, `${ws[i - 1]} ${w}`);
      });
    }
  }
  const byLength = new Map();
  for (const w of unigrams.keys()) {
    if (!/^[a-z]+$/.test(w)) continue;
    const list = byLength.get(w.length) ?? [];
    list.push(w);
    byLength.set(w.length, list);
  }
  return { unigrams, bigrams, total, byLength };
}

/** log P(w): how common a word is. */
const logP = (vocab, w) => Math.log((vocab.unigrams.get(w) ?? 0) / vocab.total);

/** log P(next | prev), leaning on the pair when buyers have written it, on the word when not. */
function logNext(vocab, prev, next) {
  const pair = vocab.bigrams.get(`${prev} ${next}`) ?? 0;
  const prevCount = vocab.unigrams.get(prev) ?? 0;
  const nextCount = vocab.unigrams.get(next) ?? 0;
  const p = 0.7 * (prevCount ? pair / prevCount : 0) + 0.3 * (nextCount / vocab.total);
  return Math.log(p || 1e-9);
}

/** Every word, or pair of words, that fits the stretch letter for letter. */
function candidates(vocab, l, stars, r) {
  const length = l.length + stars + r.length;
  const out = [];
  for (const w of vocab.byLength.get(length) ?? []) {
    if (w.startsWith(l) && w.endsWith(r)) out.push([w]);
  }
  // Starred across a space: the space sits somewhere in the starred letters.
  for (let a = Math.max(l.length, 1); a <= length - r.length - 2; a += 1) {
    const firsts = (vocab.byLength.get(a) ?? []).filter((w) => w.startsWith(l));
    if (!firsts.length) continue;
    const seconds = (vocab.byLength.get(length - a - 1) ?? []).filter((w) => w.endsWith(r));
    for (const w1 of firsts) for (const w2 of seconds) out.push([w1, w2]);
  }
  return out;
}

/**
 * The phrase a starred stretch most likely was, or null when the corpus cannot say.
 * `before` and `after` are the words around it, which weigh the guess.
 */
export function guessMasked(vocab, { left, stars, right, before = '', after = '' }) {
  if (left.length + right.length < MIN_VISIBLE) return null;
  const l = left.toLowerCase();
  const r = right.toLowerCase();
  const scored = [];
  for (const parts of candidates(vocab, l, stars, r)) {
    let score = logP(vocab, parts[0]);
    if (parts[1]) score += logNext(vocab, parts[0], parts[1]);
    if (before) score += logNext(vocab, before, parts[0]);
    if (after) score += logNext(vocab, parts.at(-1), after);
    const phrase = parts.join(' ');
    const starred = phrase.slice(l.length, phrase.length - r.length).replace(/ /g, '');
    const blocked = BLOCKED.has(starred);
    if (blocked) score += BLOCKED_BONUS;
    else if (parts[1]) score -= ACROSS_SPACE_PENALTY;
    // Starred letters that spell nothing we know the filter blocks need a second witness:
    // buyers must have written the guess next to one of the words actually around it.
    const chain = [before, ...parts, after].filter(Boolean);
    const attested = chain.some((w, i) => i > 0 && vocab.bigrams.has(`${chain[i - 1]} ${w}`)
      && (parts.includes(w) || parts.includes(chain[i - 1])));
    scored.push({ phrase, score, sure: blocked || attested });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best.sure) return null;
  if (next && best.score - next.score < Math.log(MARGIN)) return null;
  return best.phrase;
}

/** Keep the capital the buyer typed: "Co***" is "Cocok", not "cocok". */
function fill(left, phrase, right) {
  const middle = phrase.slice(left.length, phrase.length - right.length);
  return `${left}${middle}${right}`;
}

/**
 * The text with every starred stretch the corpus can account for filled back in.
 * Returns the text unchanged when nothing is starred or nothing can be guessed.
 */
export function unmaskText(text, vocab) {
  const source = String(text ?? '');
  if (!source.includes('*') || !vocab) return source;
  return source.replace(MASKED, (whole, left, starRun, right, offset) => {
    const before = words(source.slice(0, offset)).at(-1) ?? '';
    const after = words(source.slice(offset + whole.length))[0] ?? '';
    const phrase = guessMasked(vocab, { left, stars: starRun.length, right, before, after });
    return phrase ? fill(left, phrase, right) : whole;
  });
}

/**
 * One function to hand to an export: builds the corpus once from every review it may see.
 * Buyers' words only - our replies repeat the same few phrases ("kami ya kak") often
 * enough to drown out how buyers actually write.
 */
export function unmaskerFor(reviews) {
  const vocab = buildVocab((reviews ?? []).map((review) => review?.text));
  return (text) => unmaskText(text, vocab);
}
