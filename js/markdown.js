// Minimal, dependency-free Markdown rendering for topic cards.
//
// Supported syntax (a deliberate subset – cards are short notes, not documents):
//   **bold**  *italic*  ~~strikethrough~~  `inline code`
//   ``` fenced code blocks ```
//   [text](https://… | mailto:…)  and  autolinks like <https://…>
//   a single newline becomes a <br> (matches the previous pre-wrap behaviour)
//
// Safety model: the input is HTML-escaped FIRST, then the formatting rules run
// on the escaped text. Raw HTML can therefore never reach the DOM, and links
// must match an allow-listed scheme (https?, mailto) or they stay literal text.
// Underscore emphasis is intentionally not supported: `_italic_` conflicts with
// snake_case identifiers, which show up often in dev-team topics.

// Placeholder tokens use private-use characters that cannot appear in escaped
// user input, so extracted code spans survive the inline rules untouched.
const TOKEN_START = '\uE000';
const TOKEN_END = '\uE001';

const RE_FENCE = /```[^\n]*\n[\s\S]*?(?:```|$)/g;
const RE_INLINE_CODE = /`[^`\n]+`/g;
// Link targets are matched on already-escaped text; quotes are entities there,
// so the character class cannot break out of the href attribute.
const RE_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/gi;
// Autolinks <https://…>: matched on escaped text, so the delimiters are the
// &lt;/&gt; entities. The lazy URL stops at the closing &gt;.
const RE_AUTOLINK = /&lt;((?:https?:\/\/|mailto:)[^\s]*?)&gt;/gi;
// Emphasis delimiters must hug non-space content, so "2 * 3 * 4" stays literal.
const RE_BOLD = /\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/g;
const RE_ITALIC = /\*([^\s*](?:[^*\n]*[^\s*])?)\*/g;
const RE_STRIKE = /~~([^\s~](?:[^~\n]*[^\s~])?)~~/g;

/**
 * Render topic text as safe HTML.
 * @param {string} text  raw Markdown source (as stored in the database)
 * @returns {string} HTML string, safe to assign via innerHTML
 */
export function renderMarkdown(text) {
  const escaped = escapeHtml(String(text ?? ''));
  const stash = [];

  const keep = (html) => {
    stash.push(html);
    return TOKEN_START + (stash.length - 1) + TOKEN_END;
  };

  let out = escaped
    // Code first, so its contents are exempt from every other rule.
    .replace(RE_FENCE, (m) => keep(
      `<pre class="md-block"><code>${m.replace(/^```[^\n]*\n/, '').replace(/```\s*$/, '')}</code></pre>`))
    .replace(RE_INLINE_CODE, (m) => keep(`<code class="md-inline">${m.slice(1, -1)}</code>`))
    .replace(RE_LINK, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(RE_AUTOLINK, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(RE_BOLD, '<strong>$1</strong>')
    .replace(RE_ITALIC, '<em>$1</em>')
    .replace(RE_STRIKE, '<del>$1</del>')
    .replace(/\n/g, '<br>');

  // Restore stashed code, whose newlines are meaningful inside <pre>.
  out = out.replace(new RegExp(`${TOKEN_START}(\\d+)${TOKEN_END}`, 'g'),
    (_, i) => stash[Number(i)]);

  return out;
}

/**
 * Plain-text version of topic text (markers stripped) for aria-labels and
 * other non-HTML contexts.
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, '$1')
    .replace(/\*\*|~~|\*/g, '');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
