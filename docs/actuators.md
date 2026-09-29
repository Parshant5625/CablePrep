# CablePrep — Actuator Specification

**Owner:** Person 1 — Engineering / Control (virtual machine logic)
**Module file covered:** `js/machine.js`
**Companion documents:** `docs/machine-workflow.md` (v0.1.1), `docs/sensors.md` (v0.1.1)
**Document version:** v0.1 (Phase 3 — design only, no code written yet)
**Status:** Draft for review

---

## 0. Disclaimer

* CablePrep is a **software-based virtual prototype**. These are **simulated** actuators. No motor,
  blade, roller or mechanism physically exists.
* Nothing here claims **IS 10810 compliance**.
* Value labels used throughout: `[SIM]` = simulation assumption chosen by us; `[STD?]` = must be
  verified against the official standard or the component datasheet before it can be treated as an
  engineering value.
* All such values will live in `MACHINE_CONFIG` (Phase 6), never hard-coded in `machine.js`.

---

## 1. What "actuator" means in this project

An actuator is one of the machine's **muscles**. It does exactly two things:

1. Hold a current **state** (ON or OFF, plus its own internal counters).
2. Change that state **only when it is told to**, and update the motion of the simulation
   accordingly.

### 1.1 The dumb-actuator rule (mirrors the dumb-sensor rule)

`machine.js` controls actuator state. `machine.js` must **NOT**:

* decide which machine state should run,
* implement the state machine,
* independently decide when to cut, feed, or prepare,
* read sensors to work out what to do next,
* change the machine state or raise a fault by itself.

**Why this matters:** if an actuator decided for itself when to cut, the cutting logic would live
in two places at once. A bug could then be fixed in `simulation.js` while `machine.js` kept
cutting at the wrong moment — and the machine would be unsafe in a way that is very hard to find.
One module decides, one module obeys.

### 1.2 The one command `machine.js` answers to

Every actuator ON/OFF is a **command from `simulation.js`**, and nothing else:

```
simulation.js (decides) → machine.js (obeys) → sensors.js (reports) → simulation.js
```

`machine.js` also performs the **motion arithmetic**, because motion *is* the actuator's job:

```
each tick, for each actuator that is ON:
   advance its own motion model (position, elapsed time, stroke progress)
   and publish the result for the sensors to read
```

Advancing position is not a decision. Deciding *when* to stop is. The line is: `machine.js`
maintains motion; `simulation.js` commands motion.

### 1.3 The three functions `machine.js` will expose (its entire API)

| Function | Called by | What it does |
|---|---|---|
| `set(actuatorName, on)` | `simulation.js` | Turns one actuator ON or OFF. **The only way an actuator changes state.** |
| `allOff()` | `simulation.js` | Forces every actuator OFF. Used by `COMPLETE`, `FAULT`, `reset()` and the interlock. |
| `tick(dt)` | `simulation.js` | Advances the motion model of every ON actuator by the tick length. |

There is deliberately **no** `machine.js` function that starts a cycle, selects a state, or raises
a fault. Those do not exist on purpose.

---


## 2. Actuator summary

The brief specifies five actuators plus stop/emergency behaviour. That is exactly what we
implement — no more.

| ID | Actuator | `machineData.actuators` key | Motion it produces | Controlled by states |
|---|---|---|---|---|
| A1 | Feed Motor | `feedMotor` | Cable translation along the feed axis (mm) | `FEEDING` |
| A2 | Feed Rollers | `feedRollers` | Grip/release; roller rotation; small alignment jogs (mm) | `FEEDING`, `ALIGNING` |
| A3 | Cutter | `cutter` | One down-stroke that severs the cable | `CUTTING` |
| A4 | Preparation Mechanism | `preparation` | Strip/peel stroke on the severed piece | `PREPARING` |
| A5 | Specimen Movement | `specimenMovement` | Specimen transfer between stations (mm on specimen axis) | `INITIALIZING`, `FORMING`, `ACCEPT`, `REJECT` |
| A6 | Stop / Emergency Behaviour | *(not a key — a behaviour)* | Forces all of the above OFF | any state |

**Decision A1 — alignment uses the Feed Rollers, not a sixth actuator.** Phase 1 originally
described an "alignment head / rollers" in `ALIGNING`. That was an 8th/6th actuator that appears
nowhere in the brief or in the `machineData` contract, so it has been corrected: the **Feed
Rollers** run in **align mode**, gripping and jogging the cable to straighten it. This keeps the
actuator count at five and the HMI contract unchanged. The correction was applied to
`machine-workflow.md` (Sections 6, 7.1, 10) and `docs/sensors.md` (S4 card and interaction matrix).

**Decision A2 — there is no "measuring head" actuator.** `MEASURING` runs with **all actuators
OFF**. Measurement is a sensor-side observation of where the cable already is, so it needs no
muscle. Same for `INSPECTING` (the camera moves nothing) and `IDLE` / `COMPLETE`.

---

## 3. A1 — Feed Motor

