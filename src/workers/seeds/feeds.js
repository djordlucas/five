// News feeds into today's digest. Code fetches, parses and remembers what it
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
  // URLs in any form: one per line, or joined with commas or semicolons.
  const given = [...new Set(task.input.match(/https?:\/\/[^\s,;<>"'()[\]]+/g) ?? [])];
  fs.mkdirSync("news", { recursive: true });
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
      `Headlines:\n${list}\n\nWhich of these are significant world news? For each, give its number and one factual line on what happened, from the headline and summary only.`,
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
                properties: { n: { type: "integer" }, line: { type: "string" } },
                required: ["n", "line"],
              },
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
  const file = `news/${day}.md`;
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# News, ${day}\n\n`);
  fs.appendFileSync(file, picked.map((p) => `- ${p.line} — [${p.source}](${p.link})\n`).join(""));
  // Seen only once the model has been through them: a failed run leaves them for the next.
  for (const it of fresh) seen.add(it.link);
  fs.writeFileSync(SEEN, JSON.stringify([...seen].slice(-5000)));
  // The top headlines, for the lead to pick stories from.
  const top = picked
    .slice(0, 6)
    .map((p) => `\n- ${p.line}`)
    .join("");
  return `${fresh.length} new items; ${picked.length} added to ${file}.${said}${top ? `\nTop of them:${top}` : ""}`;
};
