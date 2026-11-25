// Stone look: the frame of a model shown as carved, veined marble instead of
// its flat preview colour. Only the preview changes — the exported solid is
// the same either way. The look is three things: veining computed in the
// shader from where a point sits in the model (the meshes carry no UVs),
// facets blended into round mouldings with their arrises kept sharp, and a
// low sun that casts shadows across the relief. The same look can be taken
// as a finished picture, lit far more carefully than a live view can afford.

// Facets meeting at less than this are one curved surface; at more, an arris.
const CREASE = Math.PI * 2 / 9;
// Where the stone's sun stands, seen from the model (which is Z-up).
const SUN = [-0.62, -0.45, 0.64];
// How much of the sun and of the sky stone takes, against the flat preview
// colours, and the warm light that comes back up at it from below.
const SUN_GAIN = 1.35, SKY_GAIN = 0.8;
const BOUNCE = [0.43, 0.33, 0.22];

/**
 * Normals for a triangle soup (three corners per triangle, no index), blended
 * across every edge shallower than `angle` and left sharp across the others.
 * Corners count as one vertex when they sit on exactly the same point, which
 * is how STL and extruded meshes repeat a vertex for each of its triangles.
 * The corners of a zero-area triangle come back as zero vectors.
 */
export function creasedNormals(position, angle = CREASE) {
  const corners = Math.floor(position.length / 9) * 3;
  const out = new Float32Array(corners * 3);
  if (!corners) return out;

  // Adding zero folds -0 into +0, so equal points have equal bits.
  const point = new Float32Array(corners * 3);
  for (let i = 0; i < point.length; i++) point[i] = position[i] + 0;
  const bits = new Uint32Array(point.buffer);
  let size = 1;
  while (size < corners * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const vertex = new Int32Array(corners);
  let vertices = 0;
  for (let c = 0; c < corners; c++) {
    const x = bits[3 * c], y = bits[3 * c + 1], z = bits[3 * c + 2];
    // Round coordinates leave a float's low bits empty, so the high ones are
    // folded down before the table size masks them off.
    let h = Math.imul(x ^ (x >>> 16), 0x85ebca6b) ^ y;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) ^ z;
    h = Math.imul(h ^ (h >>> 16), 0x27d4eb2f);
    let slot = (h ^ (h >>> 15)) & (size - 1);
    for (;;) {
      const other = table[slot];
      if (other < 0) { table[slot] = c; vertex[c] = vertices++; break; }
      if (bits[3 * other] === x && bits[3 * other + 1] === y && bits[3 * other + 2] === z) {
        vertex[c] = vertex[other];
        break;
      }
      slot = (slot + 1) & (size - 1);
    }
  }

  // Each triangle's unit normal, and for each corner the angle the triangle
  // spans there: a long sliver should not outweigh the broad facet next to it.
  const faceNormal = new Float32Array(corners);
  const weight = new Float32Array(corners);
  for (let f = 0; f < corners; f += 3) {
    const o = 3 * f;
    const ux = point[o + 3] - point[o], uy = point[o + 4] - point[o + 1], uz = point[o + 5] - point[o + 2];
    const vx = point[o + 6] - point[o], vy = point[o + 7] - point[o + 1], vz = point[o + 8] - point[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 0)) continue;
    faceNormal[f] = nx / length; faceNormal[f + 1] = ny / length; faceNormal[f + 2] = nz / length;
    const wx = vx - ux, wy = vy - uy, wz = vz - uz;
    weight[f] = Math.atan2(length, ux * vx + uy * vy + uz * vz);
    weight[f + 1] = Math.atan2(length, -(ux * wx + uy * wy + uz * wz));
    weight[f + 2] = Math.atan2(length, vx * wx + vy * wy + vz * wz);
  }

  // Which corners meet at each vertex.
  const start = new Int32Array(vertices + 1);
  for (let c = 0; c < corners; c++) start[vertex[c] + 1]++;
  for (let v = 0; v < vertices; v++) start[v + 1] += start[v];
  const next = start.slice(0, vertices);
  const around = new Int32Array(corners);
  for (let c = 0; c < corners; c++) around[next[vertex[c]]++] = c;

  const limit = Math.cos(angle);
  for (let c = 0; c < corners; c++) {
    const f = c - c % 3, nx = faceNormal[f], ny = faceNormal[f + 1], nz = faceNormal[f + 2];
    let x = 0, y = 0, z = 0;
    for (let i = start[vertex[c]], end = start[vertex[c] + 1]; i < end; i++) {
      const other = around[i], g = other - other % 3;
      const ox = faceNormal[g], oy = faceNormal[g + 1], oz = faceNormal[g + 2];
      if (ox * nx + oy * ny + oz * nz < limit) continue;
      x += weight[other] * ox; y += weight[other] * oy; z += weight[other] * oz;
    }
    const length = Math.hypot(x, y, z);
    if (!(length > 0)) continue;
    out[3 * c] = x / length; out[3 * c + 1] = y / length; out[3 * c + 2] = z / length;
  }
  return out;
}

