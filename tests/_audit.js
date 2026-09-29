const path=require('path'); const JS=path.join(__dirname,'..','js');
const Sensors=require(path.join(JS,'sensors.js'));
const Machine=require(path.join(JS,'machine.js'));
global.Sensors=Sensors; global.Machine=Machine; global.MACHINE_CONFIG=null;
const Simulation=require(path.join(JS,'simulation.js'));
const L=console.log; console.log=function(){};
function fresh(){Simulation.init();Simulation.clearInjectedFaults();Simulation.clearBatch();Simulation.reset();Simulation.unloadCable();}
function to(states,max){const t=Array.isArray(states)?states:[states];for(let i=0;i<max;i++){Simulation.stopTimer();if(t.indexOf(Simulation.getState())!==-1)return true;Simulation.tick();}return t.indexOf(Simulation.getState())!==-1;}
const allOff=d=>Object.keys(d.actuators).every(k=>d.actuators[k]===false);

console.log=function(){};
fresh(); Simulation.loadCable(); Simulation.start();
const ok=to(['IDLE'],8000);
const d=Simulation.machineData();
console.log= L;
console.log('FLOW 1 NORMAL CYCLE : reached IDLE =',ok,'| result =',d.result,'| cycles =',d.cycleCount,'| fault =',d.fault);

console.log=function(){};
fresh(); Simulation.loadCable(); Simulation.start(); to(['FEEDING'],600);
Simulation.emergencyStop();
let e=Simulation.machineData();
const a=JSON.stringify({state:e.state,mode:e.mode,actOff:allOff(e),req:e.estopLatched,rr:e.requiresReset});
const blocked=(Simulation.reset()===false);
Simulation.releaseEmergencyStop();
const stillRR=Simulation.machineData().requiresReset===true;
const okReset=Simulation.reset();
const f=Simulation.machineData();
console.log= L;
console.log('FLOW 2 E-STOP       :',a);
console.log('                   reset refused =',blocked,'| still requiresReset after release =',stillRR,'| reset ok =',okReset,'| final state =',f.state);

console.log=function(){};
fresh(); Simulation.loadCable(); Simulation.start(); to(['INSPECTING'],8000);
Simulation.injectFault('VISION_ERROR'); to(['FAULT'],200);
let v=Simulation.machineData();
console.log= L;
console.log('FLOW 3 VISION ERROR : state =',v.state,'| code =',v.fault&&v.fault.code,'| visionResult =',v.sensors.visionResult,'| allOff =',allOff(v));

console.log=function(){};
fresh(); Simulation.loadCable(); Simulation.start(); to(['INSPECTING'],8000);
Simulation.injectFault('OUT_OF_RANGE','thickness'); to(['IDLE'],8000);
let b=Simulation.machineData();
console.log= L;
console.log('FLOW 4 BAD SPECIMEN : state =',b.state,'| result =',b.result,'| fault =',b.fault,'| reasons =',JSON.stringify(b.inspection.reasons));
