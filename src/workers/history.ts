// The workspace's history, kept run by run. Before a run first changes a file,
// the file as it was is kept in the run's directory, .five/history/run-<n>/
// (see src/runner/keep.ts: the host keeps its own writes, a worker's child
// process keeps the writes of its code). When the run ends, a manifest says
// whose run it was. A failed run's changes are put back at once: a worker
// that breaks must not leave broken files for the others. And any version
// kept can be read, or put back by the person.
//
// What is kept is the file before a run changed it: the latest version of a
// file is the file itself.

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileVersion } from "../api/types.ts";
import type { Logger } from "../log.ts";
import { keepBefore } from "../runner/keep.ts";

/** Where the history lives, under the workspace. */
export const HISTORY_DIR = ".five/history";
/** Runs whose changes are kept; older ones are dropped. */
const KEEP_RUNS = 500;

interface Manifest {
  run?: number;
  worker: string;
  task?: { id: number; title: string };
  at: string;
  outcome?: string;
  /** Its changes were put back. */
  restored?: boolean;
}

export class History {
  readonly root: string;
  private readonly workspace: string;
  private readonly log: Logger;

  constructor(workspace: string, log: Logger) {
    this.workspace = workspace;
    this.root = path.join(workspace, HISTORY_DIR);
    this.log = log;
  }

  /** The keep directory of run `n`: a worker's child process gets it as FIVE_KEEP_DIR. */
  dir(n: number): string {
    return path.join(this.root, `run-${n}`);
  }

  /** Keep `rel` before run `n` changes it, from the host. */
  before(n: number, rel: string): void {
    keepBefore(this.workspace, this.dir(n), rel);
  }

  /**
   * A run ended: record whose it was, and put back the changes of a failed
   * one. Returns the paths put back.
   */
  end(run: { n: number; worker: string; task?: { id: number; title: string } }, outcome: string): string[] {
    const dir = this.dir(run.n);
    if (!fs.existsSync(dir)) return [];
    const manifest: Manifest = {
      run: run.n,
      worker: run.worker,
      ...(run.task && { task: { id: run.task.id, title: run.task.title } }),
      at: new Date().toISOString(),
      outcome,
    };
    let restored: string[] = [];
    if (outcome === "failed") {
      restored = this.putBack(dir);
      manifest.restored = true;
    }
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(manifest));
    this.prune();
    return restored;
  }

  /** The versions kept of a file, newest first. */
  versions(rel: string): FileVersion[] {
    const file = this.clean(rel);
    const out: FileVersion[] = [];
    for (const id of this.ids()) {
      const dir = path.join(this.root, id);
      const m = this.manifest(dir);
      const kept = path.join(dir, "files", file);
      let bytes: number | null | undefined;
      if (fs.existsSync(kept)) bytes = fs.statSync(kept).size;
      else if (this.created(dir).includes(file)) bytes = null;
      if (bytes === undefined) continue;
      out.push({
        id,
        ...(m?.run !== undefined && { run: m.run }),
        by: m?.worker ?? "a run in progress",
        ...(m?.task && { task: m.task }),
        at: m?.at ?? fs.statSync(dir).mtime.toISOString(),
        bytes,
        ...(m?.restored && { restored: true }),
      });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /** A version's content: the file before that run changed it. */
  read(rel: string, id: string): Buffer {
    const kept = path.join(this.root, this.cleanId(id), "files", this.clean(rel));
    if (!fs.existsSync(kept)) throw new Error(`no version ${id} of ${rel}`);
    return fs.readFileSync(kept);
  }

  /** Put a version back, by the person: the file as it is now is kept first, so this can be undone too. */
  restore(rel: string, id: string): void {
    const file = this.clean(rel);
    const src = path.join(this.root, this.cleanId(id));
    const kept = path.join(src, "files", file);
    const wasNew = !fs.existsSync(kept) && this.created(src).includes(file);
    if (!fs.existsSync(kept) && !wasNew) throw new Error(`no version ${id} of ${rel}`);
    const mine = path.join(this.root, `person-${Date.now()}`);
    keepBefore(this.workspace, mine, file);
    const manifest: Manifest = { worker: "person", at: new Date().toISOString() };
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "run.json"), JSON.stringify(manifest));
    const target = path.join(this.workspace, file);
    if (wasNew) fs.rmSync(target, { force: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(kept, target);
    }
  }

  /** Put back what a run changed: its kept files, and no file it made. */
  private putBack(dir: string): string[] {
    const back: string[] = [];
    const files = path.join(dir, "files");
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(files, rel), { withFileTypes: true })) {
        const r = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) walk(r);
        else {
          const target = path.join(this.workspace, r);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.join(files, r), target);
          back.push(r);
        }
      }
    };
    try {
      if (fs.existsSync(files)) walk("");
      for (const r of this.created(dir)) {
        fs.rmSync(path.join(this.workspace, r), { force: true });
        back.push(r);
      }
    } catch (err) {
      this.log.warn("a failed run's changes not all put back", { dir, error: String(err) });
    }
    return back;
  }

  private created(dir: string): string[] {
    try {
      return fs.readFileSync(path.join(dir, "new.txt"), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  private manifest(dir: string): Manifest | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as Manifest;
    } catch {
      return undefined;
    }
  }

  private ids(): string[] {
    try {
      return fs.readdirSync(this.root).filter((n) => /^(run|person)-\d+$/.test(n));
    } catch {
      return [];
    }
  }

  private prune(): void {
    const ids = this.ids();
    if (ids.length <= KEEP_RUNS) return;
    const byAge = ids
      .map((id) => ({ id, at: fs.statSync(path.join(this.root, id)).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    for (const { id } of byAge.slice(0, ids.length - KEEP_RUNS)) {
      fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
    }
  }

  /** A workspace path, refused when it leaves the workspace. */
  private clean(rel: string): string {
    const abs = path.resolve(this.workspace, rel);
    const r = path.relative(this.workspace, abs);
    if (!r || r.startsWith("..") || path.isAbsolute(r)) throw new Error(`"${rel}" is not a file of the workspace`);
    return r;
  }

  private cleanId(id: string): string {
    if (!/^(run|person)-\d+$/.test(id)) throw new Error(`no version ${id}`);
    return id;
  }
}
