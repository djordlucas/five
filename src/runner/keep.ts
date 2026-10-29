// Copy-on-write for a run: before the run first changes a file of the
// workspace, the file as it was is copied to the run's keep directory —
// `files/<path>` — or, when the file is new, its path is added to `new.txt`.
// With that, five can put a run's changes back, and show what a file was.
//
// The host calls keepBefore before its own writes for a run (write_file,
// append_file); a child process given FIVE_KEEP_DIR patches node:fs so that
// code's writes, however it makes them, are kept the same way.

// The module object itself, not a namespace: its functions can be replaced.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The directory of the workspace five keeps to itself: never kept. */
const OWN = ".five";

// The originals, before any patch: keeping must not keep itself.
const copyFile = fs.copyFileSync;
const append = fs.appendFileSync;
const mkdir = fs.mkdirSync;
const exists = fs.existsSync;
const stat = fs.statSync;

/** The paths each keep directory has handled in this process. */
const handled = new Map<string, Set<string>>();

/** Keep `file` as it is now in `dir`, once: before the first change a run makes to it. */
export function keepBefore(workspace: string, dir: string, file: fs.PathLike): void {
  const p = typeof file === "string" ? file : file instanceof URL ? fileURLToPath(file) : undefined;
  if (p === undefined) return;
  const abs = path.resolve(workspace, p);
  const rel = path.relative(workspace, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep)[0] === OWN) return;
  const seen = handled.get(dir) ?? new Set<string>();
  handled.set(dir, seen);
  if (seen.has(rel)) return;
  seen.add(rel);
  const kept = path.join(dir, "files", rel);
  if (exists(kept)) return;
  try {
    if (exists(abs)) {
      if (!stat(abs).isFile()) return;
      mkdir(path.dirname(kept), { recursive: true });
      copyFile(abs, kept);
    } else {
      mkdir(dir, { recursive: true });
      append(path.join(dir, "new.txt"), `${rel}\n`);
    }
  } catch {
    // Keeping is a safety net: a write it could not keep still happens.
  }
}

/** Patch node:fs in this process so every write to the workspace is kept in `dir` first. */
export function keepWrites(workspace: string, dir: string): void {
  const keep = (p: unknown) => {
    if (typeof p === "string" || p instanceof URL) keepBefore(workspace, dir, p);
  };
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const promises = fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>;
  // A write or removal of its first argument.
  for (const name of ["writeFileSync", "appendFileSync", "rmSync", "unlinkSync", "truncateSync", "createWriteStream"]) {
    wrap(f, name, (a) => keep(a[0]));
  }
  for (const name of ["writeFile", "appendFile", "rm", "unlink", "truncate"]) {
    wrap(f, name, (a) => keep(a[0]));
    wrap(promises, name, (a) => keep(a[0]));
  }
  // Both ends of a rename; the destination of a copy.
  for (const name of ["renameSync", "rename"]) {
    wrap(f, name, (a) => {
      keep(a[0]);
      keep(a[1]);
    });
  }
  wrap(promises, "rename", (a) => {
    keep(a[0]);
    keep(a[1]);
  });
  for (const name of ["copyFileSync", "copyFile"]) wrap(f, name, (a) => keep(a[1]));
  wrap(promises, "copyFile", (a) => keep(a[1]));
  // `import { writeFileSync } from "node:fs"` sees the patched functions too.
  syncBuiltinESMExports();
}

function wrap(on: Record<string, (...a: unknown[]) => unknown>, name: string, before: (args: unknown[]) => void): void {
  const original = on[name];
  if (typeof original !== "function") return;
  on[name] = function (this: unknown, ...args: unknown[]) {
    before(args);
    return original.apply(this, args);
  };
}
