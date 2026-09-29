# CablePrep

Smart Automated Cable Specimen Preparation & Inspection System — virtual engineering prototype.

## Current architecture

- **Person 1 — Engineering/Control:** state machine, sensors, actuators, faults, inspection decision.
- **Person 2 — HMI/UX:** dashboard, configuration, machine visualization, live monitoring, inspection UI, history and reports.
- **Integration boundary:** `Simulation.machineData()` → `js/machine-data.js` adapter → HMI.

## Project status

The repository contains the Phase 1/2 HMI and the Person 1 machine simulation. Person 1's automated test suite reports **65/65 checks passing** in the source implementation.

The current numeric specimen/tolerance values are simulation placeholders and must not be presented as verified IS 10810 values.

## Run

Open `index.html` directly in a modern browser for the current HMI prototype.

## Test

Run:

```bash
node tests/run-tests.js
```

## Next integration work

1. Replace the HMI mock provider with an adapter over `Simulation`.
2. Map the Person 1 `machineData()` snapshot into the HMI's normalized data contract.
3. Connect inspection, history and report views to real cycle records.
4. Validate normal, reject, fault and emergency-stop demo flows.
5. Add persistent history/report export only after the live integration is stable.
