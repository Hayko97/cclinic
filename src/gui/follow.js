// Live output and transcript views: following new lines, and search, filter and folding (FR-GUI-058, FR-GUI-059).
import { element } from "./api.js";

/** A view scrolled to within this of its end counts as at the bottom. */
const BOTTOM_TOLERANCE_PX = 8;

export const FOLLOWING = Object.freeze({ isFollowing: true, buffered: 0 });

/**
 * FR-GUI-058: `lines` adds new lines, `away` is scrolling up, selecting text or jumping to a match, and `bottom` is
 * scrolling back to the end or pressing "Jump to latest". New lines are counted while paused, never dropped.
 */
export function nextFollow(state, event) {
  if (event.type === "bottom") return FOLLOWING;
  if (event.type === "away") return state.isFollowing ? { isFollowing: false, buffered: 0 } : state;
  return state.isFollowing ? state : { isFollowing: false, buffered: state.buffered + event.count };
}

const isAtBottom = (scroller) =>
  scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < BOTTOM_TOLERANCE_PX;

/** Follows `scroller` as lines are added, with a "Jump to latest" button. `stop` removes its page-wide listener. */
export function followView(scroller) {
  let state = FOLLOWING;
  const jump = element("button", { type: "button", className: "small jump-latest", hidden: true });
  const show = () => {
    jump.hidden = state.isFollowing;
    jump.textContent = `Jump to latest (${state.buffered} new)`;
  };
  const apply = (event) => {
    state = nextFollow(state, event);
    show();
  };
  const toEnd = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };
  scroller.addEventListener("scroll", () => apply({ type: isAtBottom(scroller) ? "bottom" : "away" }));
  const onSelect = () => {
    const selection = document.getSelection();
    if (selection !== null && !selection.isCollapsed && scroller.contains(selection.anchorNode))
      apply({ type: "away" });
  };
  document.addEventListener("selectionchange", onSelect);
  jump.addEventListener("click", () => {
    apply({ type: "bottom" });
    toEnd();
  });
  return {
    jump,
    /** Called after `count` lines were added, or 0 after what's shown was replaced. */
    added(count) {
      apply({ type: "lines", count });
      if (state.isFollowing) toEnd();
    },
    pause: () => apply({ type: "away" }),
    reset() {
      state = FOLLOWING;
      show();
    },
    stop: () => document.removeEventListener("selectionchange", onSelect),
  };
}

/** Shows `text` in `node` with each match of `term` marked, as text only. */
function markText(node, text, term) {
  if (term === "") {
    node.textContent = text;
    return 0;
  }
  const lower = text.toLowerCase();
  const parts = [];
  let from = 0;
  let count = 0;
  for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) {
    parts.push(text.slice(from, at), element("mark", {}, text.slice(at, at + term.length)));
    from = at + term.length;
    count += 1;
  }
  parts.push(text.slice(from));
  node.replaceChildren(...parts);
  return count;
}

/**
 * FR-GUI-059: a search box, and for transcripts a filter by entry kind, over `list`'s items. Each item holds its
 * text in a `.text` node; tool results longer than `foldLines` lines are folded with a button to unfold.
 */
export function viewTools(list, { kinds, foldLines, follow, label }) {
  const texts = new WeakMap();
  const unfolded = new WeakSet();
  const search = element("input", { type: "search", placeholder: "Search", "aria-label": `Search ${label}` });
  const kind =
    kinds === undefined
      ? null
      : element(
          "select",
          { "aria-label": `Show ${label} entries` },
          element("option", { value: "" }, "All entries"),
          Object.entries(kinds).map(([value, text]) => element("option", { value }, text)),
        );
  const count = element("span", { className: "muted match-count", role: "status" });
  const term = () => search.value.trim().toLowerCase();

  /** Draws one item: its text folded or not, with matches marked. Returns how many matches it has. */
  const draw = (item) => {
    const node = item.querySelector(".text");
    const text = texts.get(item) ?? node.textContent;
    texts.set(item, text);
    const lines = text.split("\n");
    const isLong = foldLines !== undefined && item.dataset.kind === "tool-result" && lines.length > foldLines;
    // A search match in the folded part shows the result whole, so no match is hidden.
    const hasHiddenMatch = isLong && term() !== "" && lines.slice(foldLines).join("\n").toLowerCase().includes(term());
    const isFolded = isLong && !unfolded.has(item) && !hasHiddenMatch;
    const matches = markText(node, isFolded ? lines.slice(0, foldLines).join("\n") : text, term());
    item.querySelector(".fold")?.remove();
    if (isLong && !hasHiddenMatch) {
      const button = element(
        "button",
        { type: "button", className: "small fold", "aria-expanded": String(!isFolded) },
        isFolded ? `Show all ${lines.length} lines` : "Fold",
      );
      button.addEventListener("click", () => {
        if (isFolded) unfolded.add(item);
        else unfolded.delete(item);
        draw(item);
      });
      item.append(button);
    }
    const isShown = kind === null || kind.value === "" || item.dataset.kind === kind.value;
    item.hidden = !isShown;
    return isShown ? matches : 0;
  };
  const drawAll = () => {
    let total = 0;
    for (const item of list.children) total += draw(item);
    count.textContent = term() === "" ? "" : `${total} match${total === 1 ? "" : "es"}`;
  };
  const jumpToMatch = () => {
    const first = list.querySelector(":scope > :not([hidden]) mark");
    if (first === null) return;
    follow.pause();
    first.scrollIntoView({ block: "center" });
  };
  search.addEventListener("input", drawAll);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") jumpToMatch();
  });
  kind?.addEventListener("change", drawAll);
  return {
    bar: element("div", { className: "view-tools" }, search, kind, count, follow.jump),
    /** Draws items just added, so a search or filter applies to them too. */
    added(items) {
      for (const item of items) draw(item);
      if (term() !== "") drawAll();
    },
  };
}
