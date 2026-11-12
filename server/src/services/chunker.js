/**
 * Splits a journal entry into overlapping chunks for embedding.
 *
 * Why chunk at all: one embedding for a long entry averages every topic in it
 * into a single vector, so a question about one paragraph matches poorly.
 * Chunks of roughly 180 words keep each vector about one thing.
 *
 * The splitter respects paragraph and sentence boundaries, and repeats the
 * last sentence of a chunk at the start of the next one so a thought that
 * straddles the boundary is still retrievable from either side.
 */

const DEFAULTS = { targetWords: 180, maxWords: 260, overlapSentences: 1 };

const countWords = (text) => (text.match(/\S+/g) ?? []).length;

function splitSentences(paragraph) {
  // Break after ., ! or ? (optionally followed by a closing quote/bracket) when
  // the next sentence starts with a capital letter, digit or opening quote.
  return paragraph
    .split(/(?<=[.!?]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** A "sentence" longer than maxWords (no punctuation, pasted text) is cut by word count. */
function hardSplit(sentence, maxWords) {
  const words = sentence.split(/\s+/);
  const pieces = [];
  for (let start = 0; start < words.length; start += maxWords) {
    pieces.push(words.slice(start, start + maxWords).join(' '));
  }
  return pieces;
}

export function chunkText(text, options = {}) {
  const { targetWords, maxWords, overlapSentences } = { ...DEFAULTS, ...options };
  const normalised = text.replace(/\r\n/g, '\n').trim();
  if (!normalised) return [];
  if (countWords(normalised) <= maxWords) return [normalised];

  // Units are sentences, tagged with whether they open a new paragraph.
  const units = [];
  for (const paragraph of normalised.split(/\n\s*\n/)) {
    const sentences = splitSentences(paragraph.replace(/\s*\n\s*/g, ' ').trim());
    sentences.forEach((sentence, index) => {
      const pieces = countWords(sentence) > maxWords ? hardSplit(sentence, maxWords) : [sentence];
      pieces.forEach((piece, pieceIndex) => {
        units.push({ text: piece, words: countWords(piece), paragraphStart: index === 0 && pieceIndex === 0 });
      });
    });
  }

  const chunks = [];
  let current = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(render(current));
    const overlap = overlapSentences > 0 ? current.slice(-overlapSentences).filter((unit) => unit.words <= 60) : [];
    current = overlap.map((unit) => ({ ...unit, paragraphStart: false, carried: true }));
    currentWords = current.reduce((sum, unit) => sum + unit.words, 0);
  };

  for (const unit of units) {
    const wouldExceedMax = currentWords + unit.words > maxWords;
    const reachedTarget = currentWords >= targetWords;
    // Prefer to break at a paragraph boundary once the chunk is reasonably full.
    const softBreak = unit.paragraphStart && currentWords >= targetWords * 0.6;
    if (current.some((item) => !item.carried) && (wouldExceedMax || reachedTarget || softBreak)) flush();
    current.push(unit);
    currentWords += unit.words;
  }
  // Emit the tail only if it holds something that is not just carried overlap.
  if (current.some((unit) => !unit.carried)) chunks.push(render(current));

  return chunks;
}

function render(units) {
  let output = '';
  units.forEach((unit, index) => {
    if (index > 0) output += unit.paragraphStart ? '\n\n' : ' ';
    output += unit.text;
  });
  return output;
}

/**
 * Text prepended to each chunk before embedding (not stored in the chunk).
 * A bare chunk such as "It went better than expected." carries no hint of
 * when or what it is about; the header puts date, title and tags into the
 * vector so "how did the interview go in December" can find it.
 */
export function buildChunkHeader({ entryDate, title, tags, mood }) {
  const parts = [`Journal entry dated ${entryDate}`];
  if (title) parts.push(`titled "${title}"`);
  let header = parts.join(', ');
  if (tags?.length) header += `. Tags: ${tags.join(', ')}`;
  if (mood) header += `. Mood: ${mood}/5`;
  return `${header}.`;
}