const VERTEX_PARS = /* glsl */`
varying vec3 vStonePos;
`;

const VERTEX = /* glsl */`
vStonePos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const FRAGMENT_PARS = /* glsl */`
uniform float stoneScale;
uniform float stoneTint;
uniform vec3 stoneGain;
uniform vec3 stoneSky;
uniform vec3 stoneBounce;
varying vec3 vStonePos;

float stoneHash( vec3 p ) {
	p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
	p += dot( p, p.yxz + 33.33 );
	return fract( ( p.x + p.y ) * p.z );
}

// Smooth noise in 0..1, with how fast it changes along each axis in yzw.
vec4 stoneNoise( vec3 p ) {
	vec3 i = floor( p ), f = fract( p );
	vec3 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
	vec3 du = 30.0 * f * f * ( f * ( f - 2.0 ) + 1.0 );
	float a = stoneHash( i ), b = stoneHash( i + vec3( 1, 0, 0 ) );
	float c = stoneHash( i + vec3( 0, 1, 0 ) ), d = stoneHash( i + vec3( 1, 1, 0 ) );
	float e = stoneHash( i + vec3( 0, 0, 1 ) ), g = stoneHash( i + vec3( 1, 0, 1 ) );
	float h = stoneHash( i + vec3( 0, 1, 1 ) ), k = stoneHash( i + vec3( 1, 1, 1 ) );
	float x = b - a, y = c - a, z = e - a;
	float xy = a - b - c + d, yz = a - c - e + h, zx = a - b - e + g;
	float xyz = - a + b + c - d + e - g - h + k;
	return vec4(
		a + x * u.x + y * u.y + z * u.z + xy * u.x * u.y + yz * u.y * u.z + zx * u.z * u.x + xyz * u.x * u.y * u.z,
		du * vec3( x + xy * u.y + zx * u.z + xyz * u.y * u.z,
			y + yz * u.z + xy * u.x + xyz * u.z * u.x,
			z + zx * u.x + yz * u.y + xyz * u.x * u.y ) );
}

// Each octave is turned as well as doubled, so the lattice never lines up.
const mat3 STONE_TURN = mat3( 0.00, 1.60, 1.20, -1.60, 0.72, -0.96, -1.20, -0.96, 1.28 );

// Octaves of that noise: again a value in 0..1 with its rates of change.
vec4 stoneFbm( vec3 p, int octaves ) {
	vec4 sum = vec4( 0.0 );
	float amp = 0.5, total = 0.0;
	mat3 turned = mat3( 1.0 );
	for ( int i = 0; i < octaves; i ++ ) {
		vec4 n = stoneNoise( p );
		sum += amp * vec4( n.x, n.yzw * turned );
		total += amp;
		p = STONE_TURN * p + 7.3;
		turned = STONE_TURN * turned;
		amp *= 0.5;
	}
	return sum / total;
}

// A vein is a thin sheet through the stone, where a field passes 0.5. The
// field's value over how fast it changes is how far away that sheet is, so a
// vein keeps its width wherever the field is steep and cannot pool into a blot
// where it is nearly flat. It shows width veining units to each side, and
// never thinner than a pixel. Around a peak or a dip that only just reaches
// 0.5 the sheet closes into a bubble, which no vein does, so it fades there.
float stoneVein( vec4 field, float frequency, float width, float pixel ) {
	float steep = length( field.yzw );
	float away = abs( field.x - 0.5 ) / ( frequency * max( steep, 0.7 ) );
	float w = max( width, pixel );
	return ( 1.0 - smoothstep( 0.3 * w, w, away ) ) * width / w * smoothstep( 0.4, 1.0, steep );
}

