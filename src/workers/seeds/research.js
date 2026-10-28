// One story, researched. A small agent searches and reads, and reports each
// fact with a sentence copied from its page; code keeps only the facts whose
// sentence it finds on that page, and adds them to the story's file under
// today's date. The model finds and words; code checks and writes.
const STORIES = "news/stories";
const INDEX = "news/index.md";
/** Words in a row a quote must share with its page, when it is not there whole. */
const RUN = 8;

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

const SYSTEM =
  "You are a research worker of five, a news desk. Find out what the task asks: search the web and read the pages that matter, " +
  "news reports and official sources first. Do not write files. Then reply with your findings, one fact a line, each as: " +
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
      `Task: ${task.title}\n${task.input}\n\nStories followed so far: ${stories.join(", ") || "none"}.\n\nWhich story is this task about? Give an existing slug when it is about that story; otherwise a new one — a few lowercase words joined by hyphens, no date — and its title.`,
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

  const pages = new Map();
  const kept = [];
  let dropped = 0;
  for (const f of out.facts ?? []) {
    if (!/^https?:\/\//.test(f.url ?? "")) {
      dropped++;
      continue;
    }
    if (!pages.has(f.url)) pages.set(f.url, await five.web.text(f.url).then(norm, () => ""));
    if (onPage(pages.get(f.url), f.quote)) kept.push(f);
    else dropped++;
  }
  const why = dropped ? ` ${dropped} dropped: their sentence is not on the page they name.` : "";
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
