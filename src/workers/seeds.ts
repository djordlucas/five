// The task workers a new five starts with, so it works from its first minute.
// They are ordinary task workers: the lead reads, revises and replaces them
// like its own. Each shows a way to write one — `research` hands the task to a
// small agent, `feeds` is code that asks the model only what needs judgment.

export const SEEDS: { name: string; description: string; source: string }[] = [
  {
    name: "research",
    description:
      "Does one research task with a small agent: searches the web, reads pages, and writes what it finds, with sources, to files. Title: what to find out. Input: the details, and the file to write (research/<topic>.md when none is named). Result: what it found, in a few lines, and the files it wrote.",
    source: `// One research task, done by a small agent with the web and file tools.
export default async ({ task }) =>
  five.llm.agent({
    system:
      "You are a research worker of five. Do the one task you are given: search the web, read the pages that matter, " +
      "and write what you find to the file the task names (research/<topic>.md when it names none), " +
      "citing each source's URL. Write only what your sources say. Keep it short. " +
      "When done, reply with a short result: what you found, in a few lines, and the files you wrote.",
    prompt: \`Task #\${task.id}: \${task.title}\\n\\n\${task.input}\`,
    tools: ["search_web", "fetch_url", "read_file", "write_file", "append_file", "list_files"],
  });
`,
  },
  {
    name: "feeds",
    description:
      "Reads news feeds (RSS, Atom), keeps the items it has not seen before, asks the model which matter, and appends those — one factual line each, with the link — to today's digest, news/<YYYY-MM-DD>.md. Input: feed URLs, one per line; the default world-news feeds when empty. Result: how many items were new and how many were added.",
    source: `// News feeds into today's digest. Code fetches, parses and remembers what it
// has seen; the model only picks what matters, in small batches.
const DEFAULT_FEEDS = [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://www.theguardian.com/world/rss",
  "https://www.aljazeera.com/xml/rss/all.xml",
  "https://feeds.npr.org/1004/rss.xml",
];
const SEEN = "news/seen.json";
const BATCH = 15;

export default async ({ task }) => {
  const given = task.input.split(/\\s+/).filter((u) => /^https?:\\/\\//.test(u));
  const feeds = given.length ? given : DEFAULT_FEEDS;
  fs.mkdirSync("news", { recursive: true });
  const seen = new Set(fs.existsSync(SEEN) ? JSON.parse(fs.readFileSync(SEEN, "utf8")) : []);
  const fresh = [];
  const failed = [];
  for (const url of feeds) {
    try {
      for (const item of await five.web.feed(url)) {
        if (!item.link || seen.has(item.link)) continue;
        seen.add(item.link);
        fresh.push({ ...item, source: new URL(url).hostname.replace(/^(www|feeds|rss)\\./, "") });
      }
    } catch (err) {
      failed.push(\`\${url}: \${err.message}\`);
    }
  }
  fs.writeFileSync(SEEN, JSON.stringify([...seen].slice(-5000)));
  const failures = failed.length ? \` Failed: \${failed.join("; ")}\` : "";
  if (!fresh.length) return \`No new items in \${feeds.length} feeds.\${failures}\`;

  const picked = [];
  for (let i = 0; i < fresh.length; i += BATCH) {
    const batch = fresh.slice(i, i + BATCH);
    const list = batch.map((it, n) => \`\${n}. \${it.title}\${it.summary ? \` — \${it.summary.slice(0, 160)}\` : ""}\`).join("\\n");
    const out = await five.llm.ask(
      \`Headlines:\\n\${list}\\n\\nWhich of these are significant world news? For each, give its number and one factual line on what happened, from the headline and summary only.\`,
      {
        system: "You pick significant world news from headlines. Be factual and brief. Skip opinion, sport and entertainment.",
        schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "object", properties: { n: { type: "integer" }, line: { type: "string" } }, required: ["n", "line"] },
            },
          },
          required: ["items"],
        },
      },
    );
    for (const p of out.items ?? []) {
      const it = batch[p.n];
      if (it) picked.push({ ...it, line: p.line });
    }
  }
  const day = new Date().toISOString().slice(0, 10);
  const file = \`news/\${day}.md\`;
  if (!fs.existsSync(file)) fs.writeFileSync(file, \`# News, \${day}\\n\\n\`);
  fs.appendFileSync(file, picked.map((p) => \`- \${p.line} — [\${p.source}](\${p.link})\\n\`).join(""));
  return \`\${fresh.length} new items from \${feeds.length} feeds; \${picked.length} added to \${file}.\${failures}\`;
};
`,
  },
];

/** A new five's goal. */
export const SEED_GOAL =
  "Follow what is happening in the world, as a news desk that never closes. Keep a daily digest in news/<YYYY-MM-DD>.md, one line per item with its source link, and follow the important ongoing stories in news/stories/<slug>.md, each with a dated timeline and what to watch next; keep news/index.md listing them. Write only what a source says, and name it. Tell the person when something major happens.";
