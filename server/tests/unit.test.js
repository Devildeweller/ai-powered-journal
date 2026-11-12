import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInput, isSmallTalk, titleFromMessage } from '../src/services/chat.js';
import { buildChunkHeader, chunkText } from '../src/services/chunker.js';
import { EMBEDDING_DIM, localEmbed } from '../src/services/embeddings.js';
import { computeStreaks } from '../src/services/insights.js';
import { scoreMemory } from '../src/services/memory.js';
import { buildKeywordQuery, reciprocalRankFusion } from '../src/services/retrieval.js';
import { addDays, diffDays, isIsoDate, parseDateRange } from '../src/utils/temporal.js';

const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const words = (text) => text.split(/\s+/).filter(Boolean).length;
const closeTo = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);

describe('chunkText', () => {
  it('keeps a short entry as a single chunk', () => {
    assert.deepEqual(chunkText('Went for a walk. It was nice.'), ['Went for a walk. It was nice.']);
  });

  it('returns nothing for blank text', () => {
    assert.deepEqual(chunkText('   \n  '), []);
  });

  it('splits long text into bounded chunks that overlap by one sentence', () => {
    const sentences = Array.from(
      { length: 60 },
      (_, index) => `Sentence number ${index + 1} talks about topic ${index + 1} in a few plain words.`,
    );
    const chunks = chunkText(sentences.join(' '));

    assert.ok(chunks.length > 2);
    // maxWords plus the one carried-over sentence.
    chunks.forEach((chunk) => assert.ok(words(chunk) <= 260 + 15, `chunk has ${words(chunk)} words`));
    // Every sentence survives chunking.
    sentences.forEach((sentence) => assert.ok(chunks.some((chunk) => chunk.includes(sentence))));
    // The last sentence of a chunk opens the next one.
    const lastOfFirst = chunks[0].match(/Sentence number \d+ [^.]+\.$/)[0];
    assert.ok(chunks[1].startsWith(lastOfFirst));
  });

  it('prefers to break between paragraphs', () => {
    const paragraph = (topic) => Array.from({ length: 12 }, (_, index) => `The ${topic} thought number ${index + 1} goes right here.`).join(' ');
    const chunks = chunkText([paragraph('morning'), paragraph('evening'), paragraph('night')].join('\n\n'));
    assert.ok(chunks.length >= 2);
    assert.ok(chunks[0].endsWith('The morning thought number 12 goes right here.') || chunks[0].includes('evening'));
  });

  it('hard-splits text that has no sentence boundaries', () => {
    const chunks = chunkText(Array.from({ length: 700 }, (_, index) => `word${index}`).join(' '));
    assert.ok(chunks.length >= 3);
    chunks.forEach((chunk) => assert.ok(words(chunk) <= 260));
  });

  it('describes the entry in the embedding header', () => {
    assert.equal(
      buildChunkHeader({ entryDate: '2025-12-06', title: 'Pixel', tags: ['dog'], mood: 5 }),
      'Journal entry dated 2025-12-06, titled "Pixel". Tags: dog. Mood: 5/5.',
    );
  });
});

describe('parseDateRange', () => {
  const today = '2026-02-18'; // a Wednesday

  const cases = [
    ['what did I do today?', '2026-02-18', '2026-02-18'],
    ['how was yesterday', '2026-02-17', '2026-02-17'],
    ['summarise this week', '2026-02-16', '2026-02-18'],
    ['what happened last week?', '2026-02-09', '2026-02-15'],
    ['over the past week I felt off', '2026-02-12', '2026-02-18'],
    ['anything from the last 3 days', '2026-02-16', '2026-02-18'],
    ['in the past two weeks', '2026-02-05', '2026-02-18'],
    ['how was this month', '2026-02-01', '2026-02-18'],
    ['what about last month', '2026-01-01', '2026-01-31'],
    ['how did December go', '2025-12-01', '2025-12-31'],
    ['what did I write in January 2026', '2026-01-01', '2026-01-31'],
    ['my mood last weekend', '2026-02-14', '2026-02-15'],
    ['how have I been lately', '2026-02-05', '2026-02-18'],
  ];
  for (const [text, from, to] of cases) {
    it(`understands "${text}"`, () => {
      assert.partialDeepStrictEqual(parseDateRange(text, today), { from, to });
    });
  }

  it('returns null when no time is mentioned', () => {
    assert.equal(parseDateRange('how do I feel about my job?', today), null);
  });

  it('does not mistake the verb "may" for the month', () => {
    assert.equal(parseDateRange('I may quit running', today), null);
    assert.partialDeepStrictEqual(parseDateRange('what happened in May', today), { from: '2025-05-01', to: '2025-05-31' });
  });
});

describe('date helpers', () => {
  it('adds and diffs days across month boundaries', () => {
    assert.equal(addDays('2026-02-27', 3), '2026-03-02');
    assert.equal(diffDays('2026-03-02', '2026-02-27'), 3);
  });

  it('validates ISO dates', () => {
    assert.equal(isIsoDate('2026-02-18'), true);
    assert.equal(isIsoDate('18/02/2026'), false);
    assert.equal(isIsoDate('2026-13-40'), false);
  });
});