void stoneSurface( vec3 p, vec3 tint, float wear, out vec3 color, out float rough, out float height ) {
	// How much of the veining one pixel covers: detail finer than that is
	// faded out instead of left to shimmer.
	float pixel = max( length( dFdx( p ) ), length( dFdy( p ) ) );
	float detail = 1.0 - smoothstep( 0.02, 0.08, pixel );

	// The whole field is dragged about first, which is what makes veins
	// wander instead of following the noise's own round levels.
	vec3 q = p + 1.8 * ( vec3( stoneFbm( p * 0.6 + 3.1, 3 ).x, stoneFbm( p * 0.6 + 17.3, 3 ).x,
		stoneFbm( p * 0.6 + 41.7, 3 ).x ) - 0.5 );
	vec4 broad = stoneFbm( q * 0.7, 5 );
	vec4 mid = stoneFbm( q * 1.6 + 9.2, 5 );
	vec4 fine = stoneFbm( q * 3.9 + 21.4, 4 );
	float cloud = stoneFbm( q * 0.5 + 5.7, 3 ).x;
	float mottle = stoneFbm( q * 2.6 + 13.0, 4 ).x;

	// Veins swell, thin and die out along their length rather than netting
	// the whole block evenly.
	float swell = 0.5 + stoneNoise( p * 1.1 + 6.0 ).x;
	float broadRun = smoothstep( 0.42, 0.62, stoneNoise( p * 0.45 + 2.0 ).x );
	float midRun = smoothstep( 0.46, 0.66, stoneNoise( p * 0.9 + 8.0 ).x );
	float fineRun = smoothstep( 0.50, 0.72, stoneNoise( p * 1.9 + 14.0 ).x );
	float veins = clamp( stoneVein( broad, 0.7, 0.014 * swell, pixel ) * broadRun
		+ 0.75 * stoneVein( mid, 1.6, 0.008 * swell, pixel ) * midRun
		+ 0.5 * stoneVein( fine, 3.9, 0.004 * swell, pixel ) * fineRun, 0.0, 1.0 );
	// The stone is smoky and stained for some way to either side of a vein.
	float smoke = clamp( stoneVein( broad, 0.7, 0.11, pixel ) * broadRun
		+ 0.6 * stoneVein( mid, 1.6, 0.05, pixel ) * midRun, 0.0, 1.0 );
	float stain = smoothstep( 0.45, 0.75, stoneFbm( q * 1.1 + 31.0, 3 ).x );

	// Patches where the polish has weathered off into fine pitting.
	float worn = smoothstep( 0.55, 0.80, stoneNoise( p * 1.3 + 4.0 ).x ) * detail;
	float pits = worn * smoothstep( 0.50, 0.75, stoneFbm( p * 17.0, 3 ).x );
	float grain = ( stoneNoise( p * 70.0 ).x - 0.5 ) * ( 1.0 - smoothstep( 0.004, 0.016, pixel ) );

	const vec3 pale = vec3( 0.80, 0.78, 0.73 );
	const vec3 grey = vec3( 0.43, 0.43, 0.42 );
	const vec3 rust = vec3( 0.52, 0.41, 0.27 );
	const vec3 dark = vec3( 0.080, 0.072, 0.065 );
	color = mix( pale, grey, 0.30 * smoothstep( 0.42, 0.78, cloud ) + 0.16 * smoothstep( 0.40, 0.75, mottle ) );
	color = mix( color, grey * 0.9, 0.30 * smoke );
	color = mix( color, rust, 0.24 * stain * ( 0.3 + 0.7 * smoke ) );
	color *= 1.0 + 0.08 * grain - 0.10 * pits;
	color = mix( color, mix( dark, rust * 0.4, stain ), 0.85 * veins );
	// The crowns of mouldings are rubbed paler than the rest.
	color = mix( color, pale * 1.06, 0.5 * wear );
	// A coloured part keeps its colour and takes only the marble's shading.
	color = mix( color, tint * color / pale, stoneTint );

	rough = clamp( 0.44 + 0.14 * cloud + 0.30 * veins + 0.30 * worn, 0.0, 1.0 );
	height = - 0.003 * veins - 0.0012 * pits + 0.0002 * grain + 0.002 * ( mottle - 0.5 ) * detail;
}
`;

// How the surface bends, per veining unit: positive over the crown of a
// moulding, negative down in a hollow. A hollow sees less of the sky and
// gathers dirt; a crown gets rubbed.
const FRAGMENT_COLOR = /* glsl */`
vec3 stoneDx = dFdx( - vViewPosition ) * stoneScale, stoneDy = dFdy( - vViewPosition ) * stoneScale;
vec3 stoneFacing = normalize( vNormal );
float stoneBend = dot( dFdx( stoneFacing ), stoneDx ) / max( dot( stoneDx, stoneDx ), 1e-12 )
	+ dot( dFdy( stoneFacing ), stoneDy ) / max( dot( stoneDy, stoneDy ), 1e-12 );
