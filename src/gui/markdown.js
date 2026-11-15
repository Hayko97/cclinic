// FR-PLAN-037: the PM's text as limited Markdown, built element by element. Nothing in it is ever parsed as HTML.
import { element } from "./api.js";

const FENCE = /^```/;
const BULLET = /^\s*[-*] +/;
const NUMBERED = /^\s*\d+[.)] +/;
const HEADING = /^#{1,6} +/;
/** Inline code, bold, italics, a Markdown link, or a bare web link, in that order of precedence. */
const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)<>]+)/g;

function link(text, href) {
  return element("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
}

/** One line's inline formatting, as text and elements. */
export function inline(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const [whole, code, bold, italic, , label, href, bare] = match;
    if (code !== undefined) parts.push(element("code", {}, code.slice(1, -1)));
    else if (bold !== undefined) parts.push(element("strong", {}, ...inline(bold.slice(2, -2))));
    else if (italic !== undefined) parts.push(element("em", {}, ...inline(italic.slice(1, -1))));
    else if (href !== undefined) parts.push(link(label, href));
    else if (bare !== undefined) parts.push(link(bare, bare));
    else parts.push(whole);
    last = match.index + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function withBreaks(lines) {
  return lines.flatMap((line, index) => (index === 0 ? inline(line) : [element("br"), ...inline(line)]));
}

function kindOf(line) {
  if (BULLET.test(line)) return "ul";
  if (NUMBERED.test(line)) return "ol";
  return HEADING.test(line) ? "heading" : "p";
}

/** Consecutive lines of one kind: a list, a heading, or a paragraph. */
function segment(kind, lines) {
  if (kind === "ul" || kind === "ol") {
    const marker = kind === "ul" ? BULLET : NUMBERED;
    return element(kind, {}, ...lines.map((line) => element("li", {}, ...inline(line.replace(marker, "")))));
  }
  if (kind === "heading")
    return lines.map((line) => element("p", { className: "md-heading" }, ...inline(line.replace(HEADING, ""))));
  return element("p", {}, ...withBreaks(lines));
}

/** A run of lines with no blank line or fence in it, split where its kind of line changes. */
function block(lines) {
  const nodes = [];
  let kind = kindOf(lines[0]);
  let run = [];
  for (const line of lines) {
    if (kindOf(line) !== kind) {
      nodes.push(segment(kind, run));
      kind = kindOf(line);
      run = [];
    }
    run.push(line);
  }
  nodes.push(segment(kind, run));
  return nodes.flat();
}

/** The whole text as block elements: paragraphs, lists, headings and code blocks. */
export function renderMarkdown(text) {
  const nodes = [];
  let lines = [];
  let code;
  const flush = () => {
    if (lines.length > 0) nodes.push(...block(lines));
    lines = [];
  };
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (code !== undefined) {
      if (FENCE.test(line.trim())) {
        nodes.push(element("pre", { className: "md-code" }, element("code", {}, code.join("\n"))));
        code = undefined;
      } else code.push(line);
    } else if (FENCE.test(line.trim())) {
      flush();
      code = [];
    } else if (line.trim() === "") flush();
    else lines.push(line);
  }
  if (code !== undefined) nodes.push(element("pre", { className: "md-code" }, element("code", {}, code.join("\n"))));
  flush();
  return nodes;
}
