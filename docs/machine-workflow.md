# CablePrep — Machine Workflow & State Table

**Owner:** Person 1 — Engineering / Control (virtual machine logic)
**Module files covered:** `js/sensors.js`, `js/machine.js`, `js/simulation.js`
**Document version:** v0.1.1 (Phase 1 design; alignment-roller correction applied in Phase 3)
**Status:** Draft for review

---

## 0. Disclaimer — read this first

* CablePrep is a **software-based virtual prototype**. No physical machine has been built.
* Nothing in this document claims **IS 10810 compliance**. IS 10810 (or whichever official
  standard is finally chosen) may *guide* the process, but every dimension, tolerance, speed
  and time value in this project is a **simulation assumption** until it is verified against the
  official standard text by the team.
* All numeric values live in one configuration object (`MACHINE_CONFIG`) so they can be replaced
  with verified engineering data later without rewriting the machine logic.

---

## 1. What this document is for

This document is the **contract between the person thinking about the machine and the person
writing the code.** Before writing a single line of JavaScript we must agree on:

1. What steps the machine performs, and in what order.
2. What "state" the machine is in at each moment.
3. What must be *true* before the machine is allowed to leave a state.
4. What can go wrong in each state, and what the machine does when it does.

If this document is wrong, the code will be wrong in a very consistent, very confusing way.
So: document first, code second.

---

## 2. Glossary (plain language)

| Term | Simple meaning |
|---|---|
| **Sensor** | An "eye" of the machine. It only *reports* a value. It never moves anything. |
| **Actuator** | A "muscle" of the machine. It *does* something. Example: feed motor ON = cable moves. |
| **State** | The single word describing what the machine is busy doing right now, e.g. `FEEDING`. The machine is in **exactly one** state at a time. |
| **State machine** | A controller that may change its state only when the rules say it may. It cannot skip or invent steps. |
| **Transition** | A legal move from one state to another. |
| **Entry condition** | What must be true for the machine to *enter* a state. |
| **Exit condition** | What must be true for the machine to *leave* a state. |
| **Interlock** | A safety rule that *forbids* motion. If the guard door is open, the machine may not move. |
| **Encoder** | A sensor that counts how much something rotated/moved. Fine position reading, used to confirm the coarse position sensor. |
| **Tolerance** | The allowed band around a target, e.g. target 250 mm with tolerance ±2 mm → 248 to 252 mm is acceptable. |
| **Timeout** | "If this step has not finished within this much simulated time, declare it failed." Stops the machine waiting forever. |
| **Latched** | A flag that stays true until a human clears it. Emergency stop is latched. |
| **Specimen** | The piece of cable insulation/sheath that was cut and prepared for testing. |
| **Machine tick** | One small step of the simulation — our "clock". Everything happens on a tick. |
| **machineData** | The single plain object Person 1 produces and Person 2's HMI reads. The only public output of our module. |

---

## 3. Overall process flow (source of truth: project brief)

```
START
  ↓
Select Standard / Material / Specimen Type / Quantity
  ↓
System Initialization
  ↓
Check Sensors & Safety Interlocks
  ↓
Cable Detection
  ↓
Cable Feeding
  ↓
Alignment / Straightening
  ↓
Length Measurement
  ↓
Cutting
  ↓
Insulation / Sheath Preparation
  ↓
Specimen Formation
  ↓
Machine Vision / Dimensional Inspection
  ↓
PASS or REJECT
  ↓
Store Result
  ↓
Generate Test / Batch Report
  ↓
END
```

This maps one-to-one onto the states in Section 6. "Generate report" is **out of our scope**
(Person 2 / HMI). We only guarantee that the result data is available and correct.

---


## 4. How a state machine actually works (mental model)

A state machine is just three things:

1. **currentState** — one word.
2. **sensors** — what the eyes are reading.
3. **rules** — for the current state: may I stay, or may I move on?

Every simulation tick the controller does the same four steps, in this order:

```
tick():
  1. readSensors()      → eyes update (cable present? position? aligned?)
  2. scanForFaults()    → if something dangerous is true → go to FAULT immediately
  3. runStateAction()   → muscles of the current state (motor on, cutter on…)
  4. evaluateExit()     → check this state's exit condition
                            TRUE  → run exitAction(), go to nextState
                            FALSE → stay, and tick again
```

