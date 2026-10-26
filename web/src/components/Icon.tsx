import type { IconName } from '../sections';

// 24×24 stroke icons drawn with currentColor, so they follow the theme.
const paths: Record<IconName, string> = {
  activity: 'M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4',
  inbox: 'M4 5h16v14H4zM4 13h5l1 2h4l1-2h5',
  config: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  monitor: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  play: 'M7 5v14l11-7z',
  pause: 'M8 5v14M16 5v14',
  step: 'M6 5v14l9-7zM18 5v14',
  stop: 'M6 6h12v12H6z',
  alert: 'M12 3l10 18H2zM12 10v5M12 18v.01',
  flag: 'M5 21V4h12l-2 4 2 4H5',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  chip: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
};

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
