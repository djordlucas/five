// One story, researched. A small agent searches and reads, and reports each
// fact with a sentence from its page. Code keeps only the facts it finds in
// what the agent read — the sentence as quoted, or else the page's own sentence
// that says the fact: most of its words and every number — the page it names
// first, then any other it read, which then becomes the fact's source. It adds
// them to the story's file under today's date, each with the page's sentence.
// The model finds and words; code checks and writes.
const STORIES = "news/stories";
const INDEX = "news/index.md";
/** Words in a row a quote must share with its page, when it is not there whole. */
const RUN = 8;
/** The share of a fact's words its page's sentence must have, besides every number. */
const SAYS = 0.6;
/** Words that say little on their own. */
const SMALL = new Set(
  "the and for with from that this was were are has have had its their they them than then into over after before about also been being but not more most said says will would could should which who what when where while there these those other some such only just".split(
    " ",
  ),
);

/** A URL as a key: with or without www, a slash at the end or a fragment. */
const key = (url) =>
  String(url)
    .trim()
    .replace(/#.*$/, "")
    .replace(/^https?:\/\/(www\.)?/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[“”"‘’'`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Whether the page says the quote: whole, or RUN words of it in a row. */
function onPage(page, quote) {
  const q = norm(quote);
  if (q.length < 20) return false;
  if (page.includes(q)) return true;
  const words = q.split(" ");
  for (let i = 0; i + RUN <= words.length; i++) if (page.includes(words.slice(i, i + RUN).join(" "))) return true;
  return false;
}

const words = (s) =>
  norm(s)
    .match(/[a-z]{3,}/g)
    ?.filter((w) => !SMALL.has(w)) ?? [];
const numbers = (s) => (String(s).match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, "").replace(/,/g, ""));

/** A page's sentences, and each sentence with the next: a fact may take two. */
function sentences(text) {
  const all = String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 20 && t.length <= 600);
  return [...all, ...all.slice(0, -1).map((t, i) => `${t} ${all[i + 1]}`)];
}

/** The page's sentence that says the claim: most of its words and every number; undefined when none. */
function saying(page, claim) {
  const want = [...new Set(words(claim))];
  const nums = numbers(claim);
  if (want.length < 3) return undefined;
  let best;
  for (const s of page.sentences) {
    const has = new Set(words(s));
    const shared = want.filter((w) => has.has(w)).length;
    if (shared / want.length < SAYS) continue;
    const theirs = numbers(s);
    if (!nums.every((n) => theirs.includes(n))) continue;
    // The shortest of the best: a sentence, not a paragraph.
    if (!best || shared > best.shared || (shared === best.shared && s.length < best.s.length)) best = { s, shared };
  }
  return best?.s;
}

const SYSTEM =
  "You are a research worker of five, a news desk. Find out what the task asks: search the web and read the pages that matter, " +
  "news reports and official sources first, and the latest: check each page's date. Do not write files. Then reply with your findings, one fact a line, each as: " +
  "the fact — the URL of the page you read it on — a sentence copied word for word from that page. " +
  "Only facts you read on a page you fetched in this task, never from memory: anything else is dropped. " +
  "If the pages do not answer, say so.";

export default async ({ task }) => {
  fs.mkdirSync(STORIES, { recursive: true });
  const stories = fs
    .readdirSync(STORIES)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
  // The story: named in the input, or picked by the model — an existing one when it fits.
  let slug = task.input.match(/\bstory:\s*([\w-]+)/i)?.[1];
  let title;
  if (!slug) {
    const pick = await five.llm.ask(
      `Task: ${task.title}\n${task.input}\n\nStories followed so far: ${stories.join(", ") || "none"}.\n\nWhich story is this task about? Give an existing slug when it is about that story; otherwise a new one — three to six lowercase words naming the event, such as spain-train-crash-adamuz, never a single word, a news outlet or a date — and its title, naming the event too.`,
      {
        schema: {
          type: "object",
          properties: { slug: { type: "string" }, title: { type: "string" } },
          required: ["slug", "title"],
        },
      },
    );
    slug = pick.slug;
    title = pick.title;
  }
  slug =
    String(slug)
      .toLowerCase()
      .replace(/\d{4}-\d\d-\d\d/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "other";
  // A new slug much like one followed already is that story: reuse its file.
  if (!stories.includes(slug)) {
    const words = new Set(slug.split("-"));
    const like = stories.find((s) => {
      const theirs = s.split("-");
      const shared = theirs.filter((w) => words.has(w)).length;
      return shared >= 2 && shared / Math.min(words.size, theirs.length) >= 0.6;
    });
    // A slug too short to name an event — "ukraine" — is the one story it is part of, if only one.
    const within = stories.filter((s) => [...words].every((w) => s.split("-").includes(w)));
    if (!like && words.size <= 2 && within.length === 1) slug = within[0];
    else if (like) slug = like;
  }
  const file = `${STORIES}/${slug}.md`;
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

  const report = await five.llm.agent({
    system: SYSTEM,
    prompt: `Task #${task.id}: ${task.title}\n\n${task.input}${before ? `\n\nThe story's file has this already; look for what is new:\n${before.slice(-1500)}` : ""}`,
    tools: ["search_web", "fetch_url"],
  });

  const out = await five.llm.ask(
    `Research notes:\n${report}\n\nList the facts in these notes that come with a source URL and a sentence from that source, as they are written there. Then, in one line, what to watch next in this story.`,
    {
      schema: {
        type: "object",
        properties: {
          facts: {
            type: "array",
            items: {
              type: "object",
              properties: { fact: { type: "string" }, url: { type: "string" }, quote: { type: "string" } },
              required: ["fact", "url", "quote"],
            },
          },
          watch: { type: "string" },
        },
        required: ["facts"],
      },
    },
  );

  // What the agent read, the page each fact names first; the page fetched again when the agent read none of it.
  const read = (await five.web.read()).map((r) => ({
    url: r.url,
    key: key(r.url),
    text: norm(r.text),
    sentences: sentences(r.text),
  }));
  const fetched = new Map();
  const kept = [];
  // The story's file has some already, from an earlier run.
  const quotes = new Set();
  const had = norm(before);
  let dropped = 0;
  let known = 0;
  for (const f of out.facts ?? []) {
    const named = key(f.url ?? "");
    if (!read.some((r) => r.key === named) && /^https?:\/\//.test(f.url ?? "") && !fetched.has(named)) {
      // A page the agent did not read itself: fetched now, to check against.
      const text = await five.web.text(f.url).catch(() => "");
      fetched.set(named, { url: f.url, key: named, text: norm(text), sentences: sentences(text) });
    }
    const pages = [...read, ...fetched.values()];
    const order = [...pages.filter((r) => r.key === named), ...pages.filter((r) => r.key !== named)];
    // The quote as given, or the page's own sentence that says the fact.
    let found;
    for (const page of order) {
      if (onPage(page.text, f.quote)) found = { url: page.url, quote: f.quote };
      else {
        const s = saying(page, f.fact) ?? saying(page, f.quote);
        if (s) found = { url: page.url, quote: s };
      }
      if (found) break;
    }
    if (!found) dropped++;
    else if (had.includes(norm(found.quote))) known++;
    else if (!quotes.has(norm(found.quote))) {
      quotes.add(norm(found.quote));
      kept.push({ ...f, ...found });
    }
  }
  const why = [
    dropped && ` ${dropped} dropped: nothing the agent read says them.`,
    known && ` ${known} already in the story.`,
  ]
    .filter(Boolean)
    .join("");
  if (!kept.length) return `Nothing added to ${file}: no fact could be checked against its source.${why}`;

  const day = new Date().toISOString().slice(0, 10);
  let add = "";
  if (!before) add += `# ${title || task.title}\n`;
  // One heading a day: a second run the same day adds under it.
  if ([...before.matchAll(/^## (.+)$/gm)].pop()?.[1] !== day) add += `\n## ${day}\n\n`;
  add += kept.map((f) => `- ${f.fact} ([source](${f.url}): “${f.quote.trim()}”)\n`).join("");
  if (out.watch?.trim()) add += `- Watch: ${out.watch.trim()}\n`;
  fs.writeFileSync(file, before + add);

  // The index: every story, its title and the day it last changed.
  const index = fs
    .readdirSync(STORIES)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const text = fs.readFileSync(`${STORIES}/${f}`, "utf8");
      const last = [...text.matchAll(/^## (\d{4}-\d\d-\d\d)$/gm)].pop()?.[1];
      return `- [${text.match(/^# (.+)$/m)?.[1] ?? f}](stories/${f})${last ? `, updated ${last}` : ""}`;
    });
  fs.writeFileSync(INDEX, `# Stories\n\n${index.join("\n")}\n`);

  return `${kept.length} checked facts added to ${file} (story: ${slug}).${why}\n${kept
    .slice(0, 3)
    .map((f) => `- ${f.fact}`)
    .join("\n")}`;
};
