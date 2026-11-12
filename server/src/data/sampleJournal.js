/**
 * A deterministic sample journal: 120 entries, one per day from 2025-11-01 to
 * 2026-02-28, written by a fictional junior developer.
 *
 * Twenty "anchor" entries state specific facts (a dog's name, a race time, an
 * argument).  Each has a question in EVAL_QUERIES whose correct answer is that
 * entry, which is what the retrieval benchmark measures.  The other hundred
 * entries are everyday filler assembled from themed sentence pools; they are
 * the haystack.
 */

const START_DATE = '2025-11-01';
const DAYS = 120;

const ANCHORS = [
  {
    key: 'job-start',
    date: '2025-11-03',
    title: 'First day at Brightline',
    mood: 4,
    tags: ['work'],
    content:
      'First day as a junior backend developer at Brightline Labs. My manager Farah walked me through the payments team and then left me alone with a laptop that took three hours to set up. Everyone was kind, but I spent most of the day nodding at acronyms I did not understand. I came home exhausted and oddly proud. I have a real job now.',
  },
  {
    key: 'mom-birthday',
    date: '2025-11-09',
    title: "Mom's 58th",
    mood: 5,
    tags: ['family'],
    content:
      "Took Mom to Saffron House for her 58th birthday. She pretended to be annoyed about the fuss and then asked the waiter to take four photos. I gave her the blue silk scarf I had been hiding in my cupboard for a month, and she wore it for the rest of the evening even though it clashed with her kurta. Dad gave a toast that was mostly about himself. A good night.",
  },
  {
    key: 'knee-injury',
    date: '2025-11-15',
    title: 'Knee trouble',
    mood: 2,
    tags: ['health', 'running'],
    content:
      'Sharp pain on the outside of my right knee four kilometres into the morning run, bad enough that I walked home. Saw Dr. Mehta, the physiotherapist near the station. She says it is my IT band, not the joint, which is the good news. The bad news is two full weeks of rest, then foam rolling and hip strengthening every day. I hate resting. Running is how I keep my head straight.',
  },
  {
    key: 'first-code-review',
    date: '2025-11-22',
    title: 'Twenty-three comments',
    mood: 2,
    tags: ['work'],
    content:
      'Farah reviewed my first pull request for the payment retry service and left twenty-three comments. Twenty-three. I read them on the metro and wanted to disappear. By evening I had gone through them properly and almost all of them were fair: missing idempotency keys, a retry loop with no backoff, tests that tested nothing. She ended with "good start, this is how we all learn here." Still stings, but I think this is what being taken seriously feels like.',
  },
  {
    key: 'guitar',
    date: '2025-11-29',
    title: 'A guitar of my own',
    mood: 4,
    tags: ['guitar', 'money'],
    content:
      'Bought a second-hand Yamaha acoustic guitar from a college student in Koramangala for 6,500 rupees. It has a scratch near the sound hole and it is perfect. Spent the evening on the first chords of Wonderwall and my fingertips are already sore. I have wanted to learn since I was fifteen and always found a reason not to.',
  },
  {
    key: 'pixel-adoption',
    date: '2025-12-06',
    title: 'Pixel comes home',
    mood: 5,
    tags: ['pixel', 'home'],
    content:
      'We adopted a beagle puppy from the shelter on Hosur Road today. She is four months old, all ears, and she fell asleep on my shoes in the auto on the way home. I named her Pixel. She has already chewed one charger and claimed the corner of the sofa. I did not know I could feel this responsible for something this small.',
  },
  {
    key: 'demo-panic',
    date: '2025-12-12',
    title: 'Before the sprint demo',
    mood: 2,
    tags: ['anxiety', 'work'],
    content:
      'Ten minutes before the sprint demo my chest went tight and my hands would not stop shaking. I locked myself in a meeting room and did the 4-7-8 breathing Dr. Mehta once showed me: in for four, hold for seven, out for eight, six rounds. It brought me back enough to present. Nobody noticed, or they were kind enough not to say. I need a better plan than hiding in rooms.',
  },
  {
    key: 'arjun-toronto',
    date: '2025-12-18',
    title: "Arjun's news",
    mood: 3,
    tags: ['friends'],
    content:
      'Arjun told me over chai that he got into the University of Toronto for a master’s in data science. He leaves in March. I hugged him and said all the right things, and I meant them, and then I walked home feeling hollow. He has been my closest friend since first year of college. I am happy for him. I am also not ready.',
  },
  {
    key: 'jaipur-holidays',
    date: '2025-12-24',
    title: 'Home to Jaipur',
    mood: 5,
    tags: ['family', 'travel'],
    content:
      "Took the overnight train to Jaipur. Nani had gajar ka halwa waiting, still warm, with far too much ghee, exactly the way she has made it since I was a child. I ate two bowls before even putting my bag down. The house smells the same. The cousins are loud. I slept on the terrace under three blankets and did not check my phone once.",
  },
  {
    key: 'resolutions',
    date: '2025-12-31',
    title: 'Looking at next year',
    mood: 4,
    tags: ['reflection', 'goals'],
    content:
      'Last day of the year, so here are the three things I am committing to for 2026. One: run a half marathon, knee permitting. Two: read twenty-four books, two a month, no cheating with short ones. Three: save twenty percent of my salary every single month before I spend anything. Writing them here so that future me cannot pretend I never said it.',
  },
  {
    key: 'return-to-running',
    date: '2026-01-05',
    title: 'Running again',
    mood: 4,
    tags: ['running', 'health'],
    content:
      'First run since the injury. Three kilometres around the lake, embarrassingly slow, stopping twice to stretch. No pain at all on the outside of the knee. I nearly cried at the two kilometre mark, which is ridiculous. Seven weeks of foam rolling and boring hip exercises and it actually worked. Going to build up slowly this time.',
  },
  {
    key: 'riya-argument',
    date: '2026-01-11',
    title: 'Fight with Riya',
    mood: 1,
    tags: ['family'],
    content:
      "Riya and I had an ugly argument on the phone about who looks after Dad after his eye operation. She said I use my job as an excuse to never come home. I said she likes being the martyr. Neither of those is fully true and both of us knew where to aim. I hung up first. I have not fought with my sister like this since we were teenagers, and I feel sick about it.",
  },
  {
    key: 'dad-surgery',
    date: '2026-01-17',
    title: "Dad's operation",
    mood: 4,
    tags: ['family', 'health'],
    content:
      "Dad's cataract surgery at City Eye Hospital went smoothly. Forty minutes, and he walked out with a plastic shield taped over his left eye, complaining that nobody would let him have tea. The surgeon says the right eye can be done in six weeks. I held the discharge papers and realised my hands had been clenched for the whole morning.",
  },
  {
    key: 'riya-reconciliation',
    date: '2026-01-23',
    title: 'Called Riya',
    mood: 4,
    tags: ['family'],
    content:
      'Called Riya and apologised properly, without adding a "but." She cried, then I did. We agreed to alternate weekends in Jaipur while Dad recovers, so neither of us carries it alone, and to stop keeping score. She also admitted she had been scared, not angry. So was I. It is strange how relieved I feel.',
  },
  {
    key: 'production-outage',
    date: '2026-01-28',
    title: 'I broke production',
    mood: 1,
    tags: ['work'],
    content:
      'My database migration locked the orders table for eleven minutes during the afternoon peak. Checkout was down for everyone. I found out from the alerts channel and felt my stomach drop through the floor. Farah got on a call, helped me roll it back, and then said the review process failed, not just me. I wrote the post-mortem tonight: add the index concurrently, test migrations against a production-sized copy. I still feel terrible.',
  },
  {
    key: 'atomic-habits',
    date: '2026-02-03',
    title: 'Finished Atomic Habits',
    mood: 4,
    tags: ['reading', 'habits'],
    content:
      'Finished Atomic Habits, book three of the year. The idea I am keeping is habit stacking: attach the new habit to one you already do without thinking. So from tonight I journal right after brushing my teeth, and I do my hip exercises while the morning coffee brews. Small and almost stupid, which is the point.',
  },
  {
    key: 'ten-k-race',
    date: '2026-02-08',
    title: 'City Lakes 10K',
    mood: 5,
    tags: ['running', 'goals'],
    content:
      'Ran the City Lakes 10K this morning and finished in 58 minutes 42 seconds. Under an hour, which I did not think was possible in November when I could not manage four kilometres. The last two were ugly and a seven-year-old overtook me near the finish. I do not care. Medal is hanging on the bookshelf. Half marathon next.',
  },
  {
    key: 'kabir-date',
    date: '2026-02-14',
    title: 'Pottery with Kabir',
    mood: 5,
    tags: ['kabir'],
    content:
      'Third date with Kabir, and he booked a pottery class instead of dinner. We made two spectacularly lopsided mugs and laughed until the instructor gave up on us. He walked me to the metro and we stood there far too long not saying goodbye. I like how easy it is to be quiet around him.',
  },
  {
    key: 'promotion-talk',
    date: '2026-02-20',
    title: 'Career conversation',
    mood: 4,
    tags: ['work', 'goals'],
    content:
      'One-on-one with Farah. She thinks I am on track for SDE-2 in the July cycle, which I did not expect to hear three weeks after taking down checkout. What is missing is ownership: she wants me to lead one project end to end, design document included, rather than only picking up tickets. She suggested the refunds reconciliation work. I said yes before I could talk myself out of it.',
  },
  {
    key: 'sleep-experiment',
    date: '2026-02-26',
    title: 'Two weeks without the phone at night',
    mood: 4,
    tags: ['sleep', 'habits'],
    content:
      'Two weeks of leaving my phone to charge in the hallway after ten at night. I am averaging about seven and a half hours now instead of barely six, and I am not waking up at three with my heart racing. Mornings are less foggy and I am less short with people. Cheap fix. Annoyed that it worked.',
  },
];

