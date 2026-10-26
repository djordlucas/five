import { type ComponentChildren, Fragment } from 'preact';
import styles from './ui.module.css';

export { styles as ui };

/** A state as a small coloured label. */
export function Badge({ state, children }: { state: string; children?: ComponentChildren }) {
  return <span class={`${styles.badge} ${styles[state] ?? ''}`}>{children ?? state}</span>;
}

/** A row of links that switch a view, the current one marked. */
export function Segments({ items }: { items: { href: string; label: string; current: boolean; count?: number }[] }) {
  return (
    <nav class={styles.segments}>
      {items.map((i) => (
        <a key={i.href} href={i.href} class={styles.segment} aria-current={i.current ? 'page' : undefined}>
          {i.label}
          {i.count !== undefined && i.count > 0 && <span class={styles.count}>{i.count}</span>}
        </a>
      ))}
    </nav>
  );
}

/** How full something is, as a ring in a square with the share in its middle, coloured as it nears its limit. */
export function Gauge({ value, max, warnAt, label }: { value: number; max: number; warnAt: number; label: string }) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  const level = value >= max ? 'danger' : value >= warnAt ? 'warn' : 'ok';
  // A circle of circumference 100, so the dash length is the percentage.
  const r = 100 / (2 * Math.PI);
  return (
    <div
      class={styles.gauge}
      data-level={level}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
      title={`${label}: ${value.toLocaleString()} of ${max.toLocaleString()}`}
    >
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle class={styles.track} cx="20" cy="20" r={r} />
        <circle class={styles.fill} cx="20" cy="20" r={r} stroke-dasharray={`${share * 100} 100`} />
      </svg>
      <span>{Math.round(share * 100)}%</span>
    </div>
  );
}

export function Facts({ rows }: { rows: [string, ComponentChildren][] }) {
  return (
    <dl class={styles.facts}>
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
