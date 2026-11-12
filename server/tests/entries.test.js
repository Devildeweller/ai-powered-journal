import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { db } from '../src/db/index.js';
import { jobs } from '../src/services/jobs.js';
import { createUser, fakeLlm, startApp, stopApp, titles } from './helpers.js';

const model = fakeLlm();

let app;
let alice;
let bob;

const SAMPLE = [
  {
    title: 'First 10K',
    entryDate: '2026-01-10',
    mood: 5,
    tags: ['Running', 'health'],
    content: 'Ran my first 10K race along the river this morning. Finished in 58 minutes and my legs are jelly, but I am so proud.',
  },
  {
    title: 'Interview nerves',
    entryDate: '2026-01-14',
    mood: 2,
    tags: ['work'],
    content: 'Had the final interview for the data analyst job at Northwind today. I was nervous and stumbled on the SQL question.',
  },
  {
    title: 'Dinner with Maya',
    entryDate: '2026-01-20',
    mood: 4,
    tags: ['friends'],
    content: 'Maya cooked her famous lasagne and we talked for hours about her move to Lisbon. I will miss her a lot.',
  },
  {
    title: 'Slow Sunday',
    entryDate: '2026-02-01',
    mood: 3,
    tags: ['rest'],
    content: 'Stayed in, read half of a novel, and watered the plants. Quiet day and that was fine.',
  },
];

before(async () => {
  app = await startApp();
  alice = await createUser(app, { name: 'Alice' });
  bob = await createUser(app, { name: 'Bob' });
  for (const entry of SAMPLE) {
    const response = await alice.post('/api/entries').send(entry);
    assert.equal(response.status, 201);
  }
  await jobs.drain();
});
after(stopApp);

const findEntry = async (title) => {
  const response = await alice.get('/api/entries').query({ q: title });
  return response.body.entries.find((entry) => entry.title === title);
};

describe('creating entries', () => {
  it('stores the entry, normalises tags and counts words', async () => {
    const entry = await findEntry('First 10K');
    assert.partialDeepStrictEqual(entry, { entryDate: '2026-01-10', mood: 5, tags: ['running', 'health'] });
    assert.ok(entry.wordCount > 15);
  });

  it('indexes the entry in the background', async () => {
    const entry = await findEntry('First 10K');
    assert.equal(entry.embeddingStatus, 'ready');
    const { rows } = await db.query(
      'SELECT embedding_model, vector_dims(embedding) AS dims FROM entry_chunks WHERE entry_id = $1',
      [entry.id],
    );
    assert.equal(rows.length, 1);
    assert.partialDeepStrictEqual(rows[0], { embedding_model: 'local:hash-v1', dims: 1024 });
  });

  it('splits a long entry into several chunks', async () => {
    const content = Array.from(
      { length: 50 },
      (_, index) => `Thought ${index + 1} of the day was about something specific and worth noting.`,
    ).join(' ');
    const created = await alice.post('/api/entries').send({ title: 'Long ramble', content, entryDate: '2026-02-03' });
    await jobs.drain();
    const { rows } = await db.query('SELECT count(*)::int AS chunks FROM entry_chunks WHERE entry_id = $1', [created.body.entry.id]);
    assert.ok(rows[0].chunks > 1);
    await alice.delete(`/api/entries/${created.body.entry.id}`);
  });

  it('rejects invalid input', async () => {
    assert.equal((await alice.post('/api/entries').send({ content: '   ', entryDate: '2026-01-01' })).status, 422);
    assert.equal((await alice.post('/api/entries').send({ content: 'ok', entryDate: '01/01/2026' })).status, 422);
    assert.equal((await alice.post('/api/entries').send({ content: 'ok', entryDate: '2026-01-01', mood: 9 })).status, 422);
    assert.equal((await alice.get('/api/entries/not-a-uuid')).status, 422);
  });
});

describe('listing entries', () => {
  it('returns newest first with an excerpt instead of the full text', async () => {
    const response = await alice.get('/api/entries');
    assert.deepEqual(titles(response.body.entries), ['Slow Sunday', 'Dinner with Maya', 'Interview nerves', 'First 10K']);
    assert.equal(response.body.entries[0].content, undefined);
    assert.ok(response.body.entries[0].excerpt.includes('Stayed in'));
  });

  it('pages with a keyset cursor', async () => {
    const first = await alice.get('/api/entries').query({ limit: 2 });
    assert.equal(first.body.entries.length, 2);
    assert.equal(typeof first.body.nextCursor, 'string');

    const second = await alice.get('/api/entries').query({ limit: 2, cursor: first.body.nextCursor });
    assert.deepEqual(titles(second.body.entries), ['Interview nerves', 'First 10K']);
    assert.equal(second.body.nextCursor, null);

    assert.equal((await alice.get('/api/entries').query({ cursor: 'garbage' })).status, 400);
  });

  it('filters by tag, mood, date range and text', async () => {
    assert.deepEqual(titles((await alice.get('/api/entries').query({ tag: 'work' })).body.entries), ['Interview nerves']);
    assert.deepEqual(titles((await alice.get('/api/entries').query({ mood: 5 })).body.entries), ['First 10K']);
    assert.deepEqual(titles((await alice.get('/api/entries').query({ from: '2026-01-12', to: '2026-01-31' })).body.entries), [
      'Dinner with Maya',
      'Interview nerves',
    ]);
    // Partial word, matched by substring.
    assert.deepEqual(titles((await alice.get('/api/entries').query({ q: 'lasag' })).body.entries), ['Dinner with Maya']);
    // Different word form, matched by full-text stemming ("watering" -> "watered").
    assert.deepEqual(titles((await alice.get('/api/entries').query({ q: 'watering plants' })).body.entries), ['Slow Sunday']);
  });

  it('lists tags with counts', async () => {
    const response = await alice.get('/api/entries/tags');
    assert.ok(response.body.tags.some((item) => item.tag === 'running' && item.count === 1));
  });
});