/**
 * Queries whose single correct answer is one anchor entry: twenty questions
 * phrased without copying the entry's wording, then five exact-term lookups.
 */
export const EVAL_QUERIES = [
  { key: 'job-start', query: 'When did I begin working at my company, and who do I report to?' },
  { key: 'mom-birthday', query: 'What present did I give my mother for her birthday?' },
  { key: 'knee-injury', query: 'What did the physio say was wrong with my leg?' },
  { key: 'first-code-review', query: 'How did feedback on my first pull request go?' },
  { key: 'guitar', query: 'How much did I spend on a musical instrument?' },
  { key: 'pixel-adoption', query: "What is my dog's name and where did we get her?" },
  { key: 'demo-panic', query: 'What technique calmed me down when I panicked before presenting?' },
  { key: 'arjun-toronto', query: 'Which friend is moving abroad to study, and where?' },
  { key: 'jaipur-holidays', query: 'What dessert did my grandmother make when I visited?' },
  { key: 'resolutions', query: 'What goals did I set for the new year?' },
  { key: 'return-to-running', query: 'How did it feel to jog again after recovering?' },
  { key: 'riya-argument', query: 'What did my sister and I quarrel about?' },
  { key: 'dad-surgery', query: "How did my father's eye procedure turn out?" },
  { key: 'riya-reconciliation', query: 'How did I patch things up with my sister?' },
  { key: 'production-outage', query: 'What mistake of mine caused downtime at work?' },
  { key: 'atomic-habits', query: 'Which book gave me the idea of linking a new routine to an existing one?' },
  { key: 'ten-k-race', query: 'What was my finishing time in the race?' },
  { key: 'kabir-date', query: 'What activity did I do on a date?' },
  { key: 'promotion-talk', query: 'What do I need to do to get promoted?' },
  { key: 'sleep-experiment', query: 'What change improved how well I rest at night?' },
  // Short lookups by exact names and numbers, the kind of query keyword search is good at.
  { key: 'mom-birthday', query: 'Saffron House' },
  { key: 'knee-injury', query: 'Dr. Mehta IT band' },
  { key: 'ten-k-race', query: 'City Lakes 10K 58 minutes' },
  { key: 'promotion-talk', query: 'SDE-2 refunds reconciliation' },
  { key: 'arjun-toronto', query: 'University of Toronto data science' },
];