Three rules we must never break:

* **A state may only go to states listed in Section 7.** No skipping — we can never jump from
  `FEEDING` straight to `CUTTING`.
* **The fault scan runs before the action.** Safety beats progress.
* **Every "wait until…" exit condition needs a timeout.** Waiting for alignment must not be able
  to hang forever; after `alignmentTimeoutMs` the machine declares a fault instead of waiting.

---

## 5. The cycle in words

1. **IDLE** — safe, everything off, waiting for Start.
2. **INITIALIZING** — clears old flags, zeroes encoder/position, homes the specimen axis,
   self-tests sensors, checks the safety interlock.
3. **CABLE_DETECTED** — cable-presence sensor confirms a cable is loaded. A *short decision
   state*: it latches "cable present = true" and computes the feed target from the current
   configuration. No actuator runs here.
4. **FEEDING** — feed motor and rollers ON. The cable *actually moves*; position and encoder
   increase every tick.
5. **ALIGNING** — feed motor OFF. Cable is straightened; the alignment sensor must report
   "aligned" for several consecutive ticks before we trust it.
6. **MEASURING** — confirms the cable is at the cutting position and measures the length that
   will be cut, comparing it against the commanded length.
7. **CUTTING** — cutter ON for a fixed stroke time, then OFF. The piece is severed.
8. **PREPARING** — preparation mechanism strips/peels insulation or sheath to the configured
   preparation length. The preparation sensor confirms completion.
9. **FORMING** — specimen movement transfers the prepared piece to the forming/inspection station
   and clamps it.
10. **INSPECTING** — vision system measures length, width, thickness, shape and compares each
    against the configured acceptable range.
11. **ACCEPT or REJECT** — verdict stored with the measured values and, for a reject, the
    reason(s).
12. **COMPLETE** — actuators OFF, axes home, cycle counter incremented.
13. **FAULT** — abnormal situation: safe stop, reason stored, reset required.

---

## 6. State list

These are the states given in the project brief. They are sufficient — I am deliberately **not**
inventing extra states (see Decision **D1**, Section 14).

| # | State | Type | Actuator active here | Purpose in one line |
|---|---|---|---|---|
| 1 | `IDLE` | Idle | none | Safe, waiting for Start. |
| 2 | `INITIALIZING` | Main | specimen axis (homing) | Self-check, zero counters, verify safety. |
| 3 | `CABLE_DETECTED` | Decision | none | Latch cable presence, compute feed target. |
| 4 | `FEEDING` | Main | feed motor, feed rollers | Move cable to the alignment position. |
| 5 | `ALIGNING` | Main | feed rollers (align mode) | Straighten cable until alignment sensor agrees. |
| 6 | `MEASURING` | Main | none (measuring head) | Verify length and cut position before cutting. |
| 7 | `CUTTING` | Main | cutter | Sever the specimen. |
| 8 | `PREPARING` | Main | preparation mechanism | Strip / peel insulation or sheath. |
| 9 | `FORMING` | Main | specimen movement | Move and clamp the specimen at the inspection station. |
| 10 | `INSPECTING` | Main | vision system | Measure and judge the specimen. |
| 11 | `ACCEPT` | Result | specimen movement (brief) | Store PASS record, move specimen to output. |
| 12 | `REJECT` | Result | specimen movement (brief) | Store REJECT record + reasons, reject tray. |
| 13 | `COMPLETE` | Main | none (return home) | Close the cycle, ready for the next one. |
| 14 | `FAULT` | Fault | **all forced OFF** | Safe stop with stored reason; reset required. |

---


## 7. Master state table

**How to read this table**

* **Entry Condition** — what must be true *before* the machine is allowed to enter the state.
* **Action** — what the actuators do *while* the machine is in this state (what a human would
  hear or see happening).
* **Sensors** — which of the 8 sensors are read/required in this state.
* **Exit Condition** — what must be true for the machine to leave. If it never becomes true,
  the state's timeout fires and the machine faults.
* **Possible Fault** — the fault codes this state can raise (defined in Section 9).
* **Next State** — the only legal destinations.

Every value written as `config.*` comes from `MACHINE_CONFIG` and is a **simulation
assumption** until verified against the official standard.