float stoneHollow = 1.0 - exp( - 0.06 * max( - stoneBend, 0.0 ) );
vec3 stoneColor;
float stoneRough, stoneHeight;
stoneSurface( vStonePos * stoneScale, diffuseColor.rgb, 1.0 - exp( - 0.03 * max( stoneBend, 0.0 ) ),
	stoneColor, stoneRough, stoneHeight );
diffuseColor.rgb = stoneColor * ( 1.0 - 0.25 * stoneHollow );
`;

const FRAGMENT_ROUGHNESS = /* glsl */`
roughnessFactor = stoneRough;
`;

const FRAGMENT_METALNESS = /* glsl */`
metalnessFactor = 0.0;
`;

// The veins and pits as relief: the normal leans down the slope of the height,
// taken from its change across the neighbouring pixels.
const FRAGMENT_NORMAL = /* glsl */`
{
	vec3 stoneR1 = cross( stoneDy, normal ), stoneR2 = cross( normal, stoneDx );
	float stoneDet = dot( stoneDx, stoneR1 );
	vec3 stoneSlope = sign( stoneDet ) * ( dFdx( stoneHeight ) * stoneR1 + dFdy( stoneHeight ) * stoneR2 );
	normal = normalize( abs( stoneDet ) * normal - stoneSlope );
}
`;

// Stone wants a harder light than the flat preview colours: more sun, less
// sky, and less sky still down in a hollow. What bounces back up off the
// ground and the stone itself is warm, and strongest on what faces away from
// the sky.
const FRAGMENT_LIGHT = /* glsl */`
{
	reflectedLight.directDiffuse *= stoneGain;
	reflectedLight.directSpecular *= stoneGain;
	float stoneDown = 0.5 - 0.5 * transformNormalByInverseViewMatrix( normal, viewMatrix ).z;
	reflectedLight.indirectDiffuse = ( stoneSky * reflectedLight.indirectDiffuse
		+ stoneBounce * stoneDown * BRDF_Lambert( material.diffuseContribution ) ) * ( 1.0 - 0.6 * stoneHollow );
}
`;

// The finished picture adds up many exposures, each lit from one direction:
// the sun from a slightly different place in the sky every time, which
// softens its shadows, and the sky and ground a patch at a time, each patch
// casting its own shadow, which is what darkens a hollow for real.
const SUN_PASSES = 48, SKY_PASSES = 96, GROUND_PASSES = 32, OPEN_PASSES = 16;
const SUN_SPREAD = 0.035;            // the sun's disc, as the tangent of its radius
// The share of the sky's light that reaches stone by way of other stone, so
// whatever is in the way, and the colour it has picked up by then.
const OPEN = 0.35;
const WARMTH = [1.0, 0.88, 0.74];
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const QUAD_VERTEX = /* glsl */`
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const ADD_FRAGMENT = /* glsl */`
uniform sampler2D sum;
uniform sampler2D shot;
uniform float weight;
varying vec2 vUv;
void main() {
	gl_FragColor = texture2D( sum, vUv ) + weight * texture2D( shot, vUv );
}
`;

