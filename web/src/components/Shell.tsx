import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { inboxSeen, online, status } from '../live';
import { type Section, sectionFor, sections } from '../sections';
import { cycleTheme, theme } from '../theme';
import { Icon } from './Icon';
import { Badge } from './ui';
import styles from './Shell.module.css';

/** The frame around every section: a rail on desktop; a header and a bottom tab bar under 768px. */
export function Shell({ children }: { children: ComponentChildren }) {
  const { path } = useLocation();
  const current = sectionFor(path);

  return (
    <div class={styles.shell}>
      <nav class={styles.rail} aria-label="Sections">
        <a class={styles.brand} href="/" aria-label="Five">
          5
        </a>
        {sections.map((s) => (
          <a
            key={s.path}
            href={s.path}
            class={styles.railLink}
            aria-current={s === current ? 'page' : undefined}
            title={s.label}
          >
            <Icon name={s.icon} />
            <span>{s.label}</span>
            <Unread s={s} />
          </a>
        ))}
        <div class={styles.railFoot}>
          <ThemeControl />
        </div>
      </nav>

      <div class={styles.main}>
        <header class={styles.header}>
          <h1>{current.label}</h1>
          <LoopState />
          <LiveState />
        </header>
        <main class={styles.content}>{children}</main>
      </div>

      <nav class={styles.tabs} aria-label="Sections">
        {sections.map((s) => (
          <a key={s.path} href={s.path} class={styles.tab} aria-current={s === current ? 'page' : undefined}>
            <Icon name={s.icon} />
            <span>{s.label}</span>
            <Unread s={s} />
          </a>
        ))}
        <button type="button" class={styles.tab} onClick={cycleTheme} aria-label="Change theme">
          <span class={styles.themeDot} />
          <span>{theme.value}</span>
        </button>
      </nav>
    </div>
  );
}

/** A dot on the Inbox link while five has a message this browser has not seen. */
function Unread({ s }: { s: Section }) {
  const last = status.value?.inboxLast ?? 0;
  if (s.path !== '/inbox' || last <= inboxSeen.value) return null;
  return <span class={styles.unread} role="status" aria-label="New message" />;
}

/** What the loop is doing, on every page. */
function LoopState() {
  const s = status.value;
  if (!s) return null;
  const { loop } = s;
  const state = loop.busy || loop.running ? 'running' : 'paused';
  const label = loop.busy ? `turn ${loop.turn} · step ${loop.step}` : loop.running ? 'between turns' : 'paused';
  return <Badge state={state}>{label}</Badge>;
}

/** Whether five answers the poll: what the pages show depends on it. */
function LiveState() {
  const state = online.value;
  const label = { live: 'Live', connecting: 'Connecting…', offline: 'Offline' }[state];
  return (
    <span class={styles.live} data-state={state} role="status" title="Whether five answers">
      {label}
    </span>
  );
}

function ThemeControl() {
  const label = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' }[theme.value];
  return (
    <button type="button" class={styles.control} onClick={cycleTheme}>
      {label}
    </button>
  );
}
