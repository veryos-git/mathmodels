// Match tools/cylinder.py: 128 angular strips, 0.05 mm bonding overlap.
// Clip before bending so long triangles follow the shell instead of forming
// chords through it. The export backend caps and unions the closed solids.
export const CYLINDER_SEGMENTS = 128;
export const CYLINDER_SEAM_OVERLAP = 0.05;
export const CYLINDER_MAX_REPEAT = 12;
export const CYLINDER_MAX_COPIES = 64;

export function cylinderRepeats(c) {
  const nx=c.repeatX??1, ny=c.repeatY??1;
  if (![nx,ny].every(n=>Number.isInteger(n)&&n>=1&&n<=CYLINDER_MAX_REPEAT) || nx*ny>CYLINDER_MAX_COPIES)
    throw new Error('Use 1–12 repeats per direction, with at most 64 copies.');
  return [nx,ny];
}

// Sketch repeats (the default) sweep the frame along the repeated sketch on
// the server. `tiling` is its layout from /api/regions: the repeat period,
// the flat bounds that cover the shell exactly once, and the repeats it was
// swept for. The frame arrives as one column holding every row; copies meet
// exactly, so the turn has no seam overlap. Without `tiling` (first sweep
// then repeat) finished copies overlap 0.05 mm at their tips.

// The flat artwork around and up for these repeats, and the overlap within it.
function flatSpan(bounds, repeatX, repeatY, tiling) {
  if(tiling) {
    const [px,py]=tiling.period;
    // The frame's overhang beyond the sketch, above and below, counts once.
    const overhang=(tiling.bounds[3]-tiling.bounds[1])-tiling.repeatY*py;
    return {width:px*repeatX, height:py*repeatY+overhang, seamX:0, seamY:0};
  }
  const w=bounds[2]-bounds[0], h=bounds[3]-bounds[1];
  return {width:w*repeatX, height:h*repeatY,
    seamX:repeatX*CYLINDER_SEAM_OVERLAP, seamY:(repeatY-1)*CYLINDER_SEAM_OVERLAP};
}

// Minimize squared relative errors in diameter and container height. One
// scale applies to both drawing axes; relief depth remains in millimetres.
export function cylinderFit(bounds, c, repeatX, repeatY, mode='proportional', tiling=null) {
  cylinderRepeats({repeatX,repeatY});
  const span=flatSpan(bounds,repeatX,repeatY,tiling);
  if (!(span.width>0&&span.height>0&&c.diameter>0&&c.height>0) || ![...bounds,c.diameter,c.height].every(Number.isFinite)) return null;
  const extra=cylinderDimensions(c).height-c.height+span.seamY;
  const a=span.width/Math.PI, b=span.height, seam=span.seamX/Math.PI;
  let scale=mode==='original'?1:
    (a*(c.diameter+seam)/c.diameter**2+b*(c.height+extra)/c.height**2)/(a*a/c.diameter**2+b*b/c.height**2);
  const minRadius=c.lid?2*c.thickness+c.clearance+(c.threaded?0.4*c.pitch:0):c.thickness;
  const transition=c.lid&&c.threaded?c.thickness+c.clearance+0.4*c.pitch:0;
  const minHeight=c.bottom+(c.lid?c.neck:(c.topChamfer??0))+transition;
  if(mode!=='original') {
    const minScale=Math.max((Math.max(10,2*minRadius+1e-6)+seam)/a,
      (Math.max(5,minHeight+1e-6)+extra)/b);
    const maxScale=Math.min((500+seam)/a,(500+extra)/b);
    if(minScale>maxScale)return null;
    scale=Math.max(minScale,Math.min(maxScale,scale));
  }
  const diameter=a*scale-seam, height=b*scale-extra;
  if (diameter<10 || diameter>500 || height<5 || height>500 || diameter/2<=minRadius || height<=minHeight) return null;
  return {diameter,height,repeatX,repeatY,scale,
    error:Math.hypot((diameter-c.diameter)/c.diameter,(height-c.height)/c.height)};
}