### 7.1 Part A — States 1 to 7

| State | Entry Condition | Action | Sensors | Exit Condition | Possible Fault | Next State |
|---|---|---|---|---|---|---|
| **IDLE** | Machine powered on, previous cycle finished, or a `reset()` was completed. Fault latch is clear. | All actuators forced OFF. Zero `position`, `encoder`, timers. Poll safety only. | Safety interlock; (all others forced to a defined idle value) | A `start()` command was received **AND** the safety interlock reads OK **AND** no fault is latched. | `INTERLOCK_OPEN` (Start pressed while unsafe); `ESTOP_LATCHED` (E-stop pressed while idle) | `INITIALIZING` on valid Start → `FAULT` if E-stop is latched or interlock is open |
| **INITIALIZING** | Valid `start()` from IDLE. | Run actuator self-check; home the specimen axis (specimen movement ON → OFF at home sensor); zero `encoder` and `position`; clear all per-cycle flags; read safety interlock. | Safety interlock; encoder; specimen home position; all sensor self-test bits | Safety interlock = OK **AND** all self-test bits healthy **AND** axis homing complete. | `INTERLOCK_OPEN`; `SENSOR_FAILURE` (any self-test bit bad); `ESTOP_ACTIVE`; `HOMING_TIMEOUT` | `CABLE_DETECTED` if all checks pass → `FAULT` on any fault |
| **CABLE_DETECTED** | Initialization complete. | Wait for a stable cable-present reading: the cable detection sensor must read `true` for `config.cableDetectStableTicks` consecutive ticks. Compute `feedTarget = config.feedDistanceMm`. | Cable detection sensor; safety interlock | Cable detection = stable `true`. | `CABLE_NOT_DETECTED` (stable `false` for longer than `config.cableDetectTimeoutMs`); `SENSOR_FAILURE` | `FEEDING` when cable confirmed → `FAULT` on timeout/failure |
| **FEEDING** | Cable confirmed present and feed target computed. | **Feed motor ON, feed rollers ON.** Each tick: `speed = config.feedSpeedMmPerSec`; `position += speed * dt`; `encoder += pulses from config.encoderPulsesPerMm`. Stop when target reached. | Encoder; position sensor; cable detection; safety interlock | `position >= config.feedDistanceMm` (within one tick of overshoot) **AND** encoder agrees with position within `config.encoderToleranceMm`. | `CABLE_LOST` (detection goes false mid-feed); `ENCODER_MISMATCH`; `FEED_TIMEOUT`; `INTERLOCK_OPEN`; `ESTOP_ACTIVE` | `ALIGNING` when feed target reached → `FAULT` on any fault |
| **ALIGNING** | Feed target reached; feed motor OFF. | Feed rollers ON in align mode. Apply a small deterministic corrective jog (back and forth within `config.alignJogMm`) until the alignment sensor reads true. Then hold steady and re-verify. | Alignment sensor; position sensor; encoder; safety interlock | Alignment sensor = `true` for `config.alignStableTicks` consecutive ticks **AND** the cable is still detected. | `MISALIGNMENT` (not aligned within `config.alignmentTimeoutMs`); `CABLE_LOST`; `INTERLOCK_OPEN`; `ESTOP_ACTIVE` | `MEASURING` when alignment confirmed → `FAULT` on timeout/failure |
| **MEASURING** | Cable aligned and stable. | Feed rollers OFF. Record the cut position; move the measuring head to the configured measuring station and take a length reading. Compare measured length against target ± `config.lengthToleranceMm`. | Position sensor; encoder; cut position sensor; alignment sensor; safety interlock | Measured length within tolerance **AND** cut position sensor = `cutPositionReady` true. | `LENGTH_OUT_OF_TOLERANCE` (measured length outside the configured band); `SENSOR_FAILURE` (cut position sensor stuck or disagreeing); `ESTOP_ACTIVE` | `CUTTING` when both checks pass → `FAULT` on fault. *(Decision D2: an out-of-tolerance length is a FAULT, not a REJECT — see Section 14.)* |
| **CUTTING** | Length verified and cut position ready. | Safety interlock check (cutter guard closed), then **Cutter ON** for `config.cutterStrokeMs`, then **Cutter OFF**. Feed rollers OFF for the whole state (the cable must not move while being cut). Increment `cutCount`. | Cut position sensor; safety interlock; cutter feedback (simulated) | Cutter stroke completed (elapsed ≥ `cutterStrokeMs`) **AND** the severed-piece flag is set by the cutter actuator (deterministic — no randomness, no probability value) **AND** safety OK. | `CUTTING_FAILURE` (stroke completed but cut not confirmed, or cutter did not complete the stroke); `INTERLOCK_OPEN`; `ESTOP_ACTIVE` | `PREPARING` when cut confirmed → `FAULT` on any fault |