// The sum holds light, not screen colour, and how much of each pixel the
// model covers. Out comes sRGB over the background, or cut out from it.
const RESOLVE_FRAGMENT = /* glsl */`
uniform sampler2D sum;
uniform vec3 background;
uniform float cover;
uniform bool cutOut;
varying vec2 vUv;
void main() {
	vec4 total = texture2D( sum, vUv );
	float alpha = clamp( total.a * cover, 0.0, 1.0 );
	vec3 light = cutOut ? total.rgb / max( alpha, 1e-4 ) : total.rgb + ( 1.0 - alpha ) * background;
	light = clamp( light, 0.0, 1.0 );
	gl_FragColor = vec4( mix( 12.92 * light, 1.055 * pow( light, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, light ) ),
		cutOut ? alpha : 1.0 );
}
`;

/** The i-th point of the Halton sequence in `base`, in 0..1. */
function halton(i, base) {
  let fraction = 1, value = 0;
  for (; i > 0; i = Math.floor(i / base)) {
    fraction /= base;
    value += fraction * (i % base);
  }
  return value;
}

const after = (source, chunk, addition) => source.replace(chunk, chunk + addition);

function patch(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = after(VERTEX_PARS + shader.vertexShader, '#include <begin_vertex>', VERTEX);
  let fragment = FRAGMENT_PARS + shader.fragmentShader;
  fragment = after(fragment, '#include <color_fragment>', FRAGMENT_COLOR);
  fragment = after(fragment, '#include <roughnessmap_fragment>', FRAGMENT_ROUGHNESS);
  fragment = after(fragment, '#include <metalnessmap_fragment>', FRAGMENT_METALNESS);
  fragment = after(fragment, '#include <normal_fragment_maps>', FRAGMENT_NORMAL);
  shader.fragmentShader = after(fragment, '#include <lights_fragment_end>', FRAGMENT_LIGHT);
}

/**
 * The stone look of one viewer. `group` holds the model; `sun` is the light
 * that casts the shadows and `sky` the hemisphere light around it. Frame
 * meshes are made through `mesh()` so they can change look in place when it
 * is switched.
 */
