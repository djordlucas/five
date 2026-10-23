import { signal } from '@preact/signals';
import { type Event, type EventsPage, get, type Status } from './api/client';

/**
 * Five's live state, polled once a second: the status, and every event since
 * the last poll. The events of the most recent turns are kept; a reset of the
 * context (the event log starts over) loads them afresh.
 */

/** How often the status is polled. */
const POLL_MS = 1000;
/** How many events the tab keeps. */
const KEEP = 5000;

export const status = signal<Status | null>(null);
export const events = signal<Event[]>([]);
/** Whether the last poll reached five. */
export const online = signal<'connecting' | 'live' | 'offline'>('connecting');
/** How many turns back the timeline was loaded. */
export const turnsLoaded = signal(20);

let lastSeq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
let inflight: Promise<void> | undefined;

/** One poll at a time: a refresh during a poll waits for it. */
function poll(): Promise<void> {
  inflight ??= pollOnce().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function pollOnce(): Promise<void> {
  try {
    const s = await get<Status>('/status');
    if (s.lastSeq < lastSeq) {
      // The context was reset: its events are gone.
      lastSeq = 0;
      events.value = [];
    }
    if (lastSeq === 0 && s.lastSeq > 0) {
      const page = await get<EventsPage>(`/events?turns=${turnsLoaded.value}`);
      events.value = page.events;
      lastSeq = page.last;
    }
    while (s.lastSeq > lastSeq) {
      const page = await get<EventsPage>(`/events?after=${lastSeq}`);
      if (page.events.length === 0) break;
      const all = [...events.value, ...page.events];
      events.value = all.length > KEEP ? all.slice(all.length - KEEP) : all;
      lastSeq = page.events.at(-1)?.seq ?? lastSeq;
    }
    status.value = s;
    online.value = 'live';
  } catch {
    online.value = 'offline';
  }
}

/** Poll now, then every POLL_MS. */
export function startPolling(): void {
  if (polling) return;
  polling = true;
  const tick = async () => {
    await poll();
    if (polling) timer = setTimeout(tick, POLL_MS);
  };
  void tick();
}

export function stopPolling(): void {
  polling = false;
  clearTimeout(timer);
}

/** Poll now: after an action, so the page does not wait for the next tick. */
export function refresh(): Promise<void> {
  return poll();
}

/** Load the events of `n` more earlier turns. */
export async function loadMoreTurns(n = 20): Promise<void> {
  turnsLoaded.value += n;
  const page = await get<EventsPage>(`/events?turns=${turnsLoaded.value}`);
  events.value = page.events;
  lastSeq = page.last;
}
