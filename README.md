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

## Software completion status

The software prototype is implemented end-to-end:

- Live Person 1 machine simulation connected to the Person 2 HMI through `js/machine-data.js`.
- Automatic and operator-selectable Manual mode.
- HMI configuration is persisted locally and applied to the live simulation for length, width, thickness, quantity and mode.
- Normal multi-specimen batch cycling in Automatic mode.
- Start, Stop, Reset, Emergency Stop and E-stop release controls.
- Fault demonstration and reset handling.
- Live dashboard, machine monitor, process visualization and inspection screens.
- Persistent browser history and HTML report export.
- Person 1 automated test suite: **65/65 checks passing** in the validated source implementation.

### Engineering limitations

This remains a **virtual engineering prototype**. Physical motors, encoders, sensors, cutter/preparation mechanisms, PLC/microcontroller integration and real machine safety circuits are outside the software scope. Numeric specimen dimensions and tolerances in the simulation are placeholders and must not be presented as verified IS 10810 requirements until the applicable official standard is checked.

## Final verification

Before demonstration, run `node tests/run-tests.js`, then run the browser prototype and verify one normal batch, one REJECT demonstration, and the fault/E-stop flows in the target browser.