export function initStoneLook({ THREE, renderer, scene, sun, sky, group }) {
  let enabled = false;
  let rendering = false;
  let stale = true;                  // the model changed since the sun was fitted
  const meshes = new Set();
  const normals = new WeakMap();     // geometry → { flat, creased, stone }
  // Shared by every stone material, so one change reaches them all.
  const shared = {
    stoneScale: { value: 1 },        // model millimetres → veining units
    stoneGain: { value: new THREE.Vector3().setScalar(SUN_GAIN) },
    stoneSky: { value: new THREE.Vector3().setScalar(SKY_GAIN) },
    stoneBounce: { value: new THREE.Vector3(...BOUNCE) },
  };
  // The preview's own sun stands high, which flattens a relief lying on the
  // bed. Stone is lit from lower down, over the viewer's left shoulder, and
  // brighter by as much as keeps a face's flat top lit exactly as before.
  const home = { position: sun.position.clone(), intensity: sun.intensity };
  const sunDir = new THREE.Vector3(...SUN).normalize();
  const sunIntensity = home.intensity * home.position.clone().normalize().z / sunDir.z;
  scene.add(sun.target);
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 2.5;

  /** Switch one geometry between its own normals and the creased ones. */
  function dress(geometry, stone) {
    let entry = normals.get(geometry);
    if (!entry) {
      if (!stone) return;
      const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
      entry = { stone: false };
      // Indexed or interleaved geometry is not a plain soup; leave it as it is.
      if (position?.count && normal?.count === position.count && !geometry.index
          && !position.isInterleavedBufferAttribute && !normal.isInterleavedBufferAttribute) {
        entry.flat = normal.array.slice();
        entry.creased = creasedNormals(position.array, CREASE);
        for (let i = 0; i < entry.creased.length; i += 3) {
          if (entry.creased[i] || entry.creased[i + 1] || entry.creased[i + 2]) continue;
          entry.creased.set(entry.flat.subarray(i, i + 3), i);
        }
      }
      normals.set(geometry, entry);
      stale = true;
    }
    if (entry.stone === stone || !entry.creased) return;
    const normal = geometry.getAttribute('normal');
    normal.array.set(stone ? entry.creased : entry.flat);
    normal.needsUpdate = true;
    entry.stone = stone;
  }

  /** The model's box and the sphere around it, or null while there is none. */
  function bounds() {
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return null;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    sphere.radius = Math.max(sphere.radius, 1e-3);
    return { box, sphere };
  }

  /** Stand the sun in `direction` from the model, its shadow fitted to it. */
  function aim(direction, { box, sphere }) {
    sun.target.position.copy(sphere.center);
    sun.position.copy(sphere.center).addScaledVector(direction, 2 * sphere.radius);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();

    // The shadow camera takes in the model's box as the sun sees it, which is
    // tighter than its sphere and so spends the map's texels on the model.
    const camera = sun.shadow.camera;
    camera.position.copy(sun.position);
    camera.lookAt(sun.target.position);
    camera.updateMatrixWorld();
    const seen = new THREE.Box3();
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      seen.expandByPoint(corner.applyMatrix4(camera.matrixWorldInverse));
    }
    const margin = 0.02 * sphere.radius;
    camera.left = seen.min.x - margin; camera.right = seen.max.x + margin;
    camera.bottom = seen.min.y - margin; camera.top = seen.max.y + margin;
    camera.near = Math.max(-seen.max.z - margin, 1e-3 * sphere.radius);
    camera.far = -seen.min.z + margin;
    camera.updateProjectionMatrix();
    sun.shadow.normalBias = 0.004 * sphere.radius;
    sun.shadow.bias = -0.0002;
  }

  /** Aim the sun's shadow at the model and size the veining to it. */
  function fit() {
    const model = bounds();
    if (!model) return;
    aim(sunDir, model);
    // The veining is sized to the model, so a small print and a large one
    // are veined alike. Stepping the size keeps the veins where they are
    // while a model is only nudged.
    shared.stoneScale.value = 2 ** (Math.round(2 * Math.log2(3 / model.sphere.radius)) / 2);
  }

  /** Lay the shadow map out afresh, `size` texels square. */
  function shadowMap(size, radius) {
    sun.shadow.map?.depthTexture?.dispose();
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.radius = radius;
  }

  /**
   * One exposure each for the finished picture: where its light stands, what
   * it sheds, how much of that stone takes, and its share of the whole.
   */
  function exposures() {
    const list = [];
    const side = new THREE.Vector3(0, 0, 1).cross(sunDir).normalize();
    const over = sunDir.clone().cross(side);
    for (let i = 0; i < SUN_PASSES; i++) {
      const reach = SUN_SPREAD * Math.sqrt((i + 0.5) / SUN_PASSES);
      list.push({
        direction: sunDir.clone().addScaledVector(side, reach * Math.cos(i * GOLDEN))
          .addScaledVector(over, reach * Math.sin(i * GOLDEN)).normalize(),
        color: sun.color.clone(), intensity: sunIntensity,
        gain: [SUN_GAIN, SUN_GAIN, SUN_GAIN], weight: 1 / SUN_PASSES, open: 0,
      });
    }
    // A hemisphere light is an evenly bright half-sky above and another
    // below. A patch of either, standing in for the whole half, has to shine
    // twice as bright as the light's own figure.
    const patch = (height, turn) => {
      const flat = Math.sqrt(1 - height * height);
      return new THREE.Vector3(flat * Math.cos(turn), flat * Math.sin(turn), height);
    };
    for (let i = 0; i < SKY_PASSES; i++) {
      list.push({
        direction: patch((i + 0.5) / SKY_PASSES, i * GOLDEN),
        color: sky.color.clone(), intensity: 2 * sky.intensity,
        gain: [SKY_GAIN, SKY_GAIN, SKY_GAIN], weight: 1 / SKY_PASSES,
      });
    }
    // From below, stone is lit by its own warm bounce as well as the ground.
    const ground = sky.groundColor.toArray().map((c) => Math.max(c * sky.intensity, 1e-4));
    for (let i = 0; i < GROUND_PASSES; i++) {
      list.push({
        direction: patch(-(i + 0.5) / GROUND_PASSES, i * GOLDEN),
        color: sky.groundColor.clone(), intensity: 2 * sky.intensity,
        gain: ground.map((c, k) => (SKY_GAIN * c + BOUNCE[k]) / c), weight: 1 / GROUND_PASSES,
      });
    }
    // Pale stone throws light on into the corners no patch of sky can see.
    // That share of the sky and ground goes round everything, unshadowed, and
    // only the rest is left to the patches.
    for (const exposure of list.slice(SUN_PASSES)) {
      exposure.intensity *= 1 - OPEN;
      exposure.open = 0;
    }
    for (let i = 0; i < OPEN_PASSES; i++) {
      list.push({ direction: sunDir, color: sun.color.clone(), intensity: 0, gain: [0, 0, 0],
        weight: 1 / OPEN_PASSES, open: OPEN });
    }
    return list;
  }

  /** The picture added up over every exposure, as rows of RGBA bytes, bottom row first. */
  async function expose({ camera, width, height, transparent, progress }) {
    const model = bounds();
    if (!model) throw new Error('There is no model to render yet.');
    const view = camera.clone();
    view.aspect = width / height;
    view.updateProjectionMatrix();

    const nearest = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    const precise = renderer.extensions.has('EXT_color_buffer_float') ? THREE.FloatType : THREE.HalfFloatType;
    const shot = new THREE.WebGLRenderTarget(width, height, { ...nearest, type: THREE.HalfFloatType });
    const sums = [0, 1].map(() => new THREE.WebGLRenderTarget(width, height,
      { ...nearest, type: precise, depthBuffer: false }));
    const out = new THREE.WebGLRenderTarget(width, height, { ...nearest, depthBuffer: false });
    const add = new THREE.ShaderMaterial({ vertexShader: QUAD_VERTEX, fragmentShader: ADD_FRAGMENT,
      uniforms: { sum: { value: null }, shot: { value: shot.texture }, weight: { value: 0 } },
      depthTest: false, depthWrite: false });
    const resolve = new THREE.ShaderMaterial({ vertexShader: QUAD_VERTEX, fragmentShader: RESOLVE_FRAGMENT,
      // The sun, sky, ground and open exposures each cover the model once.
      uniforms: { sum: { value: null }, cover: { value: 1 / 4 }, cutOut: { value: transparent },
        background: { value: scene.background?.isColor ? scene.background : new THREE.Color(0) } },
      depthTest: false, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), add);
    const flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Everything the exposures disturb, to be put back afterwards. The model
    // is shot alone on nothing: no grid, markers or slice planes, and every
    // part of it casting and taking shadows.
    const was = {
      target: renderer.getRenderTarget(), clear: renderer.getClearColor(new THREE.Color()),
      alpha: renderer.getClearAlpha(), background: scene.background,
      color: sun.color.clone(), intensity: sun.intensity, sky: sky.intensity,
      mapSize: sun.shadow.mapSize.x, radius: sun.shadow.radius,
      gain: shared.stoneGain.value.clone(), bounce: shared.stoneBounce.value.clone(),
      skyGain: shared.stoneSky.value.clone(),
      hidden: scene.children.filter((o) => o !== group && !o.isLight && o.visible),
      shadows: [],
    };
    group.traverse((o) => { if (o.isMesh) was.shadows.push([o, o.castShadow, o.receiveShadow]); });
    try {
      for (const o of was.hidden) o.visible = false;
      for (const [o] of was.shadows) o.castShadow = o.receiveShadow = true;
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      shared.stoneSky.value.fromArray(WARMTH).multiplyScalar(SKY_GAIN);
      shadowMap(Math.min(4096, renderer.capabilities.maxTextureSize), 1.5);
      renderer.setRenderTarget(sums[0]);
      renderer.clear();

      const list = exposures();
      const warmth = new THREE.Vector3(...WARMTH);
      for (const [i, exposure] of list.entries()) {
        aim(exposure.direction, model);
        sun.color.copy(exposure.color);
        sun.intensity = exposure.intensity;
        sky.intensity = exposure.open * was.sky;
        shared.stoneGain.value.fromArray(exposure.gain);
        shared.stoneBounce.value.fromArray(BOUNCE).multiply(warmth).multiplyScalar(exposure.open);
        // Each exposure looks through a different point of the pixel, which
        // is what smooths the edges.
        view.setViewOffset(width, height, halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5, width, height);
        renderer.setRenderTarget(shot);
        renderer.render(scene, view);
        add.uniforms.sum.value = sums[0].texture;
        add.uniforms.weight.value = exposure.weight;
        renderer.setRenderTarget(sums[1]);
        renderer.render(quad, flat);
        sums.reverse();
        // Let the page breathe, and the graphics card catch up.
        if (i % 4 === 3) {
          progress((i + 1) / list.length);
          await new Promise((done) => setTimeout(done));
        }
      }

      quad.material = resolve;
      resolve.uniforms.sum.value = sums[0].texture;
      renderer.setRenderTarget(out);
      renderer.render(quad, flat);
      const bytes = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(out, 0, 0, width, height, bytes);
      return bytes;
    } finally {
      renderer.setRenderTarget(was.target);
      renderer.setClearColor(was.clear, was.alpha);
      scene.background = was.background;
      for (const o of was.hidden) o.visible = true;
      for (const [o, cast, receive] of was.shadows) { o.castShadow = cast; o.receiveShadow = receive; }
      sun.color.copy(was.color);
      sun.intensity = was.intensity;
      sky.intensity = was.sky;
      shared.stoneGain.value.copy(was.gain);
      shared.stoneBounce.value.copy(was.bounce);
      shared.stoneSky.value.copy(was.skyGain);
      shadowMap(was.mapSize, was.radius);
      for (const target of [shot, out, ...sums]) target.dispose();
      quad.geometry.dispose();
      add.dispose();
      resolve.dispose();
      stale = true;
    }
  }

  function set(on) {
    if (enabled === !!on) return;
    enabled = !!on;
    renderer.shadowMap.enabled = enabled;
    sun.castShadow = enabled;
    sun.intensity = enabled ? sunIntensity : home.intensity;
    if (!enabled) {
      sun.position.copy(home.position);
      sun.target.position.set(0, 0, 0);
    }
    for (const mesh of meshes) {
      mesh.material.needsUpdate = true;
      if (!enabled) dress(mesh.geometry, false);
    }
    stale = true;
  }

  /** Before each frame: catch up with whatever the model has become. */
  function update() {
    if (!enabled) return;
    for (const mesh of meshes) dress(mesh.geometry, true);
    if (!stale) return;
    fit();
    stale = false;
  }

  return {
    get enabled() { return enabled; },
    /** True while a finished picture is being made; the viewer must not draw then. */
    get rendering() { return rendering; },
    set,
    update,

    /**
     * The model in stone as `camera` sees it, as a PNG blob `width` by
     * `height` pixels: every edge smoothed, shadows soft, hollows dark. On
     * the viewer's background colour, or cut out from it when `transparent`.
     * `progress` hears how far along it is, from 0 to 1. The look itself is
     * left as it was found.
     */
    async render({ camera, width, height, transparent = false, progress = () => {} }) {
      if (rendering) throw new Error('A render is already under way.');
      const limit = renderer.capabilities.maxTextureSize;
      if (!(width >= 1 && height >= 1 && width <= limit && height <= limit)) {
        throw new Error(`A render can be at most ${limit} pixels a side here.`);
      }
      const before = enabled;
      rendering = true;
      try {
        set(true);
        update();
        const bytes = await expose({ camera, width, height, transparent, progress });
        // The pixels come bottom row first; a picture starts at the top.
        const image = new ImageData(width, height);
        for (let y = 0; y < height; y++) {
          image.data.set(bytes.subarray(4 * width * (height - 1 - y), 4 * width * (height - y)), 4 * width * y);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').putImageData(image, 0, 0);
        return await new Promise((done, fail) => canvas.toBlob(
          (blob) => (blob ? done(blob) : fail(new Error('The render could not be saved as a PNG.'))), 'image/png'));
      } finally {
        set(before);
        rendering = false;
      }
    },

    /**
     * A frame mesh. `params` are its MeshStandardMaterial's, as shown with
     * the look off. A `tinted` mesh keeps its colour under the veining
     * instead of turning marble white.
     */
    mesh(geometry, params, { tinted = false } = {}) {
      const material = new THREE.MeshStandardMaterial(params);
      const uniforms = { ...shared, stoneTint: { value: tinted ? 1 : 0 } };
      material.onBeforeCompile = (shader) => { if (enabled) patch(shader, uniforms); };
      material.customProgramCacheKey = () => (enabled ? 'stone' : '');
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = mesh.receiveShadow = true;
      meshes.add(mesh);
      material.addEventListener('dispose', () => { meshes.delete(mesh); stale = true; });
      stale = true;
      return mesh;
    },
  };
}
