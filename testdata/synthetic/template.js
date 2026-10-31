// Runs inside the headless page. build(spec) draws a synthetic manga Page
// (or a two-Page spread) from a JSON spec; groundTruth() measures what was
// actually rendered so coordinates always match the PNG.

const SVG_NS = "http://www.w3.org/2000/svg";
const FONT = '"Yu Gothic", "YuGothic", "Hiragino Sans", "Noto Sans JP", "MS Gothic", sans-serif';

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

// Deterministic PRNG so re-rendering a spec gives identical pixels.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// "{漢字|かんじ}" -> <ruby>漢字<rt>かんじ</rt></ruby>
// "[12]"         -> 縦中横 (horizontal-in-vertical, e.g. numbers, "!?")
// "\n"           -> <br>
function markupToHtml(text) {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/\{([^|}]+)\|([^}]+)\}/g, "<ruby>$1<rt>$2</rt></ruby>")
        .replace(/\[([^\]]+)\]/g, '<span style="text-combine-upright:all">$1</span>'),
    )
    .join("<br>");
}

function markupToPlain(text) {
  return text.replace(/\{([^|}]+)\|[^}]+\}/g, "$1").replace(/\[([^\]]+)\]/g, "$1");
}

function markupToRuby(text) {
  return [...text.matchAll(/\{([^|}]+)\|([^}]+)\}/g)].map((m) => ({
    base: m[1],
    rt: m[2],
  }));
}

// ---- balloon shapes -------------------------------------------------------

function tailPath(b) {
  if (!b.tail) return null;
  const [tx, ty] = b.tail;
  const ang = Math.atan2(ty - b.cy, tx - b.cx);
  const rx = b.w / 2, ry = b.h / 2;
  const spread = 0.18;
  const p = (a) => [b.cx + Math.cos(a) * rx * 0.92, b.cy + Math.sin(a) * ry * 0.92];
  const [x1, y1] = p(ang - spread);
  const [x2, y2] = p(ang + spread);
  return `M${x1},${y1} L${tx},${ty} L${x2},${y2} Z`;
}

