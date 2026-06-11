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
