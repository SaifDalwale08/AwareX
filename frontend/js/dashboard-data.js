/* =========================================================
   AwareX - Centralized dashboard data layer (DEMO MODE)
   ---------------------------------------------------------
   This file owns the single application state object:

     AwareXData.analysisData = {
       video, workers, alerts, violations, ppeCompliance,
       safetyScore, riskDistribution, zones, timeline,
       recommendations, analytics, reports
     }

   Every dashboard section reads from this one object.
   No section should invent its own disconnected numbers.

   BACKEND INTEGRATION POINTS (FastAPI / OpenCV / YOLO / ML):
     AwareXData.api.analyzeVideo(file)   -> POST /api/analyze
     AwareXData.api.getAnalysis(id)      -> GET  /api/analysis/:id
     AwareXData.api.startLiveSession()   -> POST /api/live/session
     AwareXData.api.pushFrame(blob)      -> POST /api/live/frame
     AwareXData.api.getRecommendations() -> GET  /api/decision-intelligence
   Replace the demo implementations with real fetch() calls.
   Firebase (users/videos/results/alerts/reports/settings) can be
   layered on top of the same shape later - do not add it yet.
   ========================================================= */
(function (global) {
  "use strict";

  var MODE = "DEMO"; // becomes "LIVE" once the AI backend is connected
  var ZONES = ["Assembly Line A", "Welding Bay", "Loading Dock", "Restricted Zone 3", "Chemical Store", "Packaging"];
  var MOVEMENTS = ["Walking", "Standing", "Operating Machine", "Climbing", "Running", "Lifting"];
  var VIOLATION_TYPES = [
    "Helmet Missing", "Safety Vest Missing", "Gloves Missing", "Safety Shoes Missing",
    "Restricted Zone Entry", "Unsafe Movement", "Machine Proximity Breach", "No Eye Protection"
  ];

  function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function pick(arr) { return arr[rand(0, arr.length - 1)]; }
  function chance(p) { return Math.random() < p; }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function makeWorker(i) {
    var ppe = {
      helmet: chance(0.82),
      vest: chance(0.88),
      gloves: chance(0.74),
      shoes: chance(0.9)
    };
    var missing = Object.keys(ppe).filter(function (k) { return !ppe[k]; });
    var zone = pick(ZONES);
    var movement = pick(MOVEMENTS);
    var restricted = zone === "Restricted Zone 3";
    var score = 100 - missing.length * 11 - (restricted ? 14 : 0) - (movement === "Running" ? 9 : 0);
    score = Math.max(38, Math.min(100, score - rand(0, 5)));
    var risk = score >= 85 ? "Low" : score >= 70 ? "Medium" : score >= 55 ? "High" : "Critical";
    return {
      id: "Worker-" + pad(i),
      name: "Operator " + pad(i),
      shift: pick(["Shift A (06:00-14:00)", "Shift B (14:00-22:00)", "Shift C (22:00-06:00)"]),
      ppe: ppe,
      zone: zone,
      movement: movement,
      risk: risk,
      safetyScore: score,
      violations: missing.length + (restricted ? 1 : 0),
      active: chance(0.86),
      lastSeen: pad(rand(0, 23)) + ":" + pad(rand(0, 59)),
      confidence: rand(86, 99)
    };
  }

  function buildViolations(workers) {
    var out = [];
    workers.forEach(function (w) {
      Object.keys(w.ppe).forEach(function (key) {
        if (w.ppe[key]) return;
        var label = { helmet: "Helmet Missing", vest: "Safety Vest Missing", gloves: "Gloves Missing", shoes: "Safety Shoes Missing" }[key];
        out.push(makeViolation(w, label));
      });
      if (w.zone === "Restricted Zone 3") out.push(makeViolation(w, "Restricted Zone Entry"));
      if (w.movement === "Running") out.push(makeViolation(w, "Unsafe Movement"));
    });
    return out.sort(function (a, b) { return a.timestamp < b.timestamp ? 1 : -1; });
  }

  function makeViolation(worker, type) {
    var severity =
      type === "Restricted Zone Entry" || type === "Helmet Missing" ? (chance(0.5) ? "Critical" : "High")
        : type === "Unsafe Movement" ? "High"
          : chance(0.4) ? "Medium" : "Low";
    var d = new Date(Date.now() - rand(0, 6) * 86400000 - rand(0, 86000) * 1000);
    return {
      id: "VIO-" + rand(1000, 9999),
      workerId: worker.id,
      type: type,
      location: worker.zone,
      timestamp: d.toISOString(),
      date: d.toISOString().slice(0, 10),
      time: pad(d.getHours()) + ":" + pad(d.getMinutes()),
      severity: severity,
      status: chance(0.45) ? "Active" : chance(0.5) ? "Acknowledged" : "Resolved",
      confidence: rand(84, 99)
    };
  }

  function buildRecommendations(workers) {
    return workers
      .filter(function (w) { return w.risk === "Critical" || w.risk === "High"; })
      .slice(0, 6)
      .map(function (w) {
        var factors = [];
        if (!w.ppe.helmet) factors.push("Helmet Missing");
        if (!w.ppe.vest) factors.push("Safety Vest Missing");
        if (!w.ppe.gloves) factors.push("Gloves Missing");
        if (w.zone === "Restricted Zone 3") factors.push("Restricted Zone");
        if (w.movement === "Operating Machine" || w.movement === "Climbing") factors.push("Machine Nearby");
        if (w.movement === "Running") factors.push("Unsafe Movement");
        if (!factors.length) factors.push("Low PPE Confidence");
        var actions = ["Notify Supervisor", "Record Incident"];
        if (factors.indexOf("Machine Nearby") > -1) actions.unshift("Stop Machine");
        if (factors.indexOf("Helmet Missing") > -1 || factors.indexOf("Safety Vest Missing") > -1) actions.push("Provide PPE");
        if (factors.indexOf("Restricted Zone") > -1) actions.push("Restrict Zone Access");
        return {
          id: "DI-" + rand(100, 999),
          workerId: w.id,
          zone: w.zone,
          factors: factors,
          risk: w.risk === "Critical" ? "CRITICAL" : "HIGH",
          confidence: rand(88, 98),
          actions: actions,
          status: "Pending",
          source: "DEMO AI RECOMMENDATION"
        };
      });
  }

  function buildAnalytics(workers, violations) {
    var days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return {
      labels: days,
      safetyScoreTrend: days.map(function () { return rand(72, 96); }),
      ppeComplianceTrend: days.map(function () { return rand(70, 97); }),
      violationsOverTime: days.map(function () { return rand(2, 18); }),
      incidentFrequency: days.map(function () { return rand(0, 6); }),
      framesProcessed: days.map(function () { return rand(8000, 26000); }),
      zoneSafety: ZONES.map(function (z) {
        var inZone = workers.filter(function (w) { return w.zone === z; });
        var avg = inZone.length
          ? Math.round(inZone.reduce(function (s, w) { return s + w.safetyScore; }, 0) / inZone.length)
          : rand(74, 95);
        return { zone: z, score: avg, workers: inZone.length, violations: violations.filter(function (v) { return v.location === z; }).length };
      })
    };
  }

  function buildTimeline(violations) {
    return violations.slice(0, 10).map(function (v) {
      return { time: v.time, title: v.type, detail: v.workerId + " - " + v.location, severity: v.severity };
    });
  }

  function buildReports(video, workers, violations, score) {
    return [
      {
        id: "RPT-2041",
        name: "Shift A Safety Analysis",
        video: video ? video.name : "assembly-line-a.mp4",
        date: new Date().toISOString().slice(0, 10),
        workers: workers.length,
        violations: violations.length,
        safetyScore: score,
        status: "Ready"
      },
      { id: "RPT-2040", name: "Welding Bay Weekly Review", video: "welding-bay-week24.mp4", date: "2026-08-06", workers: 18, violations: 24, safetyScore: 82, status: "Ready" },
      { id: "RPT-2039", name: "Loading Dock PPE Audit", video: "dock-audit-clip.mov", date: "2026-08-03", workers: 12, violations: 9, safetyScore: 91, status: "Ready" },
      { id: "RPT-2038", name: "Night Shift Incident Review", video: "night-shift-c.mp4", date: "2026-07-30", workers: 21, violations: 31, safetyScore: 76, status: "Archived" }
    ];
  }

  function computeSummary(workers) {
    var ppeChecks = 0, ppeOk = 0;
    workers.forEach(function (w) {
      Object.keys(w.ppe).forEach(function (k) { ppeChecks++; if (w.ppe[k]) ppeOk++; });
    });
    var score = Math.round(workers.reduce(function (s, w) { return s + w.safetyScore; }, 0) / (workers.length || 1));
    return {
      ppeCompliance: Math.round((ppeOk / (ppeChecks || 1)) * 100),
      safetyScore: score
    };
  }

  function riskDistribution(workers) {
    var out = { Low: 0, Medium: 0, High: 0, Critical: 0 };
    workers.forEach(function (w) { out[w.risk]++; });
    return out;
  }

  /* ---------- State factory ---------- */
  function emptyState() {
    return {
      mode: MODE,
      video: null,
      workers: [],
      alerts: [],
      violations: [],
      ppeCompliance: 0,
      safetyScore: 0,
      riskDistribution: { Low: 0, Medium: 0, High: 0, Critical: 0 },
      zones: [],
      timeline: [],
      recommendations: [],
      analytics: null,
      reports: [],
      analyzedAt: null,
      framesProcessed: 0
    };
  }

  function generate(video) {
    var count = rand(18, 30);
    var workers = [];
    for (var i = 1; i <= count; i++) workers.push(makeWorker(i));

    var violations = buildViolations(workers);
    var summary = computeSummary(workers);
    var analytics = buildAnalytics(workers, violations);
    var recommendations = buildRecommendations(workers);
    var alerts = violations.filter(function (v) { return v.severity === "Critical" && v.status === "Active"; });

    return {
      mode: MODE,
      video: video || {
        name: "assembly-line-a.mp4", size: "184.2 MB", duration: "00:04:32",
        resolution: "1920 x 1080", fps: 30, type: "video/mp4", url: null
      },
      workers: workers,
      alerts: alerts,
      violations: violations,
      ppeCompliance: summary.ppeCompliance,
      safetyScore: summary.safetyScore,
      riskDistribution: riskDistribution(workers),
      zones: analytics.zoneSafety,
      timeline: buildTimeline(violations),
      recommendations: recommendations,
      analytics: analytics,
      reports: buildReports(video, workers, violations, summary.safetyScore),
      analyzedAt: new Date().toISOString(),
      framesProcessed: rand(6800, 18400)
    };
  }

  /* ---------- Public API ---------- */
  var listeners = [];
  var state = generate(null); // seeded demo baseline for the dashboard overview

  var AwareXData = {
    MODE: MODE,
    ZONES: ZONES,
    VIOLATION_TYPES: VIOLATION_TYPES,
    get analysisData() { return state; },
    subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    emit: function () { listeners.forEach(function (fn) { try { fn(state); } catch (e) { console.error(e); } }); },
    reset: function () { state = emptyState(); this.emit(); return state; },
    setState: function (next) { state = next; this.emit(); return state; },
    generateFor: function (video) { state = generate(video); this.emit(); return state; },

    /* Backend integration surface - swap the demo bodies for fetch() later. */
    api: {
      baseUrl: "", // e.g. "https://awarex-api.yourdomain.com"
      connected: false,
      analyzeVideo: function (videoMeta) {
        // FUTURE: return fetch(this.baseUrl + "/api/analyze", { method:"POST", body: formData }).then(r => r.json());
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(AwareXData.generateFor(videoMeta)); }, 2200);
        });
      },
      getAnalysis: function () { return Promise.resolve(state); },
      startLiveSession: function () { return Promise.resolve({ sessionId: "demo-" + Date.now(), mode: "DEMO" }); },
      pushFrame: function () { return Promise.resolve({ ok: true, mode: "DEMO" }); },
      getRecommendations: function () { return Promise.resolve(state.recommendations); }
    },

    models: [
      { key: "yolo", name: "YOLO Object Detection", detail: "PPE + worker detection (YOLOv8)", status: "Ready for Connection" },
      { key: "opencv", name: "OpenCV Pipeline", detail: "Frame extraction, preprocessing, overlays", status: "Ready for Connection" },
      { key: "ml", name: "ML Risk Model", detail: "Risk scoring from multi-factor context", status: "Ready for Connection" },
      { key: "tracking", name: "Worker Tracking", detail: "Multi-object tracking + re-identification", status: "Ready for Connection" },
      { key: "di", name: "Decision Intelligence", detail: "Recommendation + action engine", status: "Ready for Connection" }
    ]
  };

  global.AwareXData = AwareXData;
})(window);