function drawBalloon(svg, b) {
  const g = svgEl("g", {}, svg);
  const fill = b.shape === "inverted" ? "#111" : "#fff";
  const stroke = "#111";
  const common = { fill, stroke, "stroke-width": 3 };
  const tail = tailPath(b);
  if (tail && b.shape !== "thought" && b.shape !== "flash") svgEl("path", { d: tail, ...common }, g);

  switch (b.shape) {
    case "ellipse":
    case "inverted":
      svgEl("ellipse", { cx: b.cx, cy: b.cy, rx: b.w / 2, ry: b.h / 2, ...common }, g);
      break;
    case "gradient": { // vertical gradient fill, b.gradient = [top color, bottom color]
      const id = `grad-${b.id}`;
      const lg = svgEl("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, svg.querySelector("defs"));
      svgEl("stop", { offset: 0, "stop-color": b.gradient[0] }, lg);
      svgEl("stop", { offset: 1, "stop-color": b.gradient[1] }, lg);
      svgEl("ellipse", { cx: b.cx, cy: b.cy, rx: b.w / 2, ry: b.h / 2, ...common, fill: `url(#${id})` }, g);
      break;
    }
    case "flash": { // no outline: a white area bounded by radiating lines
      const rand = rng(b.seed ?? 9);
      const n = 90;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand() * 0.03;
        const k0 = 1.0 + rand() * 0.08;
        const k1 = 1.35 + rand() * 0.25;
        svgEl("path", {
          d: `M${b.cx + Math.cos(a) * (b.w / 2) * k0},${b.cy + Math.sin(a) * (b.h / 2) * k0} L${b.cx + Math.cos(a) * (b.w / 2) * k1},${b.cy + Math.sin(a) * (b.h / 2) * k1}`,
          stroke: "#111", "stroke-width": 1.5,
        }, g);
      }
      svgEl("ellipse", { cx: b.cx, cy: b.cy, rx: b.w / 2, ry: b.h / 2, fill: "#fff", stroke: "none" }, g);
      break;
    }
    case "whisper":
      svgEl("ellipse", {
        cx: b.cx, cy: b.cy, rx: b.w / 2, ry: b.h / 2, ...common,
        "stroke-dasharray": "8 6", "stroke-width": 2,
      }, g);
      break;
    case "rect": // narration box
      svgEl("rect", {
        x: b.cx - b.w / 2, y: b.cy - b.h / 2, width: b.w, height: b.h, ...common,
        "stroke-width": 2.5,
      }, g);
      break;
    case "burst": {
      const rand = rng(b.seed ?? 7);
      const n = 22;
      const pts = [];
      for (let i = 0; i < n * 2; i++) {
        const a = (i / (n * 2)) * Math.PI * 2;
        const k = i % 2 === 0 ? 1.0 + rand() * 0.18 : 0.78;
        pts.push(`${b.cx + Math.cos(a) * (b.w / 2) * k},${b.cy + Math.sin(a) * (b.h / 2) * k}`);
      }
      svgEl("polygon", { points: pts.join(" "), ...common }, g);
      break;
    }
    case "thought": {
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        svgEl("circle", {
          cx: b.cx + Math.cos(a) * (b.w / 2) * 0.82,
          cy: b.cy + Math.sin(a) * (b.h / 2) * 0.82,
          r: Math.min(b.w, b.h) * 0.2, ...common,
        }, g);
      }
      svgEl("ellipse", { cx: b.cx, cy: b.cy, rx: b.w / 2 * 0.84, ry: b.h / 2 * 0.84, fill, stroke: "none" }, g);
      if (b.tail) {
        // trail of shrinking bubbles toward the thinker
        const [tx, ty] = b.tail;
        for (let i = 1; i <= 3; i++) {
          const t = 0.55 + i * 0.13;
          svgEl("circle", {
            cx: b.cx + (tx - b.cx) * t, cy: b.cy + (ty - b.cy) * t,
            r: 12 - i * 3, ...common, "stroke-width": 2,
          }, g);
        }
      }
      break;
    }
    case "none":
      break;
    default:
      throw new Error(`unknown shape ${b.shape}`);
  }
  return g;
}

// ---- background art (simple original shapes only) -------------------------

