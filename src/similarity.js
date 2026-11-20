// Lexical similarity used for duplicate *hints*.
//
// This is deliberately simple (TF-IDF cosine over stemmed unigrams + bigrams,
// zero dependencies). It is not the judge of whether two ideas are the same —
// the agent holding the turn is. It only decides which cards are shown first
// and when the board asks "are you sure this is different?".

const STOP = new Set(
  `a an the of to in on for and or with by is are be been as at from that this these those it its
   into via using use used show shows prove proof proving approach idea try trying attempt we i you
   can could would should may might must will if then so not no any all each both than which such
   over under between about there their them they our your also only just more most some one two
   new first second next step steps method way based directly instead rather whether while where
   when what how why does do did done get gets got make makes made find finds found work works`
    .split(/\s+/)
    .filter(Boolean),
);

function stem(word) {
  if (word.length <= 4) return word;
  return word
    .replace(/ies$/, 'y')
    .replace(/(ization|isation)$/, 'ize')
    .replace(/(ations|ation)$/, 'ate')
    .replace(/(ically|ical)$/, 'ic')
    .replace(/(ing|ed|es|s|ly)$/, '');
}

export function tokenize(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
    .filter((w) => w.length > 1 && !STOP.has(w));
  const out = words.slice();
  for (let i = 0; i < words.length - 1; i++) out.push(`${words[i]}_${words[i + 1]}`);
  return out;
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Rank documents by similarity to a query.
 * @param {string} query
 * @param {{id: string, text: string}[]} docs
 * @returns {{id: string, score: number}[]} sorted, best first; score in [0, 1]
 */
export function rank(query, docs) {
  if (!docs.length) return [];
  const qtf = termFreq(tokenize(query));
  const dtfs = docs.map((d) => termFreq(tokenize(d.text)));
  const df = new Map();
  for (const tf of [qtf, ...dtfs]) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = dtfs.length + 1;
  const weight = (tf) => {
    const w = new Map();
    let norm = 0;
    for (const [t, f] of tf) {
      const idf = Math.log(1 + n / df.get(t));
      const v = (1 + Math.log(f)) * idf;
      w.set(t, v);
      norm += v * v;
    }
    return { w, norm: Math.sqrt(norm) };
  };
  const q = weight(qtf);
  return docs
    .map((d, i) => {
      const dv = weight(dtfs[i]);
      if (!q.norm || !dv.norm) return { id: d.id, score: 0 };
      let dot = 0;
      for (const [t, v] of q.w) {
        const o = dv.w.get(t);
        if (o) dot += v * o;
      }
      return { id: d.id, score: dot / (q.norm * dv.norm) };
    })
    .sort((a, b) => b.score - a.score);
}

export function similarity(a, b) {
  return rank(a, [{ id: 'b', text: b }])[0].score;
}
