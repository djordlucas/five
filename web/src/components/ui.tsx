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

/** How full something is, coloured as it nears its limit. */
export function Meter({ value, max, warnAt, label }: { value: number; max: number; warnAt: number; label: string }) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  const level = value >= max ? 'danger' : value >= warnAt ? 'warn' : 'ok';
  return (
    <div class={styles.meter} data-level={level} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${Math.round(share * 100)}%` }} />
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
