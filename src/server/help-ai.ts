import { sanitizeHelpHtml } from "./help-sanitize";
import appKnowledge from "./knowledge/app-knowledge.json";

// AI-assisted help-article drafting via Cloudflare Workers AI (spec 0027). Given a topic, ask
// Llama for a title, excerpt, and Markdown body, grounded in a curated description of AW File
// Storage plus the org's own (and shared) published articles as reference context. The Markdown is
// converted to HTML in-house (no dependency) and then run through the SAME js-xss sanitizer as
// hand-authored content, so nothing off-whitelist can reach the editor. Stateless: nothing is
// stored here; the admin reviews and saves the draft through the normal editor path.

// Cloudflare Workers AI model. The plain "@cf/meta/llama-3.1-8b-instruct" was deprecated
// (2026-05-30); this is the current 8B instruct model. For higher-quality drafts swap in
// "@cf/meta/llama-3.3-70b-instruct-fp8-fast" (70B, costs more). Check the catalog if this
// ever errors with a deprecation code: https://developers.cloudflare.com/workers-ai/models/
export const HELP_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

// The minimal shape of the Workers AI binding we use (text generation with chat messages).
export interface WorkersAi {
  run(
    model: string,
    options: Record<string, unknown>,
  ): Promise<{ response?: string } | Record<string, unknown>>;
}

// A curated, factual description of the app so drafts talk about THIS product, not a generic one.
// The content lives in ./knowledge/app-knowledge.json (editable without touching this code, bundled
// at build — Workers have no runtime filesystem); this assembles it into the system-prompt block.
// To teach the AI about a new feature, add a line to that file's "features" array.
export const APP_KNOWLEDGE = [
  appKnowledge.summary,
  "",
  "FEATURES (describe only these; use the page names and button labels exactly):",
  "",
  ...appKnowledge.features.map((f) => `- ${f}`),
  "",
  appKnowledge.houseRules,
].join("\n");

export interface ContextArticle {
  id: string;
  title: string;
  category?: string | null;
  excerpt?: string | null;
  searchText?: string;
}

export interface DraftInput {
  topic: string;
  instructions?: string;
}

export interface GeneratedDraft {
  title: string;
  excerpt: string;
  bodyHtml: string;
}

/** Pick the few most relevant reference articles for the topic by simple word-overlap scoring
 * against each article's title + searchText. Input is already the reader union (own + shared),
 * so this never reaches another org's private content. */
