// The web as a small model reads it: a page as plain text, a feed as a list of
// its items, a search as a numbered list of results. Agents get these as the
// fetch_url and search_web tools, and task workers' code as five.web.

const UA = "Mozilla/5.0 (compatible; five; +https://github.com/djordlucas/five)";
const TIMEOUT_MS = 20_000;
/** The most of a page kept: a tool result is cut to fit the context after that. */
const MAX_TEXT = 60_000;

export interface FeedItem {
  title: string;
  link: string;
  date?: string;
  summary?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function get(url: string, signal?: AbortSignal): Promise<Response> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`only http and https URLs: ${url}`);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return fetch(u, {
    headers: {
      "user-agent": UA,
      accept:
        "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

/**
 * A URL's content as text: a feed's items one per line, a page's readable
 * text, anything else as it is. An HTTP error is a line saying so.
 */
export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await get(url, signal);
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (!res.ok) return `HTTP ${res.status} ${res.statusText} from ${res.url}\n${htmlToText(body).slice(0, 500)}`;
  if (/xml|rss|atom/.test(type) || /^\s*<\?xml|<rss[\s>]|<feed[\s>]/.test(body.slice(0, 500))) {
    const items = feedItems(body);
    if (items.length) return formatFeed(res.url, items);
  }
  const text = /html/.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : body;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… [page cut at ${MAX_TEXT} characters]` : text;
}

/** A feed's items. */
export async function fetchFeed(url: string, signal?: AbortSignal): Promise<FeedItem[]> {
  const res = await get(url, signal);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  return feedItems(await res.text());
}

/** The items of an RSS or Atom feed. */
export function feedItems(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)) {
    const block = m[0];
    const tag = (name: string) => {
      const t = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block)?.[1];
      return t === undefined ? undefined : textOf(t);
    };
    const href = /<link[^>]*href="([^"]+)"/.exec(block)?.[1];
    const title = tag("title") ?? "";
    const link = decodeEntities(href ?? tag("link") ?? tag("guid") ?? "");
    const date = tag("pubDate") ?? tag("updated") ?? tag("published") ?? tag("dc:date");
    const summary = tag("description") ?? tag("summary") ?? tag("content");
    if (!title && !link) continue;
    items.push({
      title,
      link,
      ...(date && { date }),
      ...(summary && { summary: summary.length > 300 ? `${summary.slice(0, 300)}…` : summary }),
    });
  }
  return items;
}

function formatFeed(url: string, items: FeedItem[]): string {
  return [
    `${url}: ${items.length} items`,
    ...items.map(
      (it, i) =>
        `${i + 1}. ${it.title}${it.date ? ` (${it.date})` : ""}\n   ${it.link}${it.summary ? `\n   ${it.summary}` : ""}`,
    ),
  ].join("\n");
}

/** Web search, through DuckDuckGo's HTML page: the top results. */
export async function searchWeb(query: string, signal?: AbortSignal, max = 8): Promise<SearchResult[]> {
  const res = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, signal);
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
  return parseResults(await res.text(), max);
}

/** The results on DuckDuckGo's HTML results page, ads left out. */
export function parseResults(html: string, max = 8): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const b of blocks) {
    const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a?.[1]) continue;
    const url = resultUrl(decodeEntities(a[1]));
    // Ads go through DuckDuckGo's own click tracker.
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b)?.[1];
    results.push({ title: textOf(a[2] ?? ""), url, snippet: snippet ? textOf(snippet) : "" });
    if (results.length >= max) break;
  }
  return results;
}

export function formatResults(query: string, results: SearchResult[]): string {
  if (!results.length) return `No results for "${query}".`;
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n");
}

/** A result's target: DuckDuckGo links through /l/?uddg=<url>. */
function resultUrl(href: string): string {
  const u = /[?&]uddg=([^&]+)/.exec(href)?.[1];
  if (u) return decodeURIComponent(u);
  return href.startsWith("//") ? `https:${href}` : href;
}

/** A page's readable text: no scripts, styles or markup, a line per block. */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|template|iframe)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|footer|aside)[\s\S]*?<\/\1>/gi, "\n")
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|ul|ol|blockquote|pre|header)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const lines = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => l && l !== "-");
  const text = lines.join("\n");
  return title ? `${textOf(title)}\n\n${text}` : text;
}

/** Markup's text on one line. */
function textOf(s: string): string {
  return decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " "))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
