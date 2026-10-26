export type IconName = 'activity' | 'inbox' | 'folder' | 'monitor' | 'config' | 'play' | 'pause' | 'step' | 'stop' | 'alert' | 'flag' | 'edit' | 'person' | 'chip' | 'file' | 'context' | 'tool' | 'layers' | 'clock' | 'next';

export interface Section {
  path: string;
  label: string;
  icon: IconName;
}

export const sections: Section[] = [
  { path: '/', label: 'Activity', icon: 'activity' },
  { path: '/workspace', label: 'Workspace', icon: 'folder' },
  { path: '/inbox', label: 'Inbox', icon: 'inbox' },
  { path: '/config', label: 'Config', icon: 'config' },
  { path: '/monitor', label: 'Monitor', icon: 'monitor' },
];

export function sectionFor(path: string): Section {
  return sections.find((s) => s.path !== '/' && path.startsWith(s.path)) ?? (sections[0] as Section);
}
