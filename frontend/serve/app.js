/* tracetap observatory — vanilla JS, no deps, hash-routed. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ utils
  var view = document.getElementById("view");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) return r.json().then(function (b) { throw new Error(b.error || r.status); });
      return r.json();
    });
  }
  function fmtTime(epoch) {
    if (!epoch) return "—";
    var d = new Date(epoch * 1000);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fmtDur(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return ms + "ms";
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + Math.round(s % 60) + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function fmtTok(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "K";
    return String(n);
  }
  function fmtCost(c, plus) {
    if (c == null) return "—";
    var s = c >= 100 ? "$" + c.toFixed(0) : c >= 0.01 || c === 0 ? "$" + c.toFixed(2) : "$" + c.toFixed(4);
    return plus ? s + "+" : s;
  }
  function fmtPct(x) { return (x * 100).toFixed(x >= 0.1 ? 0 : 1) + "%"; }
  function basename(p) {
    if (!p) return "";
    var parts = String(p).split("/");
    return parts[parts.length - 1] || p;
  }
  function agentPill(agent) {
    var a = esc(agent || "?");
    return '<span class="pill agent-' + a + '">' + a + "</span>";
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      var args = arguments, self = this;
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // ------------------------------------------------------------- svg charts
  /** Vertical column chart. items: [{label, value, title?, warn?}] */
  function columnChart(items, opts) {
    opts = opts || {};
    var H = opts.height || 120, PAD = 4, LABEL_H = opts.labels ? 16 : 0;
    var W = Math.max(80, items.length * (opts.colWidth || 18));
    var max = 0;
    items.forEach(function (it) { if (it.value > max) max = it.value; });
    if (max <= 0) max = 1;
    var cw = W / items.length;
    var bars = items.map(function (it, i) {
      var h = Math.max(it.value > 0 ? 2 : 0, (it.value / max) * (H - PAD - LABEL_H));
      var x = i * cw + 1.5;
      var color = it.warn ? "var(--warn)" : (it.color || "var(--accent)");
      var rect = '<rect x="' + x.toFixed(1) + '" y="' + (H - LABEL_H - h).toFixed(1) +
        '" width="' + Math.max(1, cw - 3).toFixed(1) + '" height="' + h.toFixed(1) +
        '" rx="1.5" fill="' + color + '" opacity="0.85"><title>' + esc(it.title || it.label + ": " + it.value) + "</title></rect>";
      var label = "";
      if (opts.labels && (items.length <= 16 || i % Math.ceil(items.length / 16) === 0)) {
        label = '<text x="' + (i * cw + cw / 2).toFixed(1) + '" y="' + (H - 3) +
          '" font-size="9" fill="var(--dim)" text-anchor="middle">' + esc(it.label) + "</text>";
      }
      return rect + label;
    });
    return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" height="' + H + '">' + bars.join("") + "</svg>";
  }

  /** Stacked column chart. items: [{label, parts:[{value,color,name}], title}] */
  function stackedChart(items, opts) {
    opts = opts || {};
    var H = opts.height || 120, PAD = 4;
    var W = Math.max(80, items.length * (opts.colWidth || 18));
    var max = 0;
    items.forEach(function (it) {
      var sum = 0;
      it.parts.forEach(function (p) { sum += p.value; });
      if (sum > max) max = sum;
    });
    if (max <= 0) max = 1;
    var cw = W / items.length;
    var out = items.map(function (it, i) {
      var x = i * cw + 1.5, y = H;
      var rects = it.parts.map(function (p) {
        var h = (p.value / max) * (H - PAD);
        y -= h;
        if (h <= 0) return "";
        return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, cw - 3).toFixed(1) +
          '" height="' + h.toFixed(1) + '" fill="' + p.color + '" opacity="0.9"></rect>';
      });
      return '<g>' + rects.join("") + "<title>" + esc(it.title || it.label) + "</title></g>";
    });
    return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" height="' + H + '">' + out.join("") + "</svg>";
  }

  // ---------------------------------------------------------------- router
  var current = { name: null, arg: null };

  function route() {
    var h = location.hash.replace(/^#/, "") || "sessions";
    var m;
    if ((m = h.match(/^session\/(.+)$/))) renderSession(decodeURIComponent(m[1]));
    else if ((m = h.match(/^prompt\/(.+)$/))) renderPrompt(decodeURIComponent(m[1]));
    else if (h === "usage") renderUsage();
    else if (h === "analytics") renderAnalytics();
    else if (h === "prompts") renderPrompts();
    else if (h === "audit") renderAudit();
    else renderSessions();

    var tab = h.split("/")[0];
    if (tab === "session") tab = "sessions";
    if (tab === "prompt") tab = "prompts";
    document.querySelectorAll("#tabs a").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-tab") === tab);
    });
  }
  window.addEventListener("hashchange", route);

  function setView(html) { view.innerHTML = html; }
  function fail(err) {
    setView('<div class="empty">Error: ' + esc(err.message || err) + "</div>");
  }

  // ------------------------------------------------------------- sessions
  var sess = { sort: "started_at", order: "desc", q: "", agent: "", model: "", project: "", errored: false };

  var SESSION_COLS = [
    { key: "agent", label: "Agent", sortable: true },
    { key: "model", label: "Model", sortable: true },
    { key: "project_cwd", label: "Project", sortable: true },
    { key: "started_at", label: "Started", sortable: true },
    { key: "duration_ms", label: "Duration", sortable: true, num: true },
    { key: "turns", label: "Turns", num: true },
    { key: "total_in_tokens", label: "In", sortable: true, num: true },
    { key: "total_out_tokens", label: "Out", sortable: true, num: true },
    { key: "cache", label: "Cache hit", num: true },
    { key: "errors", label: "Errs", num: true },
    { key: "cost_usd", label: "Cost", sortable: true, num: true }
  ];

  function renderSessions() {
    current = { name: "sessions" };
    var controls =
      '<div class="controls">' +
      '<input id="q" type="search" placeholder="Full-text search every session (FTS5) — try an error message, a file name, a tool name…" value="' + esc(sess.q) + '" />' +
      '<input id="f-agent" class="filter" type="text" placeholder="agent" value="' + esc(sess.agent) + '" />' +
      '<input id="f-model" class="filter" type="text" placeholder="model" value="' + esc(sess.model) + '" />' +
      '<input id="f-project" class="filter" type="text" placeholder="project" value="' + esc(sess.project) + '" />' +
      '<label class="check"><input id="f-errored" type="checkbox"' + (sess.errored ? " checked" : "") + "/> errored only</label>" +
      "</div>" +
      '<div class="meta-line" id="meta">Loading…</div>' +
      '<div class="tbl-wrap"><table><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table></div>' +
      '<div class="empty" id="empty" style="display:none"></div>';
    setView(controls);

    ["q", "f-agent", "f-model", "f-project"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", debounce(onSessionControls, 200));
    });
    document.getElementById("f-errored").addEventListener("change", onSessionControls);
    loadSessionData();
  }

  function onSessionControls() {
    sess.q = document.getElementById("q").value.trim();
    sess.agent = document.getElementById("f-agent").value.trim();
    sess.model = document.getElementById("f-model").value.trim();
    sess.project = document.getElementById("f-project").value.trim();
    sess.errored = document.getElementById("f-errored").checked;
    loadSessionData();
  }

  function sessionParams() {
    var p = new URLSearchParams();
    if (sess.agent) p.set("agent", sess.agent);
    if (sess.model) p.set("model", sess.model);
    if (sess.project) p.set("project", sess.project);
    if (sess.errored) p.set("errored", "1");
    return p;
  }

  function loadSessionData() {
    if (!document.getElementById("rows")) return;
    if (sess.q) return loadSearchHits();
    renderSessionHead();
    var p = sessionParams();
    p.set("sort", sess.sort);
    p.set("order", sess.order);
    fetchJSON("/api/sessions?" + p).then(function (data) {
      var meta = document.getElementById("meta");
      if (meta) meta.textContent = data.count + " session" + (data.count === 1 ? "" : "s");
      renderSessionRows(data.sessions);
    }).catch(fail);
  }

  function renderSessionHead() {
    var head = document.getElementById("head");
    if (!head) return;
    head.innerHTML = SESSION_COLS.map(function (c) {
      var arrow = c.key === sess.sort ? ' <span class="arrow">' + (sess.order === "asc" ? "▲" : "▼") + "</span>" : "";
      return '<th class="' + (c.num ? "num " : "") + (c.sortable ? "sortable" : "") + '" data-key="' + c.key + '" data-sortable="' + (c.sortable ? 1 : 0) + '">' + esc(c.label) + arrow + "</th>";
    }).join("");
    head.querySelectorAll("th[data-sortable='1']").forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-key");
        if (sess.sort === key) sess.order = sess.order === "asc" ? "desc" : "asc";
        else { sess.sort = key; sess.order = "desc"; }
        loadSessionData();
      });
    });
  }

  function cacheRate(s) {
    var denom = (s.totalInTokens || 0) + (s.cacheRead || 0) + (s.cacheCreation || 0);
    return denom > 0 ? (s.cacheRead || 0) / denom : 0;
  }

  function renderSessionRows(sessions) {
    var rows = document.getElementById("rows");
    var empty = document.getElementById("empty");
    if (!rows) return;
    if (!sessions.length) {
      rows.innerHTML = "";
      empty.style.display = "block";
      empty.innerHTML = "No indexed sessions. Capture with <code>tracetap claude|codex|gemini</code>, then run <code>tracetap index</code>.";
      return;
    }
    empty.style.display = "none";
    rows.innerHTML = sessions.map(function (s) {
      return '<tr class="click" data-id="' + esc(s.sessionId) + '">' +
        "<td>" + agentPill(s.agent) + "</td>" +
        "<td>" + esc(s.model || "—") + "</td>" +
        '<td class="dim" title="' + esc(s.projectCwd) + '">' + esc(basename(s.projectCwd)) + "</td>" +
        "<td>" + fmtTime(s.startedAt) + "</td>" +
        '<td class="num">' + fmtDur(s.durationMs) + "</td>" +
        '<td class="num">' + (s.turns || 0) + "</td>" +
        '<td class="num">' + fmtTok(s.totalInTokens) + "</td>" +
        '<td class="num">' + fmtTok(s.totalOutTokens) + "</td>" +
        '<td class="num">' + fmtPct(cacheRate(s)) + "</td>" +
        '<td class="num">' + (s.errorCount ? '<span class="pill err">' + s.errorCount + "</span>" : "0") + "</td>" +
        '<td class="num">' + fmtCost(s.costUsd) + "</td>" +
        "</tr>";
    }).join("");
    rows.querySelectorAll("tr[data-id]").forEach(function (tr) {
      tr.addEventListener("click", function () {
        location.hash = "#session/" + encodeURIComponent(tr.getAttribute("data-id"));
      });
    });
  }

  function loadSearchHits() {
    var p = sessionParams();
    p.set("q", sess.q);
    p.set("limit", "50");
    fetchJSON("/api/search?" + p).then(function (data) {
      var meta = document.getElementById("meta");
      if (meta) meta.textContent = data.count + " hit" + (data.count === 1 ? "" : "s") + " for “" + sess.q + "”";
      var head = document.getElementById("head");
      head.innerHTML = "<th>Session</th><th>Model</th><th>Match</th><th>When</th>";
      var rows = document.getElementById("rows");
      var empty = document.getElementById("empty");
      if (!data.hits.length) {
        rows.innerHTML = "";
        empty.style.display = "block";
        empty.textContent = "No matches.";
        return;
      }
      empty.style.display = "none";
      rows.innerHTML = data.hits.map(function (h) {
        var snip = esc(h.snippet).replace(/\[([^\]]*)\]/g, "<b>$1</b>");
        return '<tr class="click" data-id="' + esc(h.sessionId) + '">' +
          "<td>" + agentPill(h.agent) + ' <span class="pill">#' + h.stepIndex + "</span>" +
          (h.errored ? ' <span class="pill err">errored</span>' : "") + "</td>" +
          "<td>" + esc(h.model) + "</td>" +
          '<td><div class="snippet">' + snip + "</div>" +
          (h.toolName ? '<div class="hash">↳ ' + esc(h.toolName) + "</div>" : "") + "</td>" +
          '<td class="dim">' + fmtTime(h.startedAt) + "</td>" +
          "</tr>";
      }).join("");
      rows.querySelectorAll("tr[data-id]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          location.hash = "#session/" + encodeURIComponent(tr.getAttribute("data-id"));
        });
      });
    }).catch(fail);
  }

  // -------------------------------------------------------- session detail
  function renderSession(id) {
    current = { name: "session", arg: id };
    setView('<div class="meta-line">Loading session…</div>');
    fetchJSON("/api/session/" + encodeURIComponent(id)).then(function (data) {
      if (current.name !== "session" || current.arg !== id) return;
      drawSession(data);
    }).catch(fail);
  }

  function drawSession(data) {
    var s = data.session, reqs = data.requests, steps = data.steps;
    var compactSeqs = {};
    data.compactions.forEach(function (c) { compactSeqs[c.seq] = c; });

    var ttfts = reqs.map(function (r) { return r.ttftMs; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
    var ttftP50 = ttfts.length ? ttfts[Math.floor((ttfts.length - 1) * 0.5)] : null;
    var errReqs = reqs.filter(function (r) { return r.errored; }).length;

    var cards =
      card("Cost", fmtCost(s.costUsd)) +
      card("Duration", fmtDur(s.durationMs)) +
      card("Turns", s.turns || 0) +
      card("API calls", reqs.length + (errReqs ? ' <small class="warn-text">' + errReqs + " failed</small>" : "")) +
      card("Tokens in/out", fmtTok(s.totalInTokens) + " <small>/</small> " + fmtTok(s.totalOutTokens)) +
      card("Cache hit", fmtPct(cacheRate(s))) +
      card("TTFT p50", ttftP50 != null ? fmtDur(ttftP50) : "—") +
      card("Compactions", data.compactions.length, data.compactions.length > 0);

    var html =
      '<div class="crumb"><a href="#sessions">← sessions</a></div>' +
      '<div class="detail-head"><h1>' + agentPill(s.agent) + " " + esc(s.model) + "</h1>" +
      '<span class="dim">' + esc(s.projectCwd) + " · " + fmtTime(s.startedAt) + "</span>" +
      '<span class="actions">' +
      (data.reportAvailable ? '<a href="/report?session=' + encodeURIComponent(s.sessionId) + '" target="_blank" rel="noopener">wire report ↗</a>' : "") +
      "</span></div>" +
      '<div class="cards">' + cards + "</div>" +
      laneSection(reqs, compactSeqs) +
      '<h2 class="sec">Request waterfall <small>(' + reqs.length + " API calls — grey = waiting for first byte, blue = streaming)</small></h2>" +
      '<div class="chart-box waterfall">' + waterfall(reqs, compactSeqs) + "</div>" +
      '<h2 class="sec">Transcript <small>(' + steps.length + " steps)</small></h2>" +
      '<div class="steps">' + steps.map(stepCard).join("") + "</div>";
    setView(html);
  }

  function card(k, v, alert) {
    return '<div class="card' + (alert ? " alert" : "") + '"><div class="k">' + k + '</div><div class="v">' + v + "</div></div>";
  }

  function laneSection(reqs, compactSeqs) {
    if (!reqs.length) return "";
    var ctxItems = reqs.map(function (r) {
      var c = compactSeqs[r.seq];
      return {
        label: String(r.seq),
        value: r.transcriptItems,
        warn: !!c,
        title: "call " + r.seq + ": " + r.transcriptItems + " transcript items" + (c ? " — COMPACTION (was " + c.from + ")" : "")
      };
    });
    var tokItems = reqs.map(function (r) {
      return {
        label: String(r.seq),
        title: "call " + r.seq + ": fresh in " + fmtTok(r.promptTokens) + " · cache read " + fmtTok(r.cacheRead) +
          " · cache write " + fmtTok(r.cacheCreation) + " · out " + fmtTok(r.completionTokens),
        parts: [
          { value: r.cacheRead, color: "var(--cache)" },
          { value: r.cacheCreation, color: "var(--purple)" },
          { value: r.promptTokens, color: "var(--accent)" },
          { value: r.completionTokens, color: "var(--ok)" }
        ]
      };
    });
    return '<div class="split">' +
      '<div class="chart-box"><div class="chart-title">Context growth — transcript items per call (amber = mid-task compaction)</div>' +
      columnChart(ctxItems, { height: 110, labels: false }) + "</div>" +
      '<div class="chart-box"><div class="chart-title">Token flow per call</div>' +
      stackedChart(tokItems, { height: 110 }) +
      '<div class="legend">' +
      '<span><span class="sw" style="background:var(--cache)"></span>cache read</span>' +
      '<span><span class="sw" style="background:var(--purple)"></span>cache write</span>' +
      '<span><span class="sw" style="background:var(--accent)"></span>fresh input</span>' +
      '<span><span class="sw" style="background:var(--ok)"></span>output</span>' +
      "</div></div></div>";
  }

  function waterfall(reqs, compactSeqs) {
    if (!reqs.length) return '<div class="dim">No wire data (re-index with tracetap ≥ 0.3).</div>';
    var t0 = Infinity, t1 = -Infinity;
    reqs.forEach(function (r) {
      if (r.ts > 0) t0 = Math.min(t0, r.ts);
      var end = r.ts + (r.durationMs || 0) / 1000;
      t1 = Math.max(t1, end);
    });
    if (!isFinite(t0) || t1 <= t0) { t0 = 0; t1 = 1; }
    var span = t1 - t0;
    return reqs.map(function (r) {
      var left = r.ts > 0 ? ((r.ts - t0) / span) * 100 : 0;
      var durW = r.durationMs != null ? Math.max(0.4, (r.durationMs / 1000 / span) * 100) : 0.6;
      var ttftW = r.ttftMs != null ? (r.ttftMs / 1000 / span) * 100 : 0;
      var bars = "";
      if (ttftW > 0) {
        bars += '<div class="wf-bar wait" style="left:' + left.toFixed(2) + "%;width:" + ttftW.toFixed(2) + '%"></div>';
        bars += '<div class="wf-bar' + (r.errored ? " errored" : "") + '" style="left:' + (left + ttftW).toFixed(2) + "%;width:" + Math.max(0.3, durW - ttftW).toFixed(2) + '%"></div>';
      } else {
        bars += '<div class="wf-bar' + (r.errored ? " errored" : "") + '" style="left:' + left.toFixed(2) + "%;width:" + durW.toFixed(2) + '%"></div>';
      }
      var c = compactSeqs[r.seq];
      var meta = (r.status == null ? "no response" : r.status) +
        " · " + fmtDur(r.durationMs) +
        (r.ttftMs != null ? " · ttft " + fmtDur(r.ttftMs) : "") +
        " · " + fmtTok(r.completionTokens) + " out" +
        (r.stopReason ? " · " + esc(r.stopReason) : "");
      return '<div class="wf-row">' +
        '<div class="wf-label">' + r.seq + (c ? ' <span class="wf-compact" title="transcript compacted: ' + c.from + " → " + c.to + '">⇣</span>' : "") + "</div>" +
        '<div class="wf-track">' + bars + "</div>" +
        '<div class="wf-meta">' + meta + "</div>" +
        "</div>";
    }).join("");
  }

  function stepCard(st) {
    var roleClass = st.role === "user" ? "user" : st.role === "agent" ? "agent" : "system";
    var head = '<div class="step-head"><span class="pill">#' + st.stepIndex + "</span><span>" + esc(st.role) + "</span>" +
      (st.errored ? '<span class="pill err">errored</span>' : "") +
      (st.toolName ? '<span class="hash">' + esc(st.toolName) + "</span>" : "") +
      "</div>";
    var body = "";
    if (st.reasoning) {
      body += '<details><summary>reasoning (' + fmtTok(st.reasoning.length) + " chars)</summary><pre>" + esc(clip(st.reasoning, 20000)) + "</pre></details>";
    }
    if (st.message) body += '<div class="step-body">' + esc(clip(st.message, 6000)) + "</div>";
    if (st.toolInput) {
      body += '<details><summary>tool input</summary><pre>' + esc(clip(st.toolInput, 20000)) + "</pre></details>";
    }
    if (st.observation) {
      body += '<details><summary>observation (' + fmtTok(st.observation.length) + " chars)</summary><pre>" + esc(clip(st.observation, 20000)) + "</pre></details>";
    }
    if (!body) body = '<div class="step-body dim">(empty step)</div>';
    return '<div class="step ' + roleClass + (st.errored ? " errored" : "") + '">' + head + body + "</div>";
  }

  function clip(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + "\n… (" + (s.length - n) + " more chars — see wire report)" : s;
  }

  // ----------------------------------------------------------------- usage
  var usage = { granularity: "daily", breakdown: false, since: "", until: "", agent: "" };

  function renderUsage() {
    current = { name: "usage" };
    var html =
      '<div class="controls">' +
      '<select id="u-gran">' +
      ["daily", "weekly", "monthly", "total"].map(function (g) {
        return '<option value="' + g + '"' + (usage.granularity === g ? " selected" : "") + ">" + g + "</option>";
      }).join("") +
      "</select>" +
      '<label class="check"><input id="u-breakdown" type="checkbox"' + (usage.breakdown ? " checked" : "") + "/> per-model breakdown</label>" +
      '<input id="u-since" type="date" value="' + esc(usage.since) + '" title="since"/>' +
      '<input id="u-until" type="date" value="' + esc(usage.until) + '" title="until"/>' +
      '<input id="u-agent" class="filter" type="text" placeholder="agent" value="' + esc(usage.agent) + '"/>' +
      "</div>" +
      '<div id="u-chart"></div>' +
      '<div class="tbl-wrap"><table><thead><tr id="u-head"></tr></thead><tbody id="u-rows"></tbody></table></div>' +
      '<div class="note" id="u-note"></div>' +
      '<div class="empty" id="u-empty" style="display:none"></div>';
    setView(html);
    [["u-gran", "change"], ["u-breakdown", "change"], ["u-since", "change"], ["u-until", "change"], ["u-agent", "input"]].forEach(function (pair) {
      document.getElementById(pair[0]).addEventListener(pair[1], debounce(onUsageControls, 150));
    });
    loadUsage();
  }

  function onUsageControls() {
    usage.granularity = document.getElementById("u-gran").value;
    usage.breakdown = document.getElementById("u-breakdown").checked;
    usage.since = document.getElementById("u-since").value;
    usage.until = document.getElementById("u-until").value;
    usage.agent = document.getElementById("u-agent").value.trim();
    loadUsage();
  }

  function loadUsage() {
    if (!document.getElementById("u-rows")) return;
    var p = new URLSearchParams();
    p.set("granularity", usage.granularity);
    if (usage.breakdown) p.set("breakdown", "1");
    if (usage.since) p.set("since", usage.since);
    if (usage.until) p.set("until", usage.until);
    if (usage.agent) p.set("agent", usage.agent);
    try { p.set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) {}
    fetchJSON("/api/usage?" + p).then(drawUsage).catch(fail);
  }

  function drawUsage(report) {
    var chart = document.getElementById("u-chart");
    if (!chart) return;
    var empty = document.getElementById("u-empty");
    var rowsEl = document.getElementById("u-rows");
    var headEl = document.getElementById("u-head");
    if (!report.rows.length) {
      chart.innerHTML = "";
      headEl.innerHTML = "";
      rowsEl.innerHTML = "";
      empty.style.display = "block";
      empty.innerHTML = "No usage in range. Capture sessions, then run <code>tracetap index</code>.";
      return;
    }
    empty.style.display = "none";

    // Chart: cost per bucket (collapse breakdown rows into buckets).
    var byBucket = {};
    report.rows.forEach(function (r) {
      byBucket[r.bucket] = (byBucket[r.bucket] || 0) + r.costUsd;
    });
    var items = Object.keys(byBucket).sort().map(function (b) {
      return { label: b.slice(5) || b, value: byBucket[b], title: b + ": " + fmtCost(byBucket[b]) };
    });
    if (report.granularity !== "total" && items.length > 1) {
      chart.innerHTML = '<div class="chart-box"><div class="chart-title">Cost per ' +
        esc(report.granularity.replace(/ly$/, "")) + "</div>" +
        columnChart(items, { height: 130, labels: true, colWidth: 34 }) + "</div>";
    } else chart.innerHTML = "";

    var showGroup = report.rows.some(function (r) { return r.group; });
    headEl.innerHTML = "<th>Bucket</th>" + (showGroup ? "<th>Group</th>" : "") +
      '<th class="num">In</th><th class="num">Out</th><th class="num">Cache R</th><th class="num">Cache W</th><th class="num">Sessions</th><th class="num">Cost</th>';
    var rowsHtml = report.rows.map(function (r) {
      return "<tr><td>" + esc(r.bucket) + "</td>" +
        (showGroup ? "<td>" + esc(r.group) + "</td>" : "") +
        '<td class="num">' + fmtTok(r.promptTokens) + "</td>" +
        '<td class="num">' + fmtTok(r.completionTokens) + "</td>" +
        '<td class="num">' + fmtTok(r.cacheRead) + "</td>" +
        '<td class="num">' + fmtTok(r.cacheCreation) + "</td>" +
        '<td class="num">' + r.sessions + "</td>" +
        '<td class="num">' + fmtCost(r.costUsd, r.hasUnpriced) + "</td></tr>";
    });
    var t = report.totals;
    rowsHtml.push('<tr class="total"><td>total</td>' + (showGroup ? "<td></td>" : "") +
      '<td class="num">' + fmtTok(t.promptTokens) + "</td>" +
      '<td class="num">' + fmtTok(t.completionTokens) + "</td>" +
      '<td class="num">' + fmtTok(t.cacheRead) + "</td>" +
      '<td class="num">' + fmtTok(t.cacheCreation) + "</td>" +
      '<td class="num">' + t.sessions + "</td>" +
      '<td class="num">' + fmtCost(t.costUsd, t.hasUnpriced) + "</td></tr>");
    rowsEl.innerHTML = rowsHtml.join("");

    var note = "prices: " + esc(report.priceSource);
    if (report.unpricedModels.length) {
      note += ' · <span class="warn-text">unpriced models excluded from $: ' + esc(report.unpricedModels.join(", ")) + "</span>";
    }
    document.getElementById("u-note").innerHTML = note;
  }

  // ------------------------------------------------------------- analytics
  function renderAnalytics() {
    current = { name: "analytics" };
    setView('<div class="meta-line">Loading analytics…</div>');
    fetchJSON("/api/analytics").then(function (a) {
      if (current.name !== "analytics") return;
      drawAnalytics(a);
    }).catch(fail);
  }

  function drawAnalytics(a) {
    var t = a.totals;
    var cards =
      card("Sessions", t.sessions) +
      card("API calls", t.requests) +
      card("Call error rate", t.requests ? fmtPct(t.erroredRequests / t.requests) : "—", t.requests && t.erroredRequests / t.requests > 0.05) +
      card("Total cost", fmtCost(t.costUsd, t.hasUnpriced)) +
      card("Cache hit rate", fmtPct(t.cacheHitRate)) +
      card("Output tokens", fmtTok(t.completionTokens)) +
      card("Compactions", a.compactions.totalCompactions + ' <small>in ' + a.compactions.sessionsWithCompaction + " sessions</small>", a.compactions.totalCompactions > 0);

    var trendHtml = "";
    if (a.trend.length > 1) {
      trendHtml = '<div class="chart-box"><div class="chart-title">Daily cost (' + a.trend.length + " active days)</div>" +
        columnChart(a.trend.map(function (d) {
          return { label: d.date.slice(5), value: d.costUsd, title: d.date + ": " + fmtCost(d.costUsd) + " (" + d.events + " turns)" };
        }), { height: 110, labels: true, colWidth: 26 }) + "</div>";
    }

    var modelRows = a.perModel.map(function (m) {
      return "<tr><td>" + esc(m.model) + "</td>" +
        '<td class="num">' + m.requests + "</td>" +
        '<td class="num">' + (m.errorRate > 0 ? '<span class="warn-text">' + fmtPct(m.errorRate) + "</span>" : "0%") + "</td>" +
        '<td class="num">' + (m.ttftP50 != null ? fmtDur(m.ttftP50) : "—") + "</td>" +
        '<td class="num">' + (m.ttftP95 != null ? fmtDur(m.ttftP95) : "—") + "</td>" +
        '<td class="num">' + (m.durP50 != null ? fmtDur(m.durP50) : "—") + "</td>" +
        '<td class="num">' + fmtTok(m.completionTokens) + "</td></tr>";
    }).join("");

    var agentRows = a.perAgent.map(function (p) {
      return "<tr><td>" + agentPill(p.agent) + "</td>" +
        '<td class="num">' + p.sessions + "</td>" +
        '<td class="num">' + fmtTok(p.promptTokens) + "</td>" +
        '<td class="num">' + fmtTok(p.completionTokens) + "</td>" +
        '<td class="num">' + fmtCost(p.costUsd) + "</td></tr>";
    }).join("");

    var maxTool = a.topTools.length ? a.topTools[0].count : 1;
    var toolRows = a.topTools.map(function (tl) {
      return '<tr><td class="bar-cell"><div class="bar" style="width:' + ((tl.count / maxTool) * 100).toFixed(1) + '%"></div><span>' + esc(tl.name) + "</span></td>" +
        '<td class="num">' + tl.count + "</td></tr>";
    }).join("");

    var topSessionRows = a.topSessions.map(function (s) {
      return '<tr class="click" data-id="' + esc(s.sessionId) + '"><td>' + agentPill(s.agent) + " " + esc(s.model) + "</td>" +
        '<td class="dim" title="' + esc(s.projectCwd) + '">' + esc(basename(s.projectCwd)) + "</td>" +
        "<td>" + fmtTime(s.startedAt) + "</td>" +
        '<td class="num">' + fmtDur(s.durationMs) + "</td>" +
        '<td class="num">' + (s.turns || 0) + "</td>" +
        '<td class="num">' + fmtCost(s.costUsd) + "</td></tr>";
    }).join("");

    setView(
      '<div class="cards">' + cards + "</div>" +
      trendHtml +
      '<div class="split">' +
      '<div><h2 class="sec">Per model <small>(wire latency &amp; reliability)</small></h2>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Model</th><th class="num">Calls</th><th class="num">Err</th><th class="num">TTFT p50</th><th class="num">TTFT p95</th><th class="num">Dur p50</th><th class="num">Out</th></tr></thead><tbody>' +
      (modelRows || '<tr><td colspan="7" class="dim">no wire data</td></tr>') + "</tbody></table></div>" +
      '<h2 class="sec">Per agent</h2>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Agent</th><th class="num">Sessions</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody>' +
      (agentRows || '<tr><td colspan="5" class="dim">no data</td></tr>') + "</tbody></table></div></div>" +
      '<div><h2 class="sec">Top tools</h2>' +
      '<div class="tbl-wrap"><table><tbody>' + (toolRows || '<tr><td class="dim">no tool calls</td></tr>') + "</tbody></table></div>" +
      '<h2 class="sec">Top sessions by cost</h2>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Session</th><th>Project</th><th>Started</th><th class="num">Dur</th><th class="num">Turns</th><th class="num">Cost</th></tr></thead><tbody>' +
      (topSessionRows || '<tr><td colspan="6" class="dim">no sessions</td></tr>') + "</tbody></table></div></div>" +
      "</div>" +
      '<div class="note">prices: ' + esc(a.priceSource) + "</div>"
    );
    view.querySelectorAll("tr[data-id]").forEach(function (tr) {
      tr.addEventListener("click", function () {
        location.hash = "#session/" + encodeURIComponent(tr.getAttribute("data-id"));
      });
    });
  }

  // --------------------------------------------------------------- prompts
  function renderPrompts() {
    current = { name: "prompts" };
    setView('<div class="meta-line">Loading prompt registry…</div>');
    fetchJSON("/api/prompts").then(function (data) {
      if (current.name !== "prompts") return;
      if (!data.prompts.length) {
        setView('<div class="empty">No system prompts on record yet. Index some traced sessions first.</div>');
        return;
      }
      var rows = data.prompts.map(function (p) {
        return '<tr class="click" data-hash="' + esc(p.promptHash) + '">' +
          '<td class="hash">' + esc(p.promptHash.slice(0, 12)) + "</td>" +
          "<td>" + agentPill(p.agent) + "</td>" +
          '<td class="num">' + fmtTok(p.approxTokens) + "</td>" +
          '<td class="num">' + p.requestCount + "</td>" +
          '<td class="num">' + p.sessionCount + "</td>" +
          "<td>" + fmtTime(p.firstSeen) + "</td>" +
          "<td>" + fmtTime(p.lastSeen) + "</td></tr>";
      }).join("");
      setView(
        '<div class="meta-line">' + data.count + " distinct system-prompt versions seen on the wire. " +
        "Every harness update that touches the prompt shows up here as a new version.</div>" +
        '<div class="tbl-wrap"><table><thead><tr><th>Hash</th><th>Agent</th><th class="num">~Tokens</th><th class="num">Requests</th><th class="num">Sessions</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>' +
        rows + "</tbody></table></div>"
      );
      view.querySelectorAll("tr[data-hash]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          location.hash = "#prompt/" + tr.getAttribute("data-hash");
        });
      });
    }).catch(fail);
  }

  function renderPrompt(hash) {
    current = { name: "prompt", arg: hash };
    setView('<div class="meta-line">Loading prompt…</div>');
    Promise.all([
      fetchJSON("/api/prompt/" + encodeURIComponent(hash)),
      fetchJSON("/api/prompts")
    ]).then(function (results) {
      if (current.name !== "prompt" || current.arg !== hash) return;
      drawPrompt(results[0], results[1].prompts);
    }).catch(fail);
  }

  function drawPrompt(p, all) {
    var others = all.filter(function (o) { return o.agent === p.agent && o.promptHash !== p.promptHash; });
    var diffSel = others.length
      ? '<select id="diff-against"><option value="">— diff against another version —</option>' +
        others.map(function (o) {
          return '<option value="' + esc(o.promptHash) + '">' + esc(o.promptHash.slice(0, 12)) + " · last seen " + fmtTime(o.lastSeen) + "</option>";
        }).join("") + "</select>"
      : '<span class="dim">no other ' + esc(p.agent) + " versions to diff against</span>";

    setView(
      '<div class="crumb"><a href="#prompts">← prompts</a></div>' +
      '<div class="detail-head"><h1>' + agentPill(p.agent) + ' <span class="hash">' + esc(p.promptHash.slice(0, 16)) + "…</span></h1>" +
      '<span class="dim">' + fmtTok(p.approxTokens) + " tokens · " + p.requestCount + " requests · " + p.sessionCount + " sessions · " +
      fmtTime(p.firstSeen) + " → " + fmtTime(p.lastSeen) + "</span></div>" +
      '<div class="controls">' + diffSel + "</div>" +
      '<div id="prompt-body"><div class="prompt-content">' + esc(p.content) + "</div></div>" +
      (p.sessionIds.length
        ? '<h2 class="sec">Sessions using this prompt</h2><div class="meta-line">' +
          p.sessionIds.slice(0, 20).map(function (id) {
            return '<a href="#session/' + encodeURIComponent(id) + '">' + esc(id) + "</a>";
          }).join(" · ") + "</div>"
        : "")
    );
    var sel = document.getElementById("diff-against");
    if (sel) {
      sel.addEventListener("change", function () {
        var other = sel.value;
        var body = document.getElementById("prompt-body");
        if (!other) {
          body.innerHTML = '<div class="prompt-content">' + esc(p.content) + "</div>";
          return;
        }
        body.innerHTML = '<div class="meta-line">computing diff…</div>';
        fetchJSON("/api/prompt/" + encodeURIComponent(other)).then(function (o) {
          body.innerHTML = '<div class="meta-line">diff: <span class="hash">' + esc(o.promptHash.slice(0, 12)) +
            "</span> (old) → <span class=\"hash\">" + esc(p.promptHash.slice(0, 12)) + "</span> (this)</div>" +
            '<div class="prompt-content diff">' + diffHtml(o.content, p.content) + "</div>";
        }).catch(fail);
      });
    }
  }

  /** Line-level LCS diff, rendered with folded unchanged regions. */
  function diffHtml(oldText, newText) {
    var a = String(oldText).split("\n"), b = String(newText).split("\n");
    if (a.length * b.length > 4_000_000) {
      return '<div class="ln ctx">(too large to diff: ' + a.length + " × " + b.length + " lines)</div>";
    }
    // LCS table (uint32, flat).
    var n = a.length, m = b.length;
    var dp = new Uint32Array((n + 1) * (m + 1));
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = a[i] === b[j]
          ? dp[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }
    var ops = []; // {t: 'ctx'|'del'|'add', s}
    var x = 0, y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) { ops.push({ t: "ctx", s: a[x] }); x++; y++; }
      else if (dp[(x + 1) * (m + 1) + y] >= dp[x * (m + 1) + y + 1]) { ops.push({ t: "del", s: a[x] }); x++; }
      else { ops.push({ t: "add", s: b[y] }); y++; }
    }
    while (x < n) { ops.push({ t: "del", s: a[x++] }); }
    while (y < m) { ops.push({ t: "add", s: b[y++] }); }

    // Fold long unchanged runs.
    var out = [], run = [];
    function flushRun(isEnd) {
      if (run.length <= 7) {
        run.forEach(function (l) { out.push('<div class="ln ctx">' + esc(l) + "</div>"); });
      } else {
        run.slice(0, 2).forEach(function (l) { out.push('<div class="ln ctx">' + esc(l) + "</div>"); });
        out.push('<div class="gap">··· ' + (run.length - 4) + " unchanged lines ···</div>");
        if (!isEnd) run.slice(-2).forEach(function (l) { out.push('<div class="ln ctx">' + esc(l) + "</div>"); });
      }
      run = [];
    }
    ops.forEach(function (op) {
      if (op.t === "ctx") { run.push(op.s); return; }
      flushRun(false);
      out.push('<div class="ln ' + op.t + '">' + (op.t === "add" ? "+ " : "− ") + esc(op.s) + "</div>");
    });
    flushRun(true);
    return out.join("");
  }

  // ----------------------------------------------------------------- audit
  var audit = { mode: "standard" };

  function renderAudit() {
    current = { name: "audit" };
    setView(
      '<div class="controls">' +
      '<label class="check"><input id="a-strict" type="checkbox"' + (audit.mode === "strict" ? " checked" : "") +
      "/> strict detectors (entropy-gated, may false-positive)</label>" +
      '<span class="spacer"></span></div>' +
      '<div id="a-body"><div class="meta-line">Scanning indexed logs…</div></div>'
    );
    document.getElementById("a-strict").addEventListener("change", function () {
      audit.mode = this.checked ? "strict" : "standard";
      loadAudit();
    });
    loadAudit();
  }

  function loadAudit() {
    var body = document.getElementById("a-body");
    if (!body) return;
    body.innerHTML = '<div class="meta-line">Scanning indexed logs…</div>';
    fetchJSON("/api/audit?mode=" + audit.mode).then(function (r) {
      if (current.name !== "audit") return;
      drawAudit(r);
    }).catch(fail);
  }

  function drawAudit(r) {
    var body = document.getElementById("a-body");
    if (!body) return;
    var cards =
      card("Files scanned", r.filesScanned) +
      card("API calls scanned", r.pairsScanned) +
      card("Distinct secrets", r.groups.length, r.groups.length > 0) +
      card("Egress occurrences", r.totalEgress, r.totalEgress > 0) +
      card("In responses", r.totalResponse, r.totalResponse > 0);

    var html = '<div class="cards">' + cards + "</div>";

    if (!r.groups.length) {
      html += '<div class="empty">✓ No secrets detected on the wire (' + esc(r.mode) + " detectors).</div>";
    } else {
      html += '<div class="meta-line warn-text">Transcript resending means a secret egresses on EVERY later turn — rotate the credentials below.</div>' +
        '<div class="tbl-wrap"><table><thead><tr>' +
        '<th>Type</th><th>Fingerprint</th><th class="num">Len</th><th class="num">Egressed</th><th class="num">In responses</th><th>Where</th><th>First → last</th><th>Files</th>' +
        "</tr></thead><tbody>" +
        r.groups.map(function (g) {
          return "<tr><td><span class=\"pill err\">" + esc(g.type) + "</span></td>" +
            '<td class="hash">' + esc(g.fingerprint) + (g.last4 ? "…" + esc(g.last4) : "") + "</td>" +
            '<td class="num">' + g.tokenLength + "</td>" +
            '<td class="num">' + (g.egressCount ? '<b class="warn-text">' + g.egressCount + "×</b>" : "0") + "</td>" +
            '<td class="num">' + (g.responseCount || 0) + "</td>" +
            "<td>" + esc(g.locations.join(", ")) + "</td>" +
            '<td class="dim">' + fmtTime(g.firstTs) + " → " + fmtTime(g.lastTs) + "</td>" +
            '<td class="dim">' + g.files.map(function (f) { return esc(basename(f)); }).join("<br/>") + "</td></tr>";
        }).join("") +
        "</tbody></table></div>";
    }

    if (r.redactCheck) {
      html += '<div class="note">redact-check: capture-time <code>--redact-bodies</code> would mask ' +
        r.redactCheck.standardMasked + ", <code>--redact-bodies=strict</code> " + r.redactCheck.strictMasked +
        " of " + r.redactCheck.total + " detected occurrence(s). " +
        "Capture with <code>tracetap claude --redact-bodies</code> to mask at write time.</div>";
    }
    body.innerHTML = html;
  }

  // -------------------------------------------------------------- SSE live
  var liveEl = document.getElementById("live");
  var liveLabel = document.getElementById("live-label");
  var refresh = debounce(function () {
    if (current.name === "sessions") loadSessionData();
    else if (current.name === "usage") loadUsage();
    else route();
  }, 400);

  function connectSSE() {
    var es = new EventSource("/api/events");
    es.addEventListener("hello", function () {
      liveEl.className = "live on";
      liveLabel.textContent = "live";
    });
    es.addEventListener("change", function () {
      liveLabel.textContent = "updated " + new Date().toLocaleTimeString();
      refresh();
    });
    es.onerror = function () {
      liveEl.className = "live off";
      liveLabel.textContent = "offline";
    };
  }

  connectSSE();
  route();
})();
