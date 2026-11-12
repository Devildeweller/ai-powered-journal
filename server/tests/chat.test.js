import './setup.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { jobs } from '../src/services/jobs.js';
import { LlmError } from '../src/services/llm.js';
import { createUser, fakeLlm, parseSse, startApp, stopApp, titles } from './helpers.js';

const model = fakeLlm();
const lastInput = () => model.lastChatRequest().input;

let app;
let alice;
let bob;

before(async () => {
  app = await startApp();
  alice = await createUser(app, { name: 'Alice' });
  bob = await createUser(app, { name: 'Bob' });

  const entries = [
    {
      title: 'Adopted Pixel',
      entryDate: '2026-01-06',
      mood: 5,
      tags: ['pixel'],
      content: 'We adopted a beagle puppy from the shelter today and named her Pixel. She fell asleep on my shoes.',
    },
    {
      title: 'Interview nerves',
      entryDate: '2026-02-10',
      mood: 2,
      tags: ['work'],
      content: 'Final interview for the analyst job at Northwind. I was nervous and stumbled on the SQL question.',
    },
    {
      title: 'Offer!',
      entryDate: '2026-02-13',
      mood: 5,
      tags: ['work'],
      content: 'Northwind called with an offer. I start in March. Celebrated with Maya over dumplings.',
    },
  ];
  for (const entry of entries) await alice.post('/api/entries').send(entry);
  await bob.post('/api/entries').send({ title: 'Bob secret', entryDate: '2026-02-11', content: 'Bob wrote about his interview at Contoso.' });
  await jobs.drain();
});
after(stopApp);
beforeEach(() => model.reset());

async function ask(user, body) {
  const response = await user.post('/api/chat').send({ today: '2026-02-18', ...body });
  const isStream = response.headers['content-type']?.includes('event-stream');
  const events = isStream ? parseSse(response.text) : [];
  return { response, events, sources: events.find((event) => event.event === 'sources')?.data };
}