---


### 7.2 Part B — States 8 to 14

| State | Entry Condition | Action | Sensors | Exit Condition | Possible Fault | Next State |
|---|---|---|---|---|---|---|
| **PREPARING** | Cut confirmed. | Preparation mechanism ON for `config.preparationDurationMs` (strip / peel the insulation or sheath to `config.preparationDepthMm`). Mechanism OFF at the end. | Preparation sensor; position sensor; safety interlock | Preparation sensor = `preparationComplete` true **AND** preparation duration elapsed. | `PREPARATION_FAILURE` (mechanism ran but sensor did not confirm within `config.preparationTimeoutMs`); `SENSOR_FAILURE`; `ESTOP_ACTIVE` | `FORMING` when preparation confirmed → `FAULT` on timeout/failure |
| **FORMING** | Preparation complete. | Specimen movement ON: move the severed specimen from the cutter to the forming station, hold for `config.formingDwellMs`, clamp, then move to the vision station. Movement OFF on arrival. | Position sensor; specimen at-station flag; safety interlock | Specimen at vision station (`atStation = true`) and clamped, after `config.formingDwellMs`. | `SPECIMEN_NOT_PLACED` (did not reach the station in time); `SENSOR_FAILURE`; `INTERLOCK_OPEN`; `ESTOP_ACTIVE` | `INSPECTING` when specimen placed → `FAULT` on timeout/failure |
| **INSPECTING** | Specimen placed and clamped at the vision station. | Vision system ON. Measure `length`, `width`, `thickness`, and evaluate `shapeOK`. Each measured value is compared against its configured min/max range. | Vision system; preparation sensor (cross-check); safety interlock | Vision measurement finished (all values non-`null`). No timeout here — if the vision system itself fails it raises a fault instead of timing out. | `VISION_FAILURE` (vision produced no reading or reported an internal error — a machine fault, not a product reject) | `ACCEPT` if every value is inside its range → `REJECT` if any value is outside → `FAULT` on `VISION_FAILURE` |
| **ACCEPT** | Inspection complete and every value inside the configured range. | Specimen movement ON briefly to move the accepted specimen to the out-tray, then OFF. Store the result record with all measured values and `result = "PASS"`. | Vision system; position sensor; safety interlock | Result stored **AND** specimen delivered to the out-tray. | `RESULT_STORE_FAILURE`; `ESTOP_ACTIVE` | `COMPLETE` when stored → `FAULT` on store failure |
| **REJECT** | Inspection complete and at least one value outside its configured range. | Build the rejection reason list (e.g. `"Thickness outside configured range (1.42 mm, allowed 1.50-2.00 mm)"`). Store the record with `result = "REJECT"` and the reasons. Specimen movement ON briefly to move the specimen to the reject tray, then OFF. | Vision system; position sensor; safety interlock | Result stored **AND** specimen delivered to the reject tray. | `RESULT_STORE_FAILURE`; `ESTOP_ACTIVE` | `COMPLETE` when stored → `FAULT` on store failure |
| **COMPLETE** | Result stored (PASS or REJECT). | All actuators forced OFF. Return axes to home. Increment `cycleCount`, add the result to the batch record, clear per-cycle flags. | Safety interlock; (all others passivated) | Cycle end acknowledged — batch finished, or the operator/HMI requests the next specimen. | `ESTOP_ACTIVE` (checked continuously); `INTERLOCK_OPEN` | `IDLE` when cycle closed → `INITIALIZING` directly if the next specimen is auto-started |
| **FAULT** | Any fault raised by any state, **or** an emergency stop was activated. | **All actuators immediately forced OFF (safe stop).** Motion frozen. Store `fault = { code, message, stateAtFault, timestamp, sensorSnapshot }`. Set `faultLatched = true` and `requiresReset = true`. No automatic continuation — no tick may move the machine out of this state. | Safety interlock; E-stop latch; (frozen snapshot of all sensors) | **Only** an explicit `reset()` command, and only if the root cause is cleared. No automatic exit exists. | `RESET_BLOCKED` (reset pressed while the cause still exists, e.g. cable still missing, interlock still open) — stays in FAULT | `IDLE` after a successful `reset()` |