function drawArt(svg, a) {
  const line = { stroke: "#111", "stroke-width": a.sw ?? 3, fill: "none", "stroke-linecap": "round" };
  switch (a.type) {
    case "face": {
      // a round-headed figure: head, eyes, mouth, optional hair tuft, shoulders
      const { x, y, r } = a;
      svgEl("path", { d: `M${x - r * 1.6},${y + r * 2.6} Q${x},${y + r * 0.9} ${x + r * 1.6},${y + r * 2.6}`, ...line }, svg);
      svgEl("circle", { cx: x, cy: y, r, fill: "#fff", ...line }, svg);
      const eye = a.eyes ?? "dot";
      for (const dx of [-0.35, 0.35]) {
        if (eye === "dot") svgEl("circle", { cx: x + dx * r, cy: y - 0.1 * r, r: r * 0.08, fill: "#111" }, svg);
        else svgEl("path", { d: `M${x + dx * r - r * 0.12},${y - 0.1 * r} l${r * 0.24},0`, ...line }, svg);
      }
      const m = a.mouth ?? "smile";
      const my = y + 0.38 * r;
      if (m === "smile") svgEl("path", { d: `M${x - r * 0.25},${my} Q${x},${my + r * 0.2} ${x + r * 0.25},${my}`, ...line }, svg);
      else if (m === "open") svgEl("ellipse", { cx: x, cy: my + r * 0.05, rx: r * 0.14, ry: r * 0.18, fill: "#111" }, svg);
      else svgEl("path", { d: `M${x - r * 0.2},${my} l${r * 0.4},0`, ...line }, svg);
      if (a.hair) svgEl("path", { d: `M${x - r * 0.9},${y - r * 0.4} Q${x - r * 0.3},${y - r * 1.5} ${x + r * 0.9},${y - r * 0.5}`, ...line, "stroke-width": 6 }, svg);
      break;
    }
    case "rect":
      svgEl("rect", { x: a.x, y: a.y, width: a.w, height: a.h, ...line, fill: a.fill ?? "none" }, svg);
      break;
    case "line":
      svgEl("path", { d: `M${a.x1},${a.y1} L${a.x2},${a.y2}`, ...line }, svg);
      break;
    case "circle":
      svgEl("circle", { cx: a.x, cy: a.y, r: a.r, ...line, fill: a.fill ?? "none" }, svg);
      break;
    case "tone": // halftone dot screen, like screentone
      svgEl("rect", { x: a.x, y: a.y, width: a.w, height: a.h, fill: `url(#tone${a.dark ? "Dark" : ""})` }, svg);
      break;
    case "speedlines": {
      const rand = rng(a.seed ?? 3);
      for (let i = 0; i < (a.n ?? 60); i++) {
        const ang = rand() * Math.PI * 2;
        const r0 = a.r0 + rand() * 40;
        svgEl("path", {
          d: `M${a.x + Math.cos(ang) * r0},${a.y + Math.sin(ang) * r0} L${a.x + Math.cos(ang) * a.r1},${a.y + Math.sin(ang) * a.r1}`,
          stroke: "#111", "stroke-width": 1 + rand() * 2,
        }, svg);
      }
      break;
    }
    case "hlines": // horizontal motion lines inside a box
      for (let yy = a.y; yy < a.y + a.h; yy += a.gap ?? 14)
        svgEl("path", { d: `M${a.x},${yy} l${a.w},0`, stroke: "#111", "stroke-width": 1.5 }, svg);
      break;
    default:
      throw new Error(`unknown art ${a.type}`);
  }
}

// ---- page assembly ---------------------------------------------------------