export function cylinderSuggestions(bounds, c, mode='proportional', limit=10, tiling=null) {
  const fits=[];
  for(let nx=1;nx<=CYLINDER_MAX_REPEAT;nx++) for(let ny=1;ny<=CYLINDER_MAX_REPEAT;ny++) {
    if(nx*ny>CYLINDER_MAX_COPIES)continue;
    const fit=cylinderFit(bounds,c,nx,ny,mode,tiling);
    if(fit)fits.push(fit);
  }
  fits.sort((a,b)=>Math.abs(a.error-b.error)>1e-10?a.error-b.error:
    Math.abs(Math.log(a.scale))-Math.abs(Math.log(b.scale)) || a.repeatX*a.repeatY-b.repeatX*b.repeatY);
  // Multiples of the same repeat ratio give nearly identical dimensions.
  // Keep the best fit, breaking ties by scale closest to the original size.
  const unique=[];
  for(const fit of fits) {
    if(mode!=='original' && unique.some(f=>f.repeatX*fit.repeatY===fit.repeatX*f.repeatY))continue;
    unique.push(fit);
    if(unique.length>=limit)break;
  }
  return unique;
}

export function cylinderDimensions(c) {
  if(c.lid&&c.threaded&&c.threadedDesign) {
    const shoulder=c.height-c.neck+c.threadedDesign.stop;
    return {shoulder,height:shoulder+c.threadedDesign.lidHeight};
  }
  return { shoulder: c.lid ? c.height-c.neck : c.height,
    height: c.lid ? c.height+0.2+c.lidTop : c.height };
}

export function cylinderBevels(c, part) {
  if(!c.lid)return c.topChamfer>0?[c.height-c.topChamfer]:[];
  const d=c.lid&&c.threaded?c.threadedDesign:null;
  if(!d)return [];
  const {shoulder,height}=cylinderDimensions(c), base=c.height-c.neck;
  return part==='body'?[d.baseBottomChamfer,base-d.baseTopChamfer,base]:
    [shoulder+d.lidBottomChamfer,height-d.lidTopChamfer];
}

export function cylinderSurfaceInset(z, c, part) {
  if(!c.lid)return Math.max(0,Math.min(c.topChamfer??0,z-c.height+(c.topChamfer??0)));
  const d=c.lid&&c.threaded?c.threadedDesign:null;
  if(!d)return 0;
  const {shoulder,height}=cylinderDimensions(c), base=c.height-c.neck;
  if(part==='body')return Math.max(0,d.baseBottomChamfer-z,
    Math.min(d.baseTopChamfer,z-(base-d.baseTopChamfer)));
  return Math.max(0,d.lidBottomChamfer-(z-shoulder),d.lidTopChamfer-(height-z));
}

export function cylinderPoint([x,y,z], bounds, c, part, seam=CYLINDER_SEAM_OVERLAP) {
  const [x0,y0,x1,y1] = bounds;
  const angle = ((x-x0)/(x1-x0)-.5)*(2*Math.PI+seam/(c.diameter/2))+Math.PI;
  const height=(y-y0)/(y1-y0)*cylinderDimensions(c).height;
  const r = c.diameter/2-cylinderSurfaceInset(height,c,part??(height<cylinderDimensions(c).shoulder?'body':'lid'))-0.05+z;
  const cx=Math.cos(angle), cy=Math.sin(angle);
  return [r*(Math.abs(cx)<1e-12?0:cx), r*(Math.abs(cy)<1e-12?0:cy),
    height];
}

function clip(poly, axis, value, greater) {
  const out = [];
  for (let i=0; i<poly.length; i++) {
    const a=poly[i], b=poly[(i+1)%poly.length];
    const da=(a[axis]-value)*(greater?1:-1), db=(b[axis]-value)*(greater?1:-1);
    if (da>=0) out.push(a);
    if ((da<0 && db>0)||(da>0 && db<0)) {
      const t=da/(da-db);
      const p=a.map((v,k)=>v+t*(b[k]-v)); p[axis]=value; out.push(p);
    }
  }
  return out;
}

function bevelBands(poly, levels) {
  let bands=[poly];
  for(const y of levels)bands=bands.flatMap(p=>Math.min(...p.map(v=>v[1]))<y&&Math.max(...p.map(v=>v[1]))>y?
    [clip(p,1,y,false),clip(p,1,y,true)]:[p]);
  return bands;
}