---


## 8. Transition diagram (text version)

```
                     ┌──────────────────────────────────────────┐
                     │                                          │
                     ▼                                          │
                  ┌──────┐   start()   ┌──────────────┐  OK   ┌────────────────┐
  power on ──────▶│ IDLE │────────────▶│ INITIALIZING │──────▶│ CABLE_DETECTED │
                  └──────┘             └──────────────┘       └────────────────┘
                     ▲                    │     ▲                       │
                     │                    │     │ fault                 │ cable stable
                     │                    ▼     │                       ▼
                     │                ┌────────┐  │                 ┌───────────┐
                     │                │ FAULT  │──┘                 │  FEEDING  │
                     │                └────────┘                    └───────────┘
                     │                     ▲                          │       │
                     │                     │ any fault                │       │ target
                     │                     │                          │       │ reached
                     │                     │                          ▼       │
                     │                ┌────────┐  stable     ┌───────────┐    │
                     │                │ REJECT │◀───────────│ INSPECTING│◀───┤
                     │                └────────┘  all in    └───────────┘     │
                     │                     ▲     range         │      │       │
                     │                     │                    │      │ target│
                     │                ┌────────┐               │      │ reached
                     │                │ ACCEPT │◀──────────────┤      ▼
                     │                └────────┘               │ ┌────────────┐
                     │                     │ result stored      │ │  ALIGNING  │
                     │                     ▼                    │ └────────────┘
                     │                ┌──────────┐             │      │ aligned
                     └────────────────│ COMPLETE │◀────────────┘      ▼
                                          └──────────┘              ┌───────────┐
                                                                    │ MEASURING │
                                                                    └───────────┘
                                                                          │ length OK
                                                                          ▼
                                                                    ┌──────────┐
                                                                    │ CUTTING  │
                                                                    └──────────┘
                                                                          │ cut OK
                                                                          ▼
                                                                    ┌────────────┐
                                                                    │ PREPARING  │
                                                                    └────────────┘
                                                                          │ prep OK
                                                                          ▼
                                                                    ┌───────────┐
                                                                    │  FORMING  │
                                                                    └───────────┘
```

---


## 9. Fault code table

Every fault has a stable `code`, a human-readable `message`, and a **severity**. All faults in
this prototype are critical: they stop the machine and require a reset.

| Code | Message | Severity | Raised in state(s) | Machine action |
|---|---|---|---|---|
| `CABLE_NOT_DETECTED` | No cable detected at the loading station | CRITICAL | `CABLE_DETECTED` | All actuators OFF, store, wait for reset |
| `CABLE_LOST` | Cable lost during feeding | CRITICAL | `FEEDING`, `ALIGNING` | Feed motor OFF immediately, wait for reset |
| `MISALIGNMENT` | Cable could not be aligned within the allowed time | CRITICAL | `ALIGNING` | Feed rollers OFF, wait for reset |
| `LENGTH_OUT_OF_TOLERANCE` | Measured cut length is outside the configured tolerance band | CRITICAL | `MEASURING` | All actuators OFF, wait for reset |
| `SENSOR_FAILURE` | A sensor reported a failure or an implausible value | CRITICAL | any state | All actuators OFF, wait for reset |
| `INTERLOCK_OPEN` | Safety interlock is not satisfied (guard/door/E-stop) | CRITICAL | any state | Immediate safe stop, wait for reset |
| `CUTTING_FAILURE` | Cutter did not complete the cut | CRITICAL | `CUTTING` | Cutter OFF, wait for reset |
| `PREPARATION_FAILURE` | Preparation stage did not complete | CRITICAL | `PREPARING` | Preparation mechanism OFF, wait for reset |
| `SPECIMEN_NOT_PLACED` | Specimen did not reach the vision station | CRITICAL | `FORMING` | Specimen movement OFF, wait for reset |
| `VISION_FAILURE` | Vision system failed to produce a measurement | CRITICAL | `INSPECTING` | Vision OFF, wait for reset |
| `ENCODER_MISMATCH` | Encoder and position sensor disagree | CRITICAL | `FEEDING` | Feed motor OFF, wait for reset |
| `FEED_TIMEOUT` | Cable did not reach the feed target within the allowed time (motor stalled or sensor stuck) | CRITICAL | `FEEDING` | Feed motor OFF, wait for reset |
| `HOMING_TIMEOUT` | Specimen axis did not reach the home position within the allowed time | CRITICAL | `INITIALIZING` | Specimen movement OFF, wait for reset |
| `ESTOP_ACTIVE` | Emergency stop was activated | CRITICAL (latched) | any state | Immediate safe stop of **every** actuator, wait for reset |
| `RESET_BLOCKED` | Reset refused because the cause still exists | (stays in FAULT) | `FAULT` | None — machine remains in FAULT |

