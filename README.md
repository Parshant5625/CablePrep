# CablePrep

Smart Automated Cable Specimen Preparation & Inspection System — virtual engineering prototype.

## Current architecture

- **Person 1 — Engineering/Control:** state machine, sensors, actuators, faults, inspection decision.
- **Person 2 — HMI/UX:** dashboard, configuration, machine visualization, live monitoring, inspection UI, history and reports.
- **Integration boundary:** `Simulation.machineData()` → `js/machine-data.js` adapter → HMI.

## Project status

The repository contains the integrated HMI + Person 1 machine simulation. The HMI now consumes Person 1's public `Simulation.machineData()` contract through `js/machine-data.js`. Person 1's automated test suite reports **65/65 checks passing** in the source implementation. Browser history and report export are also implemented.

The current numeric specimen/tolerance values are simulation placeholders and must not be presented as verified IS 10810 values.

## Run

Open `index.html` directly in a modern browser for the current HMI prototype.

## Test

Run:

```bash
node tests/run-tests.js
```

## Remaining work

1. Run the browser prototype and execute a complete normal cycle.
2. Verify ACCEPT and REJECT demonstrations.
3. Verify CABLE LOST, SAFETY INTERLOCK, SENSOR FAILURE and EMERGENCY STOP flows.
4. Verify persistent history and report export in the target browser.
5. Replace simulation placeholder dimensions/tolerances only after the applicable official standard is verified.