// The strip that wraps once, its seam overlap, and where each copy sits in it.
// With `tiling` the frame column already holds every row: it only repeats around.
function cylinderLayout(bounds, c, tiling) {
  const [nx,ny]=cylinderRepeats(c);
  const grid=(stepX,stepY,rows)=>Array.from({length:nx*rows},(_,i)=>[Math.floor(i/rows)*stepX,(i%rows)*stepY]);
  if(tiling) {
    if(tiling.repeatX!==nx||tiling.repeatY!==ny)throw new Error('The frame was swept for other repeats. Generate the model again.');
    const [px,py]=tiling.period;
    return {bounds:tiling.bounds, seam:0, copies:grid(px,py,ny), columns:grid(px,0,1)};
  }
  const width=bounds[2]-bounds[0], tileHeight=bounds[3]-bounds[1];
  // Bond each repeat with a 0.05 mm overlap. Merely touching tips become
  // non-manifold STL edges, just as they do at the full-turn seam.
  const sx=(Math.PI*c.diameter+nx*CYLINDER_SEAM_OVERLAP)/(width*nx);
  const sy=(cylinderDimensions(c).height+(ny-1)*CYLINDER_SEAM_OVERLAP)/(tileHeight*ny);
  const stepX=width-CYLINDER_SEAM_OVERLAP/sx, stepY=tileHeight-CYLINDER_SEAM_OVERLAP/sy;
  const copies=grid(stepX,stepY,ny);
  return {bounds:[bounds[0],bounds[1],bounds[0]+width+(nx-1)*stepX,bounds[1]+tileHeight+(ny-1)*stepY],
    seam:CYLINDER_SEAM_OVERLAP, copies, columns:copies};
}

// `frame`: these triangles are the swept frame, which `tiling` already repeats up.
export function wrapCylinderTriangles(positions, bounds, c, {tiling=null, frame=false}={}) {
  if (bounds.some(v=>!Number.isFinite(v)) || bounds[2]<=bounds[0] || bounds[3]<=bounds[1]) throw new Error('The drawing needs a positive width and height to wrap.');
  const layout=cylinderLayout(bounds,c,tiling);
  bounds=layout.bounds;
  const turn=bounds[2]-bounds[0];
  const result={ body:[], lid:[] };
  const { shoulder, height }=cylinderDimensions(c);
  const dx=(bounds[2]-bounds[0])/CYLINDER_SEGMENTS;
  for(const [ox,oy] of frame?layout.columns:layout.copies) for(let i=0;i<positions.length;i+=9) {
    const placed=[0,3,6].map(k=>[positions[i+k]+ox,positions[i+k+1]+oy,positions[i+k+2]]);
    // With sketch repeats, whatever reaches past either end continues on the other.
    const shifts=[0];
    if(tiling&&Math.min(...placed.map(p=>p[0]))<bounds[0])shifts.push(turn);
    if(tiling&&Math.max(...placed.map(p=>p[0]))>bounds[2])shifts.push(-turn);
    for(const shift of shifts) for(const part of c.lid?['body','lid']:['body']) {
      const triangle=shift?placed.map(([x,y,z])=>[x+shift,y,z]):placed;
      let poly=triangle;
      if(c.lid) {
        const cut=bounds[1]+(shoulder+(part==='lid'?1:-1)*c.seamGap/2)/height*(bounds[3]-bounds[1]);
        poly=clip(poly,1,cut,part==='lid');
      }
      if(poly.length<3)continue;
      const first=Math.max(0,Math.floor((Math.min(...poly.map(p=>p[0]))-bounds[0])/dx));
      const last=Math.min(CYLINDER_SEGMENTS-1,Math.floor((Math.max(...poly.map(p=>p[0]))-bounds[0])/dx));
      for(let s=first;s<=last;s++) {
        const strip=clip(clip(poly,0,bounds[0]+s*dx,true),0,bounds[0]+(s+1)*dx,false);
        if(strip.length<3)continue;
        const levels=cylinderBevels(c,part).map(z=>bounds[1]+z/height*(bounds[3]-bounds[1]));
        for(const band of bevelBands(strip,levels)) {
          const points=band.map(p=>cylinderPoint(p,bounds,c,part,layout.seam));
          for(let k=1;k<points.length-1;k++)result[part].push(...points[0],...points[k],...points[k+1]);
        }
      }
    }
  }
  return { body:new Float32Array(result.body), lid:new Float32Array(result.lid) };
}
