# Hook feature — request protocol

A running log of the requests and clarifications for the parametric hook
feature, newest decisions appended at the bottom. See `readme.md` for the
original spec.

## 2026-10-23 — initial implementation request

> please add the possibility of adding parametric designable hooks, that are
> swept from the same main profile

Clarified hook shapes:

- **Round hook** → two-arc shepherd's crook: a big arc (`radius`) through the
  `wrap` angle, then a tighter return arc (`return_radius`) through the
  `return` angle, curling toward `side`.
- **Straight hook** → a single bar of `length` turned by `angle` toward `side`,
  with an optional rounded tip.

Both are swept from the **main profile**, continue tangent to the path, and the
free tip is rounded unless the cap is cleared.

Implemented as an extension of the open-path endpoint system (the dome/revolve
endings): `--hooks` CLI flag, `hook_chain()` geometry in `gothic.py`, build
wiring in `dxf2stl.py`, server `mapFlag`, and the "endings & hooks" panel in the
model screen.

## 2026-10-23 — placement on any endpoint

> open end points are not required, hooks should be placable on any endpoint

Decisions:

- **Placeable points:** every vertex of every path — open OR closed — is offered
  as a marker (previously only the free ends of open paths; closed loops showed
  nothing).
- **Hook direction at a point that is not a free end** (a corner, or a point on a
  closed loop): the hook leaves **straight outward (perpendicular)** to the path
  at that vertex. Free ends still continue the path tangentially.

## 2026-10-23 — hook UI belongs in the Additions step

> since it is an 'addition' the UI should be in the 'additions' section

The "Path endings & hooks" panel was moved out of the Inputs "Sweep profiles &
cusp paths" group and into the **Additions** step (step 3), alongside the shelf,
since a hook is an addition to the swept frame. It still needs a main sweep
profile loaded and a Generate 3D pass so the endpoint markers exist.

## 2026-10-23 — hooks must stand up out of the frame

> the hook functionality is not at all working like i expect it to work. see
> the requirements and expected example and the current actual example

`actual_exapmle_flat_hooks.png` showed the hooks lying flat in the drawing
plane. The reference CAD (`round/`, `straight/`, `straight/expectedexample.png`)
builds them in the **vertical plane along the path**, rising out of the frame.
Rebuilt from the reference sketches and STEP files:

- **Round** (`round/circlessketch.png`, `hookround.step`): two circles resting on
  the ground and touching (Ø12 and Ø28, so 2·√(6·14) ≈ 18.3 mm apart). The path
  rises from the endpoint around the small circle, then curls clockwise round the
  big one to the 200° point (measured from its ground point). As in the STEP,
  the profile sits on the concave side of each arc. Those two sweeps only touch
  along a line where the arcs meet, so the rising arc's end is rounded off with
  a knob, which fuses them into one body.
  Parameters: `small_radius` 6, `big_radius` 14, `angle` 200.
- **Straight** (`straight/image.png`, `result.step`): a bracket. A bottom bar
  continues the path by `length` (33), a post stands at the endpoint, and a bar
  rising at `angle` (26°) from the bottom bar's far end rests on the post and
  overhangs it back over the frame by `overhang` (13, along the bar). The post
  is trimmed to the bar's underside (the reference "extrude"), and everything
  below the base plane is cut off (the reference "cutoff").
- **Tip:** the end section turns 180° about its base line through the travel
  direction, giving a half-disc knob (the reference "Revolve 1", 180°). It can be
  turned off with `cap: false`.
- The old `radius`/`return_radius`/`wrap`/`return`/`side` parameters and the
  curl-side control are gone: the hook's plane is fixed by the path direction.

## 2026-10-23 — straight hook: vertical alignment, 90° tip (`22-10-2026/`)

> only one of the hooks is correctly aligned. the second hook at the bottom. the
> hooks should be default be aligned all vertically. there could be a rotation
> input ... the top of the hook is revolved 180 degrees, but it only should be
> revolved 90 degrees

Tried on `projects/gothic_decoration_wall_hooks`. Each hook had taken its
direction from the path at its vertex (continuing a free end, perpendicular at a
corner), so the hooks pointed every which way. Only the bottom one at
(56.0, −66.9) happened to point down −Y. Vertices shared by two paths even got
**two** crossed hooks.

Decisions:

- **All hooks face the same way:** down the drawing's vertical axis (−Y),
  whatever the path does there. A **Rotation** input (degrees, counter-clockwise,
  spec key `rotation`) turns them. It applies to every hook.
- **One hook per vertex**, even where several paths meet.
- **Tip:** rounded over by a **90°** turn of the end section about its base line
  (a quarter-round nose), no longer 180°. The round hook's inner joint knob stays
  180°, because that is what fuses its two arcs.
- Focus is on the straight hook for now; the round hook is left as it was apart
  from the shared 90° tip.

## 2026-10-23 — optional smooth tip (`22-10-2026/problem2_harsh_hook/`)

> it could be that the 90 revolved endprofile has harsh edges. add the
> additional option of doing a 180 degrees revolve and then adding another sweep

As in the reference (`revolve180.png`, `sweep.png`, the STEP file): the bar's end
section is revolved **180°** about its base line, so it hangs upside down under
the bar. That flipped section is then **swept back along the bar** to the point
where the bar crosses the post. The overhang carries the moulding on both faces
and ends in a smooth half-round, and the post is trimmed to the new underside.

The tip is now a choice (spec key `tip`, UI "Tip"): `quarter` (90° roll, the
default), `half` (180° roll + underside sweep), `square`. The older `cap: false`
still means square. On a round hook, `half` gives the 180° knob without an
underside sweep.
