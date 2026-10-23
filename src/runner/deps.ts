// npm packages for code the model writes. Every bare import that is not a Node
// built-in is installed with npm into <workspace>/.five/node_modules before the code
// runs; Node then resolves it from there, because run files live under
// <workspace>/.five. Install scripts never run (--ignore-scripts). Nothing is
// allowlisted.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { promisify } from "node:util";
import { build, type Plugin } from "esbuild";
import { type Logger, noopLogger } from "../log.ts";

const run = promisify(execFile);
const BUILTINS = new Set(builtinModules);

export interface Package {
  name: string;
  version: string;
  /** The range asked for, when no version matched it and the latest was installed instead. */
  unmatched?: string;
}

/**
 * Install what `source` imports, plus `deps` (name → version range; a package
 * imported but not listed gets `latest`). Returns the top-level packages with
 * the version now installed.
 */
export async function installDeps(
  home: string,
  source: string,
  deps: Record<string, string> = {},
  log: Logger = noopLogger,
): Promise<Package[]> {
  const names = [...new Set([...(await scanImports(source)), ...Object.keys(deps)])].sort();
  const unmatched = new Map<string, string>();
  const missing = names.filter((n) => deps[n] !== undefined || !installedVersion(home, n));
  if (missing.length > 0) {
    const specs = missing.map((n) => `${n}@${deps[n] ?? "latest"}`);
    const started = performance.now();
    try {
      await install(home, specs);
    } catch (err) {
      // A version range that matches nothing is usually a guess (a model's
      // idea of a package's current major); install the latest instead and
      // say so, rather than fail a package that exists.
      const ranged = missing.filter((n) => deps[n] !== undefined && deps[n] !== "latest");
      if (!/\bETARGET\b/.test(String(err)) || ranged.length === 0) {
        log.error("package install failed", { packages: specs, error: err });
        throw err;
      }
      log.warn("package version not found; installing latest", { packages: ranged.map((n) => `${n}@${deps[n]}`) });
      try {
        await install(
          home,
          missing.map((n) => `${n}@latest`),
        );
      } catch (retry) {
        log.error("package install failed", { packages: specs, error: retry });
        throw retry;
      }
      for (const n of ranged) unmatched.set(n, deps[n] as string);
    }
    log.info("packages installed", {
      packages: missing.map((n) => `${n}@${installedVersion(home, n) ?? "?"}`),
      duration_ms: Math.round(performance.now() - started),
    });
  }
  return names.map((name) => ({
    name,
    version: installedVersion(home, name) ?? "unknown",
    ...(unmatched.has(name) && { unmatched: unmatched.get(name) }),
  }));
}

/** Make `home` a package root, so .ts files under it are ES modules and resolve its node_modules. */
export function initHome(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  const pj = path.join(home, "package.json");
  if (!fs.existsSync(pj)) fs.writeFileSync(pj, `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
}

/** The npm package names `source` imports, statically or with a literal dynamic import/require. */
async function scanImports(source: string): Promise<string[]> {
  const found = new Set<string>();
  const collect: Plugin = {
    name: "collect-bare-imports",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return undefined;
        const spec = args.path;
        if (!/^[./]|^[a-z]+:/.test(spec) && !BUILTINS.has(spec)) found.add(packageName(spec));
        return { path: spec, external: true };
      });
    },
  };
  await build({
    stdin: { contents: source, loader: "ts", sourcefile: "source.ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [collect],
    logLevel: "silent",
  }).catch((err: unknown) => {
    throw new Error(`syntax error: ${formatEsbuildError(err)}`);
  });
  return [...found];
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

function installedVersion(home: string, name: string): string | undefined {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(home, "node_modules", name, "package.json"), "utf8"));
    return typeof pj.version === "string" ? pj.version : undefined;
  } catch {
    return undefined;
  }
}

// npm is not safe to run concurrently against one prefix; installs queue here.
let installs: Promise<unknown> = Promise.resolve();

async function install(home: string, specs: string[]): Promise<void> {
  const job = installs.then(async () => {
    initHome(home);
    try {
      await run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", ...specs], {
        cwd: home,
        timeout: 180_000,
      });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim() ?? "";
      // Drop npm's pointer to its own debug log: a path the model cannot use.
      const text = stderr
        .split("\n")
        .filter((l) => !/complete log of this run/.test(l))
        .join("\n");
      const missing = /\b(E404|ETARGET)\b/.test(stderr)
        ? "\nThe package or version does not exist on npm. Check the name, or write the code yourself with Node's built-ins."
        : "";
      throw new Error(`npm install ${specs.join(" ")} failed${text ? `: ${text}` : ""}${missing}`);
    }
  });
  installs = job.catch(() => {});
  await job;
}

function formatEsbuildError(err: unknown): string {
  const errors = (err as { errors?: { text: string; location?: { line: number; column: number } | null }[] }).errors;
  if (!errors?.length) return err instanceof Error ? err.message : String(err);
  return errors.map((e) => (e.location ? `${e.location.line}:${e.location.column}: ${e.text}` : e.text)).join("\n");
}
