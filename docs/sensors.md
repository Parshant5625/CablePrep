# CablePrep — Sensor Specification

**Owner:** Person 1 — Engineering / Control (virtual machine logic)
**Module file covered:** `js/sensors.js`
**Companion documents:** `docs/machine-workflow.md` (v0.1), `docs/actuators.md` (Phase 3, pending)
**Document version:** v0.1.1 (Phase 2 design; alignment-actuator correction applied in Phase 3)
**Status:** Draft for review

---

## 0. Disclaimer

* CablePrep is a **software-based virtual prototype**. These are **simulated** sensors. No
  physical sensor, PLC, or machine exists.
* Nothing here claims **IS 10810 compliance**.
* Every threshold, position, count and timeout in this document is labelled:
  * `[SIM]` = a **simulation assumption** chosen by us so the machine has *some* number to work with.
  * `[STD?]` = a value that **must be verified against the official standard** (or the machine
    datasheets) before it can ever be treated as an engineering value.
* All `[SIM]` and `[STD?]` values will live in `MACHINE_CONFIG` (Phase 6), never hard-coded in the
  sensor logic.

---

## 1. What "sensor" means in this project

A sensor is one of the machine's **eyes**. It does exactly two things:

1. Holds a current **value** (a number, a boolean, or an object).
2. Updates that value as the simulation runs.

A sensor must **never**:

* turn an actuator ON or OFF,
* change the machine state,
* decide anything.

If you ever write `if (cableDetected) { feedMotor = true }` inside `sensors.js`, that line
belongs in `simulation.js`. **Sensors stay dumb; only the brain thinks.**

Why this rule matters: if a sensor could actuate, then a sensor bug would move the cable, and you
could no longer tell whether the fault was in the sensing or in the control. Keeping the
separation is what makes the machine debuggable and testable.

Two more rules for this module:

* **A sensor reports; it does not block.** A sensor value is never "waiting" for permission.
* **Sensors are read-only from outside.** `simulation.js` calls `sensors.get(name)` or reads the
  exported snapshot. The HMI must never write a sensor value.

---

## 2. The eight sensors

