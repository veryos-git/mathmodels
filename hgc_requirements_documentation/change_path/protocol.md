# Editing pointy tips — request protocol

A running log of the requests and decisions for changing a subject's paths in
the app, newest at the bottom. See `readme.md` for the original request.

## 2026-10-24 — find a solution for `readme.md`

> it would be really nice to be able to change the pointy tips of the gothic
> models directly in this webapp ... in the other software this is done by drag
> n drop of a point where two arcs meet. however, also the arc dimensions can be
> changed ... or the overlap dimension between the two circles ... each arc has
> to be tangent to a certain line. this constraint needs to be locked when a
> pointy tip is going to be moved.

The examples are one Onshape sketch before and after a tip edit: a rhombus of
four lines and a quatrefoil of four arcs, each arc tangent to the two rhombus
sides meeting at its end of the rhombus. The arcs meet at four pointy tips,
(±8.32, ±9.03) in `Part Studio 1 - Sketch 1 (1).dxf` and (±10.50, ±10.12) in
`lesspointz/`. The rhombus is unchanged.

Why one drag fixes the shape: an arc tangent to two lines has its centre on
their bisector, so it has one degree of freedom left. A tip lies on both of its
arcs, so placing the tip fixes both arcs.

Solution — the **pointy tip editor** (Inputs → *Edit pointy tips…*, DXF
subjects):

- **Exact geometry.** The converter reports the DXF's own lines, circles and
  arcs (`--sketch`, `POST /api/sketch`). The editor never works on flattened
  polylines.
- **Constraints are read from the drawing itself**, because a DXF stores no
  constraints. The editor reads them from what the geometry already satisfies:
  - Arc ends that meet are joined.
  - Two editable arcs meeting at an angle are a pointy tip.
  - An arc touching a line, circle or other arc is tangent to it, and that
    tangency is locked.
  - A mirror or rotation that maps the arcs and lines onto themselves is a
    symmetry.
- **Solver.** It is a small Gauss–Newton solver in the browser. The arcs the
  edit names (and their symmetric copies) reshape; every other arc stays put
  unless it has to move. A drag that would break a tangency or slide an arc off
  its line stops at the last shape that works.
- **Edits.** You can drag a tip, type its X / Y, type its *circle overlap*
  (r₁ + r₂ − distance between centres), or type an arc's *radius*. *Keep
  symmetry* is on whenever a symmetry is found.
- **Apply** writes the arcs back into the same DXF by entity handle
  (`--sketch-edit`, `POST /api/sketch/apply`). Everything else stays untouched.
  The model then rebuilds with holes, paint and scale kept.

Checked against the reference: dragging the first sketch's upper-right tip to
the `lesspointz` tip reproduces all four `lesspointz` arcs to 4 decimals
(`tools/test_tip_editor.mjs`). Writing those arcs into the DXF and reading them
back is exact (`tools/test_sketch_arcs.py`).

Limits for now:

- SVG subjects are not editable.
- Lines, circles, polylines and arcs inside blocks are fixed references.
- Only the tips themselves are draggable, not smooth joins.
