// How five schedules its workers, tunable while it runs: the web UI's Config
// page changes these through the API, and a change applies at the next
// decision. Saved changes outlive a restart; the environment gives the defaults.

import type { EventBody, SettingField, Settings, SettingsView } from "../api/types.ts";
import type { Logger } from "../log.ts";
import type { State } from "../state.ts";

export type { Settings } from "../api/types.ts";

export const FIELDS: SettingField[] = [
  {
    key: "slots",
    group: "Model",
    label: "Model calls at once",
    min: 1,
    max: 16,
    help: "Calls sent to the model at the same time; the rest wait, the chat's first. Match Ollama's OLLAMA_NUM_PARALLEL: more than it only queues in Ollama instead.",
  },
  {
    key: "taskRuns",
    group: "Workers",
    label: "Task workers at once",
    min: 0,
    max: 16,
    help: "Task runs at the same time, besides the lead and the chat. More than the model's slots is fine: a worker spends time in its own code and tools. 0: no task runs.",
  },
  {
    key: "minOpenTasks",
    group: "Workers",
    label: "Plan when fewer open than",
    unit: "tasks",
    min: 0,
    max: 50,
    help: "The lead runs when the board has fewer open tasks than this, at most every 30 seconds.",
  },
  {
    key: "leadEverySeconds",
    group: "Workers",
    label: "Lead runs at least every",
    unit: "seconds",
    min: 30,
    max: 86_400,
    help: "Even with enough open tasks, the lead runs this often, to read results and change course.",
  },
  {
    key: "taskTimeoutSeconds",
    group: "Workers",
    label: "A task run may take",
    unit: "seconds",
    min: 10,
    max: 86_400,
    help: "A task worker's run is killed after this, and its task fails. A worker can ask for its own limit.",
  },
  {
    key: "maxSteps",
    group: "Runs",
    label: "Model calls in one agent",
    unit: "steps",
    min: 1,
    max: 100,
    help: "An agent — the lead, the chat's answer, a task worker's llm.agent — ends after this many model calls.",
  },
  {
    key: "runTokens",
    group: "Runs",
    label: "Context of one agent",
    unit: "tokens",
    min: 1000,
    max: 131_072,
    help: "An agent nearing this is told to finish; past it, it ends. Small contexts keep every call fast: reading new context is what a busy model is slowest at.",
  },
  {
    key: "resultChars",
    group: "Runs",
    label: "Tool result to a file above",
    unit: "characters",
    min: 200,
    max: 16_000,
    help: "A tool result longer than this is kept whole in results/; the agent gets its start and the file's path.",
  },
  {
    key: "imageSide",
    group: "Runs",
    label: "Images shrunk to",
    unit: "px",
    min: 256,
    max: 2048,
    help: "view_image shrinks an image to fit this many pixels a side before the model sees it.",
  },
  {
    key: "chatWaitSeconds",
    group: "Chat",
    label: "Wait for the person",
    unit: "seconds",
    min: 10,
    max: 3600,
    help: "After five answers in the chat, it waits this long for the person's next message; then the chat ends and the lead reads it.",
  },
];

/** The settings when the environment sets none. */
export const DEFAULTS: Settings = {
  slots: 4,
  taskRuns: 4,
  minOpenTasks: 2,
  leadEverySeconds: 600,
  taskTimeoutSeconds: 600,
  maxSteps: 12,
  runTokens: 8000,
  resultChars: 2000,
  imageSide: 1024,
  chatWaitSeconds: 300,
};

export class SettingsStore {
  private readonly state: State;
  private readonly defaults: Settings;
  private readonly log: Logger;
  private readonly emit: (body: EventBody) => void;
  private overrides: Partial<Settings>;

  constructor(o: { state: State; defaults: Settings; log: Logger; emit: (body: EventBody) => void }) {
    this.state = o.state;
    this.defaults = o.defaults;
    this.log = o.log;
    this.emit = o.emit;
    this.overrides = sanitize(parse(o.state.getMeta("settings")));
  }

  get current(): Settings {
    return { ...this.defaults, ...this.overrides };
  }

  view(): SettingsView {
    return {
      settings: this.current,
      defaults: this.defaults,
      changed: Object.keys(this.overrides) as (keyof Settings)[],
      fields: FIELDS,
    };
  }

  /** Change some settings; an error names the first that is not valid, and nothing changes. */
  update(change: Record<string, unknown>): void {
    const next = { ...this.overrides };
    const said: string[] = [];
    for (const [key, value] of Object.entries(change)) {
      const field = FIELDS.find((f) => f.key === key);
      if (!field) throw new Error(`no setting "${key}"`);
      const k = key as keyof Settings;
      const bad = check(field, value);
      if (bad) throw new Error(`${key}: ${bad}`);
      if (value === this.defaults[k]) delete next[k];
      else next[k] = value as number;
      if (value !== this.current[k]) said.push(`${key} ${this.current[k]} → ${String(value)}`);
    }
    this.save(next, said.join(", "));
  }

  /** Back to the settings the environment gives. */
  reset(): void {
    this.save({}, "back to the defaults");
  }

  private save(overrides: Partial<Settings>, change: string): void {
    this.overrides = overrides;
    this.state.setMeta("settings", JSON.stringify(overrides));
    if (!change) return;
    this.emit({ type: "settings", change });
    this.log.info("settings changed", { change });
  }
}

/** Why a value does not fit a setting, if it does not. */
function check(field: SettingField, value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return "must be a whole number";
  if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
  if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
  return undefined;
}

/** Saved overrides that still name a setting and fit it: one saved by an older five may not. */
function sanitize(saved: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(saved)) {
    const field = FIELDS.find((f) => f.key === key);
    if (field && !check(field, value)) out[key] = value;
  }
  return out as Partial<Settings>;
}

function parse(json: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(json ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
