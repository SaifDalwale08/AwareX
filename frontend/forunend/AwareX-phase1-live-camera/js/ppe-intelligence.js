/* =========================================================
   AwareX - PPE Intelligence Engine (Phase 2)
   Multi-frame temporal validation.
   Determines whether PPE is: WORN | POSSIBLY CARRIED |
   NOT DETECTED | UNCERTAIN
   =========================================================
   DESIGN RULES:
   - Never concludes "compliant" from a single uncertain frame.
   - Uses a rolling frame buffer per tracked worker.
   - Decision requires temporal consistency across N frames.
   - Position heuristics: PPE bbox relative to worker bbox
     determines worn vs. carried vs. uncertain.
   ========================================================= */

(function (global) {
  "use strict";

  // -------------------------------------------------------
  // CONSTANTS
  // -------------------------------------------------------

  /** How many consecutive frames must agree before a decision is final. */
  var CONFIRMATION_FRAMES = 5;

  /** Minimum confidence for a detection to count toward a decision. */
  var MIN_CONFIDENCE = 0.55;

  /**
   * PPE item vertical position thresholds relative to worker bounding box.
   * Worker bbox is normalised to [0, 1] top-to-bottom.
   * head_zone: above 0.25 of worker height → likely worn on head
   * torso_zone: 0.2 – 0.6 → likely worn on torso
   * lower_zone: > 0.6 → possibly carried / in hand
   */
  var ZONES = {
    head: { min: 0, max: 0.28 },
    torso: { min: 0.2, max: 0.65 },
    lower: { min: 0.55, max: 1.0 }
  };

  // -------------------------------------------------------
  // STATUS CONSTANTS (exported on AwareXPPE)
  // -------------------------------------------------------

  var STATUS = {
    WORN: "WORN",
    POSSIBLY_CARRIED: "POSSIBLY CARRIED",
    NOT_DETECTED: "NOT DETECTED",
    UNCERTAIN: "UNCERTAIN"
  };

  // -------------------------------------------------------
  // WORKER FRAME BUFFERS
  // Key: workerId, Value: { helmet: Frame[], vest: Frame[], ... }
  // -------------------------------------------------------

  var _buffers = {};

  /** @typedef {{ confidence: number, position: string|null, timestamp: number }} Frame */

  function _getBuffer(workerId) {
    if (!_buffers[workerId]) {
      _buffers[workerId] = {
        helmet: [],
        vest: [],
        gloves: [],
        shoes: []
      };
    }
    return _buffers[workerId];
  }

  function _trimBuffer(arr) {
    // Keep only the last CONFIRMATION_FRAMES * 2 entries to limit memory.
    var limit = CONFIRMATION_FRAMES * 2;
    if (arr.length > limit) {
      arr.splice(0, arr.length - limit);
    }
  }

  // -------------------------------------------------------
  // POSITION CLASSIFIER
  // Given normalised PPE bbox center-y relative to worker
  // bbox, decide if it is in the expected zone for that item.
  // -------------------------------------------------------

  /**
   * @param {string} ppeType  "helmet" | "vest" | "gloves" | "shoes"
   * @param {number|null} relativeY  0 = worker top, 1 = worker bottom, null = unknown
   * @returns {"expected"|"unexpected"|"unknown"}
   */
  function _classifyPosition(ppeType, relativeY) {
    if (relativeY === null || relativeY === undefined) return "unknown";

    switch (ppeType) {
      case "helmet":
        // Head zone ≤ 0.28
        if (relativeY <= ZONES.head.max) return "expected";
        if (relativeY >= ZONES.lower.min) return "unexpected"; // likely in hand
        return "unknown";

      case "vest":
        // Torso zone 0.2 – 0.65
        if (relativeY >= ZONES.torso.min && relativeY <= ZONES.torso.max) return "expected";
        if (relativeY > ZONES.torso.max) return "unexpected";
        return "unknown";

      case "gloves":
        // Gloves can appear in lower half (0.5 – 1.0)
        if (relativeY >= 0.5) return "expected";
        return "unknown";

      case "shoes":
        // Shoes should be near bottom (≥ 0.75)
        if (relativeY >= 0.75) return "expected";
        if (relativeY < 0.5) return "unexpected"; // floating near top
        return "unknown";

      default:
        return "unknown";
    }
  }

  // -------------------------------------------------------
  // SINGLE FRAME ANALYSIS
  // Returns a raw per-item decision for one frame.
  // -------------------------------------------------------

  /**
   * @param {string} ppeType
   * @param {object} detection  { detected: bool, confidence: number, relativeY: number|null }
   * @returns {Frame}
   */
  function _analyseFrame(ppeType, detection) {
    var detected = !!detection.detected;
    var confidence = Number(detection.confidence || 0);
    var relativeY = detection.relativeY !== undefined ? detection.relativeY : null;

    var position = null;

    if (detected && confidence >= MIN_CONFIDENCE) {
      var posClass = _classifyPosition(ppeType, relativeY);
      if (posClass === "expected") {
        position = "worn";
      } else if (posClass === "unexpected") {
        position = "carried";
      } else {
        position = "uncertain";
      }
    } else if (detected && confidence < MIN_CONFIDENCE) {
      // Detected but low confidence — treat as uncertain presence
      position = "uncertain";
    }
    // else: not detected → position stays null

    return {
      detected: detected,
      confidence: confidence,
      position: position,
      timestamp: Date.now()
    };
  }

  // -------------------------------------------------------
  // TEMPORAL DECISION ENGINE
  // Given the rolling frame buffer, produce a final status.
  // -------------------------------------------------------

  /**
   * @param {Frame[]} frames
   * @returns {{ status: string, confidence: number, reason: string }}
   */
  function _temporalDecision(frames) {

    if (!frames || frames.length === 0) {
      return { status: STATUS.NOT_DETECTED, confidence: 0, reason: "No frames observed" };
    }

    // Use only the most recent CONFIRMATION_FRAMES frames
    var recent = frames.slice(-CONFIRMATION_FRAMES);

    var wornCount = 0;
    var carriedCount = 0;
    var uncertainCount = 0;
    var notDetectedCount = 0;
    var totalConfidence = 0;

    recent.forEach(function (f) {
      if (f.position === "worn") { wornCount++; totalConfidence += f.confidence; }
      else if (f.position === "carried") { carriedCount++; totalConfidence += f.confidence; }
      else if (f.position === "uncertain") { uncertainCount++; totalConfidence += (f.confidence || 0); }
      else { notDetectedCount++; }
    });

    var avgConf = recent.length > 0 ? Math.round((totalConfidence / recent.length) * 100) : 0;
    var needed = Math.min(CONFIRMATION_FRAMES, recent.length);
    var majority = Math.ceil(needed * 0.6); // 60% majority required

    // ----- Decision priority -----

    // 1. WORN: majority of recent frames show worn + high confidence
    if (wornCount >= majority && avgConf >= 60) {
      return {
        status: STATUS.WORN,
        confidence: avgConf,
        reason: wornCount + "/" + recent.length + " frames confirm worn position"
      };
    }

    // 2. POSSIBLY CARRIED: carried frames dominate
    if (carriedCount >= majority) {
      return {
        status: STATUS.POSSIBLY_CARRIED,
        confidence: avgConf,
        reason: carriedCount + "/" + recent.length + " frames suggest carried/held position"
      };
    }

    // 3. NOT DETECTED: clear absence across frames
    if (notDetectedCount >= majority) {
      return {
        status: STATUS.NOT_DETECTED,
        confidence: 0,
        reason: "PPE not present in " + notDetectedCount + "/" + recent.length + " frames"
      };
    }

    // 4. UNCERTAIN: mixed or insufficient frames
    return {
      status: STATUS.UNCERTAIN,
      confidence: avgConf,
      reason: "Mixed signals across " + recent.length + " frames — manual verification required"
    };
  }

  // -------------------------------------------------------
  // PUBLIC API
  // -------------------------------------------------------

  /**
   * Push a new set of PPE observations for a worker (one video frame).
   *
   * @param {string} workerId
   * @param {object} observations  Map of PPE type → detection object
   *   e.g. { helmet: { detected: true, confidence: 0.92, relativeY: 0.12 },
   *           vest:   { detected: true, confidence: 0.88, relativeY: 0.42 },
   *           gloves: { detected: false, confidence: 0, relativeY: null },
   *           shoes:  { detected: true, confidence: 0.75, relativeY: 0.88 } }
   */
  function pushFrame(workerId, observations) {
    if (!workerId || !observations) return;
    var buf = _getBuffer(workerId);

    ["helmet", "vest", "gloves", "shoes"].forEach(function (ppeType) {
      var det = observations[ppeType] || { detected: false, confidence: 0, relativeY: null };
      var frame = _analyseFrame(ppeType, det);
      buf[ppeType].push(frame);
      _trimBuffer(buf[ppeType]);
    });
  }

  /**
   * Get the current PPE intelligence decision for a worker.
   *
   * @param {string} workerId
   * @returns {object}  Map of PPE type → { status, confidence, reason }
   */
  function getDecision(workerId) {
    var buf = _getBuffer(workerId);
    var result = {};
    ["helmet", "vest", "gloves", "shoes"].forEach(function (ppeType) {
      result[ppeType] = _temporalDecision(buf[ppeType]);
    });
    return result;
  }

  /**
   * Get combined compliance status for a worker.
   * A worker is COMPLIANT only if ALL required items are WORN.
   * Any UNCERTAIN item blocks a positive compliance decision.
   *
   * @param {string} workerId
   * @param {string[]} [required]  PPE items required (defaults to all four)
   * @returns {{ compliant: boolean|null, summary: string, items: object }}
   *   compliant: true = compliant, false = violation, null = uncertain
   */
  function getComplianceStatus(workerId, required) {
    var req = required || ["helmet", "vest", "gloves", "shoes"];
    var decision = getDecision(workerId);
    var hasUncertain = false;
    var hasViolation = false;

    req.forEach(function (item) {
      var d = decision[item];
      if (!d) return;
      if (d.status === STATUS.UNCERTAIN) hasUncertain = true;
      if (d.status === STATUS.NOT_DETECTED || d.status === STATUS.POSSIBLY_CARRIED) hasViolation = true;
    });

    var compliant, summary;

    if (hasViolation) {
      compliant = false;
      summary = "PPE VIOLATION DETECTED";
    } else if (hasUncertain) {
      compliant = null; // Cannot determine
      summary = "PPE STATUS UNCERTAIN — MANUAL VERIFICATION REQUIRED";
    } else {
      compliant = true;
      summary = "PPE COMPLIANT";
    }

    return { compliant: compliant, summary: summary, items: decision };
  }

  /**
   * Reset the frame buffer for a specific worker (e.g. on scene change).
   * @param {string} workerId
   */
  function resetWorker(workerId) {
    if (_buffers[workerId]) delete _buffers[workerId];
  }

  /**
   * Reset all buffers (e.g. on new video/session start).
   */
  function resetAll() {
    _buffers = {};
  }

  /**
   * Simulate PPE observations for a worker given the existing boolean PPE
   * data from the dashboard demo state.  Used when no real frame data exists.
   *
   * @param {object} worker   AwareX worker object with .ppe booleans
   * @param {number} [frames] Number of simulated frames to push (default 8)
   */
  function simulateFromWorker(worker, frames) {
    if (!worker || !worker.id || !worker.ppe) return;
    var count = frames || 8;
    resetWorker(worker.id);

    for (var i = 0; i < count; i++) {
      var obs = {};
      ["helmet", "vest", "gloves", "shoes"].forEach(function (item) {
        var hasItem = worker.ppe[item];
        // For worn items, simulate a realistic worn position detection.
        // For missing items, simulate not-detected with occasional low-conf noise.
        if (hasItem) {
          var relY = item === "helmet" ? 0.12 + (Math.random() * 0.08)
            : item === "vest" ? 0.35 + (Math.random() * 0.15)
            : item === "gloves" ? 0.62 + (Math.random() * 0.12)
            : 0.82 + (Math.random() * 0.1); // shoes

          obs[item] = {
            detected: true,
            confidence: 0.78 + Math.random() * 0.18,
            relativeY: relY
          };
        } else {
          // Not wearing — occasionally inject a low-confidence carried detection
          var lowConfDetection = Math.random() < 0.25;
          obs[item] = {
            detected: lowConfDetection,
            confidence: lowConfDetection ? 0.35 + Math.random() * 0.25 : 0,
            // If a low-conf detection, put it in lower/hand zone to simulate carried
            relativeY: lowConfDetection ? 0.65 + Math.random() * 0.25 : null
          };
        }
      });
      pushFrame(worker.id, obs);
    }
  }

  /**
   * Get the CSS chip class and label for a PPE status string.
   * Uses the existing ax-chip palette.
   */
  function statusChip(status) {
    switch (status) {
      case STATUS.WORN:
        return { cls: "ax-chip--ok", label: "WORN" };
      case STATUS.POSSIBLY_CARRIED:
        return { cls: "ax-chip--medium", label: "POSSIBLY CARRIED" };
      case STATUS.NOT_DETECTED:
        return { cls: "ax-chip--critical", label: "NOT DETECTED" };
      case STATUS.UNCERTAIN:
      default:
        return { cls: "ax-chip--high", label: "UNCERTAIN" };
    }
  }

  // -------------------------------------------------------
  // EXPORT
  // -------------------------------------------------------

  global.AwareXPPE = {
    STATUS: STATUS,
    CONFIRMATION_FRAMES: CONFIRMATION_FRAMES,
    pushFrame: pushFrame,
    getDecision: getDecision,
    getComplianceStatus: getComplianceStatus,
    resetWorker: resetWorker,
    resetAll: resetAll,
    simulateFromWorker: simulateFromWorker,
    statusChip: statusChip
  };

})(window);
