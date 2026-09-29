/* ==========================================================================
 * CablePrep — headless test harness  (run with:  node tests/run-tests.js)
 *
 * It proves the three modules work together AND that the safety rules hold.
 * It also enforces the architecture: the tests fail loudly if sensors.js
 * ever starts deciding, or machine.js ever starts deciding.
 * ========================================================================== */

const path = require('path');
const JS = path.join(__dirname, '..', 'js');
const Sensors = require(path.join(JS, 'sensors.js'));
const Machine = require(path.join(JS, 'machine.js'));
global.Sensors = Sensors;
global.Machine = Machine;
global.MACHINE_CONFIG = null;

const Simulation = require(path.join(JS, 'simulation.js'));
const CONFIG = Simulation.config();

let passed = 0, failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS  ' + name); }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

function heading(text) { console.log('\n=== ' + text + ' ==='); }

// Run ticks without the real timer (headless).
function run(ticks) { for (let i = 0; i < ticks; i++) { Simulation.tick(); } }

// Run until the machine reaches one of the given states, or we give up.
function runUntil(states, maxTicks) {
  const targets = Array.isArray(states) ? states : [states];
  for (let i = 0; i < maxTicks; i++) {
    Simulation.stopTimer();                 // we drive the ticks ourselves
    if (targets.indexOf(Simulation.getState()) !== -1) { return true; }
    Simulation.tick();
  }
  return targets.indexOf(Simulation.getState()) !== -1;
}

function freshMachine() {
  Sensors.init(CONFIG);
  Machine.init(CONFIG);
  Simulation.init();
  Simulation.clearInjectedFaults();
  Simulation.clearBatch();
  Simulation.reset();
  // A reset must NOT magically unload a cable from the machine — that would
  // be wrong physics. So the harness unloads it explicitly between tests.
  Simulation.unloadCable();
}

// Silence the machine's own console logging during most tests.
const realLog = console.log;
function quiet(fn) {
  console.log = function () {};
  try { return fn(); } finally { console.log = realLog; }
}

function allOff(d) { return Object.keys(d.actuators).every(function (k) { return d.actuators[k] === false; }); }

/* ---------------------------------------------------------------- */
heading('TEST 1 — normal cycle runs to completion');
freshMachine();
Simulation.loadCable();
quiet(function () {
  Simulation.start();
  runUntil(['IDLE'], 6000);
});
const d1 = Simulation.machineData();
check('cycle returned to IDLE', d1.state === 'IDLE', 'state=' + d1.state);
check('cycleCount incremented to 1', d1.cycleCount === 1, 'cycleCount=' + d1.cycleCount);
check('result was PASS', d1.result === 'PASS', 'result=' + d1.result);
check('no fault raised', d1.fault === null, d1.fault ? d1.fault.code : '');
check('feed reached the target', Math.abs(d1.position - CONFIG.feedDistanceMm) <= 3, 'position=' + d1.position);
check('encoder counts were produced', d1.encoder > 0, 'encoder=' + d1.encoder);
check('all actuators OFF at the end', allOff(d1), JSON.stringify(d1.actuators));
check('inspection values recorded', d1.inspection.length !== null && d1.inspection.thickness !== null, JSON.stringify(d1.inspection));
check('batch has 1 record', Simulation.batch().length === 1, 'batch=' + Simulation.batch().length);

/* ---------------------------------------------------------------- */
heading('TEST 2 — states visited in the documented order');
freshMachine();
Simulation.loadCable();
const seenStates = [];
quiet(function () {
  Simulation.start();
  for (let i = 0; i < 6000; i++) {
    Simulation.stopTimer();
    const s = Simulation.getState();
    if (seenStates[seenStates.length - 1] !== s) { seenStates.push(s); }
    if (s === 'IDLE' && seenStates.length > 5) { break; }
    Simulation.tick();
  }
});
console.log('  visited: ' + seenStates.join(' -> '));
const expectedOrder = ['INITIALIZING', 'CABLE_DETECTED', 'FEEDING', 'ALIGNING', 'MEASURING', 'CUTTING', 'PREPARING', 'FORMING', 'INSPECTING', 'ACCEPT', 'COMPLETE', 'IDLE'];
let orderOk = seenStates.length === expectedOrder.length;
for (let i = 0; i < Math.min(seenStates.length, expectedOrder.length); i++) {
  if (seenStates[i] !== expectedOrder[i]) { orderOk = false; }
}
check('order matches docs/machine-workflow.md Section 7', orderOk, seenStates.join('->'));

/* ---------------------------------------------------------------- */
heading('TEST 3 — cable not detected -> FAULT, reset required');
freshMachine();
quiet(function () { Simulation.start(); runUntil(['FAULT'], 600); });
const d3 = Simulation.machineData();
check('state is FAULT', d3.state === 'FAULT', 'state=' + d3.state);
check('code is CABLE_NOT_DETECTED', d3.fault && d3.fault.code === 'CABLE_NOT_DETECTED', d3.fault ? d3.fault.code : 'none');
check('requiresReset is true', d3.requiresReset === true);
check('all actuators OFF', allOff(d3));
check('start() refused while in FAULT', quiet(function () { return Simulation.start(); }) === false);
check('reset() succeeds once cause cleared', quiet(function () { return Simulation.reset(); }) === true);
check('state back to IDLE', Simulation.getState() === 'IDLE');