describe('reciprocalRankFusion', () => {
  it('ranks items found by both retrievers above items found by one', () => {
    const scores = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'a', 'd'],
    ]);
    const ranked = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    assert.deepEqual(ranked.slice(0, 2).sort(), ['a', 'c']);
    closeTo(scores.get('a'), 1 / 61 + 1 / 62);
    closeTo(scores.get('d'), 1 / 63);
  });
});

describe('buildKeywordQuery', () => {
  it('ORs the meaningful words and drops stopwords', () => {
    assert.equal(buildKeywordQuery('How did the interview at Google go?'), 'interview | google | go');
  });

  it('is empty when nothing meaningful remains', () => {
    assert.equal(buildKeywordQuery('what is it?'), '');
  });
});

describe('localEmbed', () => {
  it('returns unit vectors of the configured dimension', () => {
    const vector = localEmbed('Ran five kilometres along the river this morning.');
    assert.equal(vector.length, EMBEDDING_DIM);
    closeTo(Math.sqrt(cosine(vector, vector)), 1, 1e-3);
  });

  it('places texts with shared vocabulary closer together', () => {
    const run = localEmbed('Morning run by the river, five kilometres, legs felt strong.');
    const similar = localEmbed('Another run along the river today, kilometres flew by.');
    const different = localEmbed('Quarterly budget review meeting with the finance team.');
    assert.ok(cosine(run, similar) > cosine(run, different));
  });
});

describe('computeStreaks', () => {
  it('counts the current and longest runs', () => {
    const days = ['2026-02-18', '2026-02-17', '2026-02-16', '2026-02-10', '2026-02-09', '2026-02-08', '2026-02-07'];
    assert.deepEqual(computeStreaks(days, '2026-02-18'), { current: 3, longest: 4 });
  });

  it('keeps a streak alive until the end of the following day', () => {
    assert.equal(computeStreaks(['2026-02-17', '2026-02-16'], '2026-02-18').current, 2);
    assert.equal(computeStreaks(['2026-02-16', '2026-02-15'], '2026-02-18').current, 0);
  });

  it('handles an empty journal', () => {
    assert.deepEqual(computeStreaks([], '2026-02-18'), { current: 0, longest: 0 });
  });
});

describe('scoreMemory', () => {
  const now = Date.parse('2026-02-18T00:00:00Z');

  it('prefers similar, important and recent memories', () => {
    const base = { similarity: 0.6, importance: 3, updatedAt: '2026-02-01T00:00:00Z' };
    assert.ok(scoreMemory({ ...base, similarity: 0.8 }, now) > scoreMemory(base, now));
    assert.ok(scoreMemory({ ...base, importance: 5 }, now) > scoreMemory(base, now));
    assert.ok(scoreMemory({ ...base, updatedAt: '2025-02-01T00:00:00Z' }, now) < scoreMemory(base, now));
  });
});

describe('chat helpers', () => {
  it('recognises small talk', () => {
    assert.equal(isSmallTalk('Hey!'), true);
    assert.equal(isSmallTalk('thanks'), true);
    assert.equal(isSmallTalk('hey, how did my interview go?'), false);
  });

  it('builds a short conversation title', () => {
    assert.equal(titleFromMessage('How was my week?'), 'How was my week?');
    const long = titleFromMessage('Can you look through everything I wrote about my job search and tell me what changed over time?');
    assert.ok(long.length <= 61);
    assert.ok(long.endsWith('…'));
  });

  it('builds one input: transcript without old citations, then context, then the new message', () => {
    const history = [
      { role: 'assistant', content: 'orphan answer' },
      { role: 'user', content: 'first question' },
      // Both citation styles the model produces: "[1][3]" and the combined "[2, 4]".
      { role: 'assistant', content: 'You mentioned it on 6 December [1][3]. It went well [2, 4].' },
    ];
    assert.equal(
      buildInput(history, '<context>ctx</context>', 'follow up'),
      [
        '<conversation_so_far>',
        'User: first question',
        '',
        'Assistant: You mentioned it on 6 December. It went well.',
        '</conversation_so_far>',
        '',
        '<context>ctx</context>',
        '',
        'follow up',
      ].join('\n'),
    );
  });

  it('omits the transcript on the first message of a conversation', () => {
    assert.equal(buildInput([], '<context>ctx</context>', 'hello there'), '<context>ctx</context>\n\nhello there');
  });

  it('drops the oldest turns when the history is very long', () => {
    const history = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn ${index} ${'x'.repeat(2000)}` }));
    const input = buildInput(history, '<context>ctx</context>', 'latest');
    assert.ok(!input.includes('turn 0 '));
    assert.ok(input.includes('turn 39 '));
    assert.ok(input.length < 30_000);
  });
});