| Attribute | Detail |
|---|---|
| **Name** | Feed Motor |
| **Purpose** | Drive the cable along the feed axis toward the cutting station. It is the only actuator that produces continuous, measurable cable translation. |
| **Physical action represented** | An electric motor turning a drive shaft/roller set, pushing the cable forward. In simulation: `position` and `encoder` increase every tick. |
| **Value / state type** | `boolean` (`true` = running). Internal state kept **inside** `machine.js`: `onTimeMs`, `totalDistanceMm`, `currentSpeedMmPerSec`. |
| **Machine states that control it** | ON in **`FEEDING`** only. Explicitly **OFF** in `ALIGNING` (jogs are done by the rollers), `MEASURING`, `CUTTING` (the cable must be still while being cut), `PREPARING`, `FORMING`, `INSPECTING`, `ACCEPT`, `REJECT`, `COMPLETE`, `IDLE`, `FAULT`. |
| **ON / activation condition** | `simulation.js` calls `machine.set("feedMotor", true)` when **all** of: state = `FEEDING`; cable stably detected (S1); safety interlock OK (S7); no fault latched; encoder/position not already at target. |
| **OFF / deactivation condition** | `simulation.js` calls `machine.set("feedMotor", false)` when **any** of: `position >= feedDistanceMm` (target reached); `INTERLOCK_OPEN`; `ESTOP_ACTIVE`; `CABLE_LOST`; `ENCODER_MISMATCH`; `FEED_TIMEOUT`; leaving `FEEDING` for any reason. Also forced OFF by `allOff()`. |
| **Normal behaviour** | Each tick, `mmThisTick = speed × dt`; `position += mmThisTick`; `encoder += round(mmThisTick × encoderPulsesPerMm)`; `currentSpeedMmPerSec = feedSpeedMmPerSec`. Position and encoder climb together and monotonically. Log `[ACTUATOR] FEED MOTOR ON` once at switch-on (never every tick). |
| **Fault behaviour** | `machine.js` never raises faults. On any fault, `simulation.js` issues `allOff()` (or the specific OFF above), then records the code. The motor's frozen `position`/`encoder` values are preserved as evidence of where the machine stopped. |
| **Interaction with sensors** | S2 Position and S3 Encoder **exist because of this actuator** — it is what makes them change. S1 Cable Detection gates it (no cable, no feed). S7 Safety Interlock gates it. Its own motion is what S3 cross-checks. |
| **Interaction with other actuators** | Requires A2 Feed Rollers ON to grip — in `FEEDING` both are ON together (workflow Section 7.1). A2 must be OFF whenever A1 is OFF, otherwise the cable is free. Must never be ON while A3 Cutter is ON. |
| **During normal stop** | Turns OFF cleanly at the feed target or at the end of `FEEDING`. Motion ceases on the same tick. `speed` in `machineData` returns to `0`. This is an **orderly** stop: nothing is latched, no fault. |
| **During emergency stop** | Forced OFF **immediately** by `allOff()`, with no ramp-down and no tick of delay. `position` and `encoder` freeze exactly where they are — we never pretend the cable jumped backwards. Log `[ACTUATOR] FEED MOTOR OFF`. |
| **During reset** | Forced OFF by `allOff()`. Its internal counters (`onTimeMs`, `totalDistanceMm`, `currentSpeedMmPerSec`) are zeroed. `position` and `encoder` are reset to `0` by `sensors.js`, **not** by the motor — the motor reports, sensors own the values. |
| **Simulation assumptions `[SIM]`** | `feedSpeedMmPerSec = 25`; `dt = simulationIntervalMs / 1000 = 0.05 s`; `encoderPulsesPerMm = 4`; `maxTravelMm = 500`. |
| **Values needing verification `[STD?]`** | `feedSpeedMmPerSec` (must match the chosen drive/motor datasheet and the material's safe feed rate); `feedDistanceMm` and `targetSpecimenLengthMm` (from the standard — these two are the same number in our prototype and may not be in reality); `encoderPulsesPerMm` (encoder datasheet). |

**Why the motor alone cannot feed:** if A1 is ON while A2 is OFF, the cable is not gripped, so it
does not move — and the machine correctly times out with `FEED_TIMEOUT`. That single rule is how
we model a slipped cable, and it is enforced purely by the ON/OFF combination, not by any
decision inside `machine.js`.


## 4. A2 — Feed Rollers

| Attribute | Detail |
|---|---|
| **Name** | Feed Rollers (including alignment mode) |
| **Purpose** | Grip the cable so it can be pushed/pulled without slipping, and — in **align mode** — apply small corrective jogs to straighten the cable. |
| **Physical action represented** | A set of driven rubber rollers clamping the cable. In simulation: the rollers that make A1's motion actually transfer to the cable, plus the ±`alignJogMm` movements used during alignment. |
| **Value / state type** | `boolean` (`true` = gripping/running) **plus an internal `mode`** with two allowed values: `"feed"` and `"align"`. `mode` is set by the same `set()` command and defaults to `"feed"`. |
| **Machine states that control it** | ON in **`FEEDING`** (mode `"feed"`) and **`ALIGNING`** (mode `"align"`). Explicitly **OFF** in `MEASURING`, `CUTTING` (the cable must be still while being cut), `PREPARING`, `FORMING`, `INSPECTING`, `ACCEPT`, `REJECT`, `COMPLETE`, `IDLE`, `FAULT`. |
| **ON / activation condition** | `set("feedRollers", true, "feed")` on entering `FEEDING` with cable detected and safety OK. `set("feedRollers", true, "align")` on entering `ALIGNING` (cable still detected, safety OK). |
| **OFF / deactivation condition** | `set("feedRollers", false)` when leaving either state; on `CABLE_LOST`, `MISALIGNMENT`, `INTERLOCK_OPEN`, `ESTOP_ACTIVE`; and by `allOff()`. The rollers are released *before* the measuring and cutting steps begin. |
| **Normal behaviour** | In `feed` mode: rollers rotate with A1; cable moves; `position`/`encoder` increase. In `align` mode: rollers apply a deterministic jog of `±alignJogMm` per step — a fixed sequence of small back-and-forth corrections — until the S4 Alignment Sensor reports stable `true`. The jog sequence is a **fixed deterministic pattern**, never random. |
| **Fault behaviour** | `machine.js` raises nothing. If rollers are commanded ON but the cable is not detected, the jog produces no alignment and S4 never turns true, so `simulation.js` raises `MISALIGNMENT` after `alignmentTimeoutMs`. If rollers slip during feed, `position` stops advancing while A1 runs → `FEED_TIMEOUT`. |
| **Interaction with sensors** | S1 Cable Detection (a vanished cable cannot be gripped or aligned). S2 Position and S3 Encoder (jogs change position). S4 Alignment Sensor — **this is the sensor this actuator exists to satisfy**. S7 Safety Interlock. |
| **Interaction with other actuators** | **Paired with A1**: A1 ON + A2 ON = cable moves. A1 ON + A2 OFF = cable does *not* move (slip model). Mutually exclusive with A3 Cutter (rollers released before cutting). Independent of A4 and A5. |
| **During normal stop** | Turned OFF when `FEEDING` ends (rollers released) and at the end of `ALIGNING`. No latch, no fault — a clean release. |
| **During emergency stop** | Forced OFF immediately by `allOff()`; the cable is released and free. Log `[ACTUATOR] FEED ROLLERS OFF`. Position frozen. |
| **During reset** | Forced OFF, `mode` cleared back to `"feed"`, jog counters zeroed, any partial jog discarded. |
| **Simulation assumptions `[SIM]`** | `alignJogMm = 2`; fixed jog step count per correction cycle; `alignStableTicks = 3` (with S4); `alignmentTimeoutMs = 3000`; roller grip modelled as binary (gripped / not gripped) with no slip fraction. |
| **Values needing verification `[STD?]`** | `alignJogMm` (depends on the real straightener geometry and cable diameter); roller pressure / grip force (not simulated — noted as a limitation). |

**Why rollers are modelled separately from the motor:** it is the cheapest possible way to model
**slip**. A real machine's most common feeding fault is the cable slipping between the rollers, and
with two actuators we reproduce it exactly: motor ON, rollers OFF, cable stationary, timer runs
out. No extra "slip" flag and no probability is needed.

---


## 5. A3 — Cutter

| Attribute | Detail |
|---|---|
| **Name** | Cutter |
| **Purpose** | Sever the cable at the cutting station to create the specimen blank. **This is the most safety-critical actuator in the machine** — it is a blade. |
| **Physical action represented** | A powered blade or guillotine that travels down through the cable once and retracts. In simulation: a timed stroke with a deterministic severed-piece result. |
| **Value / state type** | `boolean` (`true` = blade actuated). Internal state inside `machine.js`: `strokeElapsedMs`, `strokeComplete` (the severed-piece flag), `cutCount`. |
| **Machine states that control it** | ON in **`CUTTING`** only. Explicitly **OFF** in every other one of the 14 states. |
| **ON / activation condition** | `set("cutter", true)` only when **all five** of: state = `CUTTING`; `cutPositionReady = true` (S5 — the permit to cut); the length check already passed in `MEASURING`; A1 and A2 both OFF (the cable is stationary); safety interlock OK. **If any one of these is false, the blade does not move.** |
| **OFF / deactivation condition** | `set("cutter", false)` when `strokeElapsedMs >= cutterStrokeMs` (stroke finished); or immediately on `INTERLOCK_OPEN`, `ESTOP_ACTIVE`, `CABLE_LOST` mid-stroke, or a failed sensor check. Also forced OFF by `allOff()`. |
| **Normal behaviour** | Turns ON, runs for exactly `cutterStrokeMs = 800` `[SIM]`, then turns OFF. On completing the stroke it sets `strokeComplete = true` and increments `cutCount`. **The cut is deterministic** — no `Math.random()`, no success probability. Log `[ACTUATOR] CUTTER ON` then `[ACTUATOR] CUTTER OFF`. |
| **Fault behaviour** | `machine.js` does not raise faults. `CUTTING_FAILURE` is raised by `simulation.js` in exactly two cases: the stroke completed but `strokeComplete` never became true, or the stroke did not complete within `cutterTimeoutMs`. On either, the cutter is forced OFF first, then all actuators OFF. |
| **Interaction with sensors** | S5 Cut Position Sensor is the **permission to cut** — the blade is forbidden without it. S2/S3 confirm the cable is stationary and where it is. S1 confirms a cable exists at all. S7 gates the stroke and can abort it mid-stroke. |
| **Interaction with other actuators** | **Strictly exclusive with A1 and A2.** Both must be OFF for the whole of `CUTTING`. Independent of A4 (which runs only after the cut is confirmed) and A5 (which picks up the severed piece afterwards). |
| **During normal stop** | Turns OFF at the end of its timed stroke. The machine then waits for `simulation.js` to confirm the cut before entering `PREPARING`. The blade never runs longer than its stroke under normal operation. |
| **During emergency stop** | Forced OFF **immediately** by `allOff()` — the blade stops mid-stroke if that is where the E-stop happened. `strokeComplete` stays `false` and `strokeElapsedMs` is frozen. Because E-stop is latched, a partially executed stroke can never be silently treated as a completed cut. Log `[ACTUATOR] CUTTER OFF`. |
| **During reset** | Forced OFF; `strokeElapsedMs` and `strokeComplete` cleared; `cutCount` **kept** (it is history/traceability, not machine state — workflow Section 11). |
| **Simulation assumptions `[SIM]`** | `cutterStrokeMs = 800`; `cutterTimeoutMs = 2000` (comfortably larger than the stroke); blade modelled as instantaneous ON/OFF with no intermediate position; no blade-wear or blade-break model. |
| **Values needing verification `[STD?]`** | `cutterStrokeMs` (depends on the real cutter and cable diameter); whether a cutter-retraction interlock is required before the blade may descend; `cuttingPositionMm`. |

**The safety argument for this card:** the cutter has the strictest ON condition in the machine
(five separate conditions, all of which must hold), the shortest permitted runtime, and the
strongest abort path. In Phase 5 we will implement that ON condition as a single `if` that checks
all five and refuses to actuate if any fails — this is the most safety-critical code in the project
and the first thing to review.

---


## 6. A4 — Preparation Mechanism

| Attribute | Detail |
|---|---|
| **Name** | Preparation Mechanism |
| **Purpose** | Strip or peel the cable's outer sheath / insulation to the configured preparation depth, producing the prepared specimen blank. |
| **Physical action represented** | A stripping head or peeling blade that engages the sheath for a controlled stroke and depth. In simulation: a timed stroke that causes the Preparation Sensor to confirm completion. |
| **Value / state type** | `boolean` (`true` = mechanism running). Internal state inside `machine.js`: `strokeElapsedMs`, `strokeComplete`. |
| **Machine states that control it** | ON in **`PREPARING`** only. Explicitly **OFF** in all other 13 states. |
| **ON / activation condition** | `set("preparation", true)` only when: state = `PREPARING`; the cut was already confirmed (`strokeComplete` true from A3); `preparationComplete` still false; safety interlock OK; no fault latched. |
| **OFF / deactivation condition** | `set("preparation", false)` when `strokeElapsedMs >= preparationDurationMs`; or immediately on `INTERLOCK_OPEN`, `ESTOP_ACTIVE`; also forced OFF by `allOff()`. |
| **Normal behaviour** | Runs for `preparationDurationMs = 1500` `[SIM]`, then turns OFF and sets `strokeComplete = true`. It does **not** decide that preparation succeeded — that judgement belongs to S6 and to `simulation.js`. |
| **Fault behaviour** | `machine.js` raises nothing. `PREPARATION_FAILURE` is raised by `simulation.js` when the mechanism has finished its stroke but S6 has not confirmed within `preparationTimeoutMs = 4000`. The mechanism is forced OFF first, then all actuators OFF. |
| **Interaction with sensors** | S6 Preparation Sensor confirms its work. S2 Position and S3 Encoder are recorded with the result. S5/Cutter history gates its start. S7 Safety Interlock. |
| **Interaction with other actuators** | Sequenced strictly **after** A3 Cutter and **before** A5 Specimen Movement. Must be OFF whenever A5 moves (the specimen must not be in transit while being stripped). Independent of A1/A2. |
| **During normal stop** | Turns OFF at the end of its timed stroke and stays OFF. Orderly, no latch. |
| **During emergency stop** | Forced OFF immediately by `allOff()`. A partially stripped specimen is **not** marked complete — `strokeComplete` stays `false`, so `simulation.js` cannot advance to `FORMING`. Log `[ACTUATOR] PREPARATION OFF`. |
| **During reset** | Forced OFF; `strokeElapsedMs` and `strokeComplete` cleared. |
| **Simulation assumptions `[SIM]`** | `preparationDurationMs = 1500`; `preparationTimeoutMs = 4000`; modelled as a single timed stroke with no intermediate blade position; no material-dependent behaviour (PVC, XLPE and PE behave identically — a documented simplification). |
| **Values needing verification `[STD?]`** | `preparationDurationMs` (material and tool dependent); `preparationDepthMm` — **a standard-critical dimension, currently a placeholder**. |

**Honest limitation:** our prototype strips every material identically. A real machine's stripping
parameters depend heavily on sheath material and thickness. Recorded as a known simplification,
not hidden.

---


## 7. A5 — Specimen Movement

| Attribute | Detail |
|---|---|
| **Name** | Specimen Movement (specimen transfer axis / gripper) |
| **Purpose** | Move the specimen between stations: cutter → forming station → vision station → accept or reject tray. It also performs the **homing** move during `INITIALIZING`. |
| **Physical action represented** | A linear axis with a gripper or tray that picks up and transfers the specimen. In simulation: position on the **specimen axis**, a different axis from the feed axis. |
| **Value / state type** | `boolean` (`true` = axis moving). Internal state inside `machine.js`: `axisPositionMm`, `atHome`, `clamped`. |
| **Machine states that control it** | ON in **`INITIALIZING`** (homing), **`FORMING`** (transfer to the vision station), **`ACCEPT`** (to the out-tray), **`REJECT`** (to the reject tray). Explicitly **OFF** in `IDLE`, `CABLE_DETECTED`, `FEEDING`, `ALIGNING`, `MEASURING`, `CUTTING`, `PREPARING`, `INSPECTING`, `COMPLETE`, `FAULT`. |
| **ON / activation condition** | `set("specimenMovement", true)` only when: state is one of those four; safety interlock OK; no fault latched. During `FORMING` it additionally requires `preparationComplete = true` (S6) — an unprepared specimen is never moved. |
| **OFF / deactivation condition** | `set("specimenMovement", false)` when the axis reaches its commanded station (arrival detected by the derived `atStation` flag); at the home sensor during `INITIALIZING`; on `INTERLOCK_OPEN`, `ESTOP_ACTIVE`, `SPECIMEN_NOT_PLACED`; and by `allOff()`. |
| **Normal behaviour** | Advances `axisPositionMm` toward the commanded station by `specimenSpeedMmPerSec × dt`, then stops on arrival. In `FORMING` it holds for `formingDwellMs = 500` `[SIM]` to clamp, then transfers to the vision station. Logs `[ACTUATOR] SPECIMEN MOVEMENT ON` / `OFF`. |
| **Fault behaviour** | `machine.js` raises nothing. `SPECIMEN_NOT_PLACED` is raised by `simulation.js` if the axis does not reach the station within `formingTimeoutMs`. `HOMING_TIMEOUT` is raised if the home move does not complete within `homingTimeoutMs` during `INITIALIZING`. |
| **Interaction with sensors** | S2 Position Sensor (reused on the specimen axis for the derived `atStation` flag — sensors.md Section 11.1). S6 Preparation Sensor gates the start of `FORMING`. S7 Safety Interlock. S8 Vision can only measure a specimen that physically arrived. |
| **Interaction with other actuators** | Sequenced **after** A4 and never overlapping it. Must be OFF while A3 Cutter runs (the blade zone must be clear). Independent of A1/A2, which work on the feed axis. |
| **During normal stop** | Turns OFF on arrival at its station. In `COMPLETE` it is already OFF, having completed delivery. Orderly, no latch. |
| **During emergency stop** | Forced OFF immediately by `allOff()`. The specimen **stays wherever it was** — mid-transfer if that is where the E-stop occurred. `axisPositionMm` is frozen and `clamped` is left as-is; `simulation.js` will not treat a mid-transfer position as an arrival. Log `[ACTUATOR] SPECIMEN MOVEMENT OFF`. |
| **During reset** | Forced OFF; `axisPositionMm` zeroed; `atHome` set `false`; `clamped` cleared. `cycleCount` is **kept**. |
| **Simulation assumptions `[SIM]`** | `specimenSpeedMmPerSec = 40`; `formingDwellMs = 500`; `formingTimeoutMs = 6000`; `homingTimeoutMs = 5000`; station positions (`cutterStationMm`, `formingStationMm`, `visionStationMm`, `outTrayMm`, `rejectTrayMm`); `formingStationToleranceMm = ±2`. |
| **Values needing verification `[STD?]`** | Station positions and clearances (depend on the real machine layout); `formingDwellMs` (clamp/settle time); specimen axis speed. |

**Note on two axes:** the machine has a **feed axis** (A1/A2, published as `machineData.position`)
and a **specimen axis** (A5, position internal to `machine.js`). They are deliberately separate so
that moving the specimen can never be confused with feeding the cable. The `atStation` derived flag
reuses the Position Sensor concept on the specimen axis (sensors.md Section 11.1).

---


## 8. A6 — Stop / Emergency Behaviour

This is not a sixth actuator with an ON/OFF flag. It is the **behaviour** that `machine.js`
provides through `allOff()`, plus the three defined stop paths. It has no key in
`machineData.actuators`, because when it fires, *every* key in that object is `false`.

| Attribute | Detail |
|---|---|
| **Name** | Stop / Emergency Behaviour (normal stop, safe stop, emergency stop, reset) |
| **Purpose** | Guarantee that the machine is always in a known, safe actuator state, and that every stop happens in a defined, repeatable way. |
| **Physical action represented** | Contactors dropping out, a safety relay opening, brakes applying. In simulation: every actuator flag forced to `false`. |
| **Value / state type** | Not a flag. Three **stop kinds**, chosen by `simulation.js`: `normalStop`, `safeStop`, `emergencyStop`. The resulting actuator state is always all-`false`. |
| **Machine states that control it** | `normalStop` is used by every state that finishes its work, and by `COMPLETE`. `safeStop` is used by `FAULT` and by `reset()`. `emergencyStop` may be triggered **from any of the 14 states**, at any tick, with the highest priority. |
| **ON / activation condition** | `normalStop`: the current state's work is complete and its exit condition passed. `safeStop`: any critical fault was raised. `emergencyStop`: `sensors.triggerEmergencyStop()` was called, or S7 reported E-stop. |
| **OFF / deactivation condition** | There is no "off" for a stop — a stop is an action, not a sustained state. Actuators are re-enabled only by a fresh, explicit `set(..., true)` from `simulation.js`, after the stop condition has cleared and `reset()` has run. |
| **Normal behaviour** | `normalStop` → the *current* actuator turns OFF in its own time (end of stroke, arrival at station, target reached). All five keys in `machineData.actuators` become `false`. State → `COMPLETE` → `IDLE`. No latch, no fault, `requiresReset` stays `false`. |
| **Fault behaviour** | `safeStop` → the same actuator result as `normalStop` (all `false`), **plus** the machine freezes: no `tick()` advances any motion, and the fault record is stored together with the actuator snapshot. |
| **Interaction with sensors** | S7 Safety Interlock triggers `safeStop` (`INTERLOCK_OPEN`) and `emergencyStop` (`ESTOP_ACTIVE`). All other sensors freeze and keep their last values as evidence. |
| **Interaction with other actuators** | It overrides all five actuators. No actuator may re-enable itself after a stop — only `simulation.js` may command it, and only after a reset. |
| **During normal stop** | This *is* the normal stop: the current actuator OFF in its own time, all others already OFF, `speed` → `0`, state advances normally. |
| **During emergency stop** | `emergencyStop` → `allOff()` immediately — no ramp-down, no waiting for a stroke to finish. State → `FAULT`, `fault.code = ESTOP_ACTIVE`, `estopLatched = true`, `requiresReset = true`. Positions freeze. **No tick may leave `FAULT`**; the HMI cannot resume. This is exactly the nine steps in workflow Section 10. |
| **During reset** | `reset()` → refuses to run while `estopLatched` or while `safetyOK` is false (`RESET_BLOCKED`); otherwise forces `allOff()`, clears every internal counter, zeroes the axes, and returns to `IDLE` with `requiresReset = false`. `cutCount` and `cycleCount` are **kept**. |
| **Simulation assumptions `[SIM]`** | Emergency stop is instantaneous — real machines have a finite deceleration time and we do not simulate coasting. `simulationIntervalMs = 50` is the reaction granularity. |
| **Values needing verification `[STD?]`** | Whether a category-3 / PLd safety stop is required by the machine's risk assessment; whether a separate physical reset button is mandated. **These are safety-engineering questions, not software choices — they must be answered by a qualified person.** |

### 8.1 The three stop kinds compared

| | Normal stop | Safe stop (fault) | Emergency stop |
|---|---|---|---|
| Actuators | all OFF | all OFF | all OFF **immediately** |
| Machine state | `COMPLETE` → `IDLE` | `FAULT` | `FAULT` |
| Motion | finished in its own time | frozen instantly | frozen instantly |
| `requiresReset` | `false` | `true` | `true` (latched) |
| Can it end by itself? | n/a — the work finished | **No** | **No** |
| Triggered by | a completed exit condition | a raised fault code | E-stop button / `triggerEmergencyStop()` |
| Blocked by interlock? | no | yes — `INTERLOCK_OPEN` | yes — `ESTOP_ACTIVE` |

The last three rows are the whole point of this project: **a fault or an E-stop never ends by
itself.** A person must reset the machine.

---


## 9. Actuator interaction matrix

| Actuator | Must be ON when | Must be OFF when | Directly coupled to | Legal to overlap? |
|---|---|---|---|---|
| A1 Feed Motor | `FEEDING` | all other 13 states | A2 (grip), S1, S2, S3, S7 | **Only with A2** |
| A2 Feed Rollers | `FEEDING` (feed mode), `ALIGNING` (align mode) | `MEASURING`, `CUTTING`, `PREPARING`, `FORMING`, `INSPECTING`, `ACCEPT`, `REJECT`, `COMPLETE`, `IDLE`, `FAULT` | A1, S1, S4 | **Only with A1** (in feed mode) |
| A3 Cutter | `CUTTING` | all other 13 states | S5 (permit), S7, A1, A2 | **Never** with A1 or A2 |
| A4 Preparation | `PREPARING` | all other 13 states | S6, A3 (before), A5 (after) | **Never** with A5 |
| A5 Specimen Movement | `INITIALIZING`, `FORMING`, `ACCEPT`, `REJECT` | the other 10 states | S6, S7, A4, A3 | **Never** with A3 or A4 |

### 9.1 Three safety rules the matrix encodes

1. **Blade exclusivity** — A3 may only run when A1 and A2 are both OFF. A cable that is moving
   must never be under a descending blade.
2. **Single-writer rule** — only `simulation.js` ever calls `set()`. Two modules writing the same
   flag is how contradictory actuator states get created, and they are very hard to find.
3. **Stop dominance** — `allOff()` always wins. It is called by `safeStop`, `emergencyStop`,
   `reset()` and the interlock check, and no other command may be issued until the machine leaves
   `FAULT` through a reset.

---

## 10. How this maps to `machineData.actuators` (the HMI contract)

Exactly the object from workflow Section 16. Person 2's HMI reads these five keys and nothing
else.

```js
actuators: {
  feedMotor: false,          // A1
  feedRollers: false,        // A2  (align mode is internal to machine.js, not exposed)
  cutter: false,             // A3
  preparation: false,        // A4
  specimenMovement: false    // A5
}
```

**Kept inside `machine.js` and NOT exposed** (internal detail — exposing them would widen the HMI
contract for no benefit):

| Internal value | Why it stays private |
|---|---|
| `rollers.mode` (`"feed"` / `"align"`) | An implementation detail of A2. The HMI only needs to know the rollers are ON. |
| `strokeElapsedMs` (A3, A4) | Timing detail; the state name already tells the HMI what is happening. |
| `strokeComplete`, `atHome`, `clamped` | Internal sequencing flags. |
| `axisPositionMm` (A5) | The specimen axis is internal; only `position` (feed axis) is public. |

**One addition to the top level of `machineData`:** `speed` is already in the contract
(workflow Section 16) and is the feed motor's contribution. When A1 is OFF, `speed` must read `0`
— that is the only place `machine.js` writes to `machineData`, and it writes exactly one number.

---

## 11. Complete simulation-assumption register (actuator values)

**Every `[SIM]` and `[STD?]` value used anywhere in this document.** All must live in
`MACHINE_CONFIG` (Phase 6) and be replaceable without touching `machine.js` logic.

| Config key | Value | Label | Used by | Purpose |
|---|---|---|---|---|
| `simulationIntervalMs` | `50` | `[SIM]` | all | The tick length (`dt = 0.05 s`). |
| `feedSpeedMmPerSec` | `25` | `[SIM]` | A1 | Feed rate. |
| `feedDistanceMm` | `250` | `[SIM]` | A1 | Target feed distance. |
| `maxTravelMm` | `500` | `[SIM]` | A1 | Travel limit / sanity bound. |
| `encoderPulsesPerMm` | `4` | `[SIM]` | A1 | Encoder resolution (datasheet-dependent). |
| `alignJogMm` | `2` | `[SIM]` | A2 | Size of one alignment jog. |
| `alignmentTimeoutMs` | `3000` | `[SIM]` | A2 | Max time in `ALIGNING`. |
| `cutterStrokeMs` | `800` | `[SIM]` | A3 | Blade stroke duration. |
| `cutterTimeoutMs` | `2000` | `[SIM]` | A3 | Max time for the stroke to complete. |
| `cuttingPositionMm` | `250` | `[SIM]` | A3 | Cutter station position. |
| `preparationDurationMs` | `1500` | `[SIM]` | A4 | Preparation stroke duration. |
| `preparationTimeoutMs` | `4000` | `[SIM]` | A4 | Max time in `PREPARING`. |
| `preparationDepthMm` | `30` | `[SIM]` | A4 | Strip/peel depth. **[STD?]** too — see below. |
| `specimenSpeedMmPerSec` | `40` | `[SIM]` | A5 | Specimen axis speed. |
| `formingDwellMs` | `500` | `[SIM]` | A5 | Clamp/settle dwell. |
| `formingTimeoutMs` | `6000` | `[SIM]` | A5 | Max time to reach the station. |
| `homingTimeoutMs` | `5000` | `[SIM]` | A5 | Max time to home. |
| `formingStationToleranceMm` | `±2` | `[SIM]` | A5 | "Arrived at station" band. |
| `stationPositions` | `cutter 0, forming 150, vision 300, outTray 400, rejectTray 450` | `[SIM]` | A5 | Station layout. |
| `feedSpeedMmPerSec` (max safe) | material-dependent | `[STD?]` | A1 | Safe feed rate for the material. |
| `preparationDepthMm` | per standard | `[STD?]` | A4 | **Standard-critical.** Placeholder only. |
| `cutterStrokeMs` | per cutter + cable OD | `[STD?]` | A3 | Depends on real tooling and cable diameter. |
| `targetSpecimenLengthMm` | `250` | `[STD?]` | A1/A5 | Nominal specimen length. |
| `visionRange` | TBD | `[STD?]` | S8 | Acceptable dimension bands. |

### 11.1 What we deliberately do **not** simulate

Being explicit about omissions is part of an honest prototype:

* **Material behaviour** — no difference between PVC, XLPE, PE, or rubber.
* **Cable diameter / cross-section** — a single nominal cable is assumed.
* **Blade wear, blade breakage, roller wear.**
* **Deceleration / inertia** — motion starts and stops instantly.
* **Air pressure, hydraulic pressure, power supply** (only present as the interlock concept).
* **Multiple cables in one batch** — the prototype runs one specimen per cycle; batch counting is
  tracked but not yet looped.

Each of these is a *documented simplification*, not an oversight.


## 12. Consistency check results (Phase 3 exit criteria)

Run against `machine-workflow.md` (v0.1.1), `sensors.md` (v0.1.1) and this document.

| # | Check | Result |
|---|---|---|
| 1 | Every actuator referenced in the state table exists in `actuators.md` | **PASS** — `feedMotor`, `feedRollers`, `cutter`, `preparation`, `specimenMovement` all documented as A1–A5. The phantom "alignment head / rollers" was found and **corrected** to Feed Rollers in align mode (Decision A1). |
| 2 | Every actuator has defined ON and OFF behaviour | **PASS** — A1–A5 each have both rows; A6 defines all three stop paths. |
| 3 | Every actuator has defined emergency-stop behaviour | **PASS** — A1–A6 all state forced-OFF-immediately, plus what is frozen. |
| 4 | Every actuator has defined reset behaviour | **PASS** — A1–A6 all state what is cleared and what is **kept** (`cutCount`, `cycleCount`). |
| 5 | No actuator makes state-machine decisions | **PASS** — Section 1.1 states the prohibition; the API in Section 1.3 exposes only `set()`, `allOff()`, `tick(dt)`. No `machine.js` function starts a cycle, selects a state, or raises a fault. Every fault code in this document is attributed to `simulation.js`. |
| 6 | No contradictions between the three documents | **PASS after 6 corrections** — listed in Section 12.1. |

### 12.1 Corrections made during Phase 3

| # | File | Problem found | Fix |
|---|---|---|---|
| 1 | `machine-workflow.md` §6, §7.1, §10 | "alignment head / rollers" described as an actuator — a **sixth actuator** that is absent from the brief and from the `machineData` contract | Replaced with **Feed Rollers in align mode**; E-stop list renumbered 1–9 to match the five actuators |
| 2 | `sensors.md` S4 card + matrix | "Feed Rollers / alignment actuator" — implied a separate actuator | Changed to "Feed Rollers (align mode)" |
| 3 | `machine-workflow.md` §7.1 `CUTTING` | "Cutter guard check" implied an unlisted actuator | Now "Safety interlock check (cutter guard closed)" |
| 4 | `machine-workflow.md` §7.1 `CUTTING` | Referenced a non-existent `config.cutSuccessProbability` | Now the severed-piece flag set by the cutter actuator — deterministic, no probability |
| 5 | `machine-workflow.md` §9 | `FEED_TIMEOUT` and `HOMING_TIMEOUT` were used in the state table but missing from the fault table (found during Phase 2) | Added both rows — fault table now has **15 codes** |
| 6 | `machine-workflow.md`, `sensors.md` headers | Version not bumped after edits | Now both read **v0.1.1** |

### 12.2 Fault codes used in this document — all exist in workflow §9

`CABLE_LOST` · `CUTTING_FAILURE` · `ENCODER_MISMATCH` · `ESTOP_ACTIVE` · `FEED_TIMEOUT` ·
`HOMING_TIMEOUT` · `INTERLOCK_OPEN` · `MISALIGNMENT` · `PREPARATION_FAILURE` ·
`RESET_BLOCKED` · `SENSOR_FAILURE` · `SPECIMEN_NOT_PLACED` — **12 of 15.** The three not raised
by actuators (`CABLE_NOT_DETECTED`, `LENGTH_OUT_OF_TOLERANCE`, `VISION_FAILURE`) are detected by
sensors or by the inspection logic, never by a muscle. That is correct and expected.

---

## 13. Phase 3 self-check

- [ ] Exactly 5 actuators + stop behaviour; no sixth actuator invented.
- [ ] Each card answers all 16 required attributes.
- [ ] Every actuator has ON, OFF, emergency-stop and reset behaviour.
- [ ] The dumb-actuator rule is stated and the API contains no decision-making function.
- [ ] Every fault is attributed to `simulation.js`, never to `machine.js`.
- [ ] Every value carries `[SIM]` or `[STD?]`.
- [ ] E-stop rules match workflow §10 exactly (five actuators, immediate OFF, latched).
- [ ] Reset rules match workflow §11 (what is cleared vs what is kept).
- [ ] `machineData.actuators` matches the contract exactly — five keys, no more.
- [ ] All six consistency checks pass.

---

## 14. Next step (Phase 4)

Phase 4 implements **`js/sensors.js`**: the eight sensors, their values, per-tick updates, debounce
counters, sensor failure injection, and reset. It will import `MACHINE_CONFIG` and export the
functions listed in sensors.md Section 14. Still no state machine — that is Phase 6/7.

---

*End of document — v0.1*

