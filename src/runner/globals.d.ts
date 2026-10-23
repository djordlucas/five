// The globals a run gets beyond Node's own (see child.ts). Declared here so
// tests and tools written in this repo typecheck.
declare var five: {
  /** A SQLite database file in the workspace, created if needed. */
  db(path: string): import("node:sqlite").DatabaseSync;
  /** Host functions: five.<module>.<fn>(...args) over IPC. */
  // biome-ignore lint/suspicious/noExplicitAny: host modules are defined by the embedding program
  [module: string]: any;
};
