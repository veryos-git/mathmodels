// RGB transmission curves interpolate in optical-density space. Measurements
// use the same backlight as the intended model; mixed stacks multiply channels.
const linear = (v) => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4;
const srgb = (v) => v <= .0031308 ? 12.92*v : 1.055*v**(1/2.4)-.055;
const channels = (hex) => [1,3,5].map((i) => linear(parseInt(hex.slice(i,i+2),16)/255));
const hexColor = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0,Math.min(1,srgb(v)))*255).toString(16).padStart(2,'0')).join('');
export function transmission(filament, thickness) {
  const points = [{ thickness:0, color:'#ffffff' }, ...(filament.samples.length ? filament.samples : [{thickness:1,color:filament.color}])];
  let index = points.findIndex((p) => p.thickness >= thickness);
  if (index < 0) index = points.length-1;
  index = Math.max(1,index);
  const a = points[index-1], b = points[index];
  const t = (thickness-a.thickness)/(b.thickness-a.thickness);
  const low = channels(a.color), high = channels(b.color);
  return low.map((v,i) => Math.min(1,Math.exp(Math.log(Math.max(v,1e-6))*(1-t)+Math.log(Math.max(high[i],1e-6))*t)));
}
export function initFilaments({ changed, layerHeight }) {
  let library = [], assignments = [null,null,null,null], editing = null, patches = [];
  const dialog = document.createElement('dialog'); dialog.className = 'workflow-dialog';
  dialog.innerHTML = `<header><strong>Filaments & calibration</strong><button id="filamentClose" type="button">Close</button></header>
    <p>1. Choose a filament. 2. Print the numbered thickness tabs at 100% infill with the chosen layer height. 3. Compare each tab against the intended backlight and match its color below.</p>
    <div class="filament-layout"><section><label>Saved filaments<select id="filamentList"></select></label><button id="filamentNew">New filament</button><button class="ghost" id="filamentDuplicate">Duplicate</button><button class="ghost" id="filamentDelete">Delete</button><div id="filamentAssignments"></div></section>
    <form id="filamentForm"><label>Name<input id="filamentName" required maxlength="120"></label>
      <div class="row"><label>Brand<input id="filamentBrand"></label><label>Material<input id="filamentMaterial" placeholder="PLA"></label></div>
      <div class="row"><label>Base color<input type="color" id="filamentColor" value="#22aabb"></label><label>Print layer (mm)<input type="number" min="0.05" max="1" step="0.01" id="filamentLayer" value="0.2" required></label></div>
      <div class="row"><label>Patch count<input id="filamentCount" type="number" value="10" min="2" max="16"></label><label>Layers per step<input id="filamentStep" type="number" value="1" min="1" max="20"></label></div>
      <button type="button" id="filamentPatches">Set patch thicknesses</button><button type="button" id="filamentCoupon">Download numbered coupon STL</button>
      <div id="filamentSamples" class="calibration-patches"></div>
      <label class="check"><input type="checkbox" id="filamentMeasured"> I matched these colors to my printed, backlit tabs</label>
      <p class="muted">Unmeasured filaments use an estimate. Calibration describes this filament and backlight; mixed-color stacks use an optical approximation.</p>
      <button type="submit">Save filament</button>
    </form></div><p id="filamentStatus" role="status"></p>`;
  document.body.append(dialog);
  const $ = (id) => dialog.querySelector('#'+id);
  const status = (text) => $('filamentStatus').textContent=text;
  async function request(path='', options={}) {
    const r=await fetch('/api/filaments'+path,options), body=await r.json();
    if(!r.ok) throw new Error(body.error??r.statusText); return body;
  }
  function renderAssignments() {
    const box=$('filamentAssignments'); box.replaceChildren();
    assignments.forEach((f,i) => {
      const label=document.createElement('label'); label.textContent=`Palette row ${i+1}`;
      const select=document.createElement('select'); select.add(new Option('Unassigned — palette hue',''));
      for (const item of library) select.add(new Option(item.name+(item.samples.length?' · calibrated':' · estimated'),item.id));
      if(f&&!library.some((r)=>r.id===f.id)) select.add(new Option(f.name+' · project copy',f.id));
      select.value=f?.id??''; select.onchange=()=>{assignments[i]=structuredClone(library.find((r)=>r.id===select.value)??null);changed();};
      label.append(select);box.append(label);
    });
  }
  async function refresh() {
    library=(await request()).filaments;
    const list=$('filamentList');list.replaceChildren(new Option('Choose filament',''));
    for(const f of library)list.add(new Option(f.name,f.id));
    list.value=editing?.id??'';renderAssignments();
  }
  function renderPatches() {
    const box=$('filamentSamples');box.replaceChildren();
    patches.forEach((p,i)=>{
      const label=document.createElement('label');label.textContent=`${i+1}: ${p.thickness.toFixed(2)} mm`;
      const color=document.createElement('input');color.type='color';color.value=p.color;
      color.oninput=()=>p.color=color.value;label.append(color);box.append(label);
    });
  }
  function newPatches() {
    const n=Number($('filamentCount').value), step=Number($('filamentStep').value), lh=Number($('filamentLayer').value);
    if(!Number.isInteger(n)||n<2||n>16||!Number.isInteger(step)||step<1||!(lh>=.05&&lh<=1)||n*step*lh>10)throw new Error('Use 2–16 tabs and whole layer steps, up to 10 mm thick.');
    patches=Array.from({length:n},(_,i)=>{const thickness=+(lh*step*(i+1)).toFixed(4);return {thickness,color:hexColor(transmission({samples:[],color:$('filamentColor').value},thickness))};});
    $('filamentMeasured').checked=false;renderPatches();
  }
  function edit(f) {
    editing=f; $('filamentName').value=f?.name??''; $('filamentBrand').value=f?.brand??'';$('filamentMaterial').value=f?.material??'PLA';
    $('filamentColor').value=f?.color??'#22aabb';$('filamentLayer').value=f?.layerHeight??Math.max(.05,Math.min(1,layerHeight()));
    patches=structuredClone(f?.samples??[]);$('filamentMeasured').checked=!!patches.length;
    if(!patches.length)newPatches();else renderPatches();status('');
  }
  const safe=(fn)=>async(e)=>{try{await fn(e);}catch(error){status(error.message);}};
  $('filamentClose').onclick=()=>dialog.close();
  $('filamentList').onchange=()=>edit(library.find((f)=>f.id===$('filamentList').value));
  $('filamentNew').onclick=()=>{edit(null);$('filamentList').value='';};
  $('filamentDuplicate').onclick=()=>{if(editing){edit({...structuredClone(editing),id:null,name:editing.name+' copy'});$('filamentList').value='';}};
  $('filamentPatches').onclick=safe(newPatches);
  $('filamentDelete').onclick=safe(async()=>{
    if(!editing?.id||!confirm(`Delete “${editing.name}”? Saved projects keep their calibration copies.`))return;
    await request('/'+editing.id,{method:'DELETE'});edit(null);await refresh();
  });
  $('filamentForm').onsubmit=safe(async(e)=>{
    e.preventDefault();
    const f={name:$('filamentName').value,brand:$('filamentBrand').value,material:$('filamentMaterial').value,color:$('filamentColor').value,layerHeight:+$('filamentLayer').value,samples:$('filamentMeasured').checked?patches:[]};
    const saved=await request(editing?.id?'/'+editing.id:'',{method:editing?.id?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(f)});
    assignments=assignments.map((item)=>item?.id===saved.id?structuredClone(saved):item);
    edit(saved);await refresh();changed();status('Saved. Assign this filament to a palette row to use it in the model preview.');
  });
  $('filamentCoupon').onclick=safe(async()=>{
    const button=$('filamentCoupon');button.disabled=true;status('Generating coupon…');
    try{
      const r=await fetch('/api/calibration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({layerHeight:+$('filamentLayer').value,thicknesses:patches.map((p)=>p.thickness)})});
      if(!r.ok)throw new Error((await r.json()).error);
      const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download='filament-calibration.stl';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      status('Tabs are numbered left to right. Match the numbered colors after printing. The raised numbers are on the handling spine, outside the samples.');
    }finally{button.disabled=false;}
  });
  return {
    async open(){try{if(!editing)edit(null);dialog.showModal();await refresh();}catch(e){status(e.message);}},
    snapshot:()=>structuredClone(assignments),
    restore:(value)=>{assignments=[0,1,2,3].map((i)=>value?.[i]?structuredClone(value[i]):null);},
    clear:(i)=>{assignments[i]=null;},
    color:(i,t)=>assignments[i]?hexColor(transmission(assignments[i],t)):null,
    name:(i)=>assignments[i]?.name??null,
    stackColor:(stack)=>{
      if(!stack.length||stack.some((p)=>!assignments[p.hue]))return null;
      return hexColor(stack.reduce((rgb,p)=>transmission(assignments[p.hue],p.t).map((c,i)=>c*rgb[i]),[1,1,1]));
    },
  };
}