/* ---------------------------------------------------------------- */
heading('TEST 4 — cable lost during feeding -> CABLE_LOST, motor OFF');
freshMachine();
Simulation.loadCable();
quiet(function () {
  Simulation.start();
  runUntil(['FEEDING'], 600);
  Simulation.injectFault('CABLE_LOST');
  runUntil(['FAULT'], 300);
});
const d4 = Simulation.machineData();
check('state is FAULT', d4.state === 'FAULT', 'state=' + d4.state);
check('code is CABLE_LOST', d4.fault && d4.fault.code === 'CABLE_LOST', d4.fault ? d4.fault.code : 'none');
check('feed motor OFF', d4.actuators.feedMotor === false);
check('feed rollers OFF', d4.actuators.feedRollers === false);
check('position frozen, not reset to 0', d4.position > 0, 'position=' + d4.position);
check('requiresReset is true', d4.requiresReset === true);

/* ---------------------------------------------------------------- */
heading('TEST 5 — emergency stop: immediate, latched, cannot self-clear');
freshMachine();
Simulation.loadCable();
quiet(function () {
  Simulation.start();
  runUntil(['FEEDING'], 600);
  Simulation.emergencyStop();
});
const d5 = Simulation.machineData();
check('state is FAULT', d5.state === 'FAULT', 'state=' + d5.state);
check('mode is ESTOP', d5.mode === 'ESTOP', 'mode=' + d5.mode);
check('code is ESTOP_ACTIVE', d5.fault && d5.fault.code === 'ESTOP_ACTIVE', d5.fault ? d5.fault.code : 'none');
check('estopLatched is true', d5.estopLatched === true);
check('every actuator OFF', allOff(d5), JSON.stringify(d5.actuators));
check('reset() REFUSED while E-stop latched', quiet(function () { return Simulation.reset(); }) === false);
check('still in FAULT after refused reset', Simulation.getState() === 'FAULT');
quiet(function () { Simulation.releaseEmergencyStop(); });
check('reset() works after E-stop released', quiet(function () { return Simulation.reset(); }) === true);
check('state back to IDLE', Simulation.getState() === 'IDLE');

/* ---------------------------------------------------------------- */
heading('TEST 6 — encoder disagreement -> ENCODER_MISMATCH');
freshMachine();
Simulation.loadCable();
quiet(function () {
  Simulation.start();
  runUntil(['FEEDING'], 600);
  Simulation.injectFault('ENCODER_DRIFT', 5);
  runUntil(['FAULT'], 300);
});
const d6 = Simulation.machineData();
check('state is FAULT', d6.state === 'FAULT', 'state=' + d6.state);
check('code is ENCODER_MISMATCH', d6.fault && d6.fault.code === 'ENCODER_MISMATCH', d6.fault ? d6.fault.code : 'none');

/* ---------------------------------------------------------------- */
heading('TEST 7 — wrong measured length -> FAULT, not REJECT (decision D2)');
freshMachine();
Simulation.loadCable();
quiet(function () {
  Simulation.start();
  runUntil(['MEASURING'], 4000);
  Simulation.injectFault('LENGTH_OFFSET', 25);
  runUntil(['FAULT'], 300);
});
const d7 = Simulation.machineData();
check('state is FAULT', d7.state === 'FAULT', 'state=' + d7.state);
check('code is LENGTH_OUT_OF_TOLERANCE', d7.fault && d7.fault.code === 'LENGTH_OUT_OF_TOLERANCE', d7.fault ? d7.fault.code : 'none');
check('result is NOT REJECT', d7.result !== 'REJECT', 'result=' + d7.result);

/* ---------------------------------------------------------------- */
heading('TEST 8 — vision ERROR -> VISION_FAILURE (machine fault)');
freshMachine();
Simulation.loadCable();
quiet(function () {
  Simulation.start();
  runUntil(['INSPECTING'], 6000);
  Simulation.injectFault('VISION_ERROR');
  runUntil(['FAULT'], 200);
});
const d8 = Simulation.machineData();
check('state is FAULT', d8.state === 'FAULT', 'state=' + d8.state);
check('code is VISION_FAILURE', d8.fault && d8.fault.code === 'VISION_FAILURE', d8.fault ? d8.fault.code : 'none');