describe('POST /api/chat', () => {
  let conversationId;

  it('retrieves relevant entries, streams the answer and stores the exchange', async () => {
    model.answerWith('The interview on 10 February felt rough [1], but you got the offer.');
    const { response, events, sources } = await ask(alice, { message: 'How did my job interview at Northwind go?' });

    assert.equal(response.status, 200);
    assert.ok(response.headers['content-type'].includes('text/event-stream'));
    assert.deepEqual(
      events.map((event) => event.event),
      ['conversation', 'status', 'sources', 'status', 'delta', 'delta', 'done'],
    );

    const opened = events[0].data;
    assert.equal(opened.isNew, true);
    assert.equal(opened.conversation.title, 'How did my job interview at Northwind go?');
    conversationId = opened.conversation.id;

    // Retrieval put the right entries in front of the model, and only this user's.
    assert.equal(sources.entries[0].title, 'Interview nerves');
    assert.ok(!titles(sources.entries).includes('Bob secret'));

    const prompt = lastInput();
    assert.ok(prompt.includes('<today>2026-02-18, Wednesday</today>'));
    assert.ok(prompt.includes('Name: Alice. Journal: 3 entries from 2026-01-06 to 2026-02-13.'));
    assert.ok(prompt.includes('stumbled on the SQL question'));
    assert.ok(!prompt.includes('Contoso'));
    assert.ok(prompt.endsWith('How did my job interview at Northwind go?'));
    assert.ok(model.lastChatRequest().system.includes('You are Inkwell'));

    const streamed = events
      .filter((event) => event.event === 'delta')
      .map((event) => event.data.text)
      .join('');
    const done = events.at(-1).data.message;
    assert.equal(streamed, done.content);
    assert.equal(done.sources.entries[0].title, 'Interview nerves');
    assert.equal(done.meta.model, 'fake-model');

    const stored = await alice.get(`/api/conversations/${conversationId}`);
    assert.deepEqual(
      stored.body.messages.map((message) => message.role),
      ['user', 'assistant'],
    );
  });

  it('sends earlier turns as history on a follow-up', async () => {
    model.answerWith('You start in March.');
    const { events } = await ask(alice, { message: 'And when do I start?', conversationId });

    assert.equal(events[0].data.isNew, false);
    // Earlier turns travel as a transcript; citation markers from the previous answer are not replayed.
    assert.ok(
      lastInput().startsWith(
        '<conversation_so_far>\nUser: How did my job interview at Northwind go?\n\nAssistant: The interview on 10 February felt rough, but you got the offer.\n</conversation_so_far>',
      ),
    );
    assert.ok(lastInput().endsWith('And when do I start?'));
    // The short follow-up was searched together with the previous question.
    assert.ok(lastInput().includes('Northwind called with an offer'));

    const stored = await alice.get(`/api/conversations/${conversationId}`);
    assert.equal(stored.body.messages.length, 4);
  });

  it('restricts retrieval to the dates a question mentions', async () => {
    model.answerWith('Last week you had the interview and then the offer.');
    const { sources } = await ask(alice, { message: 'What happened last week?' });

    assert.partialDeepStrictEqual(sources.range, { from: '2026-02-09', to: '2026-02-15' });
    assert.deepEqual(titles(sources.entries), ['Interview nerves', 'Offer!']);
    assert.ok(lastInput().includes('Only entries dated 2026-02-09 to 2026-02-15 (last week) were searched: 2 found.'));
    assert.ok(!lastInput().includes('Pixel'));
  });

  it('skips the journal search for small talk', async () => {
    model.answerWith('Hi Alice!');
    const { sources } = await ask(alice, { message: 'hey!' });
    assert.equal(sources.entries.length, 0);
  });

  it('reports model failures as an error event and stores no answer', async () => {
    model.streamChat.mock.mockImplementationOnce(async () => {
      throw new LlmError('The AI service is rate limited right now.');
    });
    const { events } = await ask(alice, { message: 'Tell me about Pixel the beagle' });

    assert.deepEqual(events.at(-1), { event: 'error', data: { message: 'The AI service is rate limited right now.' } });
    const stored = await alice.get(`/api/conversations/${events[0].data.conversation.id}`);
    assert.deepEqual(
      stored.body.messages.map((message) => message.role),
      ['user'],
    );
  });

  it('hides internal error details from the client', async () => {
    model.streamChat.mock.mockImplementationOnce(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
    });
    const { events } = await ask(alice, { message: 'Tell me about Pixel the beagle' });
    assert.equal(events.at(-1).data.message, 'Something went wrong while answering. Please try again.');
  });

  it('validates the request before opening a stream', async () => {
    assert.equal((await ask(alice, { message: '   ' })).response.status, 422);
    assert.equal((await ask(bob, { message: 'hello there friend', conversationId })).response.status, 404);
    assert.equal(model.streamChat.mock.callCount(), 0);
  });
});

