// tracetap observatory — shared chart/tooltip library (inlined before app.js).
// Hand-rolled SVG, zero dependencies.
"use strict";

/** Singleton hover tooltip. Views bind containers via TT.bind(el, selector, fn). */
var TT = (function () {
  var el = null;

  function escT(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ensure() {
    if (!el) {
      el = document.createElement("div");
      el.className = "tt";
      document.body.appendChild(el);
    }
    return el;
  }
  function position(x, y) {
    var pad = 14;
    var r = el.getBoundingClientRect();
    var nx = x + pad, ny = y + pad;
    if (nx + r.width > window.innerWidth - 8) nx = x - r.width - pad;
    if (ny + r.height > window.innerHeight - 8) ny = y - r.height - pad;
    el.style.left = Math.max(4, nx) + "px";
    el.style.top = Math.max(4, ny) + "px";
  }
  function show(html, x, y) {
    var t = ensure();
    t.innerHTML = html;
    t.classList.add("on");
    position(x, y);
  }
  function hide() {
    if (el) el.classList.remove("on");
  }
  /** Delegated hover: htmlFn(target) returns tooltip HTML or null. */
  function bind(container, selector, htmlFn) {
    container.addEventListener("mousemove", function (e) {
      var t = e.target.closest(selector);
      if (!t || !container.contains(t)) { hide(); return; }
      var html = htmlFn(t, e);
      if (!html) { hide(); return; }
      show(html, e.clientX, e.clientY);
    });
    container.addEventListener("mouseleave", hide);
  }
  function title(s) { return '<div class="tt-title">' + escT(s) + "</div>"; }
  function row(k, v) {
    return '<div class="tt-row"><span class="k">' + escT(k) + '</span><span class="v">' + v + "</span></div>";
  }

  return { show: show, hide: hide, bind: bind, title: title, row: row, esc: escT };
})();

/** Hand-rolled SVG charts for the analytics view. */
var TracetapCharts = (function () {
  var esc = TT.esc;

  function fmtDur(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return Math.round(ms) + "ms";
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + "s";
    return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  }
  function fmtCost(c) {
    if (c == null) return "—";
    return c >= 100 ? "$" + c.toFixed(0) : c >= 0.01 || c === 0 ? "$" + c.toFixed(2) : "$" + c.toFixed(4);
  }
  function iso(dt) {
    var p = function (n) { return String(n).padStart(2, "0"); };
    return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
  }

  // -- calendar heatmap (26 weeks of daily cost) ---------------------------
  function calendarHeatmap(trend) {
    var byDate = {}, max = 0;
    trend.forEach(function (d) {
      byDate[d.date] = d;
      if (d.costUsd > max) max = d.costUsd;
    });
    var CELL = 12, GAP = 3, LEFT = 30, TOP = 18;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var start = new Date(today);
    start.setDate(start.getDate() - 181);
    start.setDate(start.getDate() - start.getDay()); // align to Sunday
    var weeks = Math.ceil(((today - start) / 86400000 + 1) / 7);
    var W = LEFT + weeks * (CELL + GAP) + 4, H = TOP + 7 * (CELL + GAP) + 4;

    var cells = [], months = [], lastMonth = -1;
    for (var w = 0; w < weeks; w++) {
      for (var d = 0; d < 7; d++) {
        var dt = new Date(start);
        dt.setDate(start.getDate() + w * 7 + d);
        if (dt > today) continue;
        var key = iso(dt);
        var rec = byDate[key];
        var x = LEFT + w * (CELL + GAP), y = TOP + d * (CELL + GAP);
        if (d === 0 && dt.getMonth() !== lastMonth) {
          lastMonth = dt.getMonth();
          months.push('<text x="' + x + '" y="10" class="hm-month">' + dt.toLocaleString("en", { month: "short" }).toUpperCase() + "</text>");
        }
        var attrs = rec && rec.costUsd > 0
          ? 'fill="var(--accent)" fill-opacity="' + (0.22 + 0.78 * Math.sqrt(rec.costUsd / max)).toFixed(2) + '"'
          : 'fill="var(--surface-2)"';
        cells.push('<rect class="hm-cell" x="' + x + '" y="' + y + '" width="' + CELL + '" height="' + CELL +
          '" rx="2.5" ' + attrs + ' data-d="' + key + '" data-c="' + (rec ? rec.costUsd : 0) +
          '" data-e="' + (rec ? rec.events : 0) + '"></rect>');
      }
    }
    var days = ["", "MON", "", "WED", "", "FRI", ""].map(function (lbl, i) {
      return lbl ? '<text x="' + (LEFT - 6) + '" y="' + (TOP + i * (CELL + GAP) + 9) + '" text-anchor="end" class="hm-day">' + lbl + "</text>" : "";
    }).join("");
    return '<svg viewBox="0 0 ' + W + " " + H + '" style="max-width:' + W + 'px">' +
      months.join("") + days + cells.join("") + "</svg>";
  }

  // -- squarified treemap (cost by project) --------------------------------
  function squarify(items, x, y, w, h) {
    var out = [];
    var total = 0;
    items.forEach(function (it) { total += it.value; });
    if (total <= 0 || w <= 0 || h <= 0) return out;
    var scale = (w * h) / total;
    var row = [], rx = x, ry = y, rw = w, rh = h;

    function worst(r, side) {
      var sum = 0, min = Infinity, mx = 0;
      r.forEach(function (it) {
        var a = it.value * scale;
        sum += a;
        if (a < min) min = a;
        if (a > mx) mx = a;
      });
      var s2 = sum * sum, w2 = side * side;
      return Math.max((w2 * mx) / s2, s2 / (w2 * min));
    }
    function layoutRow() {
      var sum = 0;
      row.forEach(function (it) { sum += it.value * scale; });
      var horiz = rw < rh;
      var side = horiz ? rw : rh;
      var thick = sum / side, off = 0;
      row.forEach(function (it) {
        var len = (it.value * scale) / thick;
        out.push(horiz
          ? { x: rx + off, y: ry, w: len, h: thick, item: it }
          : { x: rx, y: ry + off, w: thick, h: len, item: it });
        off += len;
      });
      if (horiz) { ry += thick; rh -= thick; } else { rx += thick; rw -= thick; }
      row = [];
    }
    items.forEach(function (it) {
      if (it.value <= 0) return;
      var side = Math.min(rw, rh);
      if (row.length && worst(row.concat([it]), side) > worst(row, side)) layoutRow();
      row.push(it);
    });
    if (row.length) layoutRow();
    return out;
  }

  var TM_COLORS = ["var(--accent)", "var(--teal)", "var(--accent2)", "var(--green)", "var(--amber)", "var(--red)", "var(--mid)"];

  /** items: [{label, value, idx}] pre-sorted desc; idx points into the caller's data. */
  function treemap(items, opts) {
    opts = opts || {};
    var W = opts.width || 940, H = opts.height || 210;
    var rects = squarify(items, 0, 0, W, H);
    var out = rects.map(function (r) {
      var color = TM_COLORS[r.item.idx % TM_COLORS.length];
      var cell = '<g class="tm-cell" data-i="' + r.item.idx + '">' +
        '<rect x="' + (r.x + 1).toFixed(1) + '" y="' + (r.y + 1).toFixed(1) +
        '" width="' + Math.max(0, r.w - 2).toFixed(1) + '" height="' + Math.max(0, r.h - 2).toFixed(1) +
        '" rx="3" fill="' + color + '" fill-opacity="0.16" stroke="' + color + '" stroke-opacity="0.55"></rect>';
      if (r.w > 78 && r.h > 34) {
        cell += '<text x="' + (r.x + 9).toFixed(1) + '" y="' + (r.y + 18).toFixed(1) + '" class="tm-label">' + esc(r.item.label) + "</text>" +
          '<text x="' + (r.x + 9).toFixed(1) + '" y="' + (r.y + 32).toFixed(1) + '" class="tm-sub">' + esc(r.item.sub || "") + "</text>";
      }
      return cell + "</g>";
    });
    return '<svg viewBox="0 0 ' + W + " " + H + '">' + out.join("") + "</svg>";
  }

  // -- TTFT percentile strips per model -------------------------------------
  /** models: [{model, ttftPcts:[p10,p25,p50,p75,p90,p95], ttftN}] */
  function ttftStrips(models) {
    var ms = models.filter(function (m) {
      return m.ttftPcts && m.ttftPcts.length === 6 && m.ttftPcts[5] != null;
    });
    if (!ms.length) return "";
    var max = 0;
    ms.forEach(function (m) { if (m.ttftPcts[5] > max) max = m.ttftPcts[5]; });
    max = max * 1.1 || 1;
    var LEFT = 168, RIGHT = 70, ROWH = 30, W = 680;
    var H = ms.length * ROWH + 24;
    var plotW = W - LEFT - RIGHT;
    function X(v) { return LEFT + (v / max) * plotW; }

    var axis = [0, 0.25, 0.5, 0.75, 1].map(function (f) {
      var v = max * f;
      return '<line x1="' + X(v).toFixed(1) + '" y1="6" x2="' + X(v).toFixed(1) + '" y2="' + (H - 16) +
        '" stroke="var(--border)" stroke-dasharray="2 4"></line>' +
        '<text x="' + X(v).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" class="ts-axis">' + fmtDur(v) + "</text>";
    }).join("");

    var rows = ms.map(function (m, i) {
      var p = m.ttftPcts;
      var cy = 8 + i * ROWH + ROWH / 2;
      var label = m.model.length > 24 ? m.model.slice(0, 23) + "…" : m.model;
      return '<g class="ts-row" data-i="' + models.indexOf(m) + '">' +
        '<rect x="0" y="' + (cy - ROWH / 2).toFixed(1) + '" width="' + W + '" height="' + ROWH + '" fill="transparent"></rect>' +
        '<text x="' + (LEFT - 12) + '" y="' + (cy + 3.5).toFixed(1) + '" text-anchor="end" class="ts-label">' + esc(label) + "</text>" +
        '<rect x="' + X(p[0]).toFixed(1) + '" y="' + (cy - 2.5).toFixed(1) + '" width="' + Math.max(1, X(p[4]) - X(p[0])).toFixed(1) + '" height="5" rx="2.5" fill="var(--accent)" fill-opacity="0.18"></rect>' +
        '<rect x="' + X(p[1]).toFixed(1) + '" y="' + (cy - 4.5).toFixed(1) + '" width="' + Math.max(1, X(p[3]) - X(p[1])).toFixed(1) + '" height="9" rx="3" fill="var(--accent)" fill-opacity="0.42"></rect>' +
        '<line x1="' + X(p[2]).toFixed(1) + '" y1="' + (cy - 8).toFixed(1) + '" x2="' + X(p[2]).toFixed(1) + '" y2="' + (cy + 8).toFixed(1) + '" stroke="var(--bright)" stroke-width="2"></line>' +
        '<line x1="' + X(p[5]).toFixed(1) + '" y1="' + (cy - 6).toFixed(1) + '" x2="' + X(p[5]).toFixed(1) + '" y2="' + (cy + 6).toFixed(1) + '" stroke="var(--amber)" stroke-width="1.5"></line>' +
        '<text x="' + (W - RIGHT + 10) + '" y="' + (cy + 3.5).toFixed(1) + '" class="ts-val">' + fmtDur(p[2]) + "</text>" +
        "</g>";
    }).join("");

    return '<svg viewBox="0 0 ' + W + " " + H + '">' + axis + rows + "</svg>";
  }

  return { calendarHeatmap: calendarHeatmap, treemap: treemap, ttftStrips: ttftStrips, fmtDur: fmtDur, fmtCost: fmtCost };
})();