**Important:** `REJECT` is **not** a fault. It is a normal, successful machine outcome — the
machine worked correctly and correctly discovered a bad specimen. This distinction matters for the
report: a *fault* means the machine failed; a *reject* means the machine did its job.

---

## 10. Emergency stop rules

Emergency stop is **not a normal transition**. It is an override that can happen in any state,
at any tick, and it takes priority over everything else.

When `emergencyStop()` is called:

1. Feed motor → OFF
2. Feed rollers → OFF
3. Cutter → OFF
4. Preparation mechanism → OFF
5. Specimen movement → OFF
6. State → `FAULT`
7. `fault = { code: "ESTOP_ACTIVE", ... }`, `estopLatched = true`, `requiresReset = true`
8. All position/encoder values are **frozen** where they are (we do not pretend the cable went back)
9. No tick may leave `FAULT` on its own. The HMI must not be able to "resume" from E-stop.

`reset()` refuses to run while `estopLatched` is true unless the caller explicitly releases the
E-stop first (`releaseEmergencyStop()`), exactly like turning the mushroom button and then
pressing reset on a real machine.

---


## 11. Reset rules

`reset()` is the only way out of `FAULT`, and the only way to start a fresh cycle. It performs
these steps **in this order**, and aborts with `RESET_BLOCKED` if step 1 or 2 fails:

1. **Pre-conditions** — safety interlock reads OK, and E-stop is not latched. If not → refuse.
2. **Stop everything** — all actuators forced OFF (even if some were mid-action).
3. Clear `fault`, `faultLatched`, `requiresReset`, `estopLatched`.
4. Clear `inspection` values back to `null`, and `result` back to `null`.
5. Zero `position` and `encoder`. Reset all sensor values to their defined idle values.
6. Clear all per-cycle timers, tick counters, and "hold" flags used by ALIGNING / MEASURING.
7. State → `IDLE`. `cycleCount` and the batch record are **kept** (they are history, not machine
   state).

---

## 12. Event / log message format

Person 2 will show machine events in the HMI, so the messages must be stable and greppable.
Format: `[TAG] message`

| Tag | Meaning | Example |
|---|---|---|
| `[START]` | A run was started | `[START] Standard=IS10810 Material=PVC Type=INSULATION Qty=1` |
| `[STATE]` | State transition | `[STATE] FEEDING` |
| `[SAFETY]` | Interlock result | `[SAFETY] OK` |
| `[SENSOR]` | A sensor value changed / was sampled | `[SENSOR] POSITION = 150` |
| `[ACTUATOR]` | An actuator turned ON or OFF | `[ACTUATOR] FEED MOTOR ON` |
| `[INSPECTION]` | Inspection outcome | `[INSPECTION] PASS` or `[INSPECTION] REJECT` |
| `[FAULT]` | A fault was raised | `[FAULT] Cable lost during feeding` |
| `[RESET]` | Reset performed or refused | `[RESET] Machine reset to IDLE` |

These messages come from the machine logic — they are **not** hard-coded console text. The HMI
should render `machineData`, and the log is for debugging and the event trail.

---

## 13. Determinism rule (why no random numbers)

