// News feeds into today's digest. Code fetches, parses and remembers what it
// has seen; the model only picks what matters, in small batches, and weighs
// it. The weightiest new items become research tasks: what to follow comes
// from the news, not from what a model remembers.
const DEFAULT_FEEDS = [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://www.theguardian.com/world/rss",
  "https://www.aljazeera.com/xml/rss/all.xml",
  "https://feeds.npr.org/1004/rss.xml",
];
// A dot file: its own state, which agents' file tools leave alone.
const SEEN = "news/.seen.json";
const LOCK = "news/.feeds.lock";
const BATCH = 15;
/** Research tasks one run posts at most, for its weightiest new items. */
const FOLLOW = 3;
/** The weight, from 1 to 5, an item needs to be followed. */
const FOLLOW_WEIGHT = 4;
/** A lock older than this was left by a run that died. */
const STALE_MS = 15 * 60_000;

// One feeds run at a time: two would take the same new items, and add each twice.
export default async ({ task }) => {
  fs.mkdirSync("news", { recursive: true });
  try {
    fs.writeFileSync(LOCK, String(Date.now()), { flag: "wx" });
  } catch {
    if (Date.now() - fs.statSync(LOCK).mtimeMs < STALE_MS)
      return "Another feeds run is reading the feeds right now, so this one did nothing. One feeds task at a time is enough.";
    fs.writeFileSync(LOCK, String(Date.now()));
  }
  try {
    return await digest(task);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
};

async function digest(task) {
  // URLs in any form: one per line, or joined with commas or semicolons.
  const given = [...new Set(task.input.match(/https?:\/\/[^\s,;<>"'()[\]]+/g) ?? [])];
  const seen = new Set(fs.existsSync(SEEN) ? JSON.parse(fs.readFileSync(SEEN, "utf8")) : []);
  const fresh = [];
  const failed = [];
  const read = async (urls) => {
    for (const url of urls) {
      try {
        for (const item of await five.web.feed(url)) {
          if (!item.link || seen.has(item.link) || fresh.some((f) => f.link === item.link)) continue;
          fresh.push({ ...item, source: new URL(url).hostname.replace(/^(www|feeds|rss)\./, "") });
        }
      } catch (err) {
        failed.push(`${url}: ${err.message}`);
      }
    }
  };
  await read(given.length ? given : DEFAULT_FEEDS);
  // None of the named feeds worked: the defaults do.
  const extra = DEFAULT_FEEDS.filter((u) => !given.includes(u));
  const fellBack = given.length > 0 && failed.length === given.length && extra.length > 0;
  if (fellBack) await read(extra);
  const notes = [
    fellBack &&
      `The feeds named in the input failed (${failed.join("; ")}); the default feeds were read instead, and they work: next time, leave the input empty.`,
    !fellBack && failed.length && `Some feeds failed: ${failed.join("; ")}.`,
  ].filter(Boolean);
  const said = notes.length ? ` ${notes.join(" ")}` : "";
  // Nothing new is the normal state between two runs, not a failure.
  if (!fresh.length) return `Up to date: no new items since the last run. That is normal; run again in a while.${said}`;

  const picked = [];
  for (let i = 0; i < fresh.length; i += BATCH) {
    const batch = fresh.slice(i, i + BATCH);
    const list = batch
      .map((it, n) => `${n}. ${it.title}${it.summary ? ` — ${it.summary.slice(0, 160)}` : ""}`)
      .join("\n");
    const out = await five.llm.ask(
      `Headlines:\n${list}\n\nWhich of these are significant world news? For each, give its number, one factual line on what happened, from the headline and summary only, and its weight: 5 for news that changes things for many countries or millions of people, 1 for local news.`,
      {
        system:
          "You pick significant world news from headlines. Be factual and brief. Skip opinion, sport and entertainment.",
        schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  n: { type: "integer" },
                  line: { type: "string" },
                  weight: { type: "integer", minimum: 1, maximum: 5 },
                },
                required: ["n", "line", "weight"],
              },
            },
          },
          required: ["items"],
        },
      },
    );
    for (const p of out.items ?? []) {
      const it = batch[p.n];
      if (it && !picked.includes(it)) picked.push({ ...it, line: p.line, weight: Number(p.weight) || 1 });
    }
  }
  const day = new Date().toISOString().slice(0, 10);
  const file = `news/${day}.md`;
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# News, ${day}\n\n`);
  fs.appendFileSync(file, picked.map((p) => `- ${p.line} — [${p.source}](${p.link})\n`).join(""));
  // Seen only once the model has been through them: a failed run leaves them for the next.
  for (const it of fresh) seen.add(it.link);
  fs.writeFileSync(SEEN, JSON.stringify([...seen].slice(-5000)));
  // The weightiest, followed: a research task each. One like a task already on the board is not posted again.
  const posted = [];
  for (const p of [...picked].sort((a, b) => b.weight - a.weight)) {
    if (posted.length >= FOLLOW || p.weight < FOLLOW_WEIGHT) break;
    try {
      const id = await five.board.post(
        "research",
        p.line.slice(0, 200),
        `${p.title}${p.summary ? `\n${p.summary}` : ""}\nFirst reported: ${p.link}`,
      );
      if (id) posted.push(`#${id} ${p.line}`);
    } catch {
      // The same story is on the board already.
    }
  }
  const top = picked
    .slice(0, 6)
    .map((p) => `\n- ${p.line}`)
    .join("");
  const follow = posted.length ? `\nResearch tasks posted:${posted.map((p) => `\n- ${p}`).join("")}` : "";
  return `${fresh.length} new items; ${picked.length} added to ${file}.${said}${follow}${top ? `\nTop of them:${top}` : ""}`;
}
