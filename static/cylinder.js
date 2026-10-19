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

// Minimize squared relative errors in diameter and container height. One
// scale applies to both drawing axes; relief depth remains in millimetres.
export function cylinderFit(bounds, c, repeatX, repeatY, mode='proportional') {
  const w=bounds[2]-bounds[0], h=bounds[3]-bounds[1];
  cylinderRepeats({repeatX,repeatY});
  if (!(w>0&&h>0&&c.diameter>0&&c.height>0) || ![...bounds,c.diameter,c.height].every(Number.isFinite)) return null;
  const extra=cylinderDimensions(c).height-c.height+(repeatY-1)*CYLINDER_SEAM_OVERLAP;
  const a=w*repeatX/Math.PI, b=h*repeatY, seam=repeatX*CYLINDER_SEAM_OVERLAP/Math.PI;
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

export function cylinderSuggestions(bounds, c, mode='proportional', limit=10) {
  const fits=[];
  for(let nx=1;nx<=CYLINDER_MAX_REPEAT;nx++) for(let ny=1;ny<=CYLINDER_MAX_REPEAT;ny++) {
    if(nx*ny>CYLINDER_MAX_COPIES)continue;
    const fit=cylinderFit(bounds,c,nx,ny,mode);
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

export function cylinderPoint([x,y,z], bounds, c, part) {
  const [x0,y0,x1,y1] = bounds;
  const angle = ((x-x0)/(x1-x0)-.5)*(2*Math.PI+CYLINDER_SEAM_OVERLAP/(c.diameter/2))+Math.PI;
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

export function wrapCylinderTriangles(positions, bounds, c) {
  if (bounds.some(v=>!Number.isFinite(v)) || bounds[2]<=bounds[0] || bounds[3]<=bounds[1]) throw new Error('The drawing needs a positive width and height to wrap.');
  const [nx,ny]=cylinderRepeats(c);
  const width=bounds[2]-bounds[0], tileHeight=bounds[3]-bounds[1];
  // Bond each repeat with a 0.05 mm overlap. Merely touching tips become
  // non-manifold STL edges, just as they do at the full-turn seam.
  const sx=(Math.PI*c.diameter+nx*CYLINDER_SEAM_OVERLAP)/(width*nx);
  const sy=(cylinderDimensions(c).height+(ny-1)*CYLINDER_SEAM_OVERLAP)/(tileHeight*ny);
  const stepX=width-CYLINDER_SEAM_OVERLAP/sx, stepY=tileHeight-CYLINDER_SEAM_OVERLAP/sy;
  bounds=[bounds[0],bounds[1],bounds[0]+width+(nx-1)*stepX,bounds[1]+tileHeight+(ny-1)*stepY];
  const result={ body:[], lid:[] };
  const { shoulder, height }=cylinderDimensions(c);
  const dx=(bounds[2]-bounds[0])/CYLINDER_SEGMENTS;
  for(let ix=0;ix<nx;ix++) for(let iy=0;iy<ny;iy++) for(let i=0;i<positions.length;i+=9) {
    const triangle=[0,3,6].map(k=>[positions[i+k]+ix*stepX,positions[i+k+1]+iy*stepY,positions[i+k+2]]);
    for(const part of c.lid?['body','lid']:['body']) {
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
          const points=band.map(p=>cylinderPoint(p,bounds,c,part));
          for(let k=1;k<points.length-1;k++)result[part].push(...points[0],...points[k],...points[k+1]);
        }
      }
    }
  }
  return { body:new Float32Array(result.body), lid:new Float32Array(result.lid) };
}
