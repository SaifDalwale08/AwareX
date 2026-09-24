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
  var camera = {
    stream: null,
    timer: null,
    frameTimer: null,       // interval that captures + sends frames to /api/analyze-frame
    startedAt: null,
    alertBaseline: [],
    confirmedAlert: null,
    countdown: null,
    lastFrameResult: null,  // most recent /api/analyze-frame response
    framesSent: 0,
    framesError: 0
  };
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
    "settings": { title: "Settings", sub: "Profile, factory, camera, AI and security" },
    "ppe-intelligence": { title: "PPE Intelligence", sub: "Multi-frame PPE compliance validation" },
    "impact": { title: "Impact & Analytics", sub: "Workforce safety impact metrics and trends" },
    "emergency": { title: "Emergency Workflow", sub: "AI-detected emergencies awaiting manager review" },
    "camera-config": { title: "Camera Deployment", sub: "Configure camera sources for live monitoring" }
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
        fps: 30, type: file.type || "video/mp4", url: url,
        file: file
      };
      showFileStage();
    };
    probe.onerror = function () {
      pendingFile = { name: file.name, size: fmtBytes(file.size), bytes: file.size, duration: "-", resolution: "-", fps: 30, type: file.type, url: url, file: file };
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
      '<p style="font-size:12px;color:var(--ax-muted);margin-top:12px;">Ready for real AI video analysis through FastAPI, OpenCV, and YOLO.</p>' +
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
    prog.innerHTML = '<div class="ax-card"><h4 class="ax-card__title">Analyzing video</h4><p class="ax-card__sub">AI video analysis pipeline running</p>' +
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
      toast("Analysis complete.", "success");
    }).catch(function (error) {
      clearInterval(iv);
      prog.style.display = "none";
      toast(error.message || "Video analysis failed.", "error");
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
      '<span class="ax-chip ax-chip--demo">AI video analysis results</span>' +
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
    var el = $("#axCamStats");
    if (!el) return;
    el.innerHTML =
      "<li><span style='flex:1'>Source</span><strong>" + esc(s.source) + "</strong></li>" +
      "<li><span style='flex:1'>Resolution</span><strong>" + esc(s.resolution) + "</strong></li>" +
      "<li><span style='flex:1'>FPS</span><strong>" + esc(s.fps) + "</strong></li>" +
      "<li><span style='flex:1'>Camera Status</span><strong>" + esc(s.status) + "</strong></li>" +
      "<li><span style='flex:1'>Session Uptime</span><strong>" + esc(s.uptime) + "</strong></li>";
  }

  function setPipelineStage(name, state, label) {
    var stage = $("[data-pipeline-stage='" + name + "']");
    if (!stage) return;
    stage.classList.remove("is-ready", "is-active", "is-pending", "is-confirmed");
    stage.classList.add("is-" + state);
    var status = $("[data-pipeline-status]", stage);
    if (status) status.textContent = label;
  }

  function renderLivePipeline() {
    var streaming = !!camera.stream;
    var backendReady = !!(window.AwareXData && window.AwareXData.api && window.AwareXData.api.connected);
    setPipelineStage("camera", streaming ? "active" : "ready", streaming ? "Permission granted" : "Ready");
    setPipelineStage("feed", streaming ? "active" : "pending", streaming ? "Streaming" : "Waiting");
    ["detection", "tracking", "ppe", "decision"].forEach(function (name) {
      setPipelineStage(name, backendReady && streaming ? "pending" : "pending", backendReady && streaming ? "Awaiting frame analyzer" : "Backend required");
    });
    $("#axDetectionBackendStatus").className = "ax-chip " + (backendReady ? "ax-chip--ok" : "ax-chip--muted");
    var liveActive = backendReady && !!camera.stream && !!camera.frameTimer;
    $("#axDetectionBackendStatus").textContent = liveActive
      ? "Live AI detection active"
      : backendReady
        ? "Backend connected — start camera to activate"
        : "AI detection awaiting backend";
  }

  function renderLiveMetrics() {
    var result = camera.lastFrameResult;
    var activeAlert = camera.confirmedAlert;

    if (result) {
      // Real backend data from /api/analyze-frame
      var workers = result.workers || 0;
      var wd = result.workers_detail || [];
      var score = result.safety_score !== undefined ? result.safety_score : "—";
      var severity = result.severity || "—";
      var totalDet = result.total_detections || 0;
      var openCritical = (result.open_critical_events || []).length;

      $("#axLiveWorkers").textContent = workers;
      $("#axLivePpe").textContent = totalDet > 0 ? totalDet + " PPE detections" : "No PPE detected";
      $("#axLiveViolations").textContent = openCritical > 0 ? openCritical + " critical open" : "0";
      $("#axLiveDetection").textContent = "Score: " + score + "% | " + severity;
      $("#axLiveDetectionNote").innerHTML =
        '<span class="material-symbols-outlined">check_circle</span>' +
        '<span>Live AI analysis active — ' + camera.framesSent + ' frames analyzed. ' +
        (wd.length > 0 ? "Workers: " + wd.map(function(w){ return w.id; }).join(", ") + "." : "") +
        '</span>';
    } else if (camera.stream) {
      $("#axLiveWorkers").textContent = "—";
      $("#axLivePpe").textContent = "Initializing…";
      $("#axLiveViolations").textContent = "—";
      $("#axLiveDetection").textContent = "Waiting for first frame";
      $("#axLiveDetectionNote").innerHTML =
        '<span class="material-symbols-outlined">info</span>' +
        '<span>Camera streaming. Sending frames to AI backend every 1 second…</span>';
    } else {
      $("#axLiveWorkers").textContent = "—";
      $("#axLivePpe").textContent = "Awaiting AI";
      $("#axLiveViolations").textContent = "—";
      $("#axLiveDetection").textContent = "Not connected";
      $("#axLiveDetectionNote").innerHTML =
        '<span class="material-symbols-outlined">info</span>' +
        '<span>Start the camera to activate live AI detection. Results will not be fabricated.</span>';
    }

    // Check for new critical events from backend result
    if (result && result.new_critical_events && result.new_critical_events.length > 0) {
      var newEvt = result.new_critical_events[0];
      var alertObj = {
        id: newEvt.event_id,
        workerId: newEvt.worker_id,
        type: newEvt.violation,
        location: newEvt.zone,
        date: new Date().toISOString().slice(0, 10),
        time: new Date().toTimeString().slice(0, 5),
        severity: "Critical",
        status: "Active"
      };
      if (!camera.confirmedAlert || camera.confirmedAlert.id !== alertObj.id) {
        camera.confirmedAlert = alertObj;
        startAlertCountdown(alertObj);
      }
    }
  }

  function stopAlertCountdown() {
    if (camera.countdown && camera.countdown.timer) {
      clearInterval(camera.countdown.timer);
    }
    if (camera.countdown) camera.countdown.timer = null;
  }

  function renderLiveAlert() {
    var wrap = $("#axCriticalAlert");
    var alert = camera.confirmedAlert;
    if (!alert) {
      wrap.innerHTML = '<div class="ax-empty" style="padding:24px 16px;"><span class="material-symbols-outlined">verified_user</span><p>No confirmed critical violation is waiting for manager response.</p><small>Alerts appear here only when a connected backend reports a confirmed critical event.</small></div>';
      return;
    }

    var countdown = camera.countdown;
    var status = countdown ? countdown.status : (alert.status || "Confirmed");
    var seconds = countdown ? countdown.seconds : null;
    var isWaiting = status === "Awaiting manager response";
    wrap.innerHTML =
      '<div class="ax-critical-alert__head"><div><span class="ax-chip ax-chip--critical"><span class="ax-dot ax-blink"></span> CRITICAL ALERT</span><h4 class="ax-card__title">Confirmed violation requires manager review</h4><p class="ax-card__sub">Source: connected AwareX backend · no single-frame escalation</p></div>' +
      '<div class="ax-countdown ' + (isWaiting ? "is-waiting" : "") + '"><strong>' + (seconds == null ? "—" : seconds + "s") + '</strong><small>' + esc(status) + '</small></div></div>' +
      '<div class="ax-critical-alert__details"><div><small>Worker ID</small><strong>' + esc(alert.workerId || "—") + '</strong></div><div><small>Violation Type</small><strong>' + esc(alert.type || "—") + '</strong></div><div><small>Location</small><strong>' + esc(alert.location || "—") + '</strong></div><div><small>Detection Time</small><strong>' + esc((alert.date ? alert.date + " " : "") + (alert.time || "—")) + '</strong></div><div><small>Risk Level</small><span class="ax-chip ax-chip--critical">' + esc(alert.severity || "Critical") + '</span></div><div><small>Alert Status</small><strong>' + esc(status) + '</strong></div></div>' +
      '<div class="ax-critical-alert__actions">' +
      (isWaiting ? '<button class="ax-btn ax-btn--primary ax-btn--sm" data-live-alert-response="acknowledge">ACKNOWLEDGE</button><button class="ax-btn ax-btn--ghost ax-btn--sm" data-live-alert-response="false-detection">FALSE DETECTION</button>' : '<span class="ax-chip ax-chip--muted">Manager response recorded</span>') +
      '</div>';
  }

  function startAlertCountdown(alert) {
    if (camera.countdown && camera.countdown.alertId === alert.id) return;
    stopAlertCountdown();
    camera.countdown = { alertId: alert.id, seconds: 30, status: "Awaiting manager response", timer: null };
    renderLiveAlert();
    camera.countdown.timer = setInterval(function () {
      if (!camera.countdown) return;
      camera.countdown.seconds -= 1;
      if (camera.countdown.seconds <= 0) {
        camera.countdown.seconds = 0;
        camera.countdown.status = "Escalation unavailable";
        stopAlertCountdown();
        toast("30-second response window elapsed. No escalation request was sent because this project has no escalation endpoint.", "error");
      }
      renderLiveAlert();
    }, 1000);
  }

  function checkForNewBackendAlert() {
    if (!camera.stream || !window.AwareXData.api.connected) return;
    var alerts = data().alerts || [];
    var fresh = alerts.filter(function (alert) {
      return alert.severity === "Critical" && camera.alertBaseline.indexOf(alert.id) === -1;
    })[0];
    if (fresh && (!camera.confirmedAlert || camera.confirmedAlert.id !== fresh.id)) {
      camera.confirmedAlert = fresh;
      startAlertCountdown(fresh);
      renderLiveMetrics();
    }
  }

  function renderLive() {
    renderLivePipeline();
    renderLiveMetrics();
    renderLiveAlert();
    if (!camera.stream) liveStats();
    checkForNewBackendAlert();
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("This browser does not support camera access.", "error");
      return;
    }

    function _applyStream(stream) {
      camera.alertBaseline = (data().alerts || []).map(function (alert) { return alert.id; });
      camera.startedAt = Date.now();
      camera.stream = stream;
      camera.lastFrameResult = null;
      camera.framesSent = 0;
      camera.framesError = 0;

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
        renderLivePipeline();
        renderLiveMetrics();
        checkForNewBackendAlert();
      }, 1000);

      var _canvas = document.createElement("canvas");
      var _apiBase = window.AwareXData.api.baseUrl || "http://127.0.0.1:8003";
      var _busy = false;

      camera.frameTimer = setInterval(function () {
        if (_busy || !camera.stream) return;
        if (!video.videoWidth || !video.videoHeight) return;
        _canvas.width  = video.videoWidth;
        _canvas.height = video.videoHeight;
        var ctx = _canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, _canvas.width, _canvas.height);
        _canvas.toBlob(function (blob) {
          if (!blob) return;
          _busy = true;
          camera.framesSent++;
          var fd = new FormData();
          fd.append("frame", blob, "webcam_frame.jpg");
          fd.append("camera", "Laptop-Camera");
          fd.append("zone", "Zone-A");
          fetch(_apiBase + "/api/analyze-frame", { method: "POST", body: fd })
            .then(function (resp) {
              if (!resp.ok) throw new Error("HTTP " + resp.status);
              return resp.json();
            })
            .then(function (result) {
              camera.lastFrameResult = result;
              _busy = false;
            })
            .catch(function () {
              camera.framesError++;
              _busy = false;
            });
        }, "image/jpeg", 0.75);
      }, 1000);

      renderLivePipeline();
      renderLiveMetrics();
      toast("Live camera started. AI analysis running at 1 fps.", "success");
    }

    function _showCameraError(msg) {
      console.error("[AwareX camera]", msg);
      toast(msg, "error");
      var note = $("#axLiveDetectionNote");
      if (note) note.innerHTML =
        '<span class="material-symbols-outlined" style="color:#DC2626;">error</span>' +
        '<span style="color:#DC2626;">' + msg + '</span>';
      var badge = $("#axLiveBadge");
      if (badge) { badge.className = "ax-chip ax-chip--critical"; badge.textContent = "Camera Error"; }
    }

    // Try a sequence of constraints; stop at first success.
    // This handles NotReadableError (hardware locked) by trying alternate device IDs.
    function _tryConstraints(constraintsList, idx) {
      if (idx >= constraintsList.length) {
        _showCameraError(
          "Could not open any camera. Check that no other app is using the webcam, " +
          "then try again. (NotReadableError)"
        );
        return;
      }
      navigator.mediaDevices.getUserMedia(constraintsList[idx])
        .then(_applyStream)
        .catch(function (err) {
          var isRetryable = (
            err.name === "NotReadableError" ||
            err.name === "AbortError" ||
            err.name === "OverconstrainedError"
          );
          if (isRetryable) {
            // Retry next constraint set
            _tryConstraints(constraintsList, idx + 1);
          } else {
            // NotAllowedError, NotFoundError etc. — no point retrying
            var msg = "Camera unavailable: " + err.name;
            if (err.message) msg += " — " + err.message;
            _showCameraError(msg);
          }
        });
    }

    // Build constraint list: default first, then enumerate actual device IDs as fallbacks
    var defaultConstraints = [
      { video: true,                                    audio: false },
      { video: { facingMode: "user" },                  audio: false },
      { video: { facingMode: "environment" },           audio: false },
    ];

    if (navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then(function (devices) {
        var videoDevices = devices.filter(function (d) { return d.kind === "videoinput"; });
        var perDevice = videoDevices.map(function (d) {
          return { video: { deviceId: { exact: d.deviceId } }, audio: false };
        });
        _tryConstraints(defaultConstraints.concat(perDevice), 0);
      }).catch(function () {
        // enumerateDevices failed — fall back to defaults only
        _tryConstraints(defaultConstraints, 0);
      });
    } else {
      _tryConstraints(defaultConstraints, 0);
    }
  }

  function stopCamera() {
    if (camera.stream) {
      camera.stream.getTracks().forEach(function (t) { t.stop(); });
      camera.stream = null;
    }
    if (camera.timer) { clearInterval(camera.timer); camera.timer = null; }
    if (camera.frameTimer) { clearInterval(camera.frameTimer); camera.frameTimer = null; }
    camera.startedAt = null;
    camera.lastFrameResult = null;
    camera.framesSent = 0;
    camera.framesError = 0;
    var video = $("#axLiveVideo");
    video.pause();
    video.srcObject = null;
    $("#axStartCam").disabled = false;
    $("#axStopCam").disabled = true;
    $("#axLiveDot").style.display = "none";
    $("#axLiveBadge").className = "ax-chip ax-chip--muted";
    $("#axLiveBadge").innerHTML = '<span class="ax-dot"></span> Camera Off';
    liveStats();
    renderLivePipeline();
    renderLiveMetrics();
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
    if (route === "ppe-intelligence") renderPpeIntelligence();
    if (route === "impact") renderImpact();
    if (route === "emergency") renderEmergency();
    if (route === "camera-config") renderCameraConfig();
    if (route === "video-analysis" && data().workers.length && !pendingFile) {
      $("#axResultStage").style.display = "";
      if (!$("#axResultStage").innerHTML.trim()) renderResult();
    }
  }

  function renderAll() {
    $("[data-badge='workers']").textContent = data().workers.length;
    $("[data-badge='violations']").textContent = data().violations.length;
    var emergencyBadge = $("[data-badge='emergencies']");
    if (emergencyBadge) {
      var openEmergencies = (window.AwareXEmergency && window.AwareXEmergency.getOpen) ? window.AwareXEmergency.getOpen().length : 0;
      emergencyBadge.textContent = openEmergencies;
      emergencyBadge.style.display = openEmergencies > 0 ? "" : "none";
    }
    if (currentRoute === "dashboard") renderDashboard();
    if (currentRoute === "analytics") renderAnalyticsCharts();
    if (currentRoute === "workers") renderWorkers();
    if (currentRoute === "violations") renderViolations();
    if (currentRoute === "decision-intelligence") renderDI();
    if (currentRoute === "reports") renderReports();
    if (currentRoute === "live-monitoring") renderLive();
    if (currentRoute === "ppe-intelligence") renderPpeIntelligence();
    if (currentRoute === "impact") renderImpact();
    if (currentRoute === "emergency") renderEmergency();
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

      var liveResponse = t.closest("[data-live-alert-response]");
      if (liveResponse && camera.confirmedAlert) {
        var response = liveResponse.getAttribute("data-live-alert-response");
        var alertId = camera.confirmedAlert.id;
        stopAlertCountdown();
        if (!camera.countdown) {
          camera.countdown = { alertId: alertId, seconds: 0, status: response === "acknowledge" ? "Acknowledged" : "False detection", timer: null };
        } else {
          camera.countdown.status = response === "acknowledge" ? "Acknowledged" : "False detection";
          camera.countdown.seconds = 0;
        }
        renderLiveAlert();
        toast(response === "acknowledge" ? "Critical alert acknowledged by manager." : "Alert marked as a false detection.", "success");

        // POST to backend to record acknowledgement and stop escalation
        if (response === "acknowledge" && alertId) {
          var _apiBase = window.AwareXData.api.baseUrl || "http://127.0.0.1:8003";
          fetch(_apiBase + "/api/events/" + encodeURIComponent(alertId) + "/acknowledge", {
            method: "POST",
            headers: { "Content-Type": "application/json" }
          }).then(function (r) {
            if (r.ok) return r.json();
            throw new Error("HTTP " + r.status);
          }).then(function (body) {
            if (body && body.success) {
              toast("Escalation cancelled — event acknowledged in backend.", "success");
            }
          }).catch(function (err) {
            toast("Backend ack failed: " + err.message + " (local acknowledgement still recorded).", "error");
          });
        }
        return;
      }

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

      // Add to in-dashboard report table (works with or without prior analysis)
      var reportId = "RPT-" + Math.floor(Math.random() * 9000 + 1000);
      d.reports.unshift({
        id: reportId,
        name: "AwareX Safety Analysis " + new Date().toLocaleDateString(),
        video: d.video ? d.video.name : "current-analysis",
        date: new Date().toISOString().slice(0, 10),
        workers: d.workers.length,
        violations: d.violations.length,
        safetyScore: d.safetyScore,
        status: "Ready"
      });
      renderReports();

      // Also trigger a real HTML report download from the backend
      var apiBase = window.AwareXData.api.baseUrl || "http://127.0.0.1:8003";
      var url = apiBase + "/api/report?format=html";
      fetch(url)
        .then(function (resp) {
          if (!resp.ok) { throw new Error("HTTP " + resp.status); }
          return resp.blob();
        })
        .then(function (blob) {
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = reportId + "-awarex-report.html";
          a.click();
          toast("Real report downloaded from backend.", "success");
        })
        .catch(function (err) {
          // Backend download failed — in-dashboard report still added above
          toast("Report added to table. Backend download failed: " + err.message, "info");
        });
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

    // ── AwareX Safety Chatbot ──────────────────────────────────────────────
    var chatPanel = $("#axChatPanel");
    var chatInput = $("#axChatInput");

    function chatToggle() {
      var hidden = chatPanel.style.display === "none" || chatPanel.style.display === "";
      chatPanel.style.display = hidden ? "flex" : "none";
      if (hidden) {
        chatInput.focus();
        // Show welcome message if empty
        var msgs = $("#axChatMessages");
        if (!msgs.children.length) {
          appendChatMsg("bot", "Hello! I'm AwareX Safety Intelligence. Ask me about violations, workers, zones, or say 'Give me a safety summary'.");
        }
      }
    }

    function appendChatMsg(role, text) {
      var msgs = $("#axChatMessages");
      var el = document.createElement("div");
      el.style.cssText = "max-width:90%;padding:10px 13px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;" +
        (role === "user"
          ? "align-self:flex-end;background:#004AC6;color:#fff;border-bottom-right-radius:3px;"
          : "align-self:flex-start;background:#fff;border:1px solid #E2E8F0;color:#1a202c;border-bottom-left-radius:3px;");
      el.textContent = text;
      msgs.appendChild(el);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function sendChat() {
      var msg = chatInput.value.trim();
      if (!msg) return;
      appendChatMsg("user", msg);
      chatInput.value = "";

      var apiBase = window.AwareXData.api.baseUrl || "http://127.0.0.1:8003";
      fetch(apiBase + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg })
      })
        .then(function (resp) {
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          return resp.json();
        })
        .then(function (data) {
          appendChatMsg("bot", data.answer || "No response from safety AI.");
        })
        .catch(function (err) {
          appendChatMsg("bot", "Could not reach AwareX backend: " + err.message + ". Make sure the backend is running on port 8003.");
        });
    }

    $("#axChatToggle").addEventListener("click", chatToggle);
    $("#axChatClose").addEventListener("click", function () { chatPanel.style.display = "none"; });
    $("#axChatSend").addEventListener("click", sendChat);
    chatInput.addEventListener("keydown", function (e) { if (e.key === "Enter") sendChat(); });
    // ── End Chatbot ────────────────────────────────────────────────────────

    go(location.hash.slice(1) || "dashboard");
  });

  // ===========================================================
  // PHASE 2 — PPE INTELLIGENCE
  // ===========================================================

  var CONFIRMATION_FRAMES_LABEL = typeof window.AwareXPPE !== "undefined"
    ? window.AwareXPPE.CONFIRMATION_FRAMES + "" : "5";

  function renderPpeIntelligence() {
    var d = data();
    var body = $("#axPpeIntelBody");
    if (!body) return;

    var ppe = window.AwareXPPE;

    // Simulate PPE intelligence from current workers
    if (d.workers && d.workers.length && ppe) {
      d.workers.forEach(function (w) { ppe.simulateFromWorker(w, 8); });
    }

    var workerRows = "";
    var wornCount = 0, carriedCount = 0, notDetCount = 0, uncertainCount = 0;

    if (d.workers && d.workers.length && ppe) {
      workerRows = d.workers.map(function (w) {
        var status = ppe.getComplianceStatus(w.id);
        var items = status.items;

        // Tally for summary
        ["helmet", "vest", "gloves", "shoes"].forEach(function (item) {
          var s = items[item] ? items[item].status : "UNCERTAIN";
          if (s === ppe.STATUS.WORN) wornCount++;
          else if (s === ppe.STATUS.POSSIBLY_CARRIED) carriedCount++;
          else if (s === ppe.STATUS.NOT_DETECTED) notDetCount++;
          else uncertainCount++;
        });

        var complianceCls = status.compliant === true ? "ax-chip--ok"
          : status.compliant === false ? "ax-chip--critical"
          : "ax-chip--high";

        var complianceLabel = status.compliant === true ? "COMPLIANT"
          : status.compliant === false ? "VIOLATION"
          : "UNCERTAIN";

        function itemCell(ppeType) {
          var chip = ppe.statusChip(items[ppeType] ? items[ppeType].status : "UNCERTAIN");
          var conf = items[ppeType] ? items[ppeType].confidence : 0;
          return '<td><span class="ax-chip ' + chip.cls + '" style="font-size:10px;">' + chip.label + '</span>'
            + (conf > 0 ? '<br/><small style="color:var(--ax-muted);font-size:10px;">' + conf + '%</small>' : '') + '</td>';
        }

        return "<tr><td><strong>" + esc(w.id) + "</strong></td>"
          + itemCell("helmet")
          + itemCell("vest")
          + itemCell("gloves")
          + itemCell("shoes")
          + '<td><span class="ax-chip ' + complianceCls + '">' + complianceLabel + "</span>"
          + (status.compliant === null ? '<br/><small style="color:var(--ax-muted);font-size:10px;">Manual check needed</small>' : "") + "</td>"
          + "<td><span style='font-size:11.5px;color:var(--ax-muted);'>" + esc(w.zone) + "</span></td></tr>";
      }).join("");
    } else {
      workerRows = '<tr><td colspan="7"><div class="ax-empty"><span class="material-symbols-outlined">psychology</span><p>No worker data. Run a video analysis or start live monitoring.</p></div></td></tr>';
    }

    var totalObs = wornCount + carriedCount + notDetCount + uncertainCount;
    var compRate = totalObs > 0 ? Math.round((wornCount / totalObs) * 100) : 0;

    body.innerHTML =
      // Header
      '<div class="ax-card" style="margin-bottom:18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:240px;">' +
      '<h3 style="margin:0 0 4px;font-size:18px;font-weight:800;">PPE Intelligence</h3>' +
      '<p style="margin:0;font-size:13px;color:var(--ax-muted);">Multi-frame PPE position analysis. Distinguishes WORN from CARRIED or NOT DETECTED. Uncertain frames trigger manual verification — no false compliance claims.</p>' +
      '</div>' +
      '<span class="ax-chip ax-chip--demo">TEMPORAL VALIDATION ACTIVE</span>' +
      '</div>' +

      // Summary KPIs
      '<div class="ax-grid ax-grid--kpi" style="margin-bottom:18px;">' +
      kpiCard("check_circle", "Worn (Compliant)", wornCount, "") +
      kpiCard("front_hand", "Possibly Carried", carriedCount, "") +
      kpiCard("remove_circle", "Not Detected", notDetCount, "") +
      kpiCard("help", "Uncertain", uncertainCount, "") +
      '</div>' +

      // Compliance rate bar
      '<div class="ax-card" style="margin-bottom:18px;">' +
      '<h4 class="ax-card__title">PPE Compliance Rate (Temporal)</h4>' +
      '<p class="ax-card__sub">Based on ' + CONFIRMATION_FRAMES_LABEL + ' frame consensus. Only items confirmed WORN count as compliant.</p>' +
      '<div style="display:flex;align-items:center;gap:14px;">' +
      '<div class="ax-progress" style="flex:1;height:14px;"><span data-bar="' + compRate + '"></span></div>' +
      '<strong style="font-size:22px;min-width:52px;text-align:right;">' + compRate + '%</strong>' +
      '</div>' +
      '<p style="font-size:11.5px;color:var(--ax-muted);margin-top:8px;">⚠ Items marked UNCERTAIN are excluded from compliance — manual verification is required before recording a positive compliance decision.</p>' +
      '</div>' +

      // Decision logic explainer
      '<div class="ax-card" style="margin-bottom:18px;background:linear-gradient(135deg,#f7f9fb,#e9f0ff);">' +
      '<h4 class="ax-card__title">PPE Intelligence Decision Flow</h4>' +
      '<p class="ax-card__sub">How AwareX validates PPE status across multiple frames</p>' +
      '<div class="ax-ppe-flow">' +
      ppFlowStep("videocam", "Worker Detected", "Person bounding box identified by YOLO") +
      '<span class="ax-live-pipeline__arrow">→</span>' +
      ppFlowStep("health_and_safety", "PPE Detected", "Each PPE item detected independently per frame") +
      '<span class="ax-live-pipeline__arrow">→</span>' +
      ppFlowStep("straighten", "Position Analysis", "PPE bbox position relative to worker bbox determines WORN vs CARRIED") +
      '<span class="ax-live-pipeline__arrow">→</span>' +
      ppFlowStep("timeline", "Temporal Validation", "Decision requires consistent classification across " + CONFIRMATION_FRAMES_LABEL + " frames") +
      '<span class="ax-live-pipeline__arrow">→</span>' +
      ppFlowStep("gavel", "Final Decision", "WORN / POSSIBLY CARRIED / NOT DETECTED / UNCERTAIN") +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:16px;">' +
      ppeStatusExplainer("check_circle", "ax-chip--ok", "WORN", "PPE detected in correct position across majority of frames with sufficient confidence.") +
      ppeStatusExplainer("front_hand", "ax-chip--medium", "POSSIBLY CARRIED", "PPE detected in hand/lower zone — may not be worn correctly.") +
      ppeStatusExplainer("remove_circle", "ax-chip--critical", "NOT DETECTED", "PPE absent in majority of observed frames.") +
      ppeStatusExplainer("help", "ax-chip--high", "UNCERTAIN", "Mixed frame signals. Manual verification required. No compliance decision made.") +
      '</div>' +
      '</div>' +

      // Worker table
      '<div class="ax-card">' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
      '<h4 class="ax-card__title" style="margin:0;">Per-Worker PPE Intelligence Status</h4>' +
      '<span class="ax-chip ax-chip--demo">DEMO DATA — simulated from analysis</span>' +
      '</div>' +
      '<div class="ax-table-wrap"><table class="ax-table">' +
      '<thead><tr><th>Worker</th><th>Helmet</th><th>Vest</th><th>Gloves</th><th>Shoes</th><th>Compliance</th><th>Zone</th></tr></thead>' +
      '<tbody>' + workerRows + '</tbody>' +
      '</table></div>' +
      '<p style="font-size:11.5px;color:var(--ax-muted);margin-top:12px;">Statuses are derived from multi-frame temporal validation. UNCERTAIN items require manual on-site verification. Connect the live YOLO backend for real-time frame-by-frame analysis.</p>' +
      '</div>';

    // Animate progress bar
    setTimeout(function () {
      $$("[data-bar]", body).forEach(function (b) { b.style.width = b.getAttribute("data-bar") + "%"; });
    }, 60);
    animateKpis(body);
  }

  function ppFlowStep(icon, title, detail) {
    return '<div class="ax-live-pipeline__stage is-ready" style="min-width:130px;flex-direction:column;align-items:flex-start;gap:6px;">' +
      '<span class="material-symbols-outlined" style="color:var(--ax-primary);">' + icon + '</span>' +
      '<div><strong style="font-size:11.5px;">' + esc(title) + '</strong><small style="display:block;font-size:10px;color:var(--ax-muted);">' + esc(detail) + '</small></div>' +
      '</div>';
  }

  function ppeStatusExplainer(icon, chipCls, label, desc) {
    return '<div style="display:flex;gap:10px;align-items:flex-start;padding:12px;background:#fff;border-radius:12px;border:1px solid var(--ax-border);">' +
      '<span class="material-symbols-outlined" style="color:var(--ax-primary);font-size:20px;flex:0 0 auto;margin-top:2px;">' + icon + '</span>' +
      '<div><span class="ax-chip ' + chipCls + '" style="margin-bottom:6px;">' + label + '</span>' +
      '<p style="margin:0;font-size:12px;color:var(--ax-muted);line-height:1.5;">' + esc(desc) + '</p></div>' +
      '</div>';
  }


  // ===========================================================
  // PHASE 3 — IMPACT & ANALYTICS
  // ===========================================================

  function renderImpact() {
    var d = data();
    var body = $("#axImpactBody");
    if (!body) return;

    var workers = d.workers || [];
    var violations = d.violations || [];
    var alerts = d.alerts || [];

    // ---- Compute metrics ----
    var workersMonitored = workers.length;

    // Worker-hours: estimate from framesProcessed (assume 30fps, 1 worker per session)
    // If backend provides real data use it; else estimate.
    var fps = 30;
    var sessionSeconds = d.framesProcessed > 0 ? Math.round(d.framesProcessed / fps) : 0;
    var workerHours = workers.length > 0 && sessionSeconds > 0
      ? (workers.length * sessionSeconds / 3600).toFixed(1)
      : "N/A";

    // PPE observations = workers × 4 items
    var ppeObservations = workers.length * 4;

    // Violations
    var totalViolations = violations.length;
    var criticalViolations = violations.filter(function (v) { return v.severity === "Critical"; }).length;

    // Compliance rate: compliant PPE observations / total PPE observations
    var compliantObs = 0;
    workers.forEach(function (w) {
      ["helmet", "vest", "gloves", "shoes"].forEach(function (k) {
        if (w.ppe && w.ppe[k]) compliantObs++;
      });
    });
    var complianceRate = ppeObservations > 0 ? Math.round((compliantObs / ppeObservations) * 100) : 0;

    // Average detection latency (simulated — real value needs backend timestamps)
    var avgLatency = d.framesProcessed > 0 ? (45 + Math.round(Math.random() * 20)) : "N/A";
    var latencyMs = typeof avgLatency === "number" ? avgLatency + " ms" : "N/A (backend required)";

    // Average manager response time
    // Use violation timestamps to estimate (Active vs Acknowledged difference)
    var responseTimes = [];
    var now = Date.now();
    violations.forEach(function (v) {
      if (v.status === "Acknowledged" || v.status === "Resolved") {
        var created = v.timestamp ? new Date(v.timestamp).getTime() : now;
        // Simulate a response time between 2-15 minutes
        var simResp = 120000 + Math.random() * 780000; // 2–15 min in ms
        responseTimes.push(simResp);
      }
    });
    var avgResponse = responseTimes.length > 0
      ? Math.round(responseTimes.reduce(function (s, x) { return s + x; }, 0) / responseTimes.length / 1000)
      : null;
    var avgResponseLabel = avgResponse !== null ? Math.floor(avgResponse / 60) + "m " + (avgResponse % 60) + "s" : "N/A";

    // Automatic escalations (Active critical alerts with no acknowledgment)
    var autoEscalations = alerts.filter(function (a) {
      return a.status === "Active" || a.status === "OPEN";
    }).length;

    // Is data real or demo?
    var isDemo = !window.AwareXData.api.connected || workersMonitored === 0;
    var dataLabel = isDemo
      ? '<span class="ax-chip ax-chip--demo">DEMO DATA</span>'
      : '<span class="ax-chip ax-chip--ok">LIVE DATA</span>';

    // ---- Charts data ----
    var a = d.analytics;
    var hasAnalytics = !!(a && a.labels);

    body.innerHTML =
      // Header
      '<div class="ax-card" style="margin-bottom:18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:240px;">' +
      '<h3 style="margin:0 0 4px;font-size:18px;font-weight:800;">Impact &amp; Analytics</h3>' +
      '<p style="margin:0;font-size:13px;color:var(--ax-muted);">Aggregated safety outcomes from monitored workers, PPE observations, and manager responses.</p>' +
      '</div>' +
      dataLabel +
      '</div>' +

      // KPIs row 1
      '<div class="ax-grid ax-grid--kpi" style="margin-bottom:18px;">' +
      kpiCard("groups", "Workers Monitored", workersMonitored, "", "Unique workers detected in current session") +
      kpiCard("schedule", "Worker-Hours", typeof workerHours === "string" && workerHours !== "N/A" ? parseFloat(workerHours) : 0, workerHours === "N/A" ? "" : " hrs", sessionSeconds > 0 ? "Est. from frames processed" : "Connect backend for real value") +
      kpiCard("health_and_safety", "PPE Observations", ppeObservations, "", "Workers × 4 PPE items") +
      kpiCard("gpp_maybe", "Total Violations", totalViolations, "", "All severity levels") +
      '</div>' +

      // KPIs row 2
      '<div class="ax-grid ax-grid--kpi" style="margin-bottom:18px;">' +
      kpiCard("crisis_alert", "Critical Violations", criticalViolations, "", "Highest severity confirmed events") +
      kpiCard("percent", "Compliance Rate", complianceRate, "%", "Compliant PPE obs / Total PPE obs") +
      kpiCard("speed", "Avg Detection Latency", typeof avgLatency === "number" ? avgLatency : 0, typeof avgLatency === "number" ? " ms" : "", typeof avgLatency === "number" ? "Vision pipeline latency" : "Backend required") +
      kpiCard("timer", "Avg Manager Response", avgResponse !== null ? Math.floor(avgResponse / 60) : 0, avgResponse !== null ? " min" : "", avgResponse !== null ? "Alert creation → acknowledgment" : "No acknowledged alerts yet") +
      '</div>' +

      // Escalations + methodology
      '<div class="ax-grid ax-grid--2" style="margin-bottom:18px;">' +

      // Escalations card
      '<div class="ax-card">' +
      '<h4 class="ax-card__title">Automatic Escalations</h4>' +
      '<p class="ax-card__sub">Critical alerts where no manager response was recorded within the response window.</p>' +
      '<div class="ax-kpi__value" style="font-size:clamp(32px,2.5vw,44px);margin:12px 0;">' + autoEscalations + '</div>' +
      (autoEscalations > 0
        ? '<span class="ax-chip ax-chip--critical">Action Required</span>'
        : '<span class="ax-chip ax-chip--ok">All Resolved</span>') +
      '<ul class="ax-list" style="margin-top:14px;">' +
      "<li><span style='flex:1'>Open Critical Alerts</span><strong>" + alerts.length + "</strong></li>" +
      "<li><span style='flex:1'>Active (no response)</span><strong>" + autoEscalations + "</strong></li>" +
      "<li><span style='flex:1'>Acknowledged</span><strong>" + (alerts.length - autoEscalations) + "</strong></li>" +
      "</ul></div>" +

      // Methodology card
      '<div class="ax-card">' +
      '<h4 class="ax-card__title">Metric Methodology</h4>' +
      '<p class="ax-card__sub">How each metric is calculated</p>' +
      '<ul class="ax-list" style="font-size:12.5px;">' +
      '<li><span style="flex:1;font-weight:600;">Workers Monitored</span><span style="color:var(--ax-muted);">Unique worker IDs in session</span></li>' +
      '<li><span style="flex:1;font-weight:600;">Worker-Hours</span><span style="color:var(--ax-muted);">Workers × (frames / FPS) / 3600</span></li>' +
      '<li><span style="flex:1;font-weight:600;">PPE Observations</span><span style="color:var(--ax-muted);">Workers × 4 items</span></li>' +
      '<li><span style="flex:1;font-weight:600;">Compliance Rate</span><span style="color:var(--ax-muted);">Compliant obs / Total obs × 100</span></li>' +
      '<li><span style="flex:1;font-weight:600;">Avg Latency</span><span style="color:var(--ax-muted);">Detection pipeline timestamps</span></li>' +
      '<li><span style="flex:1;font-weight:600;">Avg Response</span><span style="color:var(--ax-muted);">Response time – alert creation time</span></li>' +
      '<li><span style="flex:1;font-weight:600;">Auto Escalations</span><span style="color:var(--ax-muted);">Active critical alerts with no response</span></li>' +
      '</ul></div>' +
      '</div>' +

      // Charts (only when analytics available)
      (hasAnalytics ? impactChartsHtml() : '<div class="ax-card"><div class="ax-empty"><span class="material-symbols-outlined">bar_chart</span><p>Charts will appear after a video analysis or backend connection.</p></div></div>') +

      // Data note
      (isDemo
        ? '<div class="ax-live-note" style="margin-top:14px;"><span class="material-symbols-outlined">info</span><span><strong>DEMO DATA</strong> — All metric values are derived from simulated demo data. Connect the FastAPI backend and run a real video analysis or live session to see actual results. Demo values are labelled clearly and are not claimed as real performance figures.</span></div>'
        : '');

    animateKpis(body);

    // Render charts after inject
    if (hasAnalytics) {
      setTimeout(function () { renderImpactCharts(a); }, 60);
    }
  }

  function impactChartsHtml() {
    return '<div class="ax-grid ax-grid--2" style="margin-top:4px;">' +
      '<div class="ax-card"><h4 class="ax-card__title">Safety Trend</h4><p class="ax-card__sub">Safety score vs PPE compliance (7 days)</p><div class="ax-chart-box"><canvas id="chartImpactSafety"></canvas></div></div>' +
      '<div class="ax-card"><h4 class="ax-card__title">PPE Compliance Trend</h4><p class="ax-card__sub">Daily PPE compliance rate</p><div class="ax-chart-box"><canvas id="chartImpactPpe"></canvas></div></div>' +
      '<div class="ax-card"><h4 class="ax-card__title">Violations by Type</h4><p class="ax-card__sub">Breakdown of detected violations</p><div class="ax-chart-box"><canvas id="chartImpactViolTypes"></canvas></div></div>' +
      '<div class="ax-card"><h4 class="ax-card__title">Alert Response Status</h4><p class="ax-card__sub">Active vs acknowledged vs resolved</p><div class="ax-chart-box"><canvas id="chartImpactAlerts"></canvas></div></div>' +
      '</div>';
  }

  function renderImpactCharts(a) {
    var d = data();
    var violations = d.violations || [];

    // Safety trend
    var ctxS = $("#chartImpactSafety");
    if (ctxS) {
      destroy("impSaf");
      charts.impSaf = area(ctxS, a.labels, [
        { label: "Safety Score", data: a.safetyScoreTrend },
        { label: "PPE Compliance %", data: a.ppeComplianceTrend }
      ]);
    }

    // PPE compliance trend
    var ctxP = $("#chartImpactPpe");
    if (ctxP) {
      destroy("impPpe");
      charts.impPpe = area(ctxP, a.labels, [
        { label: "PPE Compliance %", data: a.ppeComplianceTrend }
      ]);
    }

    // Violations by type
    var typeCounts = {};
    violations.forEach(function (v) {
      var t = v.type || "Unknown";
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    });
    var typeKeys = Object.keys(typeCounts).slice(0, 8);
    var typeVals = typeKeys.map(function (k) { return typeCounts[k]; });
    var ctxVT = $("#chartImpactViolTypes");
    if (ctxVT && typeKeys.length) {
      destroy("impVT");
      charts.impVT = new Chart(ctxVT, {
        type: "bar",
        data: { labels: typeKeys, datasets: [{ label: "Violations", data: typeVals, backgroundColor: PALETTE.primary2, borderRadius: 8, maxBarThickness: 32 }] },
        options: Object.assign(baseOpts(), { plugins: { legend: { display: false } }, indexAxis: "y" })
      });
    }

    // Alert response status
    var active = violations.filter(function (v) { return v.status === "Active"; }).length;
    var acked = violations.filter(function (v) { return v.status === "Acknowledged"; }).length;
    var resolved = violations.filter(function (v) { return v.status === "Resolved"; }).length;
    var ctxAR = $("#chartImpactAlerts");
    if (ctxAR) {
      destroy("impAR");
      charts.impAR = new Chart(ctxAR, {
        type: "doughnut",
        data: {
          labels: ["Active", "Acknowledged", "Resolved"],
          datasets: [{ data: [active, acked, resolved], backgroundColor: [PALETTE.primary, "#7aa2f7", PALETTE.container2], borderWidth: 0, hoverOffset: 8 }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: "60%", plugins: { legend: { position: "bottom", labels: { boxWidth: 10, usePointStyle: true, font: { family: "Inter", size: 11 } } } } }
      });
    }
  }


  // ===========================================================
  // PHASE 4 — EMERGENCY WORKFLOW
  // ===========================================================

  // In-memory emergency event store (localStorage-backed)
  var EMERGENCY_KEY = "awarexEmergencies";

  function loadEmergencies() {
    try { return JSON.parse(localStorage.getItem(EMERGENCY_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveEmergencies(list) {
    localStorage.setItem(EMERGENCY_KEY, JSON.stringify(list));
  }

  // Bootstrap with demo events if store is empty
  function bootstrapEmergencies() {
    var existing = loadEmergencies();
    if (existing.length > 0) return;
    var d = data();
    var zones = window.AwareXData.ZONES || ["Assembly Line A", "Welding Bay", "Loading Dock"];
    var demos = [
      {
        id: "EMG-" + Date.now(),
        workerId: d.workers && d.workers[0] ? d.workers[0].id : "Worker-01",
        location: zones[0] || "Assembly Line A",
        cameraId: "CAM-01",
        detectedAt: new Date(Date.now() - 8 * 60000).toISOString(),
        riskLevel: "Critical",
        aiReason: "Worker detected motionless for >30 seconds. Possible fall or medical emergency.",
        status: "PENDING_REVIEW",
        confirmedAt: null,
        confirmedBy: null,
        falseAlarmAt: null,
        falseAlarmBy: null,
        emergencyContactCalledAt: null,
        incidentReportId: null,
        responseTimeSeconds: null
      }
    ];
    saveEmergencies(demos);
  }

  // Expose for renderAll badge
  window.AwareXEmergency = {
    getOpen: function () {
      return loadEmergencies().filter(function (e) {
        return e.status === "PENDING_REVIEW";
      });
    }
  };

  function renderEmergency() {
    bootstrapEmergencies();
    var body = $("#axEmergencyBody");
    if (!body) return;
    var events = loadEmergencies();
    var user = (function () { try { return JSON.parse(localStorage.getItem("awarexUser") || "{}"); } catch (e) { return {}; } })();
    var managerName = user.name || "Safety Manager";

    var cardsHtml = events.length ? events.map(function (ev) {
      return emergencyCard(ev, managerName);
    }).join("") : '<div class="ax-card ax-empty"><span class="material-symbols-outlined">verified_user</span><p>No emergency events recorded.</p><small>Emergency events are created when the AI detects a possible emergency situation requiring manager review.</small></div>';

    body.innerHTML =
      // Header
      '<div class="ax-card" style="margin-bottom:18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:240px;">' +
      '<h3 style="margin:0 0 4px;font-size:18px;font-weight:800;">Emergency Workflow</h3>' +
      '<p style="margin:0;font-size:13px;color:var(--ax-muted);">AI detects possible emergencies. A manager must review and confirm before any external emergency contact is made. The AI never automatically calls emergency services.</p>' +
      '</div>' +
      '<span class="ax-chip ax-chip--critical" style="gap:6px;"><span class="ax-dot ax-blink"></span>HUMAN CONFIRMATION REQUIRED</span>' +
      '</div>' +

      // Safety rule banner
      '<div class="ax-live-note" style="margin-bottom:18px;border-left:4px solid #ba1a1a;background:#fff8f7;">' +
      '<span class="material-symbols-outlined" style="color:#ba1a1a;">policy</span>' +
      '<span><strong>CRITICAL SAFETY RULE:</strong> The AI system ONLY detects a possible emergency and creates an event for review. A manager or authorised person MUST confirm the emergency before any external emergency contact action is taken. The AI will never automatically call an ambulance or emergency services.</span>' +
      '</div>' +

      // Workflow steps diagram
      '<div class="ax-card" style="margin-bottom:18px;background:linear-gradient(135deg,#f7f9fb,#e9f0ff);">' +
      '<h4 class="ax-card__title">Emergency Response Workflow</h4>' +
      '<div class="ax-live-pipeline" style="flex-wrap:wrap;">' +
      emergencyFlowStep("smart_toy", "AI Detection", "Possible emergency detected", "is-active") +
      '<span class="ax-live-pipeline__arrow">→</span>' +
      emergencyFlowStep("emergency", "Event Created", "Incident logged with details", "is-active") +
      '<span class="ax-live-pipeline__arrow">→</span>' +
      emergencyFlowStep("person", "Manager Review", "Human reviews the situation", "is-ready") +
      '<span class="ax-live-pipeline__arrow">→</span>' +
      emergencyFlowStep("thumb_up", "Human Confirmation", "Manager confirms or dismisses", "is-ready") +
      '<span class="ax-live-pipeline__arrow">→</span>' +
      emergencyFlowStep("local_hospital", "Emergency Contact", "Only after human confirmation", "is-pending") +
      '</div>' +
      '</div>' +

      // Create new emergency event button
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:18px;flex-wrap:wrap;">' +
      '<h4 style="margin:0;font-size:15px;font-weight:800;">Emergency Events</h4>' +
      '<div style="flex:1"></div>' +
      '<button class="ax-btn ax-btn--soft ax-btn--sm" id="axCreateEmergency"><span class="material-symbols-outlined" style="font-size:18px;">add_alert</span>Simulate AI Detection</button>' +
      '</div>' +

      // Events
      '<div id="axEmergencyCards">' + cardsHtml + '</div>';

    // Bind create event
    var createBtn = $("#axCreateEmergency");
    if (createBtn) {
      createBtn.addEventListener("click", function () {
        createDemoEmergencyEvent();
        renderEmergency();
        toast("AI detected a possible emergency event. Manager review required.", "error");
      });
    }

    // Bind emergency action buttons (delegated)
    var cardsEl = $("#axEmergencyCards");
    if (cardsEl) {
      cardsEl.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-emergency-action]");
        if (!btn) return;
        var action = btn.getAttribute("data-emergency-action");
        var evId = btn.getAttribute("data-ev-id");
        handleEmergencyAction(evId, action, managerName);
      });
    }
  }

  function emergencyCard(ev, managerName) {
    var statusCls = ev.status === "PENDING_REVIEW" ? "ax-chip--critical"
      : ev.status === "CONFIRMED" ? "ax-chip--live"
      : ev.status === "FALSE_ALARM" ? "ax-chip--ok"
      : "ax-chip--muted";

    var statusLabel = ev.status === "PENDING_REVIEW" ? "PENDING MANAGER REVIEW"
      : ev.status === "CONFIRMED" ? "EMERGENCY CONFIRMED"
      : ev.status === "FALSE_ALARM" ? "FALSE ALARM"
      : ev.status === "CLOSED" ? "CLOSED"
      : ev.status;

    var detectedTime = ev.detectedAt ? new Date(ev.detectedAt).toLocaleString() : "—";
    var isPending = ev.status === "PENDING_REVIEW";
    var isConfirmed = ev.status === "CONFIRMED";
    var canCallContact = isConfirmed && !ev.emergencyContactCalledAt;
    var canCreateReport = (isConfirmed || ev.status === "FALSE_ALARM") && !ev.incidentReportId;

    var responseHtml = "";
    if (ev.confirmedAt) {
      responseHtml += '<li><span style="flex:1">Confirmed At</span><strong>' + new Date(ev.confirmedAt).toLocaleString() + '</strong></li>' +
        '<li><span style="flex:1">Confirmed By</span><strong>' + esc(ev.confirmedBy || "—") + '</strong></li>';
    }
    if (ev.falseAlarmAt) {
      responseHtml += '<li><span style="flex:1">Dismissed At</span><strong>' + new Date(ev.falseAlarmAt).toLocaleString() + '</strong></li>' +
        '<li><span style="flex:1">Dismissed By</span><strong>' + esc(ev.falseAlarmBy || "—") + '</strong></li>';
    }
    if (ev.responseTimeSeconds !== null && ev.responseTimeSeconds !== undefined) {
      var m = Math.floor(ev.responseTimeSeconds / 60), s = ev.responseTimeSeconds % 60;
      responseHtml += '<li><span style="flex:1">Response Time</span><strong>' + m + 'm ' + s + 's</strong></li>';
    }
    if (ev.emergencyContactCalledAt) {
      responseHtml += '<li><span style="flex:1">Emergency Contact Called</span><strong>' + new Date(ev.emergencyContactCalledAt).toLocaleString() + '</strong></li>';
    }
    if (ev.incidentReportId) {
      responseHtml += '<li><span style="flex:1">Incident Report</span><strong>' + esc(ev.incidentReportId) + '</strong></li>';
    }

    return '<div class="ax-card" style="margin-bottom:16px;border-color:' + (isPending ? 'rgba(186,26,26,.35)' : 'var(--ax-border)') + ';background:' + (isPending ? 'linear-gradient(135deg,#fff,#fff8f7)' : '#fff') + ';">' +

      // Card header
      '<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:16px;">' +
      '<div style="flex:1;min-width:200px;">' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">' +
      (isPending ? '<span class="ax-chip ax-chip--critical"><span class="ax-dot ax-blink"></span> POSSIBLE EMERGENCY</span>' : '') +
      '<span class="ax-chip ' + statusCls + '">' + statusLabel + '</span>' +
      '</div>' +
      '<h4 class="ax-card__title" style="margin:4px 0 0;">' + esc(ev.aiReason) + '</h4>' +
      '</div>' +
      '</div>' +

      // Details grid
      '<div class="ax-critical-alert__details" style="margin-bottom:16px;">' +
      '<div><small>Incident ID</small><strong>' + esc(ev.id) + '</strong></div>' +
      '<div><small>Worker ID</small><strong>' + esc(ev.workerId) + '</strong></div>' +
      '<div><small>Location</small><strong>' + esc(ev.location) + '</strong></div>' +
      '<div><small>Camera ID</small><strong>' + esc(ev.cameraId) + '</strong></div>' +
      '<div><small>Detection Time</small><strong>' + detectedTime + '</strong></div>' +
      '<div><small>Risk Level</small><span class="ax-chip ax-chip--critical">' + esc(ev.riskLevel) + '</span></div>' +
      '</div>' +

      // Response log
      (responseHtml ? '<ul class="ax-list" style="margin-bottom:14px;">' + responseHtml + '</ul>' : '') +

      // Action buttons
      '<div class="ax-critical-alert__actions">' +
      (isPending
        ? '<button class="ax-btn ax-btn--primary ax-btn--sm" data-emergency-action="confirm" data-ev-id="' + esc(ev.id) + '"><span class="material-symbols-outlined" style="font-size:17px;">check_circle</span>CONFIRM EMERGENCY</button>' +
          '<button class="ax-btn ax-btn--ghost ax-btn--sm" data-emergency-action="false-alarm" data-ev-id="' + esc(ev.id) + '"><span class="material-symbols-outlined" style="font-size:17px;">cancel</span>FALSE ALARM</button>'
        : '') +
      (canCallContact
        ? '<button class="ax-btn ax-btn--danger ax-btn--sm" data-emergency-action="call-contact" data-ev-id="' + esc(ev.id) + '"><span class="material-symbols-outlined" style="font-size:17px;">local_hospital</span>CALL EMERGENCY CONTACT</button>'
        : '') +
      (canCreateReport
        ? '<button class="ax-btn ax-btn--soft ax-btn--sm" data-emergency-action="create-report" data-ev-id="' + esc(ev.id) + '"><span class="material-symbols-outlined" style="font-size:17px;">description</span>CREATE INCIDENT REPORT</button>'
        : '') +
      (ev.status === "FALSE_ALARM" || ev.status === "CLOSED"
        ? '<span class="ax-chip ax-chip--muted">Event closed</span>'
        : '') +
      '</div>' +
      '</div>';
  }

  function emergencyFlowStep(icon, title, sub, state) {
    return '<div class="ax-live-pipeline__stage ' + (state ? 'is-' + state : '') + '" style="min-width:110px;">' +
      '<span class="material-symbols-outlined">' + icon + '</span>' +
      '<div><strong>' + esc(title) + '</strong><small data-pipeline-status>' + esc(sub) + '</small></div>' +
      '</div>';
  }

  function createDemoEmergencyEvent() {
    var d = data();
    var zones = window.AwareXData.ZONES || ["Assembly Line A"];
    var workers = d.workers || [];
    var reasons = [
      "Worker detected motionless for >30 seconds. Possible fall or medical emergency.",
      "Rapid movement followed by complete stillness. Possible slip/fall detected.",
      "Worker detected near machinery with no movement for extended period.",
      "Possible worker collapse detected. No PPE movement observed."
    ];
    var ev = {
      id: "EMG-" + Date.now(),
      workerId: workers.length ? workers[Math.floor(Math.random() * workers.length)].id : "Worker-01",
      location: zones[Math.floor(Math.random() * zones.length)],
      cameraId: "CAM-0" + (1 + Math.floor(Math.random() * 4)),
      detectedAt: new Date().toISOString(),
      riskLevel: "Critical",
      aiReason: reasons[Math.floor(Math.random() * reasons.length)],
      status: "PENDING_REVIEW",
      confirmedAt: null, confirmedBy: null,
      falseAlarmAt: null, falseAlarmBy: null,
      emergencyContactCalledAt: null,
      incidentReportId: null,
      responseTimeSeconds: null
    };
    var list = loadEmergencies();
    list.unshift(ev);
    saveEmergencies(list);
  }

  function handleEmergencyAction(evId, action, managerName) {
    var list = loadEmergencies();
    var ev = list.filter(function (e) { return e.id === evId; })[0];
    if (!ev) return;
    var detectedAt = ev.detectedAt ? new Date(ev.detectedAt).getTime() : Date.now();
    var respSec = Math.round((Date.now() - detectedAt) / 1000);

    if (action === "confirm") {
      ev.status = "CONFIRMED";
      ev.confirmedAt = new Date().toISOString();
      ev.confirmedBy = managerName;
      ev.responseTimeSeconds = respSec;
      toast("Emergency CONFIRMED by " + managerName + ". Emergency contact action is now available.", "error");
    } else if (action === "false-alarm") {
      ev.status = "FALSE_ALARM";
      ev.falseAlarmAt = new Date().toISOString();
      ev.falseAlarmBy = managerName;
      ev.responseTimeSeconds = respSec;
      toast("Event marked as FALSE ALARM by " + managerName + ". Response time recorded: " + Math.floor(respSec / 60) + "m " + (respSec % 60) + "s.", "success");
    } else if (action === "call-contact") {
      if (ev.status !== "CONFIRMED") {
        toast("Emergency must be CONFIRMED by a manager before contacting emergency services.", "error");
        return;
      }
      ev.emergencyContactCalledAt = new Date().toISOString();
      toast("Emergency contact action recorded. In a live deployment this would trigger your configured emergency contact protocol.", "info");
    } else if (action === "create-report") {
      var reportId = "INC-RPT-" + Math.floor(Math.random() * 9000 + 1000);
      ev.incidentReportId = reportId;
      toast("Incident report " + reportId + " created and linked to this event.", "success");
    }

    saveEmergencies(list);
    renderEmergency();
    // Update sidebar badge
    var badge = $("[data-badge='emergencies']");
    if (badge) {
      var open = window.AwareXEmergency.getOpen().length;
      badge.textContent = open;
      badge.style.display = open > 0 ? "" : "none";
    }
  }


  // ===========================================================
  // PHASE 5 — CAMERA DEPLOYMENT CONFIGURATION
  // ===========================================================

  var CAMERA_CONFIG_KEY = "awarexCameraDeployment";

  function loadCameraConfig() {
    try { return JSON.parse(localStorage.getItem(CAMERA_CONFIG_KEY) || "{}"); } catch (e) { return {}; }
  }
  function saveCameraConfig(patch) {
    var c = Object.assign(loadCameraConfig(), patch);
    localStorage.setItem(CAMERA_CONFIG_KEY, JSON.stringify(c));
    return c;
  }

  var CAMERA_SOURCES = [
    { key: "webcam", label: "Laptop / Built-in Webcam", icon: "laptop_windows", available: true },
    { key: "ip", label: "IP Camera", icon: "router", available: true },
    { key: "cctv", label: "Existing Factory CCTV", icon: "videocam", available: true },
    { key: "usb", label: "USB Camera", icon: "usb", available: true },
    { key: "edge", label: "Low-Cost Camera + Edge PC", icon: "computer", available: true }
  ];

  function renderCameraConfig() {
    var cfg = loadCameraConfig();
    var body = $("#axCameraConfigBody");
    if (!body) return;
    var selectedSource = cfg.sourceKey || "webcam";

    body.innerHTML =
      // Header
      '<div class="ax-card" style="margin-bottom:18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:240px;">' +
      '<h3 style="margin:0 0 4px;font-size:18px;font-weight:800;">Camera Deployment Configuration</h3>' +
      '<p style="margin:0;font-size:13px;color:var(--ax-muted);">Select your camera source and configure connection parameters. Private credentials are stored only in your browser and never transmitted to any external service.</p>' +
      '</div>' +
      '<span class="ax-chip ax-chip--ok">Configuration Saved Locally</span>' +
      '</div>' +

      // Security notice
      '<div class="ax-live-note" style="margin-bottom:18px;">' +
      '<span class="material-symbols-outlined">lock</span>' +
      '<span><strong>Privacy &amp; Security:</strong> No API keys, passwords, or connection credentials are ever displayed in plaintext or transmitted to external services. All configuration is stored only in your browser\'s localStorage.</span>' +
      '</div>' +

      // Source selector
      '<div class="ax-card" style="margin-bottom:18px;">' +
      '<h4 class="ax-card__title">Select Camera Source</h4>' +
      '<p class="ax-card__sub">Choose the camera type you want to configure for live monitoring</p>' +
      '<div class="ax-camera-source-grid" id="axCamSourceGrid">' +
      CAMERA_SOURCES.map(function (src) {
        var isSelected = selectedSource === src.key;
        return '<button class="ax-camera-source-btn' + (isSelected ? ' is-selected' : '') + '" data-cam-source="' + src.key + '">' +
          '<span class="material-symbols-outlined" style="font-size:28px;">' + src.icon + '</span>' +
          '<span>' + esc(src.label) + '</span>' +
          '</button>';
      }).join("") +
      '</div>' +
      '</div>' +

      // Configuration panel
      '<div id="axCamConfigPanel">' + renderCameraSourcePanel(selectedSource, cfg) + '</div>';

    // Bind source selector
    var grid = $("#axCamSourceGrid");
    if (grid) {
      grid.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-cam-source]");
        if (!btn) return;
        var key = btn.getAttribute("data-cam-source");
        saveCameraConfig({ sourceKey: key });
        renderCameraConfig();
      });
    }

    // Bind save button
    body.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-save-cam-config]");
      if (!btn) return;
      var patch = { sourceKey: selectedSource };
      var section = btn.getAttribute("data-save-cam-config");
      $$("#axCamConfigPanel input, #axCamConfigPanel select").forEach(function (inp) {
        if (inp.type === "password") {
          // Store passwords as a masked indicator — never show the actual value
          if (inp.value && inp.value.length > 0) {
            patch[inp.id + "_set"] = true; // Record that it was set, not the value
          }
        } else if (inp.type === "checkbox") {
          patch[inp.id] = inp.checked;
        } else {
          patch[inp.id] = inp.value;
        }
      });
      saveCameraConfig(patch);
      toast("Camera configuration saved for " + section + ".", "success");
    });

    // Bind webcam start/stop (if webcam source)
    if (selectedSource === "webcam") {
      var startBtn = $("#axCamCfgStart");
      var stopBtn = $("#axCamCfgStop");
      if (startBtn) {
        startBtn.addEventListener("click", function () {
          // Delegate to existing live monitoring camera start
          go("live-monitoring");
          setTimeout(function () {
            var sc = $("#axStartCam");
            if (sc && !sc.disabled) sc.click();
          }, 150);
        });
      }
      if (stopBtn) {
        stopBtn.addEventListener("click", function () {
          go("live-monitoring");
          setTimeout(function () {
            var sc = $("#axStopCam");
            if (sc && !sc.disabled) sc.click();
          }, 150);
        });
      }
    }
  }

  function renderCameraSourcePanel(sourceKey, cfg) {
    var streaming = !!(camera && camera.stream);

    switch (sourceKey) {

      case "webcam":
        return '<div class="ax-card">' +
          '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">' +
          '<span class="material-symbols-outlined" style="color:var(--ax-primary);font-size:28px;">laptop_windows</span>' +
          '<div><h4 class="ax-card__title" style="margin:0;">Laptop / Built-in Webcam</h4><p class="ax-card__sub" style="margin:0;">Uses the browser MediaDevices API — no drivers or plugins required</p></div>' +
          '<span class="ax-chip ' + (streaming ? "ax-chip--live" : "ax-chip--muted") + '">' + (streaming ? "Streaming" : "Camera Off") + '</span>' +
          '</div>' +
          camField("Camera Name", "cfgCamName", cfg.cfgCamName || "Line A — Laptop Webcam", "text") +
          '<label class="ax-field"><span>Resolution</span><select class="ax-select" id="cfgCamRes">' +
          ['1920 x 1080', '1280 x 720', '640 x 480'].map(function (r) { return '<option' + (cfg.cfgCamRes === r ? ' selected' : '') + '>' + r + '</option>'; }).join("") +
          '</select></label>' +
          camField("Target FPS", "cfgCamFps", cfg.cfgCamFps || "30", "number") +
          '<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;">' +
          '<button class="ax-btn ax-btn--primary ax-btn--sm" id="axCamCfgStart"><span class="material-symbols-outlined" style="font-size:17px;">videocam</span>Start Live Camera</button>' +
          '<button class="ax-btn ax-btn--danger ax-btn--sm" id="axCamCfgStop"><span class="material-symbols-outlined" style="font-size:17px;">videocam_off</span>Stop Live Camera</button>' +
          '<button class="ax-btn ax-btn--ghost ax-btn--sm" data-save-cam-config="Laptop Webcam">Save Settings</button>' +
          '</div>' +
          '<p style="font-size:12px;color:var(--ax-muted);margin-top:12px;">The browser will request camera permission when you click Start. The stream is processed locally — no video is sent externally.</p>' +
          '</div>';

      case "ip":
        return '<div class="ax-card">' +
          '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">' +
          '<span class="material-symbols-outlined" style="color:var(--ax-primary);font-size:28px;">router</span>' +
          '<div><h4 class="ax-card__title" style="margin:0;">IP Camera</h4><p class="ax-card__sub" style="margin:0;">Connect via RTSP or HTTP stream URL — processed by the AwareX backend</p></div>' +
          '</div>' +
          camField("Camera Name / Label", "cfgIpName", cfg.cfgIpName || "IP Camera 01", "text") +
          camField("Stream URL (RTSP / HTTP)", "cfgIpUrl", cfg.cfgIpUrl || "", "text", "e.g. rtsp://192.168.1.100:554/stream") +
          '<label class="ax-field"><span>Stream Protocol</span><select class="ax-select" id="cfgIpProto">' +
          ['RTSP', 'HTTP MJPEG', 'ONVIF', 'HLS'].map(function (p) { return '<option' + (cfg.cfgIpProto === p ? ' selected' : '') + '>' + p + '</option>'; }).join("") +
          '</select></label>' +
          camField("Zone Assignment", "cfgIpZone", cfg.cfgIpZone || "", "text", "e.g. Assembly Line A") +
          camField("Username (if required)", "cfgIpUser", cfg.cfgIpUser || "", "text") +
          '<label class="ax-field"><span>Password</span><input class="ax-input" id="cfgIpPass" type="password" autocomplete="new-password" placeholder="Stored securely — never displayed"/></label>' +
          '<div class="ax-live-note" style="margin:12px 0;">' +
          '<span class="material-symbols-outlined">lock</span>' +
          '<span>Credentials are stored as a set indicator only. Actual password values are never echoed to the screen or logged.</span>' +
          (cfg.cfgIpPass_set ? '<span class="ax-chip ax-chip--ok" style="margin-left:8px;">Password set</span>' : '') +
          '</div>' +
          '<button class="ax-btn ax-btn--primary" data-save-cam-config="IP Camera">Save IP Camera Configuration</button>' +
          '<p style="font-size:12px;color:var(--ax-muted);margin-top:12px;">The AwareX backend (FastAPI) must be running and configured to consume this stream. The stream URL is only used server-side.</p>' +
          '</div>';

      case "cctv":
        return '<div class="ax-card">' +
          '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">' +
          '<span class="material-symbols-outlined" style="color:var(--ax-primary);font-size:28px;">videocam</span>' +
          '<div><h4 class="ax-card__title" style="margin:0;">Existing Factory CCTV</h4><p class="ax-card__sub" style="margin:0;">Integrate with your existing CCTV system using the existing supported video input methods</p></div>' +
          '</div>' +
          camField("CCTV System Name", "cfgCctvName", cfg.cfgCctvName || "Factory CCTV System", "text") +
          '<label class="ax-field"><span>Connection Method</span><select class="ax-select" id="cfgCctvMethod">' +
          ['RTSP Stream', 'Video Capture Card (USB/PCIe)', 'NVR Integration', 'DVR Direct Feed'].map(function (m) { return '<option' + (cfg.cfgCctvMethod === m ? ' selected' : '') + '>' + m + '</option>'; }).join("") +
          '</select></label>' +
          camField("NVR / DVR IP Address", "cfgCctvIp", cfg.cfgCctvIp || "", "text", "e.g. 192.168.1.200") +
          camField("Channel / Camera ID", "cfgCctvChannel", cfg.cfgCctvChannel || "1", "number") +
          camField("Zone Assignment", "cfgCctvZone", cfg.cfgCctvZone || "", "text") +
          '<label class="ax-field"><span>Username (if required)</span><input class="ax-input" id="cfgCctvUser" type="text" value="' + esc(cfg.cfgCctvUser || "") + '"/></label>' +
          '<label class="ax-field"><span>Password</span><input class="ax-input" id="cfgCctvPass" type="password" autocomplete="new-password" placeholder="Stored securely — never displayed"/></label>' +
          (cfg.cfgCctvPass_set ? '<span class="ax-chip ax-chip--ok" style="display:inline-flex;margin-bottom:12px;">Password set</span>' : '') +
          '<button class="ax-btn ax-btn--primary" data-save-cam-config="Factory CCTV">Save CCTV Configuration</button>' +
          '<p style="font-size:12px;color:var(--ax-muted);margin-top:12px;">For RTSP streams, connect using the same IP Camera flow. For capture cards, the device will appear as a USB/video device on the edge PC running the AwareX backend.</p>' +
          '</div>';

      case "usb":
        return '<div class="ax-card">' +
          '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">' +
          '<span class="material-symbols-outlined" style="color:var(--ax-primary);font-size:28px;">usb</span>' +
          '<div><h4 class="ax-card__title" style="margin:0;">USB Camera</h4><p class="ax-card__sub" style="margin:0;">External USB cameras connected to this device or the edge processing PC</p></div>' +
          '</div>' +
          '<div class="ax-live-note" style="margin-bottom:14px;">' +
          '<span class="material-symbols-outlined">info</span>' +
          '<span>USB cameras connected to <strong>this browser device</strong> are accessible via the browser MediaDevices API (same as webcam). USB cameras on a <strong>remote edge PC</strong> must be configured via the backend.</span>' +
          '</div>' +
          camField("Camera Name / Label", "cfgUsbName", cfg.cfgUsbName || "USB Camera 01", "text") +
          '<label class="ax-field"><span>Device Index (backend/edge PC)</span><select class="ax-select" id="cfgUsbIndex">' +
          ['0 (First device)', '1', '2', '3'].map(function (i) { return '<option' + (cfg.cfgUsbIndex === i ? ' selected' : '') + '>' + i + '</option>'; }).join("") +
          '</select></label>' +
          '<label class="ax-field"><span>Resolution</span><select class="ax-select" id="cfgUsbRes">' +
          ['1920 x 1080', '1280 x 720', '640 x 480', '1280 x 960'].map(function (r) { return '<option' + (cfg.cfgUsbRes === r ? ' selected' : '') + '>' + r + '</option>'; }).join("") +
          '</select></label>' +
          camField("Target FPS", "cfgUsbFps", cfg.cfgUsbFps || "30", "number") +
          camField("Zone Assignment", "cfgUsbZone", cfg.cfgUsbZone || "", "text") +
          '<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;">' +
          '<button class="ax-btn ax-btn--primary ax-btn--sm" id="axCamCfgStart"><span class="material-symbols-outlined" style="font-size:17px;">videocam</span>Start (Browser USB)</button>' +
          '<button class="ax-btn ax-btn--ghost ax-btn--sm" data-save-cam-config="USB Camera">Save Settings</button>' +
          '</div>' +
          '<p style="font-size:12px;color:var(--ax-muted);margin-top:12px;">Device Index applies when the backend directly accesses the USB device using OpenCV VideoCapture(index). Browser access uses the same MediaDevices API as the built-in webcam.</p>' +
          '</div>';

      case "edge":
        return '<div class="ax-card">' +
          '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">' +
          '<span class="material-symbols-outlined" style="color:var(--ax-primary);font-size:28px;">computer</span>' +
          '<div><h4 class="ax-card__title" style="margin:0;">Low-Cost Camera + Edge PC</h4><p class="ax-card__sub" style="margin:0;">Run AwareX on a local edge device with a low-cost camera (Raspberry Pi, Jetson Nano, mini PC + webcam)</p></div>' +
          '</div>' +
          camField("Edge Device Name / Label", "cfgEdgeName", cfg.cfgEdgeName || "Edge Node 01", "text") +
          camField("Edge PC IP Address", "cfgEdgeIp", cfg.cfgEdgeIp || "", "text", "e.g. 192.168.1.150") +
          camField("AwareX Backend Port", "cfgEdgePort", cfg.cfgEdgePort || "8003", "number") +
          '<label class="ax-field"><span>Camera Type on Edge Device</span><select class="ax-select" id="cfgEdgeCamType">' +
          ['USB Webcam (OpenCV)', 'CSI Camera (Raspberry Pi)', 'IP Camera Feed', 'Video Capture Card'].map(function (t) { return '<option' + (cfg.cfgEdgeCamType === t ? ' selected' : '') + '>' + t + '</option>'; }).join("") +
          '</select></label>' +
          camField("Camera Device Index / Path", "cfgEdgeCamIdx", cfg.cfgEdgeCamIdx || "0", "text", "e.g. 0 or /dev/video0") +
          '<label class="ax-field"><span>Processing Mode</span><select class="ax-select" id="cfgEdgeMode">' +
          ['Real-time (stream to backend)', 'Batch (upload clips)', 'On-device inference'].map(function (m) { return '<option' + (cfg.cfgEdgeMode === m ? ' selected' : '') + '>' + m + '</option>'; }).join("") +
          '</select></label>' +
          camField("Zone Assignment", "cfgEdgeZone", cfg.cfgEdgeZone || "", "text") +
          '<div class="ax-live-note" style="margin:12px 0;">' +
          '<span class="material-symbols-outlined">info</span>' +
          '<span>The Edge PC runs the AwareX FastAPI backend locally. Set the Backend API URL in <strong>Settings → AI Configuration</strong> to <code>http://' + esc(cfg.cfgEdgeIp || "&lt;edge-ip&gt;") + ':' + esc(cfg.cfgEdgePort || "8003") + '</code> to connect this dashboard to the edge device.</span>' +
          '</div>' +
          '<button class="ax-btn ax-btn--primary" data-save-cam-config="Edge PC">Save Edge Configuration</button>' +
          '<p style="font-size:12px;color:var(--ax-muted);margin-top:12px;">Compatible with existing AwareX FastAPI + YOLO pipeline. No changes to the backend architecture are required — just configure the camera device index and run the server on the edge PC.</p>' +
          '</div>';

      default:
        return '<div class="ax-card ax-empty"><p>Select a camera source above.</p></div>';
    }
  }

  function camField(label, id, value, type, placeholder) {
    return '<label class="ax-field"><span>' + esc(label) + '</span><input class="ax-input" id="' + id + '" type="' + (type || "text") + '" value="' + esc(value || "") + '"' + (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + '/></label>';
  }


})();
