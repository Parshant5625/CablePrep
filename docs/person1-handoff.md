# CablePrep — Person 1 → Person 2 HANDOFF

**From:** Person 1 — Engineering / Control (virtual machine logic)
**To:** Person 2 — HMI / Software
**Module version:** v1.0 (functionally complete, 65/65 automated checks passing)

---

## 0. Read this first — the one rule that matters

**Person 1 owns every decision. Person 2 owns every pixel.**

Person 1's three files contain the state machine, the sensors, the actuators, the fault logic and
the inspection verdict. Person 2 builds the interface. If Person 2 re-implements any decision —
"should this specimen be accepted?", "is it safe to cut?", "has the cable moved?" — then the
project has two machines that will eventually disagree, and neither can be trusted.

**Person 2 never computes anything. Person 2 only reads `machineData` and calls commands.**

---

## 1. The public `machineData` object

Produced by `Simulation.machineData()`. This is a **function**, not a live object — call it to get
a fresh snapshot. It returns a brand-new plain object every time, so Person 2 can safely hold a
reference without it changing underneath them.

```js
machineData = {
  state:           "IDLE",   // string
  mode:            "IDLE",   // string
  position:        0,        // number, mm
  speed:           0,        // number, mm/s
  encoder:         0,        // number, counts
  cycleCount:      0,        // number
  requiresReset:   false,    // boolean
  estopLatched:    false,    // boolean
  sensors:    { ... },       // object — see 1.4
  actuators:  { ... },       // object — see 1.5
  inspection: { ... },       // object — see 1.6
  result:     null,          // null | "PASS" | "REJECT"
  fault:      null,          // null | { code, message, stateAtFault, timestamp }
  events:     []             // array of strings
};
```

Exactly **14 top-level keys**. This is the entire public output of the Person 1 module.

---

## 1.1 Machine state

| Field | Type | Values | Meaning |
|---|---|---|---|
| `state` | string | `IDLE`, `INITIALIZING`, `CABLE_DETECTED`, `FEEDING`, `ALIGNING`, `MEASURING`, `CUTTING`, `PREPARING`, `FORMING`, `INSPECTING`, `ACCEPT`, `REJECT`, `COMPLETE`, `FAULT` | The single state the machine is in **right now**. Exactly one at a time. |
| `mode` | string | `IDLE`, `RUNNING`, `FAULT`, `ESTOP` | A coarse summary **for header colouring only**. Build no logic on it — read `state` instead. `ESTOP` means an emergency stop caused the current `FAULT`. |
| `cycleCount` | number | 0, 1, 2, … | Completed cycles since page load. **Survives `reset()`** (it is history). Increments once per cycle, not once per tick. |
| `requiresReset` | boolean | — | `true` means the machine is latched and **will refuse to start**. Person 2 should disable the START button and light a "RESET REQUIRED" indicator. |
| `estopLatched` | boolean | — | `true` means the E-stop button is still physically pressed. Stays `true` until `Simulation.releaseEmergencyStop()` is called. |

**The 14 states in workflow order:**
`IDLE → INITIALIZING → CABLE_DETECTED → FEEDING → ALIGNING → MEASURING → CUTTING → PREPARING
→ FORMING → INSPECTING → ACCEPT | REJECT → COMPLETE → IDLE`
Any state may go to `FAULT`. `FAULT` can only be left by `reset()`.

---

## 1.2 Motion

| Field | Type | Unit | Meaning |
|---|---|---|---|
| `position` | number | mm | Position on the **feed axis** — where the cable is. Starts at 0, rises while the feed motor runs. **Frozen (not zeroed) when the machine faults**, so the operator can see where it stopped. |
| `speed` | number | mm/s | Current feed speed. **Exactly `0` whenever the feed motor or the rollers are off.** Person 2 can drive a speed gauge with this directly; no calculation needed. |
| `encoder` | number | pulses | Raw count from the independent encoder. Display it as a **cross-check readout** beside `position`, because a large divergence is the signature of `ENCODER_MISMATCH`. |

* `position` increases only while **both** `feedMotor` and `feedRollers` are `true`. Motor on with
  rollers off = slipping cable = `position` stays put.
* Person 2 does **not** need to check encoder agreement — Person 1 already does and raises the fault.

> Note: `position` is the **feed axis** only. The specimen axis is internal — see Section 6.

---

## 1.4 Sensors — every field of `machineData.sensors`

Seven fields. All boolean except `visionResult`.

| Field | Type | Meaning | Suggested HMI treatment |
|---|---|---|---|
| `cableDetected` | boolean | A cable is physically present at the loading station (debounced, 3 ticks) | Green indicator |
| `positionReached` | boolean | **Derived:** `position >= feedDistanceMm`. Feed target reached. | Progress-bar target tick |
| `aligned` | boolean | Cable is straight and correctly aligned (debounced, 3 ticks) | Indicator; meaningful in `ALIGNING`/`MEASURING` |
| `cutPositionReady` | boolean | Cable is under the cutter, within ±1 mm. **This is the machine's "permit to cut."** | Show prominently in `MEASURING`/`CUTTING` |
| `preparationComplete` | boolean | Strip/peel stroke confirmed complete | Indicator during `PREPARING` |
| `safetyOK` | boolean | Guards closed **and** E-stop released **and** safety sensor alive. Computed live, never cached. | **Red when `false`** — highest priority |
| `visionResult` | string \| null | `null`, `"PASS"`, `"REJECT"`, `"ERROR"` | Badge |

**`visionResult` — the distinction Person 2 must get right:**

| Value | Meaning | Consequence |
|---|---|---|
| `"PASS"` | Every property inside its band | Machine continues to `ACCEPT` |
| `"REJECT"` | Camera **worked**, specimen is bad | Machine continues to `REJECT` → `COMPLETE`. **Not a machine error.** |
| `"ERROR"` | Camera **failed**, no reading | `VISION_FAILURE` → `FAULT`. The machine itself is broken. |
| `null` | Vision not run yet | Normal outside `INSPECTING` |