Normal machine operation must be **deterministic**: the same inputs must always produce the same
outputs, so a bug can be reproduced and a demo can be trusted. Therefore:

* Feed speed, encoder rate, timings, and "good" inspection values are **fixed constants** in
  `MACHINE_CONFIG`.
* Nothing in the normal path calls `Math.random()`.
* Faults are injected **on purpose** through an explicit test hook (e.g.
  `injectFault("CABLE_LOST")` or a "fault injection" panel the HMI can call). This is how we test
  faults in Phase 20 without making normal operation random.

If we later want realistic noise, it is added as an *optional, off-by-default* noise layer in
configuration — never as hidden randomness.

---


## 14. Design decisions made in this document (and why)

| ID | Decision | Why |
|---|---|---|
| **D1** | Use **exactly** the 14 states from the brief. No extra states such as `PAUSED`, `HOMING` or `WAITING_FOR_OPERATOR`. | The brief says not to invent states without justification. Homing, pausing and operator prompts can all be handled as *actions inside* a state or as *flags in `machineData`* (`mode`, `requiresOperatorAction`). Fewer states = fewer illegal transitions = easier to verify. If we later need `PAUSED`, that is a change we make deliberately with a documented reason. |
| **D2** | A measured length outside tolerance is a **FAULT** (`LENGTH_OUT_OF_TOLERANCE`), not a `REJECT`. | The specimen has not been cut yet — there is no specimen to judge. The *machine* could not achieve the commanded length, which is a machine/process problem. `REJECT` is reserved for the vision inspection of an actual specimen. |
| **D3** | `VISION_FAILURE` (camera error / no reading) is a **FAULT**; a readable measurement outside the range is a **REJECT**. | Same logic as D2: if the eye cannot see, the machine failed. If the eye sees something bad, the specimen is bad. This keeps "machine health" separate from "product quality". |
| **D4** | No automatic continuation out of `FAULT`. A `requiresReset` flag blocks `start()`. | Required by the brief (Sections 11, 12, 13). It is also the single most important safety property of the whole prototype. |
| **D5** | `MEASURING` and `INSPECTING` are **separated on purpose**. | The brief lists both. `MEASURING` checks the *cut length* before cutting (position/encoder + cut position sensor). `INSPECTING` checks the *finished specimen* (vision). They use different sensors and different failure semantics, so merging them would hide a real distinction. |
| **D6** | `CABLE_DETECTED` is a real state, not just a boolean check inside `FEEDING`. | It gives us a named place for the cable timeout and the feed-target calculation, and it makes the HMI log match the project workflow exactly. |

---

## 15. Configuration keys referenced by this document

These will all live in **one** object, `MACHINE_CONFIG`, inside `js/simulation.js` (Phase 6).
**Every one of them is a simulation assumption** unless explicitly verified from the standard.

| Key | Meaning | Example value | Source |
|---|---|---|---|
| `simulationIntervalMs` | Machine tick length | `50` | Simulation choice |
| `feedSpeedMmPerSec` | Feed motor speed | `25` | Simulation choice |
| `feedDistanceMm` | Target feed distance | `250` | Simulation choice — **not** a standard dimension |
| `encoderPulsesPerMm` | Encoder resolution | `4` | Simulation choice |
| `encoderToleranceMm` | Allowed encoder vs position difference | `0.5` | Simulation choice |
| `alignmentPositionMm` | Position at which alignment happens | `250` | Simulation choice |
| `alignJogMm` | Small corrective jog during alignment | `2` | Simulation choice |
| `alignStableTicks` | Consecutive "aligned" readings required | `3` | Simulation choice |
| `alignmentTimeoutMs` | Max time allowed in `ALIGNING` | `3000` | Simulation choice |
| `cuttingPositionMm` | Position of the cutter | `250` | Simulation choice |
| `cutterStrokeMs` | How long the cutter stays ON | `800` | Simulation choice |
| `lengthToleranceMm` | Allowed deviation of measured cut length | `±2` | **To be verified against standard** |
| `targetSpecimenLengthMm` | Nominal specimen length | `250` | **To be verified against standard** |
| `preparationDepthMm` | How much sheath/insulation is stripped | `30` | **To be verified against standard** |
| `preparationDurationMs` | How long the preparation mechanism runs | `1500` | Simulation choice |
| `preparationTimeoutMs` | Max time allowed in `PREPARING` | `4000` | Simulation choice |
| `formingDwellMs` | Clamp/hold time at the forming station | `500` | Simulation choice |
| `visionRange` | `{ length: {min,max}, width: {...}, thickness: {...} }` | TBD | **To be verified against standard** |
| `goodMeasurement` | The deterministic "perfect" specimen values | TBD | Simulation choice |
| `cableDetectTimeoutMs` | Max wait for cable detection | `2000` | Simulation choice |
| `cableDetectStableTicks` | Consecutive true readings to trust the sensor | `3` | Simulation choice |