describe('long-term memory', () => {
  it('extracts a memory from a chat and recalls it in a brand-new conversation', async () => {
    model.answerWith('That sounds exciting. Lisbon is lovely in spring.');
    model.extractWith([
      {
        action: 'add',
        existing_memory: null,
        content: 'The user plans to move to Lisbon in spring 2026 with their partner Sam.',
        category: 'goal',
        importance: 5,
      },
    ]);
    await ask(alice, { message: 'Sam and I decided we are moving to Lisbon this spring. I am thrilled but nervous.' });
    await jobs.drain();

    const extraction = model.lastExtractionRequest();
    assert.ok(extraction.prompt.includes('moving to Lisbon'));
    assert.ok(extraction.prompt.includes('(none yet)'));

    const { memories } = (await alice.get('/api/memories')).body;
    assert.equal(memories.length, 1);
    assert.partialDeepStrictEqual(memories[0], { category: 'goal', importance: 5, sourceType: 'chat' });

    // A different conversation, with no shared history, still knows.
    model.answerWith('Portuguese lessons would be a good start.');
    const { sources } = await ask(alice, { message: 'What should I be preparing for in the coming months?' });
    assert.ok(!lastInput().includes('<conversation_so_far>'));
    assert.ok(lastInput().includes('- (goal) The user plans to move to Lisbon in spring 2026 with their partner Sam.'));
    assert.equal(sources.memories.length, 1);

    // Memories are private to their owner.
    model.answerWith('Hello Bob.');
    await ask(bob, { message: 'What should I be preparing for in the coming months?' });
    assert.ok(!lastInput().includes('Lisbon'));
  });

  it('updates and retires existing memories instead of duplicating them', async () => {
    model.answerWith('Noted, summer it is.');
    model.extractWith([
      {
        action: 'update',
        existing_memory: 1,
        content: 'The user plans to move to Lisbon in summer 2026 (postponed from spring) with their partner Sam.',
        category: 'goal',
        importance: 5,
      },
    ]);
    await ask(alice, { message: 'Small change of plans: the Lisbon move with Sam is postponed to summer.' });
    await jobs.drain();

    // The model was shown the existing memory, numbered.
    assert.match(model.lastExtractionRequest().prompt, /1\. \[goal, importance 5\] The user plans to move to Lisbon in spring/);

    let { memories } = (await alice.get('/api/memories')).body;
    assert.equal(memories.length, 1);
    assert.ok(memories[0].content.includes('summer 2026'));

    model.answerWith('I am sorry to hear that.');
    model.extractWith([{ action: 'delete', existing_memory: 1, content: '', category: 'goal', importance: 1 }]);
    await ask(alice, { message: 'Actually we cancelled the Lisbon move with Sam entirely, we are staying put.' });
    await jobs.drain();

    ({ memories } = (await alice.get('/api/memories')).body);
    assert.equal(memories.length, 0);
  });

  it('ignores operations that point at memories the model was never shown', async () => {
    model.answerWith('Okay.');
    model.extractWith([
      { action: 'update', existing_memory: 7, content: 'The user owns a boat.', category: 'other', importance: 3 },
      { action: 'delete', existing_memory: 9, content: '', category: 'other', importance: 1 },
    ]);
    await ask(alice, { message: 'Just rambling about nothing in particular this evening, honestly.' });
    await jobs.drain();
    assert.equal((await alice.get('/api/memories')).body.memories.length, 0);
  });

  it('survives a failing extraction without affecting the chat', async () => {
    model.answerWith('Got it.');
    model.generateStructured.mock.mockImplementationOnce(async () => {
      throw new LlmError('boom');
    });
    const { events } = await ask(alice, { message: 'Remember that my sister Priya visits every August.' });
    await jobs.drain();
    assert.equal(events.at(-1).event, 'done');
  });
});

describe('memories API', () => {
  it('supports manual create, update, filter and delete, scoped to the owner', async () => {
    const created = await alice.post('/api/memories').send({ content: 'The user is vegetarian.', category: 'preference', importance: 4 });
    assert.equal(created.status, 201);
    const { id } = created.body.memory;
    assert.equal(created.body.memory.sourceType, 'manual');

    assert.equal((await alice.get('/api/memories').query({ category: 'preference' })).body.memories.length, 1);
    assert.equal((await alice.get('/api/memories').query({ category: 'work' })).body.memories.length, 0);
    assert.equal((await bob.get('/api/memories')).body.memories.length, 0);

    assert.equal((await bob.patch(`/api/memories/${id}`).send({ importance: 1 })).status, 404);
    const updated = await alice.patch(`/api/memories/${id}`).send({ content: 'The user is vegan.', importance: 5 });
    assert.partialDeepStrictEqual(updated.body.memory, { content: 'The user is vegan.', importance: 5, category: 'preference' });

    assert.equal((await alice.post('/api/memories').send({ content: 'x' })).status, 422);
    assert.equal((await bob.delete(`/api/memories/${id}`)).status, 404);
    assert.equal((await alice.delete(`/api/memories/${id}`)).status, 204);
  });
});

describe('conversations API', () => {
  it('lists, renames and deletes conversations for their owner only', async () => {
    const list = await alice.get('/api/conversations');
    assert.ok(list.body.conversations.length > 2);
    const { id } = list.body.conversations[0];

    assert.equal((await bob.get(`/api/conversations/${id}`)).status, 404);
    assert.ok(!(await bob.get('/api/conversations')).body.conversations.some((conversation) => conversation.id === id));

    const renamed = await alice.patch(`/api/conversations/${id}`).send({ title: 'Renamed' });
    assert.equal(renamed.body.conversation.title, 'Renamed');

    assert.equal((await alice.delete(`/api/conversations/${id}`)).status, 204);
    assert.equal((await alice.get(`/api/conversations/${id}`)).status, 404);
  });
});
