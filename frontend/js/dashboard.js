/* =========================================================
   AwareX - Dashboard controller
   Routing, rendering, charts, camera, modals, toasts.
   Reads ONLY from AwareXData.analysisData (shared state).
   ========================================================= */
(function () {
  "use strict";

  var SESSION_KEY = "awarexUser";
  var SETTINGS_KEY = "awarexSettings";
  var PALETTE = {
    primary: "#004AC6", primary2: "#2563EB", tint: "#0053DB",
    container: "#E9F0FF", container2: "#DBE1FF", muted: "#46566C", bg: "#F7F9FB"
  };
  var charts = {};
  var camera = { stream: null, timer: null };
  var currentRoute = "dashboard";

  var ROUTES = {
    "dashboard": { title: "Dashboard", sub: "Safety Intelligence at a Glance" },
    "video-analysis": { title: "Video Analysis", sub: "Recorded industrial video - AI safety analysis" },
    "analytics": { title: "Analytics", sub: "Trends, distributions and workforce statistics" },
    "live-monitoring": { title: "Live Monitoring", sub: "Real laptop webcam feed and live safety panel" },
    "workers": { title: "Workers", sub: "Workforce PPE, zone, movement and risk" },
    "violations": { title: "Safety Violations", sub: "All detected violations with filters and status" },
    "decision-intelligence": { title: "Decision Intelligence", sub: "From detection to recommended action" },
    "reports": { title: "Reports", sub: "AwareX AI Safety Analysis Reports" },
    "settings": { title: "Settings", sub: "Profile, factory, camera, AI and security" }
  };

  /* ---------------- helpers ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function data() { return window.AwareXData.analysisData; }
  function sevClass(s) { return "ax-chip ax-chip--" + String(s || "low").toLowerCase(); }
  function statusChip(s) {
    var cls = s === "Active" ? "ax-chip--critical" : s === "Acknowledged" ? "ax-chip--medium" : "ax-chip--ok";
    return '<span class="ax-chip ' + cls + '">' + esc(s) + "</span>";
  }
  function ppeCell(ok) {
    return '<span class="ax-ppe ' + (ok ? "is-ok" : "is-no") + '"><span class="material-symbols-outlined" style="font-size:16px;">' + (ok ? "check" : "close") + "</span></span>";
  }
  function fmtBytes(b) {
    if (!b && b !== 0) return "-";
    var u = ["B", "KB", "MB", "GB"], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(1) + " " + u[i];
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function p(n) { return n < 10 ? "0" + n : n; }
    return p(h) + ":" + p(m) + ":" + p(s);
  }

  function toast(message, type) {
    var wrap = $("#axToasts");
    var el = document.createElement("div");
    el.className = "ax-toast" + (type ? " is-" + type : "");
    el.innerHTML = '<span class="material-symbols-outlined" style="font-size:19px;color:var(--ax-primary);">' +
      (type === "error" ? "error" : type === "success" ? "check_circle" : "info") + "</span><div>" + esc(message) + "</div>";
    wrap.appendChild(el);
    setTimeout(function () { el.style.opacity = "0"; setTimeout(function () { el.remove(); }, 250); }, 3600);
  }

  function openModal(html) {
    $("#axModalBody").innerHTML = html;
    $("#axModal").classList.add("is-open");
    document.body.style.overflow = "hidden";
  }
  function closeModal() {
    $("#axModal").classList.remove("is-open");
    $("#axModalBody").innerHTML = "";
    document.body.style.overflow = "";
  }

  function countUp(el, target, suffix) {
    var start = 0, dur = 900, t0 = performance.now();
    function step(now) {
      var p = Math.min(1, (now - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(start + (target - start) * eased) + (suffix || "");
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function kpiCard(icon, label, value, suffix, delta) {
    return '<div class="ax-card ax-card--hover">' +
      '<div class="ax-kpi__top"><div class="ax-kpi__icon"><span class="material-symbols-outlined">' + icon + '</span></div>' +
      '<div class="ax-kpi__label">' + esc(label) + "</div></div>" +
      '<div class="ax-kpi__value" data-count="' + value + '" data-suffix="' + (suffix || "") + '">0' + (suffix || "") + "</div>" +
      (delta ? '<div class="ax-kpi__delta">' + esc(delta) + "</div>" : "") +
      "</div>";
  }
  function animateKpis(root) {
    $$("[data-count]", root).forEach(function (el) {
      countUp(el, parseFloat(el.getAttribute("data-count")) || 0, el.getAttribute("data-suffix") || "");
    });
  }

  /* ---------------- auth ---------------- */
  function session() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; }
  }
  function requireAuth() {
    var s = session();
    if (!s) { window.location.replace("login.html?redirect=dashboard.html"); return null; }
    return s;
  }

  /* ---------------- charts ---------------- */
  function destroy(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
  function baseOpts(extra) {
    return Object.assign({
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 900, easing: "easeOutQuart" },
      plugins: { legend: { display: true, labels: { boxWidth: 10, usePointStyle: true, font: { family: "Inter", size: 11 } } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: PALETTE.muted, font: { family: "Inter", size: 11 } } },
        y: { grid: { color: "rgba(70,86,108,.1)" }, ticks: { color: PALETTE.muted, font: { family: "Inter", size: 11 } }, beginAtZero: true }
      }
    }, extra || {});
  }
  function area(ctx, labels, series) {
    var c = ctx.getContext("2d");
    var g = c.createLinearGradient(0, 0, 0, 240);
    g.addColorStop(0, "rgba(37,99,235,.28)");
    g.addColorStop(1, "rgba(37,99,235,0)");
    return new Chart(ctx, {
      type: "line",
      data: { labels: labels, datasets: series.map(function (s, i) {
        return {
          label: s.label, data: s.data, borderColor: i === 0 ? PALETTE.primary : PALETTE.primary2,
          backgroundColor: i === 0 ? g : "rgba(0,74,198,.08)", fill: true, tension: .38,
          borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5
        };
      }) },
      options: baseOpts()
    });
  }

  function renderOverviewCharts() {
    var d = data(), a = d.analytics;
    if (!a) return;
    destroy("ot"); destroy("or");
    charts.ot = area($("#chartOverviewTrend"), a.labels, [
      { label: "Safety Score", data: a.safetyScoreTrend },
      { label: "PPE Compliance %", data: a.ppeComplianceTrend }
    ]);
    charts.or = new Chart($("#chartOverviewRisk"), {
      type: "doughnut",
      data: {
        labels: ["Low", "Medium", "High", "Critical"],
        datasets: [{
          data: [d.riskDistribution.Low, d.riskDistribution.Medium, d.riskDistribution.High, d.riskDistribution.Critical],
          backgroundColor: [PALETTE.container2, "#7aa2f7", PALETTE.primary2, PALETTE.primary],
          borderWidth: 0, hoverOffset: 8
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "bottom", labels: { boxWidth: 10, usePointStyle: true, font: { family: "Inter", size: 11 } } } } }
    });
  }

  function renderAnalyticsCharts() {
    var d = data(), a = d.analytics;
    if (!a) return;
    ["st", "pt", "vt", "rd", "inc", "fr"].forEach(destroy);
    charts.st = area($("#chartSafetyTrend"), a.labels, [{ label: "Safety Score", data: a.safetyScoreTrend }]);
    charts.pt = area($("#chartPpeTrend"), a.labels, [{ label: "PPE Compliance %", data: a.ppeComplianceTrend }]);
    charts.vt = new Chart($("#chartViolationsTime"), {
      type: "bar",
      data: { labels: a.labels, datasets: [{ label: "Violations", data: a.violationsOverTime, backgroundColor: PALETTE.primary2, borderRadius: 8, maxBarThickness: 34 }] },
      options: baseOpts()
    });
    charts.rd = new Chart($("#chartRiskDonut"), {
      type: "doughnut",
      data: { labels: ["Low", "Medium", "High", "Critical"], datasets: [{ data: [d.riskDistribution.Low, d.riskDistribution.Medium, d.riskDistribution.High, d.riskDistribution.Critical], backgroundColor: [PALETTE.container2, "#7aa2f7", PALETTE.primary2, PALETTE.primary], borderWidth: 0, hoverOffset: 8 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "60%", plugins: { legend: { position: "bottom", labels: { boxWidth: 10, usePointStyle: true, font: { family: "Inter", size: 11 } } } } }
    });
    charts.inc = new Chart($("#chartIncidents"), {
      type: "bar",
      data: { labels: a.labels, datasets: [{ label: "Critical Incidents", data: a.incidentFrequency, backgroundColor: PALETTE.primary, borderRadius: 8, maxBarThickness: 34 }] },
      options: baseOpts()
    });
    charts.fr = area($("#chartFrames"), a.labels, [{ label: "Frames Processed", data: a.framesProcessed }]);

    $("#axZoneBars").innerHTML = a.zoneSafety.map(function (z) {
      return '<div style="margin-bottom:14px;">' +
        '<div style="display:flex;justify-content:space-between;font-size:13px;font-weight:600;margin-bottom:6px;">' +
        "<span>" + esc(z.zone) + '</span><span style="color:var(--ax-muted);">' + z.score + "% &middot; " + z.workers + " workers &middot; " + z.violations + " violations</span></div>" +
        '<div class="ax-progress"><span data-bar="' + z.score + '"></span></div></div>';
    }).join("");
    setTimeout(function () { $$("[data-bar]").forEach(function (b) { b.style.width = b.getAttribute("data-bar") + "%"; }); }, 60);

    var w = d.workers;
    var rows = [
      ["Total Workers Detected", w.length],
      ["Active Workers", w.filter(function (x) { return x.active; }).length],
      ["Average Safety Score", d.safetyScore + "%"],
      ["PPE Compliance", d.ppeCompliance + "%"],
      ["High Risk Workers", w.filter(function (x) { return x.risk === "High"; }).length],
      ["Critical Risk Workers", w.filter(function (x) { return x.risk === "Critical"; }).length],
      ["Total Violations", d.violations.length],
      ["Frames Processed", d.framesProcessed.toLocaleString()]
    ];
    $("#axWorkerStats").innerHTML = '<ul class="ax-list">' + rows.map(function (r) {
      return "<li><span style='flex:1'>" + esc(r[0]) + "</span><strong>" + esc(r[1]) + "</strong></li>";
    }).join("") + "</ul>";

    $("#axAnalyticsKpi").innerHTML =
      kpiCard("shield", "Safety Score", d.safetyScore, "%") +
      kpiCard("health_and_safety", "PPE Compliance", d.ppeCompliance, "%") +
      kpiCard("gpp_maybe", "Total Violations", d.violations.length, "") +
      kpiCard("burst_mode", "Frames Processed", d.framesProcessed, "");
    animateKpis($("#axAnalyticsKpi"));
  }

  /* ---------------- sections ---------------- */
  function renderDashboard() {
    var d = data();
    var active = d.workers.filter(function (w) { return w.active; }).length;
    var critical = d.violations.filter(function (v) { return v.severity === "Critical"; }).length;
    var restricted = d.violations.filter(function (v) { return v.type === "Restricted Zone Entry"; }).length;

    $("#axKpiGrid").innerHTML =
      kpiCard("groups", "Total Workers", d.workers.length, "", "Detected in current analysis") +
      kpiCard("directions_walk", "Active Workers", active, "", "Currently on the floor") +
      kpiCard("shield", "Safety Score", d.safetyScore, "%", "Workforce average") +
      kpiCard("health_and_safety", "PPE Compliance", d.ppeCompliance, "%", "Helmet / vest / gloves / shoes") +
      kpiCard("notifications_active", "Active Alerts", d.alerts.length, "", "Unresolved critical alerts") +
      kpiCard("crisis_alert", "Critical Incidents", critical, "", "Highest severity detections") +
      kpiCard("block", "Restricted Zone Violations", restricted, "", "Unauthorised zone entries") +
      kpiCard("burst_mode", "Frames Analyzed", d.framesProcessed, "", "Vision pipeline throughput");
    animateKpis($("#axKpiGrid"));
    $("#axKpiUpdated").textContent = d.analyzedAt ? "Updated " + new Date(d.analyzedAt).toLocaleString() : "";

    $("#axRecentViolations").innerHTML = d.violations.slice(0, 6).map(function (v) {
      return "<tr><td><strong>" + esc(v.workerId) + "</strong></td><td>" + esc(v.type) + "</td><td>" + esc(v.location) +
        "</td><td>" + esc(v.time) + '</td><td><span class="' + sevClass(v.severity) + '">' + esc(v.severity) + "</span></td><td>" + statusChip(v.status) + "</td></tr>";
    }).join("") || '<tr><td colspan="6" class="ax-empty">No violations detected.</td></tr>';

    $("#axOverviewDI").innerHTML = d.recommendations.slice(0, 3).map(function (r) {
      return '<div class="ax-card" style="box-shadow:none;border-color:var(--ax-border);margin-bottom:10px;padding:14px;">' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><strong style="font-size:13.5px;">' + esc(r.workerId) + "</strong>" +
        '<span class="' + sevClass(r.risk) + '">' + esc(r.risk) + "</span>" +
        '<span class="ax-chip ax-chip--demo">DEMO</span></div>' +
        '<div style="font-size:12.5px;color:var(--ax-muted);margin-top:6px;">' + esc(r.factors.join(" + ")) + "</div>" +
        '<div style="font-size:12.5px;margin-top:8px;"><strong>Action:</strong> ' + esc(r.actions[0]) + "</div></div>";
    }).join("") || '<div class="ax-empty">No AI recommendations pending.</div>';

    renderOverviewCharts();
    $("[data-badge='workers']").textContent = d.workers.length;
    $("[data-badge='violations']").textContent = d.violations.length;
  }

  /* ----- video analysis ----- */
  var pendingFile = null;

  function resetAnalysis() {
    pendingFile = null;
    window.AwareXData.reset();
    $("#axFileStage").style.display = "none";
    $("#axResultStage").style.display = "none";
    $("#axAnalysisProgress").style.display = "none";
    $("#axUploadStage").style.display = "";
    $("#axFileInput").value = "";
    toast("Previous analysis cleared. Upload a new video to start.", "info");
  }

  function handleFile(file) {
    if (!file) return;
    var okTypes = /(mp4|quicktime|x-msvideo|avi|webm)/i;
    if (!okTypes.test(file.type) && !/\.(mp4|mov|avi|webm)$/i.test(file.name)) {
      toast("Unsupported file. Use MP4, MOV, AVI or WebM.", "error");
      return;
    }
    // A new video always clears the previous analysis state.
    window.AwareXData.reset();
    $("#axResultStage").style.display = "none";

    var url = URL.createObjectURL(file);
    var probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = function () {
      pendingFile = {
        name: file.name, size: fmtBytes(file.size), bytes: file.size,
        duration: fmtTime(probe.duration),
        resolution: (probe.videoWidth || 0) + " x " + (probe.videoHeight || 0),
        fps: 30, type: file.type || "video/mp4", url: url
      };
      showFileStage();
    };
    probe.onerror = function () {
      pendingFile = { name: file.name, size: fmtBytes(file.size), bytes: file.size, duration: "-", resolution: "-", fps: 30, type: file.type, url: url };
      showFileStage();
    };
    probe.src = url;
  }

  function showFileStage() {
    var f = pendingFile;
    $("#axUploadStage").style.display = "none";
    var stage = $("#axFileStage");
    stage.style.display = "";
    stage.innerHTML =
      '<div class="ax-card"><div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;">' +
      '<div style="flex:1 1 320px;min-width:260px;"><video class="ax-media" src="' + esc(f.url) + '" controls></video></div>' +
      '<div style="flex:1 1 320px;min-width:260px;">' +
      '<h4 class="ax-card__title">' + esc(f.name) + "</h4>" +
      '<p class="ax-card__sub">Ready for AI safety analysis</p>' +
      '<ul class="ax-list">' +
      "<li><span style='flex:1'>File Name</span><strong>" + esc(f.name) + "</strong></li>" +
      "<li><span style='flex:1'>File Size</span><strong>" + esc(f.size) + "</strong></li>" +
      "<li><span style='flex:1'>Duration</span><strong>" + esc(f.duration) + "</strong></li>" +
      "<li><span style='flex:1'>Resolution</span><strong>" + esc(f.resolution) + "</strong></li>" +
      "<li><span style='flex:1'>FPS</span><strong>" + esc(f.fps) + "</strong></li>" +
      "</ul>" +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;">' +
      '<button class="ax-btn ax-btn--primary" id="axStartAnalysis"><span class="material-symbols-outlined">bolt</span>START AI ANALYSIS</button>' +
      '<button class="ax-btn ax-btn--ghost" id="axChangeFile">Choose another file</button></div>' +
      '<p style="font-size:12px;color:var(--ax-muted);margin-top:12px;">DEMO MODE - results are simulated. Connect FastAPI + YOLO + OpenCV to produce real detections.</p>' +
      "</div></div></div>";

    $("#axStartAnalysis").addEventListener("click", startAnalysis);
    $("#axChangeFile").addEventListener("click", function () {
      $("#axFileStage").style.display = "none";
      $("#axUploadStage").style.display = "";
      $("#axFileInput").value = "";
    });
  }

  function startAnalysis() {
    var prog = $("#axAnalysisProgress");
    prog.style.display = "";
    var steps = ["Extracting frames (OpenCV)", "Detecting workers &amp; PPE (YOLO)", "Tracking workers across frames", "Scoring risk (ML model)", "Generating decision intelligence"];
    prog.innerHTML = '<div class="ax-card"><h4 class="ax-card__title">Analyzing video</h4><p class="ax-card__sub">DEMO MODE pipeline simulation</p>' +
      '<div class="ax-progress" style="height:10px;"><span id="axProgBar"></span></div>' +
      '<div id="axProgStep" style="font-size:13px;color:var(--ax-muted);margin-top:12px;"></div>' +
      '<div style="display:grid;gap:10px;margin-top:16px;">' +
      '<div class="ax-skeleton" style="height:18px;width:60%;"></div><div class="ax-skeleton" style="height:18px;width:85%;"></div><div class="ax-skeleton" style="height:18px;width:45%;"></div></div></div>';

    var i = 0;
    var iv = setInterval(function () {
      i++;
      $("#axProgBar").style.width = Math.min(100, i * 20) + "%";
      $("#axProgStep").innerHTML = steps[Math.min(i - 1, steps.length - 1)];
      if (i >= steps.length) clearInterval(iv);
    }, 420);

    window.AwareXData.api.analyzeVideo(pendingFile).then(function () {
      clearInterval(iv);
      prog.style.display = "none";
      renderResult();
      renderAll();
      toast("Analysis complete (DEMO MODE).", "success");
    });
  }

  function renderResult() {
    var d = data(), f = d.video;
    var stage = $("#axResultStage");
    stage.style.display = "";
    var riskLevel = d.safetyScore >= 85 ? "Low" : d.safetyScore >= 72 ? "Medium" : d.safetyScore >= 60 ? "High" : "Critical";
    stage.innerHTML =
      '<div class="ax-card" style="margin-bottom:18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
      '<h4 class="ax-card__title" style="margin:0;">Analysis Result</h4>' +
      '<span class="ax-chip ax-chip--demo">DEMO MODE - simulated detections</span>' +
      '<div style="flex:1"></div>' +
      '<button class="ax-btn ax-btn--soft ax-btn--sm" data-goto="reports">Open Reports</button>' +
      '<button class="ax-btn ax-btn--soft ax-btn--sm" data-goto="decision-intelligence">Decision Intelligence</button></div>' +

      '<div class="ax-grid ax-grid--sidebarish" style="margin-bottom:18px;">' +
      '<div class="ax-card"><h4 class="ax-card__title">Video Preview</h4><p class="ax-card__sub">' + esc(f.name) + "</p>" +
      (f.url ? '<video class="ax-media" src="' + esc(f.url) + '" controls></video>'
        : '<div class="ax-media" style="display:grid;place-items:center;color:#fff;font-size:13px;">Demo baseline video (no file loaded)</div>') +
      "</div>" +
      '<div class="ax-card"><h4 class="ax-card__title">Summary</h4><p class="ax-card__sub">Aggregated safety outcome</p><ul class="ax-list">' +
      "<li><span style='flex:1'>Total Workers</span><strong>" + d.workers.length + "</strong></li>" +
      "<li><span style='flex:1'>PPE Compliance</span><strong>" + d.ppeCompliance + "%</strong></li>" +
      "<li><span style='flex:1'>Safety Score</span><strong>" + d.safetyScore + "%</strong></li>" +
      "<li><span style='flex:1'>Violations</span><strong>" + d.violations.length + "</strong></li>" +
      "<li><span style='flex:1'>Critical Alerts</span><strong>" + d.alerts.length + "</strong></li>" +
      "<li><span style='flex:1'>Risk Level</span><span class='" + sevClass(riskLevel) + "'>" + riskLevel + "</span></li>" +
      "</ul></div></div>" +

      '<div class="ax-card"><h4 class="ax-card__title">Detected Workers</h4><p class="ax-card__sub">Per-worker PPE, zone, movement and risk</p>' +
      '<div class="ax-table-wrap"><table class="ax-table"><thead><tr><th>Worker ID</th><th>Helmet</th><th>Vest</th><th>Gloves</th><th>Shoes</th><th>Zone</th><th>Movement</th><th>Risk</th><th>Safety Score</th></tr></thead><tbody>' +
      d.workers.map(function (w) {
        return '<tr data-clickable data-worker="' + esc(w.id) + '"><td><strong>' + esc(w.id) + "</strong></td>" +
          ppeTd(w) + "<td>" + esc(w.zone) + "</td><td>" + esc(w.movement) + '</td><td><span class="' + sevClass(w.risk) + '">' + esc(w.risk) + "</span></td><td>" + w.safetyScore + "%</td></tr>";
      }).join("") +
      "</tbody></table></div></div>";
  }
  function ppeTd(w) {
    return "<td>" + ppeCell(w.ppe.helmet) + "</td><td>" + ppeCell(w.ppe.vest) + "</td><td>" + ppeCell(w.ppe.gloves) + "</td><td>" + ppeCell(w.ppe.shoes) + "</td>";
  }

  /* ----- workers ----- */
  function renderWorkers() {
    var d = data(), w = d.workers;
    $("#axWorkerKpi").innerHTML =
      kpiCard("groups", "Total Workers", w.length, "") +
      kpiCard("directions_walk", "Active Workers", w.filter(function (x) { return x.active; }).length, "") +
      kpiCard("warning", "High Risk Workers", w.filter(function (x) { return x.risk === "High"; }).length, "") +
      kpiCard("crisis_alert", "Critical Workers", w.filter(function (x) { return x.risk === "Critical"; }).length, "");
    animateKpis($("#axWorkerKpi"));
    filterWorkers();
  }
  function filterWorkers() {
    var q = ($("#axWorkerSearch").value || "").toLowerCase();
    var risk = $("#axWorkerRisk").value;
    var rows = data().workers.filter(function (w) {
      var m = !q || w.id.toLowerCase().indexOf(q) > -1 || w.zone.toLowerCase().indexOf(q) > -1;
      return m && (!risk || w.risk === risk);
    });
    $("#axWorkerTable").innerHTML = rows.map(function (w) {
      return '<tr data-clickable data-worker="' + esc(w.id) + '"><td><strong>' + esc(w.id) + "</strong></td>" + ppeTd(w) +
        "<td>" + esc(w.zone) + "</td><td>" + esc(w.movement) + '</td><td><span class="' + sevClass(w.risk) + '">' + esc(w.risk) +
        "</span></td><td>" + w.safetyScore + "%</td><td>" + w.violations + "</td></tr>";
    }).join("") || '<tr><td colspan="10"><div class="ax-empty"><span class="material-symbols-outlined">search_off</span><p>No workers match your filters.</p></div></td></tr>';
  }
  function openWorker(id) {
    var w = data().workers.filter(function (x) { return x.id === id; })[0];
    if (!w) return;
    var vios = data().violations.filter(function (v) { return v.workerId === id; });
    openModal(
      '<h3 style="margin:0 0 4px;font-size:20px;font-weight:800;">' + esc(w.id) + "</h3>" +
      '<p style="margin:0 0 18px;color:var(--ax-muted);font-size:13px;">' + esc(w.name) + " &middot; " + esc(w.shift) + '</p>' +
      '<div class="ax-grid ax-grid--3" style="margin-bottom:18px;">' +
      kpiCard("shield", "Safety Score", w.safetyScore, "%") +
      kpiCard("warning", "Violations", w.violations, "") +
      kpiCard("target", "Detection Confidence", w.confidence, "%") +
      "</div>" +
      '<div class="ax-card" style="margin-bottom:18px;"><h4 class="ax-card__title">Status</h4><ul class="ax-list">' +
      "<li><span style='flex:1'>Helmet</span>" + ppeCell(w.ppe.helmet) + "</li>" +
      "<li><span style='flex:1'>Safety Vest</span>" + ppeCell(w.ppe.vest) + "</li>" +
      "<li><span style='flex:1'>Gloves</span>" + ppeCell(w.ppe.gloves) + "</li>" +
      "<li><span style='flex:1'>Safety Shoes</span>" + ppeCell(w.ppe.shoes) + "</li>" +
      "<li><span style='flex:1'>Current Zone</span><strong>" + esc(w.zone) + "</strong></li>" +
      "<li><span style='flex:1'>Movement</span><strong>" + esc(w.movement) + "</strong></li>" +
      "<li><span style='flex:1'>Risk Level</span><span class='" + sevClass(w.risk) + "'>" + esc(w.risk) + "</span></li>" +
      "<li><span style='flex:1'>Last Seen</span><strong>" + esc(w.lastSeen) + "</strong></li>" +
      "</ul></div>" +
      '<div class="ax-card"><h4 class="ax-card__title">Violation History</h4>' +
      (vios.length ? '<div class="ax-timeline">' + vios.map(function (v) {
        return '<div class="ax-timeline__item"><div style="font-size:13.5px;font-weight:700;">' + esc(v.type) +
          ' <span class="' + sevClass(v.severity) + '">' + esc(v.severity) + '</span></div>' +
          '<div style="font-size:12.5px;color:var(--ax-muted);">' + esc(v.date) + " " + esc(v.time) + " &middot; " + esc(v.location) + "</div></div>";
      }).join("") + "</div>" : '<div class="ax-empty">No violations recorded for this worker.</div>') + "</div>"
    );
    animateKpis($("#axModalBody"));
  }

  /* ----- violations ----- */
  var sevTab = "";
  function renderViolations() {
    var d = data();
    $("#axViolationKpi").innerHTML =
      kpiCard("crisis_alert", "Critical", d.violations.filter(function (v) { return v.severity === "Critical"; }).length, "") +
      kpiCard("priority_high", "High", d.violations.filter(function (v) { return v.severity === "High"; }).length, "") +
      kpiCard("warning", "Medium", d.violations.filter(function (v) { return v.severity === "Medium"; }).length, "") +
      kpiCard("info", "Low", d.violations.filter(function (v) { return v.severity === "Low"; }).length, "");
    animateKpis($("#axViolationKpi"));

    var workerSel = $("#axFilterWorker"), zoneSel = $("#axFilterZone"), typeSel = $("#axFilterType");
    workerSel.innerHTML = '<option value="">All</option>' + d.workers.map(function (w) { return "<option>" + esc(w.id) + "</option>"; }).join("");
    zoneSel.innerHTML = '<option value="">All</option>' + window.AwareXData.ZONES.map(function (z) { return "<option>" + esc(z) + "</option>"; }).join("");
    typeSel.innerHTML = '<option value="">All</option>' + window.AwareXData.VIOLATION_TYPES.map(function (t) { return "<option>" + esc(t) + "</option>"; }).join("");
    filterViolations();
  }
  function filterViolations() {
    var d = data();
    var date = $("#axFilterDate").value, sev = $("#axFilterSeverity").value || sevTab;
    var worker = $("#axFilterWorker").value, zone = $("#axFilterZone").value, type = $("#axFilterType").value;
    var rows = d.violations.filter(function (v) {
      return (!date || v.date === date) && (!sev || v.severity === sev) && (!worker || v.workerId === worker) &&
        (!zone || v.location === zone) && (!type || v.type === type);
    });
    $("#axViolationTable").innerHTML = rows.map(function (v) {
      return "<tr><td>" + esc(v.id) + "</td><td><strong>" + esc(v.workerId) + "</strong></td><td>" + esc(v.type) + "</td><td>" + esc(v.location) +
        "</td><td>" + esc(v.date) + " " + esc(v.time) + '</td><td><span class="' + sevClass(v.severity) + '">' + esc(v.severity) + "</span></td><td>" + statusChip(v.status) + "</td>" +
        '<td><button class="ax-btn ax-btn--soft ax-btn--sm" data-ack="' + esc(v.id) + '"' + (v.status === "Resolved" ? " disabled" : "") + ">" +
        (v.status === "Active" ? "Acknowledge" : v.status === "Acknowledged" ? "Resolve" : "Resolved") + "</button></td></tr>";
    }).join("") || '<tr><td colspan="8"><div class="ax-empty"><span class="material-symbols-outlined">verified</span><p>No violations match these filters.</p></div></td></tr>';
  }

  /* ----- decision intelligence ----- */
  function renderDI() {
    var d = data();
    $("#axDIList").innerHTML = d.recommendations.map(function (r) {
      return '<div class="ax-card ax-card--hover" data-di="' + esc(r.id) + '">' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">' +
        '<strong style="font-size:15px;">' + esc(r.workerId) + "</strong>" +
        '<span class="ax-chip ax-chip--demo">' + esc(r.source) + "</span>" +
        '<div style="flex:1"></div><span class="' + sevClass(r.risk) + '">RISK: ' + esc(r.risk) + "</span></div>" +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">' +
        r.factors.map(function (f) { return '<span class="ax-chip ax-chip--low">' + esc(f) + "</span>"; }).join("") + "</div>" +
        '<div style="font-size:12px;color:var(--ax-muted);margin-bottom:6px;">AI RECOMMENDATION &middot; confidence ' + r.confidence + "%</div>" +
        '<ul class="ax-list" style="margin-bottom:14px;">' + r.actions.map(function (a) {
          return "<li><span class='material-symbols-outlined' style='color:var(--ax-primary);font-size:18px;'>arrow_forward</span><span>" + esc(a) + "</span></li>";
        }).join("") + "</ul>" +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button class="ax-btn ax-btn--soft ax-btn--sm" data-di-ack="' + esc(r.id) + '">ACKNOWLEDGE</button>' +
        '<button class="ax-btn ax-btn--primary ax-btn--sm" data-di-action="' + esc(r.id) + '">TAKE ACTION</button>' +
        '<button class="ax-btn ax-btn--ghost ax-btn--sm" data-worker="' + esc(r.workerId) + '">VIEW WORKER</button>' +
        '<span class="ax-chip ax-chip--muted" style="margin-left:auto;">' + esc(r.status) + "</span></div></div>";
    }).join("") || '<div class="ax-card ax-empty"><span class="material-symbols-outlined">psychology</span><p>No AI recommendations. Run a video analysis to generate decision intelligence.</p></div>';
  }

  /* ----- reports ----- */
  function renderReports() {
    var d = data();
    $("#axReportTable").innerHTML = d.reports.map(function (r) {
      return "<tr><td><strong>" + esc(r.name) + "</strong><br/><small style='color:var(--ax-muted)'>" + esc(r.id) + "</small></td><td>" + esc(r.video) +
        "</td><td>" + esc(r.date) + "</td><td>" + r.workers + "</td><td>" + r.violations + "</td><td>" + r.safetyScore + "%</td><td>" +
        '<span class="ax-chip ' + (r.status === "Ready" ? "ax-chip--ok" : "ax-chip--muted") + '">' + esc(r.status) + "</span></td>" +
        '<td><div style="display:flex;gap:6px;">' +
        '<button class="ax-btn ax-btn--soft ax-btn--sm" data-report-view="' + esc(r.id) + '">View</button>' +
        '<button class="ax-btn ax-btn--ghost ax-btn--sm" data-report-print="' + esc(r.id) + '">Print</button>' +
        '<button class="ax-btn ax-btn--ghost ax-btn--sm" data-report-download="' + esc(r.id) + '">Download</button>' +
        "</div></td></tr>";
    }).join("") || '<tr><td colspan="8"><div class="ax-empty"><span class="material-symbols-outlined">description</span><p>No reports yet.</p></div></td></tr>';
  }

  function reportHtml(r) {
    var d = data();
    return '<div class="ax-report" id="axReportDoc">' +
      '<div class="ax-report__head"><img src="assets/logo/awarex-logo.png" alt="AwareX" style="height:36px;"/>' +
      "<div><h1>AI Safety Analysis Report</h1><div style='font-size:12px;color:var(--ax-muted);'>From Detection to Decision Intelligence &middot; " + esc(r.id) + "</div></div>" +
      "<div style='margin-left:auto;'><span class='ax-chip ax-chip--demo'>DEMO MODE</span></div></div>" +

      "<h3 style='font-size:14px;margin:0 0 8px;'>Video Information</h3>" +
      '<div class="ax-report__grid" style="margin-bottom:18px;">' +
      stat("Video", r.video) + stat("Analysis Date", r.date) + stat("Duration", d.video ? d.video.duration : "-") +
      stat("Total Workers", r.workers) + stat("Frames Processed", d.framesProcessed.toLocaleString()) + stat("PPE Compliance", d.ppeCompliance + "%") +
      stat("Safety Score", r.safetyScore + "%") + stat("Violations", r.violations) + stat("Critical Alerts", d.alerts.length) +
      "</div>" +

      "<h3 style='font-size:14px;margin:0 0 8px;'>Risk Distribution</h3>" +
      '<div class="ax-report__grid" style="margin-bottom:18px;">' +
      stat("Low", d.riskDistribution.Low) + stat("Medium", d.riskDistribution.Medium) + stat("High", d.riskDistribution.High) +
      "</div>" +

      "<h3 style='font-size:14px;margin:0 0 8px;'>Zone Analysis</h3>" +
      '<div class="ax-table-wrap" style="margin-bottom:18px;"><table class="ax-table"><thead><tr><th>Zone</th><th>Workers</th><th>Violations</th><th>Safety Score</th></tr></thead><tbody>' +
      (d.zones || []).map(function (z) { return "<tr><td>" + esc(z.zone) + "</td><td>" + z.workers + "</td><td>" + z.violations + "</td><td>" + z.score + "%</td></tr>"; }).join("") +
      "</tbody></table></div>" +

      "<h3 style='font-size:14px;margin:0 0 8px;'>Worker Analysis</h3>" +
      '<div class="ax-table-wrap" style="margin-bottom:18px;"><table class="ax-table"><thead><tr><th>Worker</th><th>Zone</th><th>Risk</th><th>Score</th><th>Violations</th></tr></thead><tbody>' +
      d.workers.slice(0, 12).map(function (w) { return "<tr><td>" + esc(w.id) + "</td><td>" + esc(w.zone) + "</td><td>" + esc(w.risk) + "</td><td>" + w.safetyScore + "%</td><td>" + w.violations + "</td></tr>"; }).join("") +
      "</tbody></table></div>" +

      "<h3 style='font-size:14px;margin:0 0 8px;'>Incident Timeline</h3>" +
      '<div class="ax-timeline" style="margin-bottom:18px;">' + d.timeline.map(function (t) {
        return '<div class="ax-timeline__item"><strong style="font-size:13px;">' + esc(t.time) + " - " + esc(t.title) + "</strong><div style='font-size:12px;color:var(--ax-muted);'>" + esc(t.detail) + " &middot; " + esc(t.severity) + "</div></div>";
      }).join("") + "</div>" +

      "<h3 style='font-size:14px;margin:0 0 8px;'>AI Recommendations &amp; Decision Intelligence Summary</h3>" +
      '<ul class="ax-list" style="margin-bottom:10px;">' + d.recommendations.map(function (rec) {
        return "<li><span style='flex:1'><strong>" + esc(rec.workerId) + "</strong> - " + esc(rec.factors.join(" + ")) + "</span><span>" + esc(rec.actions.join(", ")) + "</span></li>";
      }).join("") + "</ul>" +
      "<p style='font-size:11.5px;color:var(--ax-muted);'>Generated by AwareX in DEMO MODE. Values are simulated until the YOLO / OpenCV / ML backend is connected.</p>" +
      "</div>" +
      '<div class="ax-no-print" style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap;">' +
      '<button class="ax-btn ax-btn--primary ax-btn--sm" data-report-print="' + esc(r.id) + '">Print</button>' +
      '<button class="ax-btn ax-btn--ghost ax-btn--sm" data-report-download="' + esc(r.id) + '">Download HTML</button></div>';
  }
  function stat(label, value) {
    return '<div class="ax-report__stat"><small>' + esc(label) + "</small><strong>" + esc(value) + "</strong></div>";
  }
  function findReport(id) { return data().reports.filter(function (r) { return r.id === id; })[0]; }

  /* ----- settings ----- */
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch (e) { return {}; }
  }
  function saveSettings(patch) {
    var s = Object.assign(loadSettings(), patch);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    return s;
  }
  function field(label, id, value, type) {
    return '<label class="ax-field"><span>' + esc(label) + '</span><input class="ax-input" id="' + id + '" type="' + (type || "text") + '" value="' + esc(value || "") + '"/></label>';
  }
  function toggleRow(label, detail, id, checked) {
    return '<div class="ax-switch"><div class="ax-switch__meta"><strong>' + esc(label) + "</strong><small>" + esc(detail) + '</small></div>' +
      '<label class="ax-toggle"><input type="checkbox" id="' + id + '"' + (checked ? " checked" : "") + "/><i></i></label></div>";
  }

  function renderSettings(tab) {
    var s = loadSettings();
    var u = session() || {};
    var body = $("#axSettingsBody");
    var html = "";

    if (tab === "profile") {
      html = '<div class="ax-card" style="max-width:760px;"><h4 class="ax-card__title">Profile Settings</h4><p class="ax-card__sub">Your AwareX account details</p>' +
        field("Name", "setName", s.name || u.name || "Safety Manager") +
        field("Email", "setEmail", s.email || u.email || "demo@awarex.ai", "email") +
        field("Role", "setRole", s.role || "Safety Manager") +
        field("Company", "setCompany", s.company || u.company || "AwareX Industrial") +
        field("Phone", "setPhone", s.phone || "+91 00000 00000", "tel") +
        '<button class="ax-btn ax-btn--primary" data-save="profile">Save Changes</button></div>';
    } else if (tab === "factory") {
      html = '<div class="ax-card" style="max-width:760px;"><h4 class="ax-card__title">Factory Settings</h4><p class="ax-card__sub">Plant identity and operating window</p>' +
        field("Factory Name", "setFactory", s.factory || "AwareX Plant One") +
        field("Location", "setLocation", s.location || "Pune, India") +
        field("Plant ID", "setPlant", s.plant || "AX-PLT-001") +
        '<label class="ax-field"><span>Timezone</span><select class="ax-select" id="setTz">' +
        ["Asia/Kolkata", "UTC", "Europe/Berlin", "America/New_York"].map(function (t) {
          return "<option" + ((s.tz || "Asia/Kolkata") === t ? " selected" : "") + ">" + t + "</option>";
        }).join("") + "</select></label>" +
        field("Operating Hours", "setHours", s.hours || "06:00 - 22:00") +
        '<button class="ax-btn ax-btn--primary" data-save="factory">Save Factory Settings</button></div>';
    } else if (tab === "camera") {
      html = '<div class="ax-card" style="max-width:760px;"><h4 class="ax-card__title">Camera Settings</h4><p class="ax-card__sub">Sources used by Live Monitoring</p>' +
        field("Camera Name", "setCamName", s.camName || "Line A - Laptop Webcam") +
        '<label class="ax-field"><span>Camera Type</span><select class="ax-select" id="setCamType">' +
        '<option>Laptop Webcam</option><option disabled>IP Camera (Coming Soon)</option><option disabled>RTSP Stream (Coming Soon)</option><option disabled>Factory CCTV (Coming Soon)</option>' +
        "</select></label>" +
        '<label class="ax-field"><span>Resolution</span><select class="ax-select" id="setCamRes"><option>1280 x 720</option><option>1920 x 1080</option><option>640 x 480</option></select></label>' +
        field("FPS", "setCamFps", s.camFps || "30", "number") +
        '<div class="ax-switch"><div class="ax-switch__meta"><strong>Status</strong><small>Current device state</small></div><span class="ax-chip ' +
        (camera.stream ? "ax-chip--live" : "ax-chip--muted") + '">' + (camera.stream ? "Streaming" : "Idle") + "</span></div>" +
        '<button class="ax-btn ax-btn--primary" style="margin-top:14px;" data-save="camera">Save Camera Settings</button></div>';
    } else if (tab === "notifications") {
      html = '<div class="ax-card" style="max-width:760px;"><h4 class="ax-card__title">Notification Settings</h4><p class="ax-card__sub">Choose what AwareX alerts you about</p>' +
        toggleRow("Critical Alerts", "Immediate notification for critical risk", "ntfCritical", s.ntfCritical !== false) +
        toggleRow("PPE Violations", "Helmet, vest, gloves and shoes", "ntfPpe", s.ntfPpe !== false) +
        toggleRow("Restricted Zone Alerts", "Unauthorised zone entry", "ntfZone", s.ntfZone !== false) +
        toggleRow("AI Recommendations", "Decision intelligence suggestions", "ntfAi", s.ntfAi !== false) +
        toggleRow("Report Notifications", "When a report is generated", "ntfReport", !!s.ntfReport) +
        '<button class="ax-btn ax-btn--primary" style="margin-top:16px;" data-save="notifications">Save Notification Settings</button></div>';
    } else if (tab === "ai") {
      html = '<div class="ax-card" style="margin-bottom:18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:240px;"><h4 class="ax-card__title">AI Configuration</h4><p class="ax-card__sub" style="margin:0;">Integration points for the AwareX vision and decision pipeline</p></div>' +
        '<span class="ax-chip ax-chip--demo">DEMO / NOT CONNECTED</span></div>' +
        '<div class="ax-grid ax-grid--2">' + window.AwareXData.models.map(function (m) {
          return '<div class="ax-card ax-card--hover"><div style="display:flex;gap:10px;align-items:center;">' +
            '<div class="ax-kpi__icon"><span class="material-symbols-outlined">memory</span></div>' +
            "<div><strong style='font-size:14px;'>" + esc(m.name) + "</strong><div style='font-size:12px;color:var(--ax-muted);'>" + esc(m.detail) + "</div></div></div>" +
            '<div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<span class="ax-chip ax-chip--low">' + esc(m.status) + '</span><span class="ax-chip ax-chip--muted">Not Connected</span></div></div>';
        }).join("") + "</div>" +
        '<div class="ax-card" style="margin-top:18px;max-width:760px;"><h4 class="ax-card__title">Backend Endpoint</h4><p class="ax-card__sub">FastAPI base URL used once the AI service is live</p>' +
        field("API Base URL", "setApiUrl", s.apiUrl || "") +
        '<button class="ax-btn ax-btn--primary" data-save="ai">Save AI Configuration</button></div>';
    } else if (tab === "appearance") {
      html = '<div class="ax-card" style="max-width:760px;"><h4 class="ax-card__title">Appearance</h4><p class="ax-card__sub">AwareX uses the light enterprise theme by default</p>' +
        toggleRow("Compact density", "Reduce padding across tables and cards", "apCompact", !!s.apCompact) +
        toggleRow("Animated counters", "Animate KPI values on load", "apCounters", s.apCounters !== false) +
        toggleRow("Reduced motion", "Minimise transitions and chart animation", "apMotion", !!s.apMotion) +
        '<button class="ax-btn ax-btn--primary" style="margin-top:16px;" data-save="appearance">Save Appearance</button></div>';
    } else if (tab === "security") {
      html = '<div class="ax-card" style="max-width:760px;"><h4 class="ax-card__title">Security</h4><p class="ax-card__sub">Session information - passwords are never displayed</p><ul class="ax-list">' +
        "<li><span style='flex:1'>Login Status</span><span class='ax-chip ax-chip--ok'>Signed in</span></li>" +
        "<li><span style='flex:1'>Account</span><strong>" + esc(u.email || "demo@awarex.ai") + "</strong></li>" +
        "<li><span style='flex:1'>Last Login</span><strong>" + esc(u.loggedInAt ? new Date(u.loggedInAt).toLocaleString() : new Date().toLocaleString()) + "</strong></li>" +
        "<li><span style='flex:1'>Active Session</span><strong>This browser</strong></li>" +
        "</ul><button class='ax-btn ax-btn--danger' style='margin-top:14px;' id='axLogout2'>Logout</button></div>";
    } else {
      html = '<div class="ax-card" style="max-width:900px;"><h4 class="ax-card__title">System Status</h4><p class="ax-card__sub">Frontend is fully operational in DEMO MODE</p><ul class="ax-list">' +
        "<li><span style='flex:1'>AwareX Frontend</span><span class='ax-chip ax-chip--ok'>Operational</span></li>" +
        "<li><span style='flex:1'>FastAPI Backend</span><span class='ax-chip ax-chip--muted'>Not Connected</span></li>" +
        "<li><span style='flex:1'>YOLO / OpenCV Pipeline</span><span class='ax-chip ax-chip--muted'>Not Connected</span></li>" +
        "<li><span style='flex:1'>ML Risk Engine</span><span class='ax-chip ax-chip--muted'>Not Connected</span></li>" +
        "<li><span style='flex:1'>Firebase</span><span class='ax-chip ax-chip--muted'>Planned</span></li>" +
        "<li><span style='flex:1'>Local Camera Access</span><span class='ax-chip " + (navigator.mediaDevices ? "ax-chip--ok'>Supported" : "ax-chip--critical'>Unavailable") + "</span></li>" +
        "</ul></div>";
    }
    body.innerHTML = html;
  }

  /* ----- live monitoring ----- */
  function liveStats(extra) {
    var s = Object.assign({ source: "Laptop Webcam", resolution: "-", fps: "-", status: "Camera Off", uptime: "00:00:00" }, extra || {});
    $("#axCamStats").innerHTML =
      "<li><span style='flex:1'>Source</span><strong>" + esc(s.source) + "</strong></li>" +
      "<li><span style='flex:1'>Resolution</span><strong>" + esc(s.resolution) + "</strong></li>" +
      "<li><span style='flex:1'>FPS</span><strong>" + esc(s.fps) + "</strong></li>" +
      "<li><span style='flex:1'>Camera Status</span><strong>" + esc(s.status) + "</strong></li>" +
      "<li><span style='flex:1'>Session Uptime</span><strong>" + esc(s.uptime) + "</strong></li>";
  }
  function renderLive() {
    var d = data();
    $("#axLiveKpi").innerHTML =
      kpiCard("groups", "Workers In Frame", Math.min(8, d.workers.length), "") +
      kpiCard("health_and_safety", "PPE Compliance", d.ppeCompliance, "%") +
      kpiCard("notifications_active", "Live Alerts", d.alerts.length, "") +
      kpiCard("shield", "Live Safety Score", d.safetyScore, "%");
    animateKpis($("#axLiveKpi"));
    if (!camera.stream) liveStats();
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("This browser does not support camera access.", "error");
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(function (stream) {
      camera.stream = stream;
      var video = $("#axLiveVideo");
      video.srcObject = stream;
      video.play().catch(function () {});
      $("#axStartCam").disabled = true;
      $("#axStopCam").disabled = false;
      $("#axLiveDot").style.display = "";
      $("#axLiveBadge").className = "ax-chip ax-chip--live";
      $("#axLiveBadge").innerHTML = '<span class="ax-dot ax-blink"></span> Streaming';

      var t0 = Date.now();
      var track = stream.getVideoTracks()[0];
      var settings = track.getSettings ? track.getSettings() : {};
      camera.timer = setInterval(function () {
        liveStats({
          source: track.label || "Laptop Webcam",
          resolution: (video.videoWidth || settings.width || 0) + " x " + (video.videoHeight || settings.height || 0),
          fps: settings.frameRate ? Math.round(settings.frameRate) : 30,
          status: "Streaming (real device)",
          uptime: fmtTime((Date.now() - t0) / 1000)
        });
      }, 1000);
      toast("Laptop camera started.", "success");
    }).catch(function (err) {
      toast("Camera permission denied or unavailable: " + err.name, "error");
    });
  }

  function stopCamera() {
    if (camera.stream) {
      camera.stream.getTracks().forEach(function (t) { t.stop(); });
      camera.stream = null;
    }
    if (camera.timer) { clearInterval(camera.timer); camera.timer = null; }
    var video = $("#axLiveVideo");
    video.pause();
    video.srcObject = null;
    $("#axStartCam").disabled = false;
    $("#axStopCam").disabled = true;
    $("#axLiveDot").style.display = "none";
    $("#axLiveBadge").className = "ax-chip ax-chip--muted";
    $("#axLiveBadge").innerHTML = '<span class="ax-dot"></span> Camera Off';
    liveStats();
    toast("Camera stopped and released.", "info");
  }

  /* ---------------- routing ---------------- */
  function go(route) {
    if (!ROUTES[route]) route = "dashboard";
    currentRoute = route;
    $$(".ax-section").forEach(function (s) { s.classList.remove("is-active"); });
    var el = $("#section-" + route);
    if (el) el.classList.add("is-active");
    $$(".ax-nav__item").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-route") === route); });
    $("#axPageTitle").textContent = ROUTES[route].title;
    $("#axPageSub").textContent = ROUTES[route].sub;
    if (location.hash.slice(1) !== route) history.replaceState(null, "", "#" + route);
    closeSidebar();
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (route === "dashboard") renderDashboard();
    if (route === "analytics") renderAnalyticsCharts();
    if (route === "workers") renderWorkers();
    if (route === "violations") renderViolations();
    if (route === "decision-intelligence") renderDI();
    if (route === "reports") renderReports();
    if (route === "live-monitoring") renderLive();
    if (route === "settings") renderSettings($(".ax-tab.is-active", $("#axSettingsTabs")).getAttribute("data-tab"));
    if (route === "video-analysis" && data().workers.length && !pendingFile) {
      $("#axResultStage").style.display = "";
      if (!$("#axResultStage").innerHTML.trim()) renderResult();
    }
  }

  function renderAll() {
    $("[data-badge='workers']").textContent = data().workers.length;
    $("[data-badge='violations']").textContent = data().violations.length;
    if (currentRoute === "dashboard") renderDashboard();
    if (currentRoute === "analytics") renderAnalyticsCharts();
    if (currentRoute === "workers") renderWorkers();
    if (currentRoute === "violations") renderViolations();
    if (currentRoute === "decision-intelligence") renderDI();
    if (currentRoute === "reports") renderReports();
    if (currentRoute === "live-monitoring") renderLive();
  }

  function openSidebar() { $("#axSidebar").classList.add("is-open"); $("#axBackdrop").classList.add("is-open"); }
  function closeSidebar() { $("#axSidebar").classList.remove("is-open"); $("#axBackdrop").classList.remove("is-open"); }

  function syncMenuButton() {
    $("#axMenuToggle").style.display = window.innerWidth <= 1024 ? "" : "none";
    if (window.innerWidth > 1024) closeSidebar();
  }

  function logout() {
    stopCamera();
    localStorage.removeItem(SESSION_KEY);
    window.location.replace("login.html");
  }

  /* ---------------- init ---------------- */
  document.addEventListener("DOMContentLoaded", function () {
    var user = requireAuth();
    if (!user) return;

    $("#axUserName").textContent = user.name || "Safety Manager";
    $("#axUserEmail").textContent = user.email || "demo@awarex.ai";

    window.AwareXData.subscribe(renderAll);

    // navigation
    $("#axNav").addEventListener("click", function (e) {
      var btn = e.target.closest(".ax-nav__item");
      if (btn) go(btn.getAttribute("data-route"));
    });
    $("#axMenuToggle").addEventListener("click", openSidebar);
    $("#axBackdrop").addEventListener("click", closeSidebar);
    window.addEventListener("resize", syncMenuButton);
    syncMenuButton();

    // global delegated actions
    document.addEventListener("click", function (e) {
      var t = e.target;
      var goBtn = t.closest("[data-goto]");
      if (goBtn) { go(goBtn.getAttribute("data-goto")); return; }

      if (t.closest("[data-close-modal]")) { closeModal(); return; }

      var workerEl = t.closest("[data-worker]");
      if (workerEl) { openWorker(workerEl.getAttribute("data-worker")); return; }

      var ack = t.closest("[data-ack]");
      if (ack) {
        var v = data().violations.filter(function (x) { return x.id === ack.getAttribute("data-ack"); })[0];
        if (v) {
          v.status = v.status === "Active" ? "Acknowledged" : "Resolved";
          toast("Violation " + v.id + " marked " + v.status + ".", "success");
          filterViolations();
        }
        return;
      }

      var diAck = t.closest("[data-di-ack]"), diAct = t.closest("[data-di-action]");
      if (diAck || diAct) {
        var id = (diAck || diAct).getAttribute(diAck ? "data-di-ack" : "data-di-action");
        var rec = data().recommendations.filter(function (x) { return x.id === id; })[0];
        if (rec) {
          rec.status = diAck ? "Acknowledged" : "Action Taken";
          toast(diAck ? "Recommendation acknowledged." : "Action dispatched (DEMO MODE).", "success");
          renderDI();
        }
        return;
      }

      var rv = t.closest("[data-report-view]");
      if (rv) { var r1 = findReport(rv.getAttribute("data-report-view")); if (r1) openModal(reportHtml(r1)); return; }

      var rp = t.closest("[data-report-print]");
      if (rp) {
        var r2 = findReport(rp.getAttribute("data-report-print"));
        if (r2) { openModal(reportHtml(r2)); setTimeout(function () { window.print(); }, 300); }
        return;
      }

      var rd = t.closest("[data-report-download]");
      if (rd) {
        var r3 = findReport(rd.getAttribute("data-report-download"));
        if (!r3) return;
        var doc = "<!doctype html><html><head><meta charset='utf-8'><title>" + esc(r3.name) +
          "</title><link rel='stylesheet' href='css/dashboard.css'></head><body style='padding:24px;background:#fff'>" +
          reportHtml(r3).replace(/<div class="ax-no-print"[\s\S]*$/, "") + "</body></html>";
        var blob = new Blob([doc], { type: "text/html" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = r3.id + "-awarex-report.html";
        a.click();
        toast("Report downloaded.", "success");
        return;
      }

      var save = t.closest("[data-save]");
      if (save) {
        var group = save.getAttribute("data-save");
        var patch = {};
        $$("#axSettingsBody input, #axSettingsBody select").forEach(function (inp) {
          patch[inp.id] = inp.type === "checkbox" ? inp.checked : inp.value;
        });
        saveSettings(patch);
        if (group === "ai") window.AwareXData.api.baseUrl = patch.setApiUrl || "";
        toast("Settings saved.", "success");
        return;
      }

      if (t.closest("#axLogout") || t.closest("#axLogout2")) { logout(); }
    });

    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeModal(); closeSidebar(); } });

    // video analysis
    var drop = $("#axDropzone");
    $("#axBrowseBtn").addEventListener("click", function () { $("#axFileInput").click(); });
    $("#axFileInput").addEventListener("change", function (e) { handleFile(e.target.files[0]); });
    ["dragenter", "dragover"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("is-over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("is-over"); });
    });
    drop.addEventListener("drop", function (e) { handleFile(e.dataTransfer.files[0]); });
    $("#axNewAnalysis").addEventListener("click", resetAnalysis);

    // workers filters
    $("#axWorkerSearch").addEventListener("input", filterWorkers);
    $("#axWorkerRisk").addEventListener("change", filterWorkers);

    // violation filters
    ["axFilterDate", "axFilterSeverity", "axFilterWorker", "axFilterZone", "axFilterType"].forEach(function (id) {
      $("#" + id).addEventListener("change", filterViolations);
    });
    $("#axViolationTabs").addEventListener("click", function (e) {
      var b = e.target.closest(".ax-tab");
      if (!b) return;
      $$(".ax-tab", $("#axViolationTabs")).forEach(function (x) { x.classList.remove("is-active"); });
      b.classList.add("is-active");
      sevTab = b.getAttribute("data-sev");
      $("#axFilterSeverity").value = sevTab;
      filterViolations();
    });

    // reports
    $("#axGenerateReport").addEventListener("click", function () {
      var d = data();
      if (!d.workers.length) { toast("Run a video analysis first.", "error"); return; }
      d.reports.unshift({
        id: "RPT-" + Math.floor(Math.random() * 9000 + 1000),
        name: "AwareX Safety Analysis " + new Date().toLocaleDateString(),
        video: d.video ? d.video.name : "current-analysis",
        date: new Date().toISOString().slice(0, 10),
        workers: d.workers.length, violations: d.violations.length,
        safetyScore: d.safetyScore, status: "Ready"
      });
      renderReports();
      toast("New report generated.", "success");
    });

    // settings tabs
    $("#axSettingsTabs").addEventListener("click", function (e) {
      var b = e.target.closest(".ax-tab");
      if (!b) return;
      $$(".ax-tab", $("#axSettingsTabs")).forEach(function (x) { x.classList.remove("is-active"); });
      b.classList.add("is-active");
      renderSettings(b.getAttribute("data-tab"));
    });

    // live camera
    $("#axStartCam").addEventListener("click", startCamera);
    $("#axStopCam").addEventListener("click", stopCamera);
    window.addEventListener("beforeunload", function () {
      if (camera.stream) camera.stream.getTracks().forEach(function (t) { t.stop(); });
    });

    window.addEventListener("hashchange", function () { go(location.hash.slice(1)); });
    go(location.hash.slice(1) || "dashboard");
  });
})();