describe('semantic search', () => {
  it('ranks the matching entry first', async () => {
    const response = await alice.get('/api/entries/search').query({ q: 'how did my job interview go' });
    assert.equal(response.status, 200);
    assert.equal(response.body.results[0].title, 'Interview nerves');
    assert.ok(response.body.results[0].similarity > 0);
  });

  it('finds an entry by a distinctive word', async () => {
    const response = await alice.get('/api/entries/search').query({ q: 'Lisbon' });
    assert.equal(response.body.results[0].title, 'Dinner with Maya');
  });

  it('suggests related entries', async () => {
    const created = await alice
      .post('/api/entries')
      .send({ title: 'Easy jog', entryDate: '2026-02-05', content: 'Short easy run along the river this morning, legs felt fresh after the race.' });
    await jobs.drain();
    const response = await alice.get(`/api/entries/${created.body.entry.id}/related`);
    assert.equal(response.body.related[0].title, 'First 10K');
    await alice.delete(`/api/entries/${created.body.entry.id}`);
  });
});

describe('updating and deleting', () => {
  it('re-indexes when the text changes', async () => {
    const created = await alice
      .post('/api/entries')
      .send({ title: 'Draft', content: 'Thinking about pottery classes.', entryDate: '2026-02-06' });
    await jobs.drain();
    const id = created.body.entry.id;

    const updated = await alice.patch(`/api/entries/${id}`).send({ content: 'Signed up for a ceramics workshop on Saturdays.' });
    assert.equal(updated.body.entry.embeddingStatus, 'pending');
    await jobs.drain();

    const { rows } = await db.query('SELECT content FROM entry_chunks WHERE entry_id = $1', [id]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].content.includes('ceramics'));
    assert.equal((await alice.get(`/api/entries/${id}`)).body.entry.embeddingStatus, 'ready');

    // Saving identical content leaves the index alone.
    const same = await alice.patch(`/api/entries/${id}`).send({ content: 'Signed up for a ceramics workshop on Saturdays.' });
    assert.equal(same.body.entry.embeddingStatus, 'ready');

    assert.equal((await alice.delete(`/api/entries/${id}`)).status, 204);
    const remaining = await db.query('SELECT 1 FROM entry_chunks WHERE entry_id = $1', [id]);
    assert.equal(remaining.rows.length, 0);
    assert.equal((await alice.get(`/api/entries/${id}`)).status, 404);
  });
});

describe('tenant isolation', () => {
  it("never exposes one user's entries to another", async () => {
    const entry = await findEntry('Interview nerves');

    assert.equal((await bob.get('/api/entries')).body.entries.length, 0);
    assert.equal((await bob.get(`/api/entries/${entry.id}`)).status, 404);
    assert.equal((await bob.patch(`/api/entries/${entry.id}`).send({ title: 'hijacked' })).status, 404);
    assert.equal((await bob.delete(`/api/entries/${entry.id}`)).status, 404);
    assert.equal((await bob.get(`/api/entries/${entry.id}/related`)).body.related.length, 0);
    assert.equal((await bob.get('/api/entries/search').query({ q: 'job interview Northwind' })).body.results.length, 0);

    assert.equal((await alice.get(`/api/entries/${entry.id}`)).body.entry.title, 'Interview nerves');
  });
});

describe('insights', () => {
  it('summarises the journal', async () => {
    const response = await alice.get('/api/insights').query({ today: '2026-02-01' });
    assert.equal(response.status, 200);
    assert.equal(response.body.totals.entries, 4);
    assert.deepEqual(response.body.streak, { current: 1, longest: 1 });
    assert.equal(response.body.daily.length, 4);
    assert.equal(response.body.moodDistribution.find((bucket) => bucket.mood === 5).count, 1);
  });
});

describe('memory extraction from entries', () => {
  it('saves what the model decides is worth remembering', async () => {
    model.extractWith([
      { action: 'add', existing_memory: null, content: 'The user is training for a half marathon in April 2026.', category: 'goal', importance: 4 },
    ]);
    const created = await alice.post('/api/entries').send({
      title: 'Signed up',
      entryDate: '2026-02-07',
      content: 'I finally signed up for the half marathon in April. Twelve weeks of training start on Monday.',
    });
    await jobs.drain();

    const { memories } = (await alice.get('/api/memories')).body;
    assert.equal(memories.length, 1);
    assert.partialDeepStrictEqual(memories[0], {
      category: 'goal',
      importance: 4,
      sourceType: 'entry',
      sourceEntryId: created.body.entry.id,
    });

    const { prompt } = model.lastExtractionRequest();
    assert.ok(prompt.includes('journal entry dated 2026-02-07'));
    assert.ok(prompt.includes('half marathon'));
  });
});
