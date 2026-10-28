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
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  context: 'M6 3h12v18H6zM9 7h6M9 11h6M9 15h4',
  tool: 'M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 0-2-2z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  next: 'M5 12h14M13 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 20V8M7 13l5-5 5 5M4 4h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  chat: 'M4 5h16v11H9l-5 4z',
  reset: 'M4 12a8 8 0 1 0 3-6.2M4 4v4h4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  library: 'M5 4h4v16H5zM10 4h4v16h-4zM15.5 5.5l3.8-1 3.2 14.5-3.8 1z',
  send: 'M4 12l16-8-6 16-3-7zM11 13l9-9',
  leave: 'M14 4h6v16h-6M10 8l-4 4 4 4M6 12h10',
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
