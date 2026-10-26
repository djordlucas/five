import type { ComponentChildren } from 'preact';

/**
 * A small syntax colouring for the JSON and JavaScript five shows: keys,
 * strings, numbers, keywords, literals and comments, each a span its colour
 * comes from (tokens.css, --code-*). Not a parser: a wrong guess only colours
 * a word wrongly.
 */

export type Lang = 'json' | 'js' | 'text';

const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null|undefined|NaN)\b|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|try|catch|finally|throw|async|await|import|from|export|default|class|extends|typeof|instanceof|in|of|this|yield|delete)\b/g;

/** Past this, a text shows plain: colouring it would cost more than it helps. */
const MAX = 60_000;

export function highlight(text: string, lang: Lang): ComponentChildren {
  if (lang === 'text' || text.length > MAX) return text;
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [all, comment, str, num, literal, keyword] = m;
    const kind = comment
      ? 'comment'
      : str
        ? // A JSON key, or an object key in code: a string followed by a colon.
          /^\s*:/.test(text.slice(at + all.length, at + all.length + 8))
          ? 'key'
          : 'string'
        : num
          ? 'number'
          : literal
            ? 'literal'
            : keyword && lang === 'js'
              ? 'keyword'
              : undefined;
    // A JSON key shows without its quotes: easier to read; the data is unchanged.
    const shown = kind === 'key' && lang === 'json' && all[0] === '"' ? all.slice(1, -1) : all;
    out.push(kind ? <span class={`code-${kind}`}>{shown}</span> : shown);
    last = at + all.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * JSON when it starts like an object or array — parsed or not, as a result
 * five cut short no longer parses — else plain text. "[five] …" is a note.
 */
export function guess(text: string): Lang {
  return /^\s*(\{\s*("|\}|$)|\[\s*(["{[\d\]-]|true|false|null|$))/.test(text) ? 'json' : 'text';
}

/** A markdown code block's language, as far as this colouring knows it. */
export function langOf(tag: string | undefined, text: string): Lang {
  const l = (tag ?? '').toLowerCase();
  if (l === 'json' || l === 'jsonc') return 'json';
  if (l) return 'js';
  return guess(text);
}

/** A pre with its text coloured: lang given, or guessed (JSON or plain). */
export function Code({ text, lang, class: cls }: { text: string; lang?: Lang; class?: string }) {
  return <pre class={cls}>{highlight(text, lang ?? guess(text))}</pre>;
}