window.build = function build(spec) {
  const W = spec.width, H = spec.height;
  document.body.style.cssText = `margin:0;background:#fff;width:${W}px;height:${H}px;overflow:hidden;position:relative;font-family:${FONT}`;

  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  svg.style.cssText = "position:absolute;left:0;top:0";
  document.body.appendChild(svg);

  const defs = svgEl("defs", {}, svg);
  for (const [id, r] of [["tone", 1.4], ["toneDark", 2.6]]) {
    const p = svgEl("pattern", { id, width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    svgEl("circle", { cx: 3.5, cy: 3.5, r, fill: "#111" }, p);
  }
  // Hand-drawn look for sfx: wobble the glyph outlines with turbulence.
  const rough = svgEl("filter", { id: "rough", x: "-10%", y: "-10%", width: "120%", height: "120%" }, defs);
  svgEl("feTurbulence", { type: "fractalNoise", baseFrequency: 0.045, numOctaves: 2, seed: 7, result: "noise" }, rough);
  svgEl("feDisplacementMap", { in: "SourceGraphic", in2: "noise", scale: 7, xChannelSelector: "R", yChannelSelector: "G" }, rough);

  // Page edges of a spread: a faint gutter shadow so it looks like an e-book reader's spread.
  for (const pg of spec.pages ?? []) {
    svgEl("rect", { x: pg.bbox[0], y: pg.bbox[1], width: pg.bbox[2], height: pg.bbox[3], fill: "none", stroke: "#ddd", "stroke-width": 1 }, svg);
  }

  // Panels: clip art to the panel, then draw the border on top.
  for (const p of spec.panels) {
    const clipId = `clip-${p.id}`;
    const cp = svgEl("clipPath", { id: clipId }, defs);
    svgEl("polygon", { points: p.points.map((q) => q.join(",")).join(" ") }, cp);
    const g = svgEl("g", { "clip-path": `url(#${clipId})` }, svg);
    if (p.fill) svgEl("polygon", { points: p.points.map((q) => q.join(",")).join(" "), fill: p.fill }, g);
    for (const a of p.art ?? []) drawArt(g, a);
  }
  for (const p of spec.panels) {
    svgEl("polygon", {
      points: p.points.map((q) => q.join(",")).join(" "),
      fill: "none", stroke: "#111", "stroke-width": 4, "stroke-linejoin": "miter",
    }, svg);
  }
  for (const a of spec.art ?? []) drawArt(svg, a); // art that ignores panel borders

  // Text: balloon shapes go into the SVG; the text itself is HTML so that
  // vertical writing and ruby are laid out by the browser.
  for (const t of spec.texts) {
    if (t.shape && t.shape !== "none") drawBalloon(svg, t);
  }
  for (const t of spec.texts) {
    const div = document.createElement("div");
    div.dataset.textId = t.id;
    const vertical = (t.orientation ?? "vertical") === "vertical";
    const color = t.shape === "inverted" || t.color === "white" ? "#fff" : "#111";
    const size = t.fontSize ?? 22;
    let css = `position:absolute;left:${t.cx}px;top:${t.cy}px;` +
      `transform:translate(-50%,-50%) rotate(${t.rotate ?? 0}deg) skewY(${t.skewY ?? 0}deg);` +
      `writing-mode:${vertical ? "vertical-rl" : "horizontal-tb"};` +
      `font-size:${size}px;line-height:${t.lineHeight ?? 1.35};font-weight:${t.weight ?? 700};` +
      `color:${color};white-space:nowrap;text-align:${vertical ? "start" : "center"};` +
      `font-family:${t.font === "mincho" ? '"Yu Mincho","Hiragino Mincho ProN","MS Mincho",serif' : FONT};`;
    if (t.kind === "sfx") {
      css += `-webkit-text-stroke:${Math.max(2, size / 14)}px #111;color:#fff;paint-order:stroke fill;letter-spacing:-0.05em;`;
      if (t.color === "black") css += "color:#111;-webkit-text-stroke:0;";
    }
    // Black text with a white outline, as monologue over line art often is.
    if (t.outline === "white") css += `-webkit-text-stroke:${Math.max(3, size / 6)}px #fff;paint-order:stroke fill;`;
    if (t.skew) css += `font-style:italic;`;
    if (t.rough) css += `filter:url(#rough);`;
    div.style.cssText = css;
    div.innerHTML = markupToHtml(t.ja);
    document.body.appendChild(div);
  }
};

function rect(r) {
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
}

window.groundTruth = function groundTruth(spec) {
  const panelBox = (p) => {
    const xs = p.points.map((q) => q[0]), ys = p.points.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
  };
  return {
    id: spec.id,
    description: spec.description,
    image: `${spec.id}.png`,
    width: spec.width,
    height: spec.height,
    readingDirection: "rtl",
    pages: spec.pages ?? [{ index: 0, bbox: [0, 0, spec.width, spec.height] }],
    panels: spec.panels.map((p) => ({
      id: p.id,
      page: p.page ?? 0,
      order: p.order,
      bbox: panelBox(p),
      polygon: p.points,
    })),
    texts: spec.texts
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((t) => {
        const el = document.querySelector(`[data-text-id="${t.id}"]`);
        const range = document.createRange();
        range.selectNodeContents(el);
        const textBox = rect(range.getBoundingClientRect());
        const hasShape = t.shape && t.shape !== "none";
        return {
          id: t.id,
          kind: t.kind,
          shape: t.shape ?? "none",
          panel: t.panel ?? null,
          page: t.page ?? 0,
          order: t.order,
          orientation: t.orientation ?? "vertical",
          rotate: t.rotate ?? 0,
          bbox: hasShape
            ? [Math.round(t.cx - t.w / 2), Math.round(t.cy - t.h / 2), t.w, t.h]
            : textBox,
          textBbox: textBox,
          ja: markupToPlain(t.ja).replace(/\n/g, ""),
          jaLines: markupToPlain(t.ja).split("\n"),
          ruby: markupToRuby(t.ja),
          reading: t.reading,
          zh: t.zh,
        };
      }),
  };
};