export function selectContextArticles(
  topic: string,
  articles: ContextArticle[],
  max = 4,
): ContextArticle[] {
  const words = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return articles.slice(0, max);
  const scored = articles.map((a) => {
    const hay = `${a.title} ${a.excerpt ?? ""} ${a.searchText ?? ""}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += 1;
    return { a, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, max)
    .map((s) => s.a);
}

/** Build the chat messages: a system prompt (app knowledge + house rules) and a user prompt
 * (topic + instructions + trimmed reference context + the required labeled output shape). A
 * delimiter format is used instead of JSON because the Markdown body routinely contains quotes and
 * newlines that break JSON — everything after "BODY:" is taken verbatim, so nothing needs escaping. */
export function buildDraftMessages(
  input: DraftInput,
  context: ContextArticle[],
): { role: "system" | "user"; content: string }[] {
  const system = `${APP_KNOWLEDGE}

You are a technical writer drafting one help article. Rules:
- Clear, friendly, concise. Second person ("you").
- Structure the body in Markdown: short intro paragraph, then "##" section headings, steps as numbered lists, options as bullet lists. Use "###" for sub-steps only if needed.
- Only describe features listed above. If the topic is outside the app, write a short article saying the app does not cover it.
- Do not include the title as a heading inside the body (the title is separate).`;

  const ctx =
    context.length > 0
      ? `Reference (existing published articles, for wording/scope only):\n${context
          .map((a, i) => {
            const body = (a.searchText ?? "").slice(0, i < 2 ? 600 : 0);
            return `- ${a.title}${a.excerpt ? `: ${a.excerpt}` : ""}${
              body ? `\n  ${body}` : ""
            }`;
          })
          .join("\n")}\n\n`
      : "";

  const user = `${ctx}Write a help article about: ${input.topic}${
    input.instructions ? `\nExtra instructions: ${input.instructions}` : ""
  }

Respond in EXACTLY this format and nothing else — no preamble, no code fences:
TITLE: <short article title, one line>
EXCERPT: <one-sentence summary, one line>
BODY:
<the article body in Markdown; everything after this line is the body>`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Undo the JSON string escapes an LLM emits, so an extracted field reads as plain text/Markdown. */
function unescapeJsonString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\");
}

/** Pull title/excerpt/body out of a JSON-SHAPED response that `JSON.parse` rejects — the common
 * Llama failure: the "body" value carries literal newlines AND unescaped double-quotes (button
 * names like "Browse files"), both invalid JSON. Because "body" is always the last field, we take
 * everything from `"body": "` to the final quote, so inner quotes/newlines can't truncate it.
 * Returns empty strings when the shape isn't found (caller then uses the whole response). */
export function extractDraftFields(
  raw: string,
): { title: string; excerpt: string; bodyMarkdown: string } {
  // Short fields: value ends at the first unescaped quote (they rarely contain quotes).
  const short = (key: string) => {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? unescapeJsonString(m[1]).trim() : "";
  };
  const title = short("title");
  const excerpt = short("excerpt");

  let bodyMarkdown = "";
  const bodyStart = raw.match(/"body"\s*:\s*"/);
  if (bodyStart?.index != null) {
    const from = bodyStart.index + bodyStart[0].length;
    const rest = raw.slice(from);
    const lastQuote = rest.lastIndexOf('"'); // the closing quote before the final "}"
    bodyMarkdown = unescapeJsonString(
      lastQuote >= 0 ? rest.slice(0, lastQuote) : rest,
    ).trim();
  }
  return { title, excerpt, bodyMarkdown };
}

/** Parse the delimiter format the prompt asks for:
 *   TITLE: ...
 *   EXCERPT: ...
 *   BODY:
 *   <markdown, everything after>
 * Everything after "BODY:" is the body verbatim, so quotes/newlines in it are harmless. Returns
 * null when there is no BODY marker (caller then tries the JSON paths). */
export function parseDelimitedResponse(
  raw: string,
): { title: string; excerpt: string; bodyMarkdown: string } | null {
  const bodyM = raw.match(/^[ \t]*BODY[ \t]*:[ \t]*\r?\n?([\s\S]*)$/im);
  if (!bodyM) return null;
  // Only look for TITLE/EXCERPT in the text BEFORE the body marker, so a "TITLE:" written inside
  // the body Markdown can't be mistaken for the header.
  const head = raw.slice(0, bodyM.index);
  const line = (key: string) => {
    const m = head.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+)$`, "im"));
    return m ? m[1].trim() : "";
  };
  return {
    title: line("TITLE"),
    excerpt: line("EXCERPT"),
    bodyMarkdown: bodyM[1].trim(),
  };
}

/** Pull the draft fields out of the model's raw text, defensively: the labeled TITLE/EXCERPT/BODY
 * format first, then clean JSON, then the first {...} block, then malformed-but-JSON-shaped output
 * pulled out positionally (body last), else treat the whole response as the Markdown body. */
export function parseDraftResponse(
  raw: string,
  topic: string,
): { title: string; excerpt: string; bodyMarkdown: string } {
  const fallbackTitle = topic.trim().slice(0, 120) || "Untitled";

  const delimited = parseDelimitedResponse(raw);
  if (delimited && (delimited.title || delimited.bodyMarkdown)) {
    return {
      title: delimited.title || fallbackTitle,
      excerpt: delimited.excerpt,
      bodyMarkdown: delimited.bodyMarkdown,
    };
  }

  const tryObj = (text: string) => {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      if (o && typeof o === "object") return o;
    } catch {
      /* not JSON */
    }
    return null;
  };

  let obj = tryObj(raw.trim());
  if (!obj) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) obj = tryObj(raw.slice(start, end + 1));
  }

  if (obj) {
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const excerpt = typeof obj.excerpt === "string" ? obj.excerpt.trim() : "";
    const body = typeof obj.body === "string" ? obj.body : "";
    if (title || body) {
      return {
        title: title || fallbackTitle,
        excerpt,
        bodyMarkdown: body,
      };
    }
  }

  // JSON-shaped but unparseable (literal newlines + unescaped quotes in "body", the common Llama
  // output): pull the fields out positionally rather than dumping the raw {…} wrapper into the body.
  const loose = extractDraftFields(raw);
  if (loose.title || loose.bodyMarkdown) {
    return {
      title: loose.title || fallbackTitle,
      excerpt: loose.excerpt,
      bodyMarkdown: loose.bodyMarkdown,
    };
  }

  // No usable structure at all: use the whole response as the body.
  return { title: fallbackTitle, excerpt: "", bodyMarkdown: raw };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Inline Markdown → HTML (code, bold, italic, links). Escapes first; only safe URL schemes.
function inlineMd(text: string): string {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  t = t.replace(/(^|[^_])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => {
    const safe = /^(https?:|mailto:|\/)/i.test(url) ? url : "#";
    return `<a href="${escapeHtml(safe)}">${txt}</a>`;
  });
  return t;
}

/** A focused Markdown → HTML converter for LLM help output: fenced code, ATX headings, ordered
 * and unordered lists, blockquotes, horizontal rules, and paragraphs. The result is sanitized by
 * the caller, so anything unexpected is dropped rather than trusted. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineMd(para.join(" ").trim())}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^\s*```/);
    if (fence) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      out.push(`<h${level}>${inlineMd(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }

    // Blockquote (consecutive)
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inlineMd(buf.join(" ").trim())}</blockquote>`);
      continue;
    }

    // Unordered list (consecutive)
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^\s*[-*+]\s+/, "").trim())}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list (consecutive)
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^\s*\d+\.\s+/, "").trim())}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Blank line ends a paragraph
    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }

    // Otherwise accumulate into the current paragraph
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join("\n");
}

/** Run the whole pipeline: call Workers AI, parse, convert Markdown → HTML, sanitize. Title and
 * excerpt are returned as plain text. */
export async function generateDraft(
  ai: WorkersAi,
  input: DraftInput,
  candidates: ContextArticle[],
): Promise<GeneratedDraft> {
  const context = selectContextArticles(input.topic, candidates);
  const messages = buildDraftMessages(input, context);
  const res = await ai.run(HELP_AI_MODEL, {
    messages,
    max_tokens: 1600,
    temperature: 0.4,
  });
  const raw =
    res && typeof (res as { response?: unknown }).response === "string"
      ? ((res as { response: string }).response as string)
      : "";
  const parsed = parseDraftResponse(raw, input.topic);
  const bodyHtml = sanitizeHelpHtml(markdownToHtml(parsed.bodyMarkdown));
  const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return {
    title: strip(parsed.title).slice(0, 200),
    excerpt: strip(parsed.excerpt).slice(0, 300),
    bodyHtml,
  };
}