/* ---------------------------------------------------------------- */
heading('TEST 9 — out-of-range specimen -> REJECT with a stored reason');
freshMachine();
Simulation.loadCable();
quiet(function () {
  Simulation.start();
  runUntil(['INSPECTING'], 6000);
  Simulation.injectFault('OUT_OF_RANGE', 'thickness');
  runUntil(['IDLE'], 4000);
});
const d9 = Simulation.machineData();
check('machine finished the cycle', d9.state === 'IDLE', 'state=' + d9.state);
check('result is REJECT', d9.result === 'REJECT', 'result=' + d9.result);
check('NO fault raised (a reject is not a fault)', d9.fault === null, d9.fault ? d9.fault.code : '');
check('a reason was stored', d9.inspection.reasons.length > 0, JSON.stringify(d9.inspection.reasons));
const rec9 = Simulation.batch()[0];
check('batch record keeps the reason', !!rec9 && rec9.reasons.length > 0, JSON.stringify(rec9 && rec9.reasons));
console.log('  reason text: ' + (rec9 ? rec9.reasons[0] : 'n/a'));

/* ---------------------------------------------------------------- */
heading('TEST 10 — safety interlock blocks motion');
freshMachine();
Simulation.loadCable();
quiet(function () {
  Simulation.start();
  runUntil(['FEEDING'], 600);
  Simulation.injectFault('INTERLOCK_OPEN');
  runUntil(['FAULT'], 200);
});
const d10 = Simulation.machineData();
check('opening the guard causes a FAULT', d10.state === 'FAULT', 'state=' + d10.state);
check('code is INTERLOCK_OPEN', d10.fault && d10.fault.code === 'INTERLOCK_OPEN', d10.fault ? d10.fault.code : 'none');
check('all actuators OFF', allOff(d10));
check('reset() REFUSED while guard still open', quiet(function () { return Simulation.reset(); }) === false);
quiet(function () { Simulation.clearInjectedFaults(); });
check('reset() works once the guard is closed', quiet(function () { return Simulation.reset(); }) === true);

/* ---------------------------------------------------------------- */
heading('TEST 11 — determinism: identical runs give identical results');
function deterministicRun() {
  freshMachine();
  Simulation.loadCable();
  let data;
  quiet(function () {
    Simulation.start();
    for (let i = 0; i < 6000; i++) {
      Simulation.stopTimer();
      Simulation.tick();
      if (Simulation.getState() === 'IDLE' && i > 100) { break; }
    }
    data = Simulation.machineData();
  });
  return { position: data.position, encoder: data.encoder, result: data.result, count: data.cycleCount };
}
const runA = deterministicRun();
const runB = deterministicRun();
check('same result', runA.result === runB.result, runA.result + ' vs ' + runB.result);
check('same position', runA.position === runB.position, runA.position + ' vs ' + runB.position);
check('same encoder count', runA.encoder === runB.encoder, runA.encoder + ' vs ' + runB.encoder);

/* ---------------------------------------------------------------- */
heading('TEST 12 — architecture rules (the point of the file split)');
const fs = require('fs');
function codeOnly(file) {
  return fs.readFileSync(path.join(JS, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}
const sensorsCode = codeOnly('sensors.js');
const machineCode = codeOnly('machine.js');
const simCode = codeOnly('simulation.js');
check('sensors.js never calls Machine', sensorsCode.indexOf('Machine') === -1);
check('sensors.js never calls Simulation', sensorsCode.indexOf('Simulation') === -1);
check('sensors.js has no state names', !/(FEEDING|CUTTING|INSPECTING|PREPARING|FORMING)/.test(sensorsCode));
check('sensors.js raises no faults', sensorsCode.indexOf('raiseFault') === -1);
check('machine.js never calls Sensors', machineCode.indexOf('Sensors') === -1);
check('machine.js never calls Simulation', machineCode.indexOf('Simulation') === -1);
check('machine.js has no state names', !/(FEEDING|CUTTING|INSPECTING|PREPARING|FORMING|INITIALIZING)/.test(machineCode));
check('machine.js raises no faults', machineCode.indexOf('raiseFault') === -1 && machineCode.indexOf('FAULT') === -1);
check('machine.js does not choose the next state', machineCode.indexOf('changeState') === -1);
check('no Math.random in the whole module',
  sensorsCode.indexOf('Math.random') === -1 &&
  machineCode.indexOf('Math.random') === -1 &&
  simCode.indexOf('Math.random') === -1);

/* ---------------------------------------------------------------- */
heading('TEST 13 — a FAULT never clears by itself');
freshMachine();
Simulation.loadCable();
quiet(function () { Simulation.start(); runUntil(['FEEDING'], 600); });
quiet(function () { Simulation.injectFault('SENSOR_FAILURE', 'position'); runUntil(['FAULT'], 200); });
check('a dead sensor causes a FAULT', Simulation.getState() === 'FAULT', Simulation.getState());
quiet(function () { run(600); });
check('still in FAULT after 600 extra ticks', Simulation.getState() === 'FAULT', Simulation.getState());
check('requiresReset still set', Simulation.machineData().requiresReset === true);

/* ---------------------------------------------------------------- */
console.log('\n=====================================================');
console.log('  PASSED: ' + passed + '   FAILED: ' + failed);
console.log('=====================================================');
if (failures.length) {
  console.log('\nFailures:');
  for (let i = 0; i < failures.length; i++) { console.log('  - ' + failures[i]); }
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
  process.exit(0);
}

