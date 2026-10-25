export type IconName = 'loop' | 'context' | 'inbox' | 'supervisor' | 'tool' | 'folder' | 'process';

export interface Section {
  path: string;
  label: string;
  icon: IconName;
}

export const sections: Section[] = [
  { path: '/', label: 'Loop', icon: 'loop' },
  { path: '/context', label: 'Context', icon: 'context' },
  { path: '/inbox', label: 'Inbox', icon: 'inbox' },
  { path: '/supervisor', label: 'Supervisor', icon: 'supervisor' },
  { path: '/tools', label: 'Tools', icon: 'tool' },
  { path: '/workspace', label: 'Workspace', icon: 'folder' },
  { path: '/processes', label: 'Processes', icon: 'process' },
];

export function sectionFor(path: string): Section {
  return sections.find((s) => s.path !== '/' && path.startsWith(s.path)) ?? (sections[0] as Section);
}
