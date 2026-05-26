/**
 * Normalize LaTeX math delimiters emitted by upstream LLMs into the
 * `$...$` / `$$...$$` form that `remark-math` understands.
 *
 * Models frequently emit `\[ ... \]` (display) and `\( ... \)` (inline)
 * or even bare `[ ... ]` blocks containing `\begin{vmatrix}`, `\cdot`,
 * `x_1`, etc. Without this normalization those land in chat as raw
 * source instead of rendered math.
 */

const DISPLAY_BACKSLASH = /\\\[([\s\S]+?)\\\]/g;
const INLINE_BACKSLASH = /\\\(([\s\S]+?)\\\)/g;

// Bare `[ ... ]` block that contains a LaTeX-only signal (\begin, \cdot,
// \times, etc.) and lives on its own line. Conservative: avoids matching
// markdown link/image syntax (`[text](url)`, `![alt](src)`).
const DISPLAY_BARE_BRACKETS =
  /(^|\n)[ \t]*\[[ \t]*((?:[^[\]\n]|\n(?!\n))*?\\(?:begin|end|frac|sqrt|cdot|times|sum|int|prod|lim|left|right|vmatrix|pmatrix|bmatrix|matrix|mathrm|mathbf|mathbb|alpha|beta|gamma|delta|theta|pi|sigma|infty)[^[\]]*?)[ \t]*\][ \t]*(?=\n|$)/g;

export function normalizeLatexDelimiters(input: string): string {
  if (!input || (!input.includes('\\') && !input.includes('['))) return input;

  let out = input;
  out = out.replace(DISPLAY_BACKSLASH, (_m, body) => `\n\n$$${body}$$\n\n`);
  out = out.replace(INLINE_BACKSLASH, (_m, body) => `$${body}$`);
  out = out.replace(
    DISPLAY_BARE_BRACKETS,
    (_m, lead, body) => `${lead}\n$$${body}$$\n`
  );
  return out;
}

/**
 * Heuristic: does this string likely contain LaTeX math?
 *
 * We use this to gate `remark-math` + `rehype-katex` so plain chat
 * messages (e.g. "$10 vs $20", "[link](url)") are never reinterpreted as
 * math. Only content the LLM clearly intended as math turns the plugins
 * on.
 */
const LATEX_SIGNATURE =
  /\\(?:begin|end|frac|sqrt|cdot|times|sum|int|prod|lim|left|right|vmatrix|pmatrix|bmatrix|matrix|mathrm|mathbf|mathbb|alpha|beta|gamma|delta|theta|pi|sigma|infty)\b|\\\[|\\\(|\$\$/;

export function hasLatexContent(input: string): boolean {
  if (!input) return false;
  return LATEX_SIGNATURE.test(input);
}
