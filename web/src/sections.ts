export type IconName = 'activity' | 'inbox' | 'folder' | 'monitor' | 'config';

export interface Section {
  path: string;
  label: string;
  icon: IconName;
}

export const sections: Section[] = [
  { path: '/', label: 'Activity', icon: 'activity' },
  { path: '/inbox', label: 'Inbox', icon: 'inbox' },
  { path: '/workspace', label: 'Workspace', icon: 'folder' },
  { path: '/monitor', label: 'Monitor', icon: 'monitor' },
  { path: '/config', label: 'Config', icon: 'config' },
];

export function sectionFor(path: string): Section {
  return sections.find((s) => s.path !== '/' && path.startsWith(s.path)) ?? (sections[0] as Section);
}
