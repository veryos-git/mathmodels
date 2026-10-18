import assert from 'node:assert/strict';
import { CYLINDER_SEAM_OVERLAP, cylinderDimensions, cylinderFit, cylinderSuggestions, cylinderPoint, cylinderSurfaceInset, wrapCylinderTriangles } from '../static/cylinder.js';

// Earlier saved dimensions still work without threaded-design metadata.
const c={diameter:60,height:60,thickness:2.4,bottom:2.4,lidTop:2.4,
  neck:6,pitch:1,clearance:.15,seamGap:.2,lid:true,threaded:true};
const bounds=[-10,5,90,55];
assert.deepEqual(cylinderDimensions(c),{shoulder:54,height:62.6});
const start=cylinderPoint([-10,5,1],bounds,c),end=cylinderPoint([90,5,1],bounds,c);
assert.ok(start[1]<0 && end[1]>0,'artwork overlaps at the wrap seam');
assert.ok(Math.abs(Math.hypot(...start.map((v,i)=>v-end[i]))-CYLINDER_SEAM_OVERLAP*30.95/30)<1e-6);
assert.ok(Math.abs(Math.hypot(start[0],start[1])-30.95)<1e-10);
assert.equal(cylinderPoint([-10,55,1],bounds,c)[2],62.6);
// A large face crosses both the full circumference and the lid seam.
const parts=wrapCylinderTriangles(new Float64Array([-10,5,1,90,5,1,90,55,1,-10,5,1,90,55,1,-10,55,1]),bounds,c);
assert.ok(parts.body.length>1000 && parts.lid.length>1000,'long triangles subdivide');
for(const [part,positions] of Object.entries(parts)) {
  for(let i=0;i<positions.length;i+=3) {
    assert.ok(Math.abs(Math.hypot(positions[i],positions[i+1])-30.95)<1e-4,'radial relief preserved');
    assert.ok(part==='body'?positions[i+2]<=53.90001:positions[i+2]>=54.09999,'artwork clears lid seam');
  }
  for(let i=0;i<positions.length;i+=9) {
    const angles=[0,3,6].map(k=>Math.atan2(positions[i+k+1],positions[i+k]));
    for(let j=1;j<3;j++) assert.ok(Math.abs(Math.atan2(Math.sin(angles[j]-angles[0]),Math.cos(angles[j]-angles[0])))<=(2*Math.PI+CYLINDER_SEAM_OVERLAP/30)/128+1e-5,'no chord through shell');
  }
}
assert.equal(wrapCylinderTriangles(new Float64Array([-10,5,0,90,5,0,90,55,0]),bounds,{...c,lid:false}).lid.length,0);
for(const lid of [false,true]) {
  const target={...c,lid,diameter:64,height:72};
  const fits=cylinderSuggestions(bounds,target);
  assert.equal(fits.length,10);
  for(const [i,f] of fits.entries()) {
    const sx=(Math.PI*f.diameter+f.repeatX*CYLINDER_SEAM_OVERLAP)/(100*f.repeatX);
    const sy=(cylinderDimensions({...target,...f}).height+(f.repeatY-1)*CYLINDER_SEAM_OVERLAP)/(50*f.repeatY);
    assert.ok(Math.abs(sx-sy)<1e-12,'one scale for both artwork axes');
    assert.ok(Math.abs(sx-f.scale)<1e-12);
    if(i)assert.ok(f.error>=fits[i-1].error-1e-10,'nearest dimensions first');
    assert.ok(f.repeatX*f.repeatY<=64);
  }
  assert.ok(fits[0].error<=cylinderFit(bounds,target,1,1).error);
  const native=cylinderSuggestions(bounds,target,'original');
  assert.equal(native.length,10);
  for(const f of native)assert.equal(f.scale,1);
}
const exact={...c,lid:false,diameter:(300-3*CYLINDER_SEAM_OVERLAP)/Math.PI,height:100-CYLINDER_SEAM_OVERLAP};
const best=cylinderSuggestions(bounds,exact)[0];
assert.equal(best.repeatX,3);assert.equal(best.repeatY,2);
assert.ok(best.error<1e-12);assert.ok(Math.abs(best.scale-1)<1e-12);
assert.deepEqual(cylinderSuggestions([0,0,0,0],c),[]);
const constrained=cylinderFit(bounds,{...c,diameter:10,height:5},1,1);
assert.ok(constrained&&constrained.height>c.bottom+c.neck,'closest fit respects bottom and neck');
assert.ok(constrained.height>c.bottom+c.neck+c.thickness+c.clearance+0.4*c.pitch,'closest fit leaves space for the threaded neck transition');
assert.ok(constrained.diameter/2>2*c.thickness+c.clearance+0.4*c.pitch,'closest fit respects thread walls');
assert.throws(()=>wrapCylinderTriangles(new Float64Array(),bounds,{...c,repeatX:13}));
// A small inset triangle repeated in both directions retains six copies.
const motif=new Float64Array([0,10,1,5,10,1,5,15,1]);
const repeated=wrapCylinderTriangles(motif,bounds,{...exact,repeatX:3,repeatY:2});
const z=Array.from(repeated.body).filter((_,i)=>i%3===2);
assert.ok(z.some(v=>v<20)&&z.some(v=>v>50));
const quadrants=new Set();
for(let i=0;i<repeated.body.length;i+=3)quadrants.add(Math.floor((Math.atan2(repeated.body[i+1],repeated.body[i])+2*Math.PI)%(2*Math.PI)/(2*Math.PI/3)));
assert.equal(quadrants.size,3);
const design={lidHeight:20,stop:.2,baseTopChamfer:.5,baseBottomChamfer:.5,lidTopChamfer:.5,lidBottomChamfer:.5};
const scad={...c,diameter:40,height:70,thickness:1.2,bottom:1.2,lidTop:1.2,neck:10,pitch:2,threadedDesign:design};
assert.deepEqual(cylinderDimensions(scad),{shoulder:60.2,height:80.2});
for(const fit of cylinderSuggestions(bounds,scad)) {
  assert.ok(Math.abs((Math.PI*fit.diameter+fit.repeatX*CYLINDER_SEAM_OVERLAP)/(100*fit.repeatX)-
    (cylinderDimensions({...scad,...fit}).height+(fit.repeatY-1)*CYLINDER_SEAM_OVERLAP)/(50*fit.repeatY))<1e-12);
}
const beveled=wrapCylinderTriangles(new Float64Array([-10,5,1,90,5,1,90,55,1]),bounds,scad);
for(const [part,positions] of Object.entries(beveled))for(let i=0;i<positions.length;i+=3) {
  assert.ok(Math.abs(Math.hypot(positions[i],positions[i+1])-(20.95-cylinderSurfaceInset(positions[i+2],scad,part)))<1e-4,'artwork follows the default chamfers');
  assert.ok(part==='body'?positions[i+2]<=60.10001:positions[i+2]>=60.29999,'seam follows the raised alignment stop');
}
console.log('Cylinder preview: proportions, suggestions, repetitions, curvature, default chamfers and lid seam passed');
