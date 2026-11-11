// Line icons for the page's buttons, drawn as inline SVG: the page's content security policy allows no
// image URLs but its own, and the icons are hidden from screen readers, so each button keeps its own label.

/** Each icon's SVG drawing, on a 24 by 24 grid. */
const ICONS = {
  canvas: [
    ["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }],
    ["path", { d: "M10 6.5h4M17.5 10v4" }],
  ],
  setup: [
    ["path", { d: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" }],
    ["circle", { cx: 16, cy: 6, r: 2 }],
    ["circle", { cx: 10, cy: 12, r: 2 }],
    ["circle", { cx: 18, cy: 18, r: 2 }],
  ],
  jobs: [
    ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }],
    ["path", { d: "M7 9l3 3-3 3M13 15h4" }],
  ],
  grid: [
    ["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2.5 }],
    ["path", { d: "M3 12h18M12 3v18" }],
  ],
  list: [["path", { d: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  fit: [
    ["path", { d: "M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" }],
  ],
  pulse: [["path", { d: "M22 12h-4l-3 9L9 3l-3 9H2" }]],
};

/** Which button gets which icon. */
const PLACES = {
  '[data-view="canvas"]': "canvas",
  '[data-view="setup"]': "setup",
  '[data-view="jobs"]': "jobs",
  '[data-layout="canvas"]': "grid",
  '[data-layout="list"]': "list",
  "#add-task-open": "plus",
  "#zoom-fit": "fit",
  "#run-doctor": "pulse",
};

function icon(name) {
  // The page's own SVG namespace, read from the arrows layer, so no namespace URL is written here.
  const namespace = document.getElementById("arrows").namespaceURI;
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attributes] of ICONS[name]) {
    const shape = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, String(value));
    svg.append(shape);
  }
  return svg;
}

export function addIcons() {
  for (const [selector, name] of Object.entries(PLACES))
    for (const button of document.querySelectorAll(selector)) button.prepend(icon(name));
}
