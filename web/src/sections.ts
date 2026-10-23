export type IconName = 'loop' | 'context' | 'tool';

export interface Section {
  path: string;
  label: string;
  icon: IconName;
}

export const sections: Section[] = [
  { path: '/', label: 'Loop', icon: 'loop' },
  { path: '/context', label: 'Context', icon: 'context' },
  { path: '/tools', label: 'Tools', icon: 'tool' },
];

export function sectionFor(path: string): Section {
  return sections.find((s) => s.path !== '/' && path.startsWith(s.path)) ?? (sections[0] as Section);
}