// ----------------------------------------------------------------- filler --

const THEMES = {
  work: {
    title: ['Ordinary Tuesday at work', 'Stand-up, tickets, repeat', 'Slow day at the office', 'Heads-down day'],
    mood: [3, 3, 4, 2],
    lines: [
      'Spent most of the day untangling a flaky test that only fails on the build server.',
      'Stand-up ran long again because nobody wanted to say they were blocked.',
      'Paired with a teammate on a tricky query and finally understood how the reporting tables fit together.',
      'Three meetings back to back, and I could not tell you what was decided in any of them.',
      'Closed four small tickets, which felt better than it should.',
      'Read through the service documentation over lunch and found two pages that contradict each other.',
      'The office air conditioning was arctic, so I worked in my jacket.',
      'Got a thank-you message from support for a fix I had already forgotten about.',
    ],
  },
  running: {
    title: ['Morning kilometres', 'Legs and lungs', 'Easy run', 'Out before the traffic'],
    mood: [4, 4, 3, 5],
    lines: [
      'Easy loop around the lake before the traffic woke up.',
      'Legs felt heavy for the first ten minutes and then loosened.',
      'Did the hip strengthening routine on the balcony afterwards.',
      'Kept the pace slow enough to breathe through my nose the whole way.',
      'A stray dog kept me company for half the route.',
      'Stretched properly for once instead of going straight to the shower.',
    ],
  },
  family: {
    title: ['Call home', 'Family things', 'Sunday phone call', 'News from home'],
    mood: [3, 4, 3, 4],
    lines: [
      'Long call with Mom, mostly about the neighbours and a wedding I am apparently attending.',
      'Dad sent six forwarded messages before breakfast and one of them was actually funny.',
      'Mom wants me to visit more often and I never know what to say to that.',
      'Talked to my cousin about her entrance exams; she is far calmer than I was at her age.',
      'The family group chat argued about the best route to the airport for an hour.',
      'Nani asked whether I am eating properly, which is her way of saying she misses me.',
    ],
  },
  friends: {
    title: ['Evening out', 'Catching up', 'Chai and gossip', 'Good company'],
    mood: [4, 5, 4, 3],
    lines: [
      'Met college friends at the usual chai stall and stayed until the owner started stacking chairs.',
      'Board game night went on past midnight and I lost every round.',
      'A friend is thinking of quitting her job to freelance and we talked it through from every angle.',
      'Went to a small gig at a cafe; the band was average and the company was not.',
      'Group lunch turned into a three-hour argument about the best biryani in the city.',
      'Walked back with a friend and talked about nothing in particular, which was exactly what I needed.',
    ],
  },
  dog: {
    title: ['Puppy chaos', 'Life with a beagle', 'Walks and chewed things', 'Small dog, big opinions'],
    mood: [5, 4, 4, 3],
    lines: [
      'The puppy discovered the stairs today and now refuses to use anything else.',
      'Morning walk took twice as long because every lamp post needed inspecting.',
      'She learned to sit for a treat and then forgot it completely by evening.',
      'Came home to a shredded newspaper and a very innocent face.',
      'Vet visit for vaccinations; she was braver than I was.',
      'She slept across my feet while I worked and I did not dare move.',
    ],
    from: '2025-12-07',
  },
  guitar: {
    title: ['Guitar practice', 'Sore fingertips', 'Twenty minutes of chords', 'Slow progress'],
    mood: [4, 3, 4, 3],
    lines: [
      'Twenty minutes of chord changes before dinner.',
      'The switch from G to C is finally starting to sound like music.',
      'My fingertips have calluses now, which feels like an achievement.',
      'Tried a strumming pattern from a video and gave up after the tenth attempt.',
      'Practised quietly so the neighbours would not have to suffer.',
      'Recorded myself and it was worse than I thought, but better than last week.',
    ],
    from: '2025-11-30',
  },
  reading: {
    title: ['Reading night', 'A few chapters', 'Pages before bed', 'Quiet evening with a book'],
    mood: [4, 4, 3, 4],
    lines: [
      'Read fifty pages on the metro and missed my stop.',
      'Started a novel a colleague recommended; not hooked yet.',
      'Underlined half a chapter, which probably means I should slow down.',
      'Gave up on a book I was only finishing out of stubbornness.',
      'Spent an hour in the second-hand bookshop and bought only one thing, a personal record.',
      'Reading before bed instead of scrolling made the evening feel longer.',
    ],
  },
  cooking: {
    title: ['Kitchen experiments', 'Dinner at home', 'Cooking for one', 'Something on the stove'],
    mood: [4, 3, 4, 4],
    lines: [
      'Made dal the way Mom does and got it almost right.',
      'Burnt the first batch of rotis and ate them anyway.',
      'Cooked enough for three days so I can stop ordering in.',
      'Tried a new recipe with too much chilli and regretted nothing.',
      'The vegetable seller threw in free coriander, which made my morning.',
      'Kept dinner simple: rice, yoghurt, pickle.',
    ],
  },
  mood: {
    title: ['Restless', 'A heavy sort of day', 'Overthinking again', 'Trying to be kind to myself'],
    mood: [2, 2, 3, 3],
    lines: [
      'Woke up uneasy for no reason I could name.',
      'Spent too long comparing myself to people on the internet.',
      'Felt behind on everything even though nothing is actually late.',
      'A walk around the block helped more than I expected.',
      'Wrote a list of what is actually in my control and it was shorter than the worry.',
      'Let myself do nothing for an hour without calling it laziness.',
    ],
  },
  city: {
    title: ['Rain and traffic', 'City notes', 'On the metro', 'Weather report'],
    mood: [3, 3, 4, 3],
    lines: [
      'Rain all afternoon, and the whole city slowed to a crawl.',
      'The metro was packed and somehow still quicker than the road.',
      'Clear, cold morning, the kind that makes the city look cleaner than it is.',
      'Power cut for two hours in the evening, so I sat on the balcony and watched the street.',
      'Found a new shortcut through the market that saves five minutes.',
      'The jacaranda outside my window has started to flower.',
    ],
  },
  money: {
    title: ['Budget check', 'Counting rupees', 'Month-end maths', 'Being sensible'],
    mood: [3, 3, 4, 2],
    lines: [
      'Went through the month’s spending and food delivery is the obvious culprit.',
      'Moved money into savings the day the salary arrived, before I could find a use for it.',
      'Talked myself out of new headphones for the third time.',
      'Split the electricity bill with my flatmate and argued about the air conditioner.',
      'Cancelled a subscription I had forgotten I was paying for.',
      'Paid the rent and felt briefly like an adult.',
    ],
  },
};

