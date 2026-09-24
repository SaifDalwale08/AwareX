/*
=========================================================
AwareX - Centralized Dashboard Data Layer
=========================================================
REAL BACKEND MODE

The API base can be configured before this script loads with:
  window.AWAREX_API_BASE = "https://your-backend.example.com";

Local development falls back to the local FastAPI server.
=========================================================
*/

(function (global) {
  "use strict";

  // =====================================================
  // CONFIGURATION
  // =====================================================

  var MODE = "LIVE";

  var API_BASE_URL = (
    global.AWAREX_API_BASE ||
    "https://awarex-o0mo.onrender.com"
  ).replace(/\/+$/, "");

  var ZONES = [
    "Assembly Line A",
    "Welding Bay",
    "Loading Dock",
    "Restricted Zone 3",
    "Chemical Store",
    "Packaging"
  ];

  var MOVEMENTS = [
    "Walking",
    "Standing",
    "Operating Machine",
    "Climbing",
    "Running",
    "Lifting"
  ];

  var VIOLATION_TYPES = [
    "Helmet Missing",
    "Safety Vest Missing",
    "Gloves Missing",
    "Safety Shoes Missing",
    "Restricted Zone Entry",
    "Unsafe Movement",
    "Machine Proximity Breach",
    "No Eye Protection"
  ];


  // =====================================================
  // UTILITY FUNCTIONS
  // =====================================================

  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function pick(arr) {
    return arr[rand(0, arr.length - 1)];
  }

  function chance(p) {
    return Math.random() < p;
  }

  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }


  // =====================================================
  // DEMO WORKER FUNCTIONS
  // Kept for compatibility with existing dashboard UI.
  // =====================================================

  function makeWorker(i) {

    var ppe = {
      helmet: chance(0.82),
      vest: chance(0.88),
      gloves: chance(0.74),
      shoes: chance(0.90)
    };

    var missing = Object.keys(ppe).filter(function (k) {
      return !ppe[k];
    });

    var zone = pick(ZONES);
    var movement = pick(MOVEMENTS);

    var restricted = zone === "Restricted Zone 3";

    var score =
      100 -
      missing.length * 11 -
      (restricted ? 14 : 0) -
      (movement === "Running" ? 9 : 0);

    score = Math.max(
      38,
      Math.min(100, score - rand(0, 5))
    );

    var risk =
      score >= 85
        ? "Low"
        : score >= 70
          ? "Medium"
          : score >= 55
            ? "High"
            : "Critical";

    return {
      id: "Worker-" + pad(i),
      name: "Operator " + pad(i),

      shift: pick([
        "Shift A (06:00-14:00)",
        "Shift B (14:00-22:00)",
        "Shift C (22:00-06:00)"
      ]),

      ppe: ppe,

      zone: zone,

      movement: movement,

      risk: risk,

      safetyScore: score,

      violations:
        missing.length +
        (restricted ? 1 : 0),

      active: chance(0.86),

      lastSeen:
        pad(rand(0, 23)) +
        ":" +
        pad(rand(0, 59)),

      confidence: rand(86, 99)
    };
  }


  // =====================================================
  // DEMO VIOLATIONS
  // =====================================================

  function makeViolation(worker, type) {

    var severity =
      type === "Restricted Zone Entry" ||
      type === "Helmet Missing"
        ? (chance(0.5) ? "Critical" : "High")
        : type === "Unsafe Movement"
          ? "High"
          : chance(0.4)
            ? "Medium"
            : "Low";

    var d = new Date(
      Date.now() -
      rand(0, 6) * 86400000 -
      rand(0, 86000) * 1000
    );

    return {

      id: "VIO-" + rand(1000, 9999),

      workerId: worker.id,

      type: type,

      location: worker.zone,

      timestamp: d.toISOString(),

      date: d.toISOString().slice(0, 10),

      time:
        pad(d.getHours()) +
        ":" +
        pad(d.getMinutes()),

      severity: severity,

      status:
        chance(0.45)
          ? "Active"
          : chance(0.5)
            ? "Acknowledged"
            : "Resolved",

      confidence: rand(84, 99)
    };
  }


  function buildViolations(workers) {

    var out = [];

    workers.forEach(function (w) {

      Object.keys(w.ppe).forEach(function (key) {

        if (w.ppe[key]) {
          return;
        }

        var label = {
          helmet: "Helmet Missing",
          vest: "Safety Vest Missing",
          gloves: "Gloves Missing",
          shoes: "Safety Shoes Missing"
        }[key];

        out.push(
          makeViolation(w, label)
        );
      });


      if (w.zone === "Restricted Zone 3") {
        out.push(
          makeViolation(
            w,
            "Restricted Zone Entry"
          )
        );
      }


      if (w.movement === "Running") {
        out.push(
          makeViolation(
            w,
            "Unsafe Movement"
          )
        );
      }

    });

    return out.sort(function (a, b) {
      return a.timestamp < b.timestamp
        ? 1
        : -1;
    });
  }


  // =====================================================
  // DEMO RECOMMENDATIONS
  // =====================================================

  function buildRecommendations(workers) {

    return workers

      .filter(function (w) {
        return (
          w.risk === "Critical" ||
          w.risk === "High"
        );
      })

      .slice(0, 6)

      .map(function (w) {

        var factors = [];

        if (!w.ppe.helmet) {
          factors.push("Helmet Missing");
        }

        if (!w.ppe.vest) {
          factors.push("Safety Vest Missing");
        }

        if (!w.ppe.gloves) {
          factors.push("Gloves Missing");
        }

        if (w.zone === "Restricted Zone 3") {
          factors.push("Restricted Zone");
        }

        if (
          w.movement === "Operating Machine" ||
          w.movement === "Climbing"
        ) {
          factors.push("Machine Nearby");
        }

        if (w.movement === "Running") {
          factors.push("Unsafe Movement");
        }

        if (!factors.length) {
          factors.push("Low PPE Confidence");
        }

        var actions = [
          "Notify Supervisor",
          "Record Incident"
        ];

        if (
          factors.indexOf("Machine Nearby") > -1
        ) {
          actions.unshift("Stop Machine");
        }

        if (
          factors.indexOf("Helmet Missing") > -1 ||
          factors.indexOf("Safety Vest Missing") > -1
        ) {
          actions.push("Provide PPE");
        }

        if (
          factors.indexOf("Restricted Zone") > -1
        ) {
          actions.push("Restrict Zone Access");
        }

        return {

          id: "DI-" + rand(100, 999),

          workerId: w.id,

          zone: w.zone,

          factors: factors,

          risk:
            w.risk === "Critical"
              ? "CRITICAL"
              : "HIGH",

          confidence: rand(88, 98),

          actions: actions,

          status: "Pending",

          source:
            "DEMO AI RECOMMENDATION"
        };

      });
  }


  // =====================================================
  // DEMO ANALYTICS
  // =====================================================

  function buildAnalytics(
    workers,
    violations
  ) {

    var days = [
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun"
    ];

    return {

      labels: days,

      safetyScoreTrend:
        days.map(function () {
          return rand(72, 96);
        }),

      ppeComplianceTrend:
        days.map(function () {
          return rand(70, 97);
        }),

      violationsOverTime:
        days.map(function () {
          return rand(2, 18);
        }),

      incidentFrequency:
        days.map(function () {
          return rand(0, 6);
        }),

      framesProcessed:
        days.map(function () {
          return rand(8000, 26000);
        }),

      zoneSafety:
        ZONES.map(function (z) {

          var inZone =
            workers.filter(function (w) {
              return w.zone === z;
            });

          var avg = inZone.length
            ? Math.round(
                inZone.reduce(
                  function (s, w) {
                    return s + w.safetyScore;
                  },
                  0
                ) / inZone.length
              )
            : rand(74, 95);

          return {
            zone: z,
            score: avg,
            workers: inZone.length,

            violations:
              violations.filter(function (v) {
                return v.location === z;
              }).length
          };

        })
    };
  }


  // =====================================================
  // TIMELINE
  // =====================================================

  function buildTimeline(violations) {

    return violations
      .slice(0, 10)
      .map(function (v) {

        return {

          time: v.time,

          title: v.type,

          detail:
            v.workerId +
            " - " +
            v.location,

          severity: v.severity

        };

      });
  }


  // =====================================================
  // REPORTS
  // =====================================================

  function buildReports(
    video,
    workers,
    violations,
    score
  ) {

    return [

      {
        id: "RPT-2041",

        name:
          "Shift A Safety Analysis",

        video:
          video
            ? video.name
            : "assembly-line-a.mp4",

        date:
          new Date()
            .toISOString()
            .slice(0, 10),

        workers:
          workers.length,

        violations:
          violations.length,

        safetyScore:
          score,

        status:
          "Ready"
      },

      {
        id: "RPT-2040",
        name:
          "Welding Bay Weekly Review",
        video:
          "welding-bay-week24.mp4",
        date:
          "2026-08-06",
        workers: 18,
        violations: 24,
        safetyScore: 82,
        status: "Ready"
      },

      {
        id: "RPT-2039",
        name:
          "Loading Dock PPE Audit",
        video:
          "dock-audit-clip.mov",
        date:
          "2026-08-03",
        workers: 12,
        violations: 9,
        safetyScore: 91,
        status: "Ready"
      },

      {
        id: "RPT-2038",
        name:
          "Night Shift Incident Review",
        video:
          "night-shift-c.mp4",
        date:
          "2026-07-30",
        workers: 21,
        violations: 31,
        safetyScore: 76,
        status: "Archived"
      }

    ];
  }


  // =====================================================
  // SUMMARY
  // =====================================================

  function computeSummary(workers) {

    var ppeChecks = 0;
    var ppeOk = 0;

    workers.forEach(function (w) {

      Object.keys(w.ppe).forEach(function (k) {

        ppeChecks++;

        if (w.ppe[k]) {
          ppeOk++;
        }

      });

    });

    var score =
      Math.round(
        workers.reduce(
          function (s, w) {
            return s + w.safetyScore;
          },
          0
        ) /
        (workers.length || 1)
      );

    return {

      ppeCompliance:
        Math.round(
          (ppeOk / (ppeChecks || 1)) *
          100
        ),

      safetyScore:
        score

    };
  }


  // =====================================================
  // RISK DISTRIBUTION
  // =====================================================

  function riskDistribution(workers) {

    var out = {
      Low: 0,
      Medium: 0,
      High: 0,
      Critical: 0
    };

    workers.forEach(function (w) {
      out[w.risk]++;
    });

    return out;
  }


  // =====================================================
  // EMPTY STATE
  // =====================================================

  function emptyState() {

    return {

      mode: MODE,

      video: null,

      workers: [],

      alerts: [],

      violations: [],

      ppeCompliance: 0,

      safetyScore: 0,

      riskDistribution: {
        Low: 0,
        Medium: 0,
        High: 0,
        Critical: 0
      },

      zones: [],

      timeline: [],

      recommendations: [],

      analytics: null,

      reports: [],

      analyzedAt: null,

      framesProcessed: 0
    };
  }


  // =====================================================
  // DEMO STATE GENERATOR
  // =====================================================

  function generate(video) {

    var count = rand(18, 30);

    var workers = [];

    for (
      var i = 1;
      i <= count;
      i++
    ) {
      workers.push(
        makeWorker(i)
      );
    }

    var violations =
      buildViolations(workers);

    var summary =
      computeSummary(workers);

    var analytics =
      buildAnalytics(
        workers,
        violations
      );

    var recommendations =
      buildRecommendations(workers);

    var alerts =
      violations.filter(function (v) {
        return (
          v.severity === "Critical" &&
          v.status === "Active"
        );
      });

    return {

      mode: MODE,

      video:
        video || {

          name:
            "assembly-line-a.mp4",

          size:
            "184.2 MB",

          duration:
            "00:04:32",

          resolution:
            "1920 x 1080",

          fps: 30,

          type:
            "video/mp4",

          url: null
        },

      workers: workers,

      alerts: alerts,

      violations: violations,

      ppeCompliance:
        summary.ppeCompliance,

      safetyScore:
        summary.safetyScore,

      riskDistribution:
        riskDistribution(workers),

      zones:
        analytics.zoneSafety,

      timeline:
        buildTimeline(violations),

      recommendations:
        recommendations,

      analytics:
        analytics,

      reports:
        buildReports(
          video,
          workers,
          violations,
          summary.safetyScore
        ),

      analyzedAt:
        new Date().toISOString(),

      framesProcessed:
        rand(6800, 18400)
    };
  }


  // =====================================================
  // APPLICATION STATE
  // =====================================================

  var listeners = [];

  var state = generate(null);


  // =====================================================
  // API DATA NORMALIZATION
  // =====================================================

  function normalizeBackendEvents(events) {

    if (!Array.isArray(events)) {
      return [];
    }

    return events.map(function (event) {

      var violationName =
        event.violation || "Unknown Violation";

      var displayName =
        violationName
          .replace("no-", "No ")
          .replace("-", " ");

      displayName =
        displayName.charAt(0).toUpperCase() +
        displayName.slice(1);

      var severity =
        event.severity || "WARNING";

      var confidence =
        Number(event.confidence || 0);

      var createdAt =
        event.created_at
          ? new Date(event.created_at)
          : new Date();

      return {

        id:
          "VIO-" +
          event.id,

        backendId:
          event.id,

        workerId:
          "Unknown Worker",

        type:
          displayName,

        rawType:
          violationName,

        location:
          event.zone || "Unknown Zone",

        camera:
          event.camera || "Unknown Camera",

        timestamp:
          createdAt.toISOString(),

        date:
          createdAt
            .toISOString()
            .slice(0, 10),

        time:
          pad(createdAt.getHours()) +
          ":" +
          pad(createdAt.getMinutes()),

        severity:
          severity.charAt(0).toUpperCase() +
          severity.slice(1).toLowerCase(),

        status:
          event.status || "OPEN",

        confidence:
          Math.round(
            confidence * 100
          ),

        recommendation:
          event.recommendation ||
          "Safety intervention recommended."
      };
    });
  }


  // =====================================================
  // CALCULATE REAL DASHBOARD SUMMARY
  // =====================================================

  function buildRealDashboardState(data) {

    var events =
      normalizeBackendEvents(
        data.events
      );

    var criticalEvents =
      events.filter(function (event) {

        return (
          String(event.severity)
            .toUpperCase() ===
          "CRITICAL"
        );

      });

    var warningEvents =
      events.filter(function (event) {

        return (
          String(event.severity)
            .toUpperCase() ===
          "WARNING"
        );

      });


    // -----------------------------------------------
    // Safety score
    // -----------------------------------------------

    var safetyScore = 100;

    if (events.length > 0) {

      safetyScore =
        Math.max(
          0,
          Math.round(
            100 -
            events.length * 10
          )
        );
    }


    // -----------------------------------------------
    // PPE compliance
    // -----------------------------------------------

    var ppeCompliance =
      Math.max(
        0,
        Math.round(
          100 -
          events.length * 8
        )
      );


    // -----------------------------------------------
    // Alerts
    // -----------------------------------------------

    var alerts =
      criticalEvents.slice(0, 10);


    // -----------------------------------------------
    // Violation frequency
    // -----------------------------------------------

    var violationCounts = {};

    events.forEach(function (event) {

      var key =
        event.rawType ||
        event.type;

      if (!violationCounts[key]) {
        violationCounts[key] = 0;
      }

      violationCounts[key]++;
    });


    // -----------------------------------------------
    // Most common violation
    // -----------------------------------------------

    var mostCommonViolation = null;

    Object.keys(violationCounts)
      .forEach(function (key) {

        if (
          !mostCommonViolation ||
          violationCounts[key] >
          violationCounts[
            mostCommonViolation
          ]
        ) {
          mostCommonViolation = key;
        }

      });


    // -----------------------------------------------
    // Zone status
    // -----------------------------------------------

    var zones = ZONES.map(function (zoneName) {

      var zoneEvents =
        events.filter(function (event) {

          return (
            event.location ===
            zoneName
          );

        });

      var zoneCritical =
        zoneEvents.filter(function (event) {

          return (
            String(event.severity)
              .toUpperCase() ===
            "CRITICAL"
          );

        }).length;

      var zoneScore =
        Math.max(
          0,
          100 -
          zoneEvents.length * 15
        );

      return {

        zone:
          zoneName,

        score:
          zoneScore,

        workers:
          0,

        violations:
          zoneEvents.length,

        status:
          zoneCritical > 0
            ? "Critical"
            : zoneEvents.length > 0
              ? "Warning"
              : "Safe"
      };

    });


    // -----------------------------------------------
    // Timeline
    // -----------------------------------------------

    var timeline =
      events
        .slice(0, 10)
        .map(function (event) {

          return {

            time:
              event.time,

            title:
              event.type,

            detail:
              event.camera +
              " - " +
              event.location,

            severity:
              event.severity
          };

        });


    // -----------------------------------------------
    // Decision Intelligence
    // -----------------------------------------------

    var recommendations =
      criticalEvents
        .slice(0, 5)
        .map(function (event) {

          return {

            id:
              "DI-" +
              event.backendId,

            workerId:
              event.workerId,

            zone:
              event.location,

            factors: [
              event.type
            ],

            risk:
              "CRITICAL",

            confidence:
              event.confidence,

            actions: [
              "Notify Supervisor",
              "Record Incident"
            ],

            status:
              event.status,

            source:
              "AwareX Safety Intelligence",

            recommendation:
              event.recommendation
          };

        });


    // -----------------------------------------------
    // Analytics
    // -----------------------------------------------

    var analytics = {

      labels: [
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
        "Sat",
        "Sun"
      ],

      safetyScoreTrend:
        [100, 98, 96, 92, 88, 85, safetyScore],

      ppeComplianceTrend:
        [100, 98, 96, 93, 90, 86, ppeCompliance],

      violationsOverTime:
        [
          0,
          0,
          1,
          1,
          2,
          events.length,
          events.length
        ],

      incidentFrequency:
        [
          0,
          0,
          1,
          1,
          1,
          warningEvents.length,
          criticalEvents.length
        ],

      framesProcessed:
        [0, 0, 0, 0, 0, 0, 0],

      zoneSafety:
        zones
    };


    // -----------------------------------------------
    // Return centralized dashboard state
    // -----------------------------------------------

    return {

      mode:
        "LIVE",

      video:
        null,

      workers:
        [],

      alerts:
        alerts,

      violations:
        events,

      ppeCompliance:
        ppeCompliance,

      safetyScore:
        safetyScore,

      riskDistribution: {

        Low: 0,

        Medium:
          warningEvents.length,

        High: 0,

        Critical:
          criticalEvents.length
      },

      zones:
        zones,

      timeline:
        timeline,

      recommendations:
        recommendations,

      analytics:
        analytics,

      reports:
        [],

      analyzedAt:
        new Date().toISOString(),

      framesProcessed:
        0,

      totalEvents:
        data.total_events || events.length,

      criticalEvents:
        data.critical_events ||
        criticalEvents.length,

      mostCommonViolation:
        mostCommonViolation
    };
  }

  function buildVideoAnalysisState(data, videoMeta) {

    var events = Array.isArray(data.violations) ? data.violations.map(function (event, index) {

      var severity = String(event.severity || "WARNING").toUpperCase();
      var confidence = Number(event.confidence || 0);
      var createdAt = new Date();

      return {
        id: "VIO-" + (index + 1),
        backendId: index + 1,
        workerId: "Unknown Worker",
        type: event.violation || event.type || "Unknown Violation",
        rawType: event.violation || event.type || "unknown",
        location: event.zone || "Unknown Zone",
        camera: event.camera || "Unknown Camera",
        timestamp: createdAt.toISOString(),
        date: createdAt.toISOString().slice(0, 10),
        time: pad(createdAt.getHours()) + ":" + pad(createdAt.getMinutes()),
        severity: severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase(),
        status: event.status || "OPEN",
        confidence: Math.round(confidence * 100) / 100,
        recommendation: event.recommendation || (Array.isArray(data.recommendations) ? data.recommendations[0] : data.recommendation) || "Safety intervention recommended."
      };

    }) : [];

    var criticalEvents = events.filter(function (event) {
      return String(event.severity).toUpperCase() === "CRITICAL";
    });

    var warningEvents = events.filter(function (event) {
      return String(event.severity).toUpperCase() === "WARNING";
    });

    var safetyScore = Number(data.safety_score);
    if (isNaN(safetyScore)) {
      safetyScore = events.length ? Math.max(0, Math.round(100 - events.length * 10)) : 100;
    }

    var ppeCompliance = Math.max(0, Math.round(100 - events.length * 8));

    var alerts = criticalEvents.slice(0, 10);

    var zones = ZONES.map(function (zoneName) {
      var zoneEvents = events.filter(function (event) {
        return event.location === zoneName;
      });
      var zoneCritical = zoneEvents.filter(function (event) {
        return String(event.severity).toUpperCase() === "CRITICAL";
      }).length;
      var zoneScore = Math.max(0, 100 - zoneEvents.length * 15);
      return {
        zone: zoneName,
        score: zoneScore,
        workers: 0,
        violations: zoneEvents.length,
        status: zoneCritical > 0 ? "Critical" : zoneEvents.length > 0 ? "Warning" : "Safe"
      };
    });

    var timeline = events.slice(0, 10).map(function (event) {
      return {
        time: event.time,
        title: event.type,
        detail: event.camera + " - " + event.location,
        severity: event.severity
      };
    });

    var recommendations = Array.isArray(data.recommendations) ? data.recommendations.map(function (text, index) {
      return {
        id: "DI-" + (index + 1),
        workerId: "Unknown Worker",
        zone: events[0] ? events[0].location : "Unknown Zone",
        factors: events.length ? [events[0].type] : [],
        risk: criticalEvents.length ? "CRITICAL" : warningEvents.length ? "HIGH" : "LOW",
        confidence: events.length ? events[0].confidence : 0,
        actions: ["Notify Supervisor", "Record Incident"],
        status: "OPEN",
        source: "AwareX Safety Intelligence",
        recommendation: text
      };
    }) : [];

    var analytics = {
      labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      safetyScoreTrend: [100, 98, 96, 93, 91, 89, safetyScore],
      ppeComplianceTrend: [100, 98, 96, 92, 90, 88, ppeCompliance],
      violationsOverTime: [0, 0, 1, 1, 2, events.length, events.length],
      incidentFrequency: [0, 0, 1, 1, 1, warningEvents.length, criticalEvents.length],
      framesProcessed: [0, 0, 0, 0, 0, 0, data.frames_processed || 0],
      zoneSafety: zones
    };

    // ── Build real worker objects from backend workers_detail ──
    // backend returns: workers (int) + workers_detail (array of tracked worker objects)
    var workerCount = Number(data.workers) || 0;
    var workerDetail = Array.isArray(data.workers_detail) ? data.workers_detail : [];

    var workers = [];
    if (workerDetail.length > 0) {
      // Use the detailed per-worker data from the tracker
      workers = workerDetail.map(function (w) {
        var ppe = w.ppe || {};
        var wViolations = Array.isArray(w.violations) ? w.violations : [];
        var hasHelmet = ppe.helmet !== false;
        var hasVest = ppe.vest !== false;
        var hasGloves = ppe.gloves !== false;
        var hasBoots = ppe.boots !== false;
        var missingCount = (!hasHelmet ? 1 : 0) + (!hasVest ? 1 : 0) + (!hasGloves ? 1 : 0) + (!hasBoots ? 1 : 0);
        var risk = w.risk || (missingCount === 0 ? "Low" : missingCount === 1 ? "Medium" : "High");
        var safetyScoreW = Math.max(38, 100 - missingCount * 15);
        return {
          id: w.id || ("Worker-" + pad(w.track_id || 1)),
          name: "Operator " + (w.id || ("Worker-" + pad(w.track_id || 1))).replace("Worker-", ""),
          shift: "Shift A (06:00-14:00)",
          ppe: {
            helmet: hasHelmet,
            vest: hasVest,
            gloves: hasGloves,
            shoes: hasBoots
          },
          zone: w.zone || "Zone-A",
          movement: "Walking",
          risk: risk,
          safetyScore: safetyScoreW,
          violations: wViolations.length,
          active: w.active !== false,
          lastSeen: pad(new Date().getHours()) + ":" + pad(new Date().getMinutes()),
          confidence: w.confidence || 90
        };
      });
    } else if (workerCount > 0) {
      // Fallback: backend gave a count but no detail — build minimal stubs
      for (var wi = 1; wi <= workerCount; wi++) {
        workers.push({
          id: "Worker-" + pad(wi),
          name: "Operator " + pad(wi),
          shift: "Shift A (06:00-14:00)",
          ppe: { helmet: true, vest: true, gloves: true, shoes: true },
          zone: "Zone-A",
          movement: "Walking",
          risk: "Low",
          safetyScore: 100,
          violations: 0,
          active: true,
          lastSeen: pad(new Date().getHours()) + ":" + pad(new Date().getMinutes()),
          confidence: 90
        });
      }
    }

    return {
      mode: "LIVE",
      video: videoMeta ? {
        name: videoMeta.name,
        size: videoMeta.size,
        duration: videoMeta.duration,
        resolution: videoMeta.resolution,
        fps: videoMeta.fps,
        url: videoMeta.url
      } : (data.video || null),
      workers: workers,
      alerts: alerts,
      violations: events,
      ppeCompliance: ppeCompliance,
      safetyScore: safetyScore,
      riskDistribution: {
        Low: 0,
        Medium: warningEvents.length,
        High: 0,
        Critical: criticalEvents.length
      },
      zones: zones,
      timeline: timeline,
      recommendations: recommendations,
      analytics: analytics,
      reports: [],
      analyzedAt: new Date().toISOString(),
      framesProcessed: data.frames_processed || 0,
      totalEvents: events.length,
      criticalEvents: criticalEvents.length,
      mostCommonViolation: events.length ? events[0].type : null
    };
  }


  // =====================================================
  // AwareX DATA PUBLIC API
  // =====================================================

  var AwareXData = {

    MODE:
      MODE,

    ZONES:
      ZONES,

    VIOLATION_TYPES:
      VIOLATION_TYPES,


    // -----------------------------------------------
    // Central state
    // -----------------------------------------------

    get analysisData() {
      return state;
    },


    // -----------------------------------------------
    // Subscribe
    // -----------------------------------------------

    subscribe:
      function (fn) {

        listeners.push(fn);

        return function () {

          listeners =
            listeners.filter(
              function (f) {
                return f !== fn;
              }
            );

        };
      },


    // -----------------------------------------------
    // Emit
    // -----------------------------------------------

    emit:
      function () {

        listeners.forEach(
          function (fn) {

            try {
              fn(state);
            }

            catch (e) {
              console.error(e);
            }

          }
        );

      },


    // -----------------------------------------------
    // Reset
    // -----------------------------------------------

    reset:
      function () {

        state =
          emptyState();

        this.emit();

        return state;
      },


    // -----------------------------------------------
    // Set state
    // -----------------------------------------------

    setState:
      function (next) {

        state =
          next;

        this.emit();

        return state;
      },


    // -----------------------------------------------
    // Generate demo state
    // -----------------------------------------------

    generateFor:
      function (video) {

        state =
          generate(video);

        this.emit();

        return state;
      },


    // =================================================
    // BACKEND API
    // =================================================

    api: {

      baseUrl:
        API_BASE_URL,

      connected:
        true,


      // ---------------------------------------------
      // Get real dashboard data
      // ---------------------------------------------

      getDashboardData:
        function () {

          return fetch(
            this.baseUrl +
            "/api/dashboard-data"
          )

            .then(function (response) {

              if (!response.ok) {
                throw new Error(
                  "Backend returned HTTP " +
                  response.status
                );
              }

              return response.text();

            })

            .then(function (text) {

              try {
                return JSON.parse(text || "{}");
              } catch (e) {
                throw new Error("Invalid JSON response from backend");
              }

            })

            .then(function (data) {

              if (
                !data ||
                typeof data.success !== "boolean"
              ) {
                throw new Error(
                  "Backend returned invalid response format"
                );
              }

              if (!data.success) {
                throw new Error(
                  "Backend returned unsuccessful response"
                );
              }

              if (!Array.isArray(data.events)) {
                throw new Error(
                  "Backend response missing events list"
                );
              }

              if (data.events.length === 0) {
                console.info(
                  "Backend returned no safety_events; dashboard will show no violations."
                );
              }

              state =
                buildRealDashboardState(
                  data
                );

              AwareXData.api.connected = true;

              AwareXData.emit();

              return state;

            })

            .catch(function (error) {

              AwareXData.api.connected = false;

              console.warn(
                "AwareX backend dashboard data failed:",
                error
              );

              throw error;

            });

        },


      // ---------------------------------------------
      // Analyze image
      // ---------------------------------------------

      analyzeImage:
        function (
          imagePath,
          camera,
          zone
        ) {

          return fetch(
            this.baseUrl +
            "/api/analyze-image",
            {

              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({

                  image_path:
                    imagePath,

                  camera:
                    camera ||
                    "Camera-01",

                  zone:
                    zone ||
                    "Zone-A"

                })

            }
          )

            .then(function (response) {

              if (!response.ok) {

                throw new Error(
                  "AI API returned HTTP " +
                  response.status
                );

              }

              return response.json();

            });

        },


      // ---------------------------------------------
      // Existing compatibility method
      // ---------------------------------------------

      analyzeVideo:
        function (videoMeta) {

          var file = videoMeta && videoMeta.file ? videoMeta.file : videoMeta;

          if (!file || !(file instanceof File)) {
            return this
              .getDashboardData()
              .then(function (data) {
                return data;
              });
          }

          var payload = new FormData();
          payload.append("video", file);
          payload.append("camera", "Camera-01");
          payload.append("zone", "Zone-A");

          return fetch(
            this.baseUrl +
            "/api/analyze",
            {
              method: "POST",
              body: payload
            }
          )
            .then(function (response) {
              if (!response.ok) {
                return response.text().then(function (text) {
                  throw new Error(text || ("AI API returned HTTP " + response.status));
                });
              }
              return response.json();
            })
            .then(function (data) {
              if (!data || data.success !== true) {
                throw new Error(data && data.detail ? data.detail : "AI analysis response invalid.");
              }

              state =
                buildVideoAnalysisState(
                  data,
                  videoMeta
                );

              AwareXData.api.connected = true;

              AwareXData.emit();

              return state;
            })
            .catch(function (error) {
              AwareXData.api.connected = false;
              console.warn("AwareX video analysis failed:", error);
              throw error;
            });

        },


      // ---------------------------------------------
      // Get current analysis
      // ---------------------------------------------

      getAnalysis:
        function () {

          return this
            .getDashboardData();

        },


      // ---------------------------------------------
      // Live session placeholder
      // ---------------------------------------------

      startLiveSession:
        function () {

          return Promise.resolve({

            sessionId:
              "awarex-" +
              Date.now(),

            mode:
              "LIVE"

          });

        },


      // ---------------------------------------------
      // Frame placeholder
      // ---------------------------------------------

      pushFrame:
        function () {

          return Promise.resolve({

            ok:
              true,

            mode:
              "LIVE"

          });

        },


      // ---------------------------------------------
      // Recommendations
      // ---------------------------------------------

      getRecommendations:
        function () {

          return Promise.resolve(
            state.recommendations
          );

        }

    },


    // =================================================
    // MODEL INFORMATION
    // =================================================

    models: [

      {
        key:
          "yolo",

        name:
          "YOLO Object Detection",

        detail:
          "PPE + worker detection",

        status:
          "Connected"
      },

      {
        key:
          "opencv",

        name:
          "OpenCV Pipeline",

        detail:
          "Frame extraction and preprocessing",

        status:
          "Ready"
      },

      {
        key:
          "ml",

        name:
          "ML Risk Model",

        detail:
          "Risk scoring from safety context",

        status:
          "Ready"
      },

      {
        key:
          "tracking",

        name:
          "Worker Tracking",

        detail:
          "Multi-object tracking",

        status:
          "Ready"
      },

      {
        key:
          "di",

        name:
          "Decision Intelligence",

        detail:
          "Recommendation and action engine",

        status:
          "Connected"
      }

    ]

  };


  // =====================================================
  // EXPORT
  // =====================================================

  global.AwareXData =
    AwareXData;


  // =====================================================
  // INITIAL REAL DATA LOAD
  // =====================================================

  AwareXData.api
    .getDashboardData()
    .catch(function (error) {

      console.warn(
        "AwareX backend unavailable. Using demo state.",
        error
      );

    });


})(window);