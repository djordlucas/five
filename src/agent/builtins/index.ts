// seven's built-ins, less those for working with other agents: running code,
// managing tools, controlling background runs, and SQL. Everything else —
// reading files, searching the web — five builds for itself with define_tool.
// The context tools (context.ts) are five's own.

import { codeBuiltins } from "./code.ts";
import { runBuiltins } from "./runs.ts";
import type { Builtin } from "./shared.ts";
import { sqlBuiltins } from "./sql.ts";

export type { Builtin, BuiltinContext } from "./shared.ts";
export { awaitRun, disabledError, formatRun, startGenerated } from "./shared.ts";

let all: Map<string, Builtin> | undefined;

/** Every built-in, by name. */
export function builtins(): Map<string, Builtin> {
  if (!all) {
    const isBuiltin = (name: string) => all?.has(name) ?? false;
    all = new Map([...codeBuiltins(isBuiltin), ...runBuiltins(isBuiltin), ...sqlBuiltins()].map((b) => [b.name, b]));
  }
  return all;
}