---

## 16. machineData contract (what Person 2's HMI will read)

Our module's **only public output** is one plain object, regenerated on every tick. Person 2
should never need to read our internal variables.

```js
machineData = {
  state: "IDLE",
  mode: "IDLE",                 // extra: IDLE | RUNNING | FAULT | ESTOP  (see D1)
  position: 0,                  // mm
  speed: 0,                     // mm/s (0 when feed motor is OFF)
  encoder: 0,                   // encoder counts
  cycleCount: 0,
  requiresReset: false,
  estopLatched: false,
  sensors: {
    cableDetected: false,
    positionReached: false,     // extra: target position reached
    aligned: false,
    cutPositionReady: false,
    preparationComplete: false,
    safetyOK: true,
    visionResult: null          // null | "PASS" | "REJECT" | "ERROR"
  },
  actuators: {
    feedMotor: false,
    feedRollers: false,
    cutter: false,
    preparation: false,
    specimenMovement: false
  },
  inspection: {
    length: null,
    width: null,
    thickness: null,
    shapeOK: null,
    reasons: []                 // extra: why a specimen was rejected
  },
  result: null,                 // null | "PASS" | "REJECT"
  fault: null,                  // null | { code, message, stateAtFault, timestamp }
  events: []                    // recent log lines, for the HMI event panel
};
```

**Three small additions to the brief's structure, each with a reason:**
`mode` (so the HMI can colour the header without re-deriving state), `cycleCount` and
`reasons`/`events` (a REJECT without its reason is not traceable, which the project explicitly
lists as a problem it wants to solve).

---


## 17. Open questions for the team (must be answered before we claim standard compliance)

1. **Which edition / part of IS 10810 applies** to our specimen type (insulation vs sheath)?
2. What are the official **specimen dimensions and tolerances** for length, width and thickness
   per material and specimen type?
3. What is the official **conditioning** requirement (temperature/humidity/time) before testing?
4. What is the official **gauge length** and **rate of tensile test** the specimen must be
   prepared for? (We simulate preparation only, not the tensile test itself.)
5. Are there **mandatory report fields** (batch ID, specimen ID, operator, date, machine ID,
   calibration status) that our `result` record must carry for traceability?
6. Is the standard's tolerance expressed as an **absolute value** (± mm) or a **percentage**?

Until these are answered, every corresponding value stays in `MACHINE_CONFIG` labelled
`assumed: true`, and the project documentation must state that IS 10810 compliance is
**not yet verified**.

---

## 18. Phase 1 self-check — how to verify this document

Before we write code, confirm each of these is true:

- [ ] The 14 states match the workflow in the project brief, in the same order.
- [ ] No state is missing an Entry Condition, Action, Sensors, Exit Condition, Fault, or Next State.
- [ ] Every "wait until" exit condition has a timeout (no state can hang forever).
- [ ] Every state in Part A and Part B lists at least one legal next state.
- [ ] `FAULT` can only be left by `reset()`.
- [ ] `REJECT` and `FAULT` are clearly distinguished.
- [ ] Every number is either in `MACHINE_CONFIG` or marked "to be verified".
- [ ] Nothing in this document claims IS 10810 compliance.

If all eight are true, Phase 1 is complete and we move to **Phase 2: define the sensors**
(writing `docs/sensors.md`).

---

## 19. Next step (Phase 2)

Phase 2 defines the 8 sensors in `docs/sensors.md`: for each sensor — name, purpose, value
type, normal behaviour, when it activates, which states use it, and how it fails. No code yet.

---

*End of document — v0.1*

