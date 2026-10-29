// The task workers a new five starts with, so it works from its first minute.
// They are ordinary task workers: the lead reads, revises and replaces them
// like its own. Each shows a way to write one — `feeds` is code that asks the
// model only what needs judgment; `research` has a small agent find and quote
// sources, then checks the quotes in code. Their sources are in seeds/.

import * as fs from "node:fs";

const source = (name: string) => fs.readFileSync(new URL(`./seeds/${name}.js`, import.meta.url), "utf8");

export const SEEDS: { name: string; description: string; source: string }[] = [
  {
    name: "research",
    description:
      "Researches one news story with a small agent, and adds what it finds to the story's file, news/stories/<slug>.md, under today's date — only the facts whose quoted sentence code finds in the pages the agent read — then updates news/index.md. Title: what to find out. Input: the details, and `story: <slug>` to add to a story already followed (it picks or starts one otherwise). Result: how many checked facts it added, how many it dropped, and the file.",
    source: source("research"),
  },
  {
    name: "feeds",
    description:
      'Reads world-news feeds (RSS, Atom), keeps the items it has not seen before, asks the model which matter, and appends those — one factual line each, with the link — to today\'s digest, news/<YYYY-MM-DD>.md; it posts research tasks for the weightiest. Five posts it a task every few minutes. Leave the input empty: its default feeds work. "Up to date" means nothing new since the last run, which is normal. Result: how many items were new and how many were added.',
    source: source("feeds"),
  },
];

/** A new five's goal. */
export const SEED_GOAL =
  "Follow what is happening in the world, as a news desk that never closes. Keep a daily digest in news/<YYYY-MM-DD>.md, one line per item with its source link, and follow the important ongoing stories in news/stories/<slug>.md, each with a dated timeline and what to watch next; keep news/index.md listing them. Write only what a source says, and name it. Tell the person when something major happens.";
