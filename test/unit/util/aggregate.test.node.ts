import { IEvent } from '~/util/interfaces';
import {
  timeperiodsAtomsOfPeriod,
  timeperiodsDaysOfPeriod,
} from '~/util/timeperiod';
import {
  mergeEventsByKey,
  aggregateWindow,
  aggregateBrowser,
  aggregateEditor,
  mergeCatEvents,
} from '~/util/aggregate';

const ts = '2021-01-01T00:00:00+00:00';
const ev = (data: Record<string, any>, duration: number): IEvent => ({
  timestamp: ts,
  duration,
  data,
});

describe('timeperiod atom decomposition', () => {
  test('single day -> 24 hours', () => {
    const atoms = timeperiodsAtomsOfPeriod({ start: ts, length: [1, 'day'] });
    expect(atoms).toHaveLength(24);
    expect(atoms.every(a => a.length[1] === 'hour')).toBe(true);
  });

  test('week -> 7 days', () => {
    const atoms = timeperiodsAtomsOfPeriod({ start: ts, length: [1, 'week'] });
    expect(atoms).toHaveLength(7);
    expect(atoms.every(a => a.length[1] === 'day')).toBe(true);
  });

  test('multi-day (last7d) -> 7 days', () => {
    expect(timeperiodsAtomsOfPeriod({ start: ts, length: [7, 'day'] })).toHaveLength(7);
  });

  test('year -> 12 months (not 365 days)', () => {
    const atoms = timeperiodsAtomsOfPeriod({ start: ts, length: [1, 'year'] });
    expect(atoms).toHaveLength(12);
    expect(atoms.every(a => a.length[1] === 'month')).toBe(true);
  });

  test('month -> correct day count (Jan = 31)', () => {
    expect(timeperiodsDaysOfPeriod({ start: ts, length: [1, 'month'] })).toHaveLength(31);
  });

  test('year -> 365 days (non-leap), no throw', () => {
    expect(timeperiodsDaysOfPeriod({ start: ts, length: [1, 'year'] })).toHaveLength(365);
  });

  test('atoms are chronological', () => {
    const atoms = timeperiodsAtomsOfPeriod({ start: ts, length: [1, 'week'] });
    const starts = atoms.map(a => new Date(a.start).getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe('mergeEventsByKey', () => {
  test('sums by key, sorts by duration desc, limits', () => {
    const events = [
      ev({ app: 'a' }, 10),
      ev({ app: 'b' }, 5),
      ev({ app: 'a' }, 7),
      ev({ app: 'c' }, 20),
    ];
    const merged = mergeEventsByKey(events, e => String(e.data.app), e => ({ app: e.data.app }), 2);
    expect(merged).toHaveLength(2); // limited
    expect(merged[0]).toMatchObject({ data: { app: 'c' }, duration: 20 });
    expect(merged[1]).toMatchObject({ data: { app: 'a' }, duration: 17 }); // summed 10+7
  });

  test('handles empty/undefined', () => {
    expect(mergeEventsByKey(undefined as any, e => String(e.data.app), e => e.data)).toEqual([]);
  });
});

describe('aggregateWindow', () => {
  test('merges apps/titles/categories across atoms, sums duration, concats active', () => {
    const atomA = {
      app_events: [ev({ app: 'code' }, 100), ev({ app: 'chrome' }, 50)],
      title_events: [ev({ app: 'code', title: 'x' }, 100)],
      cat_events: [ev({ $category: ['Work'] }, 100)],
      active_events: [ev({ status: 'not-afk' }, 150)],
      duration: 150,
    };
    const atomB = {
      app_events: [ev({ app: 'code' }, 30)],
      title_events: [ev({ app: 'code', title: 'x' }, 30), ev({ app: 'code', title: 'y' }, 10)],
      cat_events: [ev({ $category: ['Work'] }, 30), ev({ $category: ['Media'] }, 5)],
      active_events: [ev({ status: 'not-afk' }, 40)],
      duration: 40,
    };
    const agg = aggregateWindow([atomA, atomB]);
    expect(agg.duration).toBe(190);
    expect(agg.active_events).toHaveLength(2); // concatenated
    // code = 100+30 = 130 (top), chrome = 50
    expect(agg.app_events[0]).toMatchObject({ data: { app: 'code' }, duration: 130 });
    expect(agg.app_events[1]).toMatchObject({ data: { app: 'chrome' }, duration: 50 });
    // title (code,x) = 130, (code,y) = 10
    expect(agg.title_events[0]).toMatchObject({ data: { app: 'code', title: 'x' }, duration: 130 });
    // categories: Work = 130, Media = 5
    expect(agg.cat_events[0]).toMatchObject({ data: { $category: ['Work'] }, duration: 130 });
    expect(agg.cat_events.find(e => e.data.$category[0] === 'Media')?.duration).toBe(5);
  });

  test('tolerates missing atom results', () => {
    expect(() => aggregateWindow([undefined as any])).not.toThrow();
  });
});

describe('aggregateBrowser / aggregateEditor', () => {
  test('browser merges domains and urls', () => {
    const a = { domains: [ev({ $domain: 'g.com' }, 10)], urls: [ev({ url: 'g.com/a' }, 10)], duration: 10 };
    const b = { domains: [ev({ $domain: 'g.com' }, 5)], urls: [ev({ url: 'g.com/b' }, 5)], duration: 5 };
    const agg = aggregateBrowser([a, b]);
    expect(agg.duration).toBe(15);
    expect(agg.domains[0]).toMatchObject({ data: { $domain: 'g.com' }, duration: 15 });
    expect(agg.urls).toHaveLength(2);
  });

  test('editor merges files/languages/projects', () => {
    const a = {
      files: [ev({ file: 'a.ts', language: 'ts' }, 10)],
      languages: [ev({ language: 'ts' }, 10)],
      projects: [ev({ project: 'p' }, 10)],
      duration: 10,
    };
    const b = {
      files: [ev({ file: 'a.ts', language: 'ts' }, 5)],
      languages: [ev({ language: 'ts' }, 5)],
      projects: [ev({ project: 'p' }, 5)],
      duration: 5,
    };
    const agg = aggregateEditor([a, b]);
    expect(agg.duration).toBe(15);
    expect(agg.files[0]).toMatchObject({ data: { file: 'a.ts', language: 'ts' }, duration: 15 });
    expect(agg.languages[0]).toMatchObject({ data: { language: 'ts' }, duration: 15 });
    expect(agg.projects[0]).toMatchObject({ data: { project: 'p' }, duration: 15 });
  });
});

describe('mergeCatEvents (timeline month bucket)', () => {
  test('sums cat_events across day windows', () => {
    const merged = mergeCatEvents([
      { cat_events: [ev({ $category: ['Work'] }, 10)] },
      { cat_events: [ev({ $category: ['Work'] }, 20)] },
    ]);
    expect(merged.cat_events[0]).toMatchObject({ data: { $category: ['Work'] }, duration: 30 });
  });
});