Our module simulates exactly the eight sensors listed in the project brief. We did **not** add a
ninth sensor; where the workflow appears to need one more flag (for example "the specimen is at
the vision station"), we **derive** it from the Position Sensor instead of inventing hardware
(see Section 9.2).

| ID | Sensor | Code key | Value type | Primary states | Failure raises |
|---|---|---|---|---|---|
| S1 | Cable Detection Sensor | `cableDetected` | boolean | `CABLE_DETECTED`, `FEEDING` | `CABLE_NOT_DETECTED`, `CABLE_LOST`, `SENSOR_FAILURE` |
| S2 | Position Sensor | `position` (mm) | number | `FEEDING`, `ALIGNING`, `MEASURING` | `SENSOR_FAILURE`, `FEED_TIMEOUT` |
| S3 | Encoder | `encoder` (counts) | integer | `FEEDING`, `MEASURING` | `ENCODER_MISMATCH`, `SENSOR_FAILURE` |
| S4 | Alignment Sensor | `aligned` | boolean | `ALIGNING`, `MEASURING` | `MISALIGNMENT`, `SENSOR_FAILURE` |
| S5 | Cut Position Sensor | `cutPositionReady` | boolean | `MEASURING`, `CUTTING` | `SENSOR_FAILURE` |
| S6 | Preparation Sensor | `preparationComplete` | boolean | `PREPARING`, `FORMING` | `PREPARATION_FAILURE`, `SENSOR_FAILURE` |
| S7 | Safety Interlock | `safetyOK` (+ `estopLatched`) | boolean | **every state, every tick** | `INTERLOCK_OPEN`, `ESTOP_ACTIVE` |
| S8 | Vision System | `visionResult` + 4 measurements | object + numbers | `INSPECTING` | `VISION_FAILURE` (a REJECT is *not* a fault) |

**How to read Sections 3–10:** each sensor gets one card with the same ten attributes in the same
order, so you can compare any two sensors side by side.

---


## 3. S1 — Cable Detection Sensor

| Attribute | Detail |
|---|---|
| **Name** | Cable Detection Sensor |
| **Purpose** | Answers exactly one question: *is a cable present at the loading station?* Without it the machine would feed empty air and crash the cutter. |
| **Value / data type** | `boolean` — `true` = cable in the sensing zone, `false` = zone empty. Also maintains an internal stability counter (see Normal behaviour). |
| **Normal behaviour** | Reads `false` while idle. Reads `true` whenever the simulated cable is inside the sensing zone. Because a real sensor would bounce (read true/false/true/true…), the value must be **stable for `cableDetectStableTicks = 3` consecutive ticks `[SIM]`** before the machine is allowed to believe it. |
| **When it activates** | Read on **every tick** (cheap, boolean — no reason to skip it). It becomes *decisive* in `CABLE_DETECTED` (must be stably true) and in `FEEDING` / `ALIGNING` (must **stay** true, proving the cable did not slip out of the grippers). |
| **States that use it** | `INITIALIZING` (self-test), `CABLE_DETECTED` (confirmation), `FEEDING` (continuity), `ALIGNING` (continuity). Polled in `IDLE`, where `false` is the correct value. |
| **If it fails** | **False negative** (cable present but reads `false`): after `cableDetectTimeoutMs = 2000` `[SIM]` in `CABLE_DETECTED` this raises `CABLE_NOT_DETECTED`. **Goes false mid-feed**: raises `CABLE_LOST` immediately — no timeout, because losing a cable under load is instantly dangerous. **Self-test bit bad** at `INITIALIZING`: raises `SENSOR_FAILURE`. |
| **Interacts with** | Safety Interlock (a run only starts if both are OK); Position Sensor and Encoder (position may only change if a cable is gripped); the Feed Motor and Feed Rollers actuators. |
| **Example normal value** | `true` — cable loaded and waiting, machine in `CABLE_DETECTED`. |
| **Example fault value** | `false` while in `FEEDING` → log `[FAULT] Cable lost during feeding`, feed motor OFF, state `FAULT`. |

**Note:** the sensor itself does not raise faults. It only reports `false`. `simulation.js` decides
that "false while feeding" means `CABLE_LOST`. This is the dumb-sensor rule from Section 1.

---

## 4. S2 — Position Sensor

| Attribute | Detail |
|---|---|
| **Name** | Position Sensor |
| **Purpose** | Reports the current position of the feed / carriage axis in millimetres — *where is the cable right now?* |
| **Value / data type** | `number` in millimetres (float). Valid range `0 … maxTravelMm = 500` `[SIM]`. A derived boolean `positionReached` is exposed in `machineData` for the HMI (see Section 9.2). |
| **Normal behaviour** | `0` at home. Increases by `feedSpeedMmPerSec × dt` on **every tick while the Feed Motor is ON**, and is **frozen** while the feed motor is OFF. It never decreases during a cycle — the cable only ever feeds forward. |
| **When it activates** | Continuously during any motion: `FEEDING`, `ALIGNING` (small jogs), `PREPARING`, `FORMING`, and the home-return in `COMPLETE`. In `INSPECTING` it is static and kept only for the record. |
| **States that use it** | `FEEDING` (reach `feedDistanceMm`), `ALIGNING` (apply `alignJogMm` corrections), `MEASURING` (record the cut length), `CUTTING` (must **not** change while cutting), `PREPARING`, `FORMING`, `COMPLETE` (return home). |
| **If it fails** | **Implausible value** (negative, greater than `maxTravelMm`, `NaN`, or a jump larger than physically possible in one tick) → `SENSOR_FAILURE`. **Stuck** (unchanged while the feed motor is ON and a cable is detected) → the machine is stalled; after `feedTimeoutMs = 8000` `[SIM]` this raises `FEED_TIMEOUT`. **Drifting away from the Encoder** → `ENCODER_MISMATCH` (raised by the *comparison*, not by this sensor alone). |
| **Interacts with** | Encoder (independent cross-check — the single most valuable pairing in the machine); Cable Detection (position may only change if a cable is gripped); Cut Position Sensor (compared against `cuttingPositionMm`); Feed Motor / Feed Rollers actuators. |
| **Example normal value** | `150` mm during feeding, with `feedDistanceMm = 250` `[SIM]` |
| **Example fault value** | `NaN`, or a jump `150 → 400` in one tick, or stuck at `0` while the log shows `[ACTUATOR] FEED MOTOR ON` |

**Important:** the Position Sensor does **not** move the cable. `machine.js` moves it (the feed
motor), and the sensor *reports* where it got to. The sensor is a mirror, not a hand.

---


## 5. S3 — Encoder

| Attribute | Detail |
|---|---|
| **Name** | Encoder |
| **Purpose** | Counts pulses from the feed motor shaft to give a **fine, independent** measurement of how far the cable actually moved. It exists to cross-check the Position Sensor. |
| **Value / data type** | `integer` count. Converted to millimetres by `encoderPulsesPerMm = 4` `[SIM]`, so `encoderMm = encoder / encoderPulsesPerMm`. |
| **Normal behaviour** | Starts at `0`, is **zeroed during `INITIALIZING`** and during `reset()`. Increases by the same millimetres as the Position Sensor, multiplied by `encoderPulsesPerMm`. Frozen while the Feed Motor is OFF. |
| **When it activates** | Read every tick while the Feed Motor is ON. Also read once in `MEASURING` to confirm the cable did not slip between feeding and cutting. |
| **States that use it** | `INITIALIZING` (zeroing), `FEEDING` (mismatch check), `MEASURING` (slip check). Also polled in `ALIGNING`. |
| **If it fails** | **Disagreement** with the Position Sensor greater than `encoderToleranceMm = 0.5` `[SIM]` while feeding → `ENCODER_MISMATCH`. **Frozen while the feed motor is ON** → the encoder or its wiring has failed → `SENSOR_FAILURE`. **Implausible** (negative, or a jump no real encoder could produce in one tick) → `SENSOR_FAILURE`. |
| **Interacts with** | Position Sensor (the pair is checked against each other every tick); Feed Motor actuator (its motion is what generates the pulses); Safety Interlock. |
| **Example normal value** | `600` counts = `150 mm` at `encoderPulsesPerMm = 4` `[SIM]`, while Position Sensor reads `150` |
| **Example fault value** | `600` counts while Position Sensor reads `250` → a `100 mm` disagreement → `[FAULT] Encoder and position sensor disagree` |

**Why two sensors for the same movement?** On a real machine this is standard practice. One
sensor can lie (a sticky encoder, a loose coupling); two independent sensors that agree are
evidence. The mismatch **is** the fault detection — which is why this pair is the most important
sensor relationship in the machine.

---

## 6. S4 — Alignment Sensor

| Attribute | Detail |
|---|---|
| **Name** | Alignment Sensor |
| **Purpose** | Answers: *is the cable straight and correctly aligned in the feed axis?* A bent or twisted cable produces a bad specimen, so alignment must be confirmed **before** measuring and cutting. |
| **Value / data type** | `boolean` — `true` = cable within the alignment tolerance, `false` = not aligned. (Real machines often use an analogue deviation in mm; we keep a boolean for simplicity — noted as an open item in Section 11.) |
| **Normal behaviour** | `false` when the cable arrives from feeding. During `ALIGNING` the Feed Rollers in align mode apply small corrective jogs of `alignJogMm = 2` `[SIM]`; the sensor turns `true` once the cable is straight, and must then **stay `true` for `alignStableTicks = 3` consecutive ticks** before the machine trusts it (debounce — see Section 10.2). |
| **When it activates** | Read every tick during `ALIGNING`. Re-checked once in `MEASURING` (alignment must still hold at the moment of cutting). |
| **States that use it** | `ALIGNING` (primary — decides success/failure), `MEASURING` (cross-check). |
| **If it fails** | **Never reaches `true`** within `alignmentTimeoutMs = 3000` `[SIM]` → `MISALIGNMENT`. **Flips back to `false`** after being confirmed, while the machine is still in `ALIGNING` or `MEASURING` → `MISALIGNMENT` (the cable moved). **Stuck permanently `true`** (a shorted sensor) → self-test at `INITIALIZING` raises `SENSOR_FAILURE`. |
| **Interacts with** | Position Sensor (jog corrections change position); Feed Rollers (the actuator that grips and jogs the cable to straighten it, in align mode); Cable Detection (a cable that vanished also cannot be aligned); Safety Interlock. |
| **Example normal value** | `true` for 3 consecutive ticks → log `[SENSOR] ALIGNMENT OK` → transition to `MEASURING` |
| **Example fault value** | `false` for the whole `alignmentTimeoutMs` → `[FAULT] Cable could not be aligned within the allowed time` |

**A subtle point worth remembering:** `true` for one tick is **not** enough. This is exactly why
real machines "debounce" their sensors, and why `alignStableTicks` exists. Without it, a single
noisy tick would let the machine cut a bent cable.

---


## 7. S5 — Cut Position Sensor

| Attribute | Detail |
|---|---|
| **Name** | Cut Position Sensor |
| **Purpose** | Answers: *is the cable exactly under the cutter?* This is the last safety check before a blade is actuated. |
| **Value / data type** | `boolean` — `true` = the cable is at the cutting station within tolerance. |
| **Normal behaviour** | `false` while feeding. Becomes `true` when the Position Sensor is within `cutPositionToleranceMm = ±1` `[SIM]` of `cuttingPositionMm = 250` `[SIM]`. Stays `true` through the `CUTTING` state so the cut cannot happen at the wrong place. After the cut is confirmed, the severed piece is removed, so the sensor returns to `false`. |
| **When it activates** | Read every tick in `MEASURING` (to authorise the cut) and in `CUTTING` (to confirm the cut happened where it should). |
| **States that use it** | `MEASURING` (primary — it is half of the exit condition for that state), `CUTTING` (confirmation after the stroke). |
| **If it fails** | **Stuck `false`** at the correct position → the machine refuses to cut and the self-test/timeout path raises `SENSOR_FAILURE` at `MEASURING`. **Stuck `true`** away from the cutting position → also `SENSOR_FAILURE` (this is the dangerous case: it would authorise a cut in the wrong place). **Flips `true` then back to `false` during `CUTTING`** → the cable moved while being cut → `SENSOR_FAILURE`. |
| **Interacts with** | Position Sensor (it is the *derived* comparison `|position − cuttingPositionMm| ≤ tolerance`); Encoder (secondary confirmation of where the cable is); the Cutter actuator (this sensor is the **permission** to actuate it); Safety Interlock. |
| **Example normal value** | `true` while Position Sensor reads `250` → log `[SENSOR] CUT POSITION READY` |
| **Example fault value** | `true` while Position Sensor reads `40` → a stuck sensor that would authorise a wrong-position cut → `[FAULT] Cut position sensor is inconsistent with the position sensor` |

**This sensor is the machine's "permit to cut".** If it is not `true`, `simulation.js` must never
enter `CUTTING`, no matter what else is true. That single rule prevents the worst kind of
accident: cutting a cable at the wrong place.

---

## 8. S6 — Preparation Sensor

| Attribute | Detail |
|---|---|
| **Name** | Preparation Sensor |
| **Purpose** | Confirms that the insulation / sheath **preparation step actually finished** (stripping, peeling, roughening) before the specimen is moved on. |
| **Value / data type** | `boolean` — `true` = preparation complete. |
| **Normal behaviour** | `false` when the piece arrives from the cutter. The Preparation Mechanism runs for `preparationDurationMs = 1500` `[SIM]`; at the end of the stroke the sensor turns `true`. It is **not** true merely because time passed — it turns `true` when the simulated mechanism reports the stroke complete, and `simulation.js` additionally requires the duration to have elapsed. |
| **When it activates** | Read every tick in `PREPARING`. Re-checked in `FORMING` (a specimen that was not prepared must not be moved to inspection) and in `INSPECTING` as a cross-check recorded in the result. |
| **States that use it** | `PREPARING` (primary — it is the exit condition), `FORMING` (guard), `INSPECTING` (recorded cross-check). |
| **If it fails** | **Never turns `true`** within `preparationTimeoutMs = 4000` `[SIM]` → `PREPARATION_FAILURE` (mechanism ran, work not confirmed). **Stuck `true`** from the very start → the machine would skip preparation and pass an unprepared specimen to inspection; the self-test at `INITIALIZING` raises `SENSOR_FAILURE`. **Turns `true` then `false`** → `PREPARATION_FAILURE`. |
| **Interacts with** | Preparation Mechanism actuator (what causes the value to change); Cut Position Sensor / Cutter (preparation may only begin after a confirmed cut); Position Sensor (recorded with the result); Safety Interlock. |
| **Example normal value** | `true` after `preparationDurationMs` elapsed → log `[SENSOR] PREPARATION COMPLETE` |
| **Example fault value** | `false` after `preparationTimeoutMs` elapsed → `[FAULT] Preparation stage did not complete` |

**Design principle used twice here:** a sensor that can only *confirm* work (rather than assume
it) means a failed sensor produces a **safe** outcome (the machine stops) rather than a dangerous
one (the machine continues with bad work).

---


## 9. S7 — Safety Interlock

| Attribute | Detail |
|---|---|
| **Name** | Safety Interlock (with Emergency Stop latch) |
| **Purpose** | The master **permission to move at all**. It represents the guard door, the E-stop mushroom button, and the service/air-pressure switch combined into one "is it safe?" answer. |
| **Value / data type** | `boolean` `safetyOK`, plus a separate latched `boolean` `estopLatched` (see Section 10.3 for why the latch is separate). |
| **Normal behaviour** | `true` while the guard is closed, the E-stop is released, and service mode is off. It is polled on **every tick in every state — including `IDLE`, `COMPLETE` and `FAULT`**. It does not wait to be asked. |
| **When it activates** | Always. This is the only sensor with no "active states" — its whole purpose is to be consulted before *any* actuator is commanded. |
| **States that use it** | All 14. Additionally it is checked *before* `start()` is accepted in `IDLE`. |
| **If it fails** | `safetyOK = false` in any running state → immediate safe stop, `INTERLOCK_OPEN`. `estopLatched = true` → immediate safe stop of **every** actuator, `ESTOP_ACTIVE`, state `FAULT`. A **failed interlock itself** (self-test bad at `INITIALIZING`) is treated as `INTERLOCK_OPEN` — the machine assumes unsafe when it cannot prove safety. This is the standard "fail-safe" principle. |
| **Interacts with** | **Every** actuator (all five are gated by it); every state's exit condition; `estopLatched`; `reset()` (which refuses to run while unsafe — see workflow Section 11). |
| **Example normal value** | `true` → log `[SAFETY] OK` |
| **Example fault value** | `false` (guard opened) → all actuators OFF, `[FAULT] Safety interlock is not satisfied` → `INTERLOCK_OPEN`. Or `estopLatched = true` → `[FAULT] Emergency stop was activated` → `ESTOP_ACTIVE` |

**Fail-safe principle:** when a sensor cannot prove that a condition is safe, the machine must
treat it as **unsafe**. Never "assume OK because the sensor is probably fine".

---

## 10. S8 — Vision System

| Attribute | Detail |
|---|---|
| **Name** | Vision System (Machine Vision / Dimensional Inspection) |
| **Purpose** | Measures the finished specimen and judges it. It is the **only** sensor that produces a verdict rather than a single physical reading. |
| **Value / data type** | An object plus four numbers. `visionResult` is one of `null` (not run yet), `"PASS"`, `"REJECT"`, `"ERROR"`. Measurements: `length` (mm, number), `width` (mm, number), `thickness` (mm, number), `shapeOK` (boolean). Rejection `reasons` is a `string[]`. |
| **Normal behaviour** | Inactive (`visionResult = null`) everywhere except `INSPECTING`. When entered, it produces the deterministic "good specimen" values from `config.goodMeasurement`, then compares each against `config.visionRange` `{ length: {min,max}, width: {min,max}, thickness: {min,max} }`. If every value is inside its band → `"PASS"`. If any value is outside → `"REJECT"` plus a human-readable reason string for each failing property, e.g. `"Thickness outside configured range (1.42 mm, allowed 1.50-2.00 mm)"`. |
| **When it activates** | Only in `INSPECTING`. It is not consulted before that — a real camera would be idle and unpowered elsewhere in the cycle. |
| **States that use it** | `INSPECTING` (produces the verdict), then `ACCEPT` / `REJECT` (consume the verdict and store the record). |
| **If it fails** | **No reading produced** (camera error, no image, internal error) → `visionResult = "ERROR"` → `VISION_FAILURE` → the machine goes to `FAULT`. **A reading outside the range** → this is **NOT a fault** → `"REJECT"` and the machine continues to `COMPLETE` normally. |
| **Interacts with** | Preparation Sensor (a specimen that was never prepared should not be passed as good); Position Sensor / the derived `atStation` flag (the camera can only measure a specimen that is physically in front of it — this is why the camera failing to see a missing specimen is a *machine* fault, not a reject); Safety Interlock; the stored result record. |
| **Example normal value** | `{ visionResult: "PASS", length: 250.0, width: 10.0, thickness: 1.75, shapeOK: true }` `[SIM]` — all `[STD?]` values pending verification |
| **Example fault value** | `{ visionResult: "ERROR", length: null, width: null, thickness: null }` → `[FAULT] Vision system failed to produce a measurement`. **Reject case:** `{ visionResult: "REJECT", thickness: 1.42, reasons: ["Thickness outside configured range (1.42 mm, allowed 1.50-2.00 mm)"] }` → `[INSPECTION] REJECT` |

**The most important distinction in this document:** `ERROR` and `REJECT` are completely
different outcomes. `REJECT` = the machine worked correctly and correctly found a bad specimen.
`ERROR` = the machine itself failed. Conflating them would make the batch report meaningless.

---


## 11. Sensor interaction matrix

Read this as "A depends on B". This is the map you will use when debugging.

| Sensor | Depends on (reads) | Feeds (decisions in) | Never reads |
|---|---|---|---|
| S1 Cable Detection | Safety Interlock | `CABLE_DETECTED` entry/exit, `CABLE_LOST` in `FEEDING`/`ALIGNING` | Position, Encoder |
| S2 Position | S1 (may only move if gripped), Feed Motor | `FEEDING` exit, jogs in `ALIGNING`, length record in `MEASURING`, `atStation` in `FORMING` | Alignment |
| S3 Encoder | Feed Motor (motion produces pulses) | `ENCODER_MISMATCH` check in `FEEDING`/`MEASURING` | Position (it is compared *against* it, never corrected by it) |
| S4 Alignment | S2 (jogs move the cable), Feed Rollers (align mode) | `ALIGNING` exit, `MISALIGNMENT` | Encoder |
| S5 Cut Position | S2 (position), S3 (secondary) | `MEASURING` exit — **permission to cut** | Vision |
| S6 Preparation | Preparation actuator | `PREPARING` exit, guard in `FORMING`/`INSPECTING` | S1 |
| S7 Safety Interlock | nothing (it is the root of trust) | **every state**, `start()` acceptance, `reset()` | everything |
| S8 Vision | S6 (prepared?), `atStation` (present?) | `ACCEPT` vs `REJECT` verdict | S1, S2 directly |

### 11.1 Two derived values (not extra sensors)

The workflow needs two flags that do not justify a ninth and tenth sensor. They are **computed**
in `simulation.js` from existing sensor values:

| Derived value | Formula | Why it is not a sensor |
|---|---|---|
| `positionReached` | `position >= feedDistanceMm` | It is a comparison of the Position Sensor against configuration — a fact, not a measurement. |
| `atStation` (specimen at the vision station) | `position` on the **specimen axis** is within `formingStationToleranceMm = ±2` `[SIM]` of the station position | Same reason. The specimen axis reuses the Position Sensor on a second axis. |

Both are exposed in `machineData` so the HMI does not have to recompute them. Documented here so
nobody later "adds a sensor for it".

---

## 12. Why three sensors need extra rules

### 12.1 Raw vs stable values

Three sensors must not be trusted on a single tick: **S1 Cable Detection**, **S4 Alignment**, and
**S6 Preparation**. Each therefore keeps **two** values internally:

* `raw` — what the sensor physically reads this tick.
* `value` — the *stable* value the machine is allowed to use.

`value` only changes after the raw value has repeated `stableTicks` times. The counters are:
`cableDetectStableTicks = 3`, `alignStableTicks = 3`, `preparationStableTicks = 2` `[SIM]`.

### 12.2 Why debouncing exists at all

A real sensor sitting next to a moving cable, a vibrating cutter and a stripping mechanism will
give a wrong reading for a tick now and then. If the machine acted on that single wrong tick, it
would cut a bent cable or skip a preparation step. Debouncing costs a few milliseconds and
removes an entire class of random machine errors. It is the cheapest safety in the project.

### 12.3 Why `estopLatched` is separate from `safetyOK`

They look like the same thing but are not:

| | `safetyOK` | `estopLatched` |
|---|---|---|
| Meaning | Guards/doors are closed right now | Someone pressed the mushroom button and it has **not** been released |
| Changes back on its own? | Yes — close the door and it clears | **No.** Only `releaseEmergencyStop()` clears it |
| Blocks motion? | Yes | Yes, and blocks `reset()` too |

If we merged them into one boolean, a reset could silently clear an E-stop that nobody had
physically released. That is exactly the bug this separation prevents.

---

## 13. Sensor value lifecycle

Every sensor follows the same four-stage life. This is what `reset()` must restore (workflow
Section 11).

| Stage | What the sensor does | Log |
|---|---|---|
| **Idle** | Reports its defined idle value (mostly `false`, `position = 0`, `safetyOK = true`, `visionResult = null`) | — |
| **Active** | Updates every tick while the machine is in a state that uses it | `[SENSOR] POSITION = 150` |
| **Faulted** | Frozen at its last value, or forced to a safe default. Never updated while in `FAULT`. A `failed = true` flag is set | `[FAULT] Cable lost during feeding` |
| **Reset** | Forced back to the idle value; `failed` cleared; all internal counters cleared | `[RESET] Machine reset to IDLE` |

**Rule:** a frozen sensor in `FAULT` must keep showing its last value, so the HMI can show the
operator *where* the machine stopped. Resetting to zero would destroy that evidence.

---


## 14. How sensor failures are produced (deterministic fault injection)

Normal operation never uses randomness (workflow Section 13). A sensor fails **only** because
somebody asked it to, through an explicit test hook. This is how we will test faults in Phase 20.

`sensors.js` will expose exactly these test functions:

| Test function | What it simulates | Fault it triggers (state-dependent) |
|---|---|---|
| `injectFailure(sensorName)` | The sensor is electrically dead — stuck at its last value, `failed = true` | `SENSOR_FAILURE` in any state |
| `setInterlockOpen(true / false)` | Guard door opened / closed | `INTERLOCK_OPEN` |
| `triggerEmergencyStop()` | E-stop mushroom button pressed | `ESTOP_ACTIVE` (latched) |
| `releaseEmergencyStop()` | E-stop button physically released | clears the latch (does **not** clear the fault) |

Plus sensor-specific hooks, because these are the faults we specifically must be able to
reproduce:

| Test function | What it simulates |
|---|---|
| `injectCableLost()` | Cable drops out of the grippers mid-feed — forces S1 to `false` while `FEEDING` |
| `setEncoderDrift(mm)` | Encoder disagrees with position by a chosen amount — forces `ENCODER_MISMATCH` |
| `setVisionError(true / false)` | Camera returns no reading — forces `VISION_FAILURE` |
| `setMeasuredLengthOffset(mm)` | The measured cut length is wrong by a chosen amount — forces `LENGTH_OUT_OF_TOLERANCE` |
| `setSpecimenOutOfRange(property)` | Vision returns a value outside the configured band — forces a **REJECT** (not a fault) |

Two rules about these hooks:

1. **They are pure test inputs.** They may only be called from the HMI's test panel or a test
   script, never from normal machine logic.
2. **`setSpecimenOutOfRange` is the odd one out** — it produces a REJECT, not a fault, because
   the machine is healthy and the specimen is bad. That difference is the point.

---

## 15. Simulation assumption register (sensor-related values)

**Every value below must be replaceable from `MACHINE_CONFIG` without editing sensor logic.**

| Config key | Value | Label | Why it exists |
|---|---|---|---|
| `simulationIntervalMs` | `50` | `[SIM]` | The machine "tick". Sets how fast everything moves on screen. |
| `maxTravelMm` | `500` | `[SIM]` | Sanity limit for the Position Sensor. Beyond it is an implausible reading. |
| `encoderPulsesPerMm` | `4` | `[SIM]` | Encoder resolution. Must eventually match the chosen encoder datasheet. |
| `encoderToleranceMm` | `0.5` | `[SIM]` | Allowed S2/S3 disagreement before `ENCODER_MISMATCH`. |
| `feedTimeoutMs` | `8000` | `[SIM]` | Max time in `FEEDING` before `FEED_TIMEOUT`. |
| `cableDetectStableTicks` | `3` | `[SIM]` | Debounce for S1. |
| `cableDetectTimeoutMs` | `2000` | `[SIM]` | Max wait for a cable in `CABLE_DETECTED`. |
| `alignJogMm` | `2` | `[SIM]` | Size of one corrective alignment movement. |
| `alignStableTicks` | `3` | `[SIM]` | Debounce for S4. |
| `alignmentTimeoutMs` | `3000` | `[SIM]` | Max time in `ALIGNING` before `MISALIGNMENT`. |
| `preparationStableTicks` | `2` | `[SIM]` | Debounce for S6. |
| `preparationDurationMs` | `1500` | `[SIM]` | How long the preparation stroke takes. |
| `preparationTimeoutMs` | `4000` | `[SIM]` | Max time in `PREPARING` before `PREPARATION_FAILURE`. |
| `cutPositionToleranceMm` | `±1` | `[SIM]` | How close counts as "at the cutter". |
| `formingStationToleranceMm` | `±2` | `[SIM]` | How close counts as "at the vision station". |
| `goodMeasurement` | `{length: 250.0, width: 10.0, thickness: 1.75}` | `[STD?]` | The "perfect" specimen the vision system returns. **Placeholder only.** |
| `visionRange` | TBD | `[STD?]` | Acceptable bands for length/width/thickness. **Must come from the official standard.** |
| `targetSpecimenLengthMm` | `250` | `[STD?]` | Nominal specimen length. |
| `lengthToleranceMm` | `±2` | `[STD?]` | Allowed cut-length deviation. |

**Honest statement for the report:** with `visionRange` and `targetSpecimenLengthMm` marked
`[STD?]`, our PASS/REJECT logic demonstrates the *mechanism* of inspection correctly, but the
numbers are placeholders. The machine logic will be correct; the engineering values are still
outstanding.

---


## 16. How this maps to `machineData.sensors` (the HMI contract)

This is exactly the object from workflow Section 16. Person 2's HMI reads these and nothing else.

```js
sensors: {
  cableDetected: false,        // S1  boolean
  positionReached: false,      // derived from S2 + config
  aligned: false,              // S4  boolean
  cutPositionReady: false,     // S5  boolean
  preparationComplete: false,  // S6  boolean
  safetyOK: true,              // S7  boolean
  visionResult: null           // S8  null | "PASS" | "REJECT" | "ERROR"
}
```

Values that stay **inside** `sensors.js` and are *not* in the public contract: `position` and
`encoder` (exposed at the top level of `machineData`, per the brief), the raw/stable pairs, and
the debounce counters.

**Why:** the public contract stays small and stable. If we later change how debouncing works
internally, Person 2's HMI does not break.

---

## 17. Phase 2 self-check — verify before approving

- [ ] Exactly 8 sensors documented; no ninth sensor invented (derived values justified in 11.1).
- [ ] Each card answers all 10 required attributes: name, purpose, value type, normal behaviour,
      when it activates, states that use it, failure behaviour, interactions, normal example,
      fault example.
- [ ] Every fault named matches a code in `docs/machine-workflow.md` Section 9 (no new codes invented).
- [ ] No sensor ever turns an actuator on/off or changes state (Section 1 rule respected in prose).
- [ ] Every numeric value carries `[SIM]` or `[STD?]`.
- [ ] `REJECT` vs `VISION_FAILURE` is clearly distinguished (Section 10).
- [ ] Sensor reset behaviour matches workflow Section 11.
- [ ] Fault injection is deterministic — no `Math.random()` anywhere.

If all eight are true, Phase 2 is complete.

---

## 18. Next step (Phase 3)

Phase 3 defines the **actuators** in `docs/actuators.md`: for each of the 5 actuators plus the
stop/emergency behaviour — purpose, ON condition, OFF condition, which state controls it, and its
fault behaviour. Still no code.

---

*End of document — v0.1*