const CLOSERS = [
  'Early night.',
  'Nothing dramatic, just a day.',
  'Tired in the good way.',
  'Tomorrow I will try again.',
  'Grateful for small things today.',
  'That is all for now.',
  'Bed.',
  'Noting it down so I remember it happened.',
];

/** Small seeded PRNG (mulberry32) so the dataset is identical on every run. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function isoAddDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function buildFiller(date, random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const available = Object.entries(THEMES).filter(([, theme]) => !theme.from || date >= theme.from);

  const [firstName, first] = pick(available);
  let [secondName, second] = pick(available);
  while (secondName === firstName) [secondName, second] = pick(available);

  const take = (theme, count) => {
    const pool = [...theme.lines];
    const chosen = [];
    for (let index = 0; index < count && pool.length > 0; index += 1) {
      chosen.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
    }
    return chosen;
  };

  const variant = Math.floor(random() * first.title.length);
  const sentences = [...take(first, 2 + Math.floor(random() * 2)), ...take(second, 1 + Math.floor(random() * 2)), pick(CLOSERS)];
  return {
    key: `filler-${date}`,
    date,
    title: first.title[variant],
    mood: first.mood[variant],
    tags: [firstName, secondName],
    content: sentences.join(' '),
  };
}

/** Returns all 120 entries in chronological order: { key, date, title, mood, tags, content }. */
export function buildSampleJournal() {
  const random = createRandom(20251101);
  const anchorsByDate = new Map(ANCHORS.map((anchor) => [anchor.date, anchor]));
  const entries = [];
  for (let day = 0; day < DAYS; day += 1) {
    const date = isoAddDays(START_DATE, day);
    entries.push(anchorsByDate.get(date) ?? buildFiller(date, random));
  }
  return entries;
}

export const SAMPLE_JOURNAL_RANGE = { from: START_DATE, to: isoAddDays(START_DATE, DAYS - 1) };
