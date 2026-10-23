// Mistakes in model-written JavaScript that run without an error but give a
// wrong result, so the model sees nothing to fix. Each check names the line
// and the correction; define_tool and run_js add the notes to their result.

/** A regular expression written as a string: `.split('\s+')` matches the text `\s+`, not whitespace. */
const STRING_PATTERN = /\.(split|replace|replaceAll|match|matchAll|search)\(\s*(['"`])((?:\\.|(?!\2)[^\n])*?)\2/g;
const REGEX_ESCAPE = /\\[sdwbSDWB]|\\\\[sdwbSDWB]/;

export function lint(source: string): string[] {
  const notes: string[] = [];
  for (const m of source.matchAll(STRING_PATTERN)) {
    const [call, method, quote, text] = m;
    if (!text || !REGEX_ESCAPE.test(text)) continue;
    const line = source.slice(0, m.index).split("\n").length;
    const pattern = text.replace(/\\\\/g, "\\");
    notes.push(
      `line ${line}: \`${call}\` passes the pattern as a string (${quote}${text}${quote}), so ${method} looks for that exact text, not a regular expression. Write it as a regex literal: \`.${method}(/${pattern}/${method === "replaceAll" || method === "matchAll" ? "g" : ""})\`.`,
    );
  }
  return notes;
}

/** The notes as a block to append to a result, or "" when there are none. */
export function lintNotes(source: string): string {
  const notes = lint(source);
  return notes.length ? `\n\nPossible bug in this code:\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
}
