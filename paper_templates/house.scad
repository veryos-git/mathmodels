// Copyright (C) [Jonas Immanuel Frey] - Licensed under GPL

// One-piece paper lantern net. All dimensions are in millimetres.
// Roof shapes are upright silhouettes; the folded lantern is open on top.

// The walls are plain: windows and other decorations are SVG/DXF drawings the
// app (paper mode) places on them, see "App protocol" below.

/* [Output] */
output = "flat"; // [flat:Flat STL, cut:2D SVG or DXF, assembled:Folded preview, wall:Selected wall from outside, area:Decoration area]
// Guides appear only in the flat F5 preview, never in exported cutting geometry.
show_fold_guides = true;
paper_thickness = 0.3; // [0.1:0.05:1]

/* [House] */
// Square floor and width of each wall.
house_size = 50; // [30:1:90]
wall_height = 55; // [35:1:100]
roof_height = 18; // [0:1:40]
roof_style = "mixed"; // [mixed, gable, crooked, stepped, flat]

/* [Glue tabs] */
glue_tab_width = 6; // [3:0.5:12]
// Clearance at the floor and eaves so neighbouring folds do not bunch up.
tab_inset = 2; // [1:0.5:5]

/* [Hidden] */
// App protocol (vector2stl paper mode):
//   output = "cut"        the net as cut: the paper with every decoration cut out
//                         (inside face up, as it lies before folding)
//   output = "area"       where decorations may cut, laid out like the net; this
//                         output also echoes app_walls and app_folds
// app_walls[i] = [origin, x_axis, y_axis, [width, height]]: the point (x, y) of
//   wall i seen from outside lies on the net at origin + x * x_axis + y * y_axis.
// app_folds = [[[x0, y0], [x1, y1], angle], ...]: every fold line on the net and
//   how far it folds inward, in degrees. The app folds the cut net along these
//   lines for its 3D preview, starting from the piece under app_base.
// app_base = [x, y]: a point on the piece that stays put (the floor).
// Optional, with their defaults:
//   app_up = [0, 0, 1]: the direction on the app_base piece that points up
//     when folded; [0, 0, 1] stands a floor flat.
//   app_net_top = "inside": the face of the net facing up here becomes the
//     inside; "outside" for a net drawn outside face up (no mirroring needed).
//   app_fold_layer = true: the SVG gets a fold (score) layer; false when the cut
//     already perforates the folds.
// The app supplies normalized polygons, seen from outside:
//   app_decorations = [[wall, centre_x, centre_y, width, points, paths, rotation], ...]
decorations = is_undef(app_decorations) ? [] : app_decorations;
wall_index = 0;
minimum_border = 2;
tab_taper = glue_tab_width * 0.6;
guide_width = 0.25;
mixed_roofs = ["crooked", "gable", "stepped", "gable"];
flat_span = house_size + 2 * (wall_height + (roof_style == "flat" ? 0 : roof_height));

assert(output == "flat" || output == "cut" || output == "assembled" || output == "wall"
       || output == "area", "Choose flat, cut, assembled, wall or area output.");
assert(roof_style == "mixed" || roof_style == "gable" || roof_style == "crooked"
       || roof_style == "stepped" || roof_style == "flat", "Unknown roof style.");
assert(house_size > 0 && wall_height > 0 && roof_height >= 0 && paper_thickness > 0,
       "House size, wall height and thickness must be positive; roof height cannot be negative.");
assert(glue_tab_width > 0 && tab_inset > 0
       && wall_height > 2 * (tab_inset + tab_taper),
       "Tabs need positive width/inset and enough wall height for their tapered ends.");
assert(house_size > 2 * (glue_tab_width + minimum_border),
       "House walls need room for both corner glue areas and a cutout.");

echo(str("Floor: ", house_size, " x ", house_size,
         " mm; flat footprint: ", flat_span, " x ", flat_span, " mm."));

function wall_roof(index) = roof_style == "mixed" ? mixed_roofs[index] : roof_style;
function wall_top(index) =
    wall_roof(index) == "flat" || roof_height == 0 ? wall_height : wall_height + roof_height;

// Local wall coordinates: x = width, y = height above the floor fold.
module wall_outline_2d(style) {
    if (style == "flat" || roof_height == 0)
        square([house_size, wall_height]);
    else if (style == "stepped")
        polygon([
            [0, 0], [house_size, 0],
            [house_size, wall_height + roof_height / 3],
            [house_size * 0.75, wall_height + roof_height / 3],
            [house_size * 0.75, wall_height + roof_height * 2 / 3],
            [house_size * 0.6, wall_height + roof_height * 2 / 3],
            [house_size * 0.6, wall_height + roof_height],
            [house_size * 0.4, wall_height + roof_height],
            [house_size * 0.4, wall_height + roof_height * 2 / 3],
            [house_size * 0.25, wall_height + roof_height * 2 / 3],
            [house_size * 0.25, wall_height + roof_height / 3],
            [0, wall_height + roof_height / 3]
        ]);
    else
        polygon([
            [0, 0], [house_size, 0], [house_size, wall_height],
            [house_size * (style == "crooked" ? 0.32 : 0.5), wall_height + roof_height],
            [0, wall_height]
        ]);
}

// Where a wall may be cut: inside its perimeter border, clear of the floor fold
// and of the folded corner glue areas.
module decoration_area_2d(index) {
    intersection() {
        offset(delta = -minimum_border) wall_outline_2d(wall_roof(index));
        translate([glue_tab_width + minimum_border, minimum_border])
            square([house_size - 2 * (glue_tab_width + minimum_border),
                    wall_height + roof_height]);
    }
}

module wall_2d(index) {
    difference() {
        wall_outline_2d(wall_roof(index));
        intersection() {
            decoration_area_2d(index);
            union()
                for (decoration = decorations)
                    if (decoration[0] == index)
                        // The editor uses the outside view; the flat net faces inward.
                        // Rotation is in degrees clockwise as seen from outside.
                        translate([house_size - decoration[1], decoration[2]])
                            scale([-1, 1]) rotate(-decoration[6]) scale(decoration[3])
                                polygon(points = decoration[4], paths = decoration[5]);
        }
    }
}

// One tab on each wall's right edge; each corner receives exactly one tab.
module glue_tab_2d() {
    polygon([
        [house_size, tab_inset],
        [house_size + glue_tab_width, tab_inset + tab_taper],
        [house_size + glue_tab_width, wall_height - tab_inset - tab_taper],
        [house_size, wall_height - tab_inset]
    ]);
}

function rotate_2d(v, angle) =
    [v[0] * cos(angle) - v[1] * sin(angle), v[0] * sin(angle) + v[1] * cos(angle)];
// A point in wall `index`'s local (inside) coordinates, on the flat net.
function on_net(index, p) = rotate_2d([p[0] - house_size / 2, p[1] + house_size / 2], index * 90);
// Seen from outside, a wall's x runs the other way: x_outside = house_size - x_local.
function app_wall_frame(index) = [
    on_net(index, [house_size, 0]),
    on_net(index, [house_size - 1, 0]) - on_net(index, [house_size, 0]),
    on_net(index, [house_size, 1]) - on_net(index, [house_size, 0]),
    [house_size, wall_top(index)]
];
// The floor folds, then each glue tab's fold; walls stand up, tabs turn inward.
function fold_lines() = [
    for (index = [0:3]) each [
        [on_net(index, [0, 0]), on_net(index, [house_size, 0]), 90],
        [on_net(index, [house_size, tab_inset]), on_net(index, [house_size, wall_height - tab_inset]), 90]
    ]
];

module place_flat_wall(index) {
    rotate([0, 0, index * 90])
        translate([-house_size / 2, house_size / 2, 0]) children();
}

module net_2d() {
    union() {
        square([house_size, house_size], center = true);
        for (index = [0:3])
            place_flat_wall(index) {
                wall_2d(index);
                glue_tab_2d();
            }
    }
}

module fold_guides_2d() {
    for (line = fold_lines())
        hull() for (p = [line[0], line[1]]) translate(p) square(guide_width, center = true);
}

// Idealised folds for inspection; no allowance for paper bend radius.
module assembled() {
    color("#56364b")
        linear_extrude(paper_thickness)
            square([house_size, house_size], center = true);
    for (index = [0:3])
        rotate([0, 0, index * 90])
            translate([-house_size / 2, house_size / 2, paper_thickness / 2])
                rotate([90, 0, 0]) {
                    color(index % 2 == 0 ? "#56364b" : "#754d65")
                        linear_extrude(paper_thickness) wall_2d(index);
                    // Swing the right-hand tab inward against the next wall.
                    color("#b890a8")
                        translate([house_size - paper_thickness, 0, 0])
                            rotate([0, -90, 0])
                                linear_extrude(paper_thickness)
                                    translate([-house_size, 0]) glue_tab_2d();
                }
}

if (output == "cut") net_2d();
else if (output == "wall")
    translate([house_size, 0]) mirror([1, 0]) wall_2d(wall_index);
else if (output == "assembled") assembled();
else if (output == "area") {
    echo(app_walls = [for (index = [0:3]) app_wall_frame(index)]);
    echo(app_folds = fold_lines());
    echo(app_base = [0, 0]);
    echo(app_net_top = "inside");
    for (index = [0:3]) place_flat_wall(index) decoration_area_2d(index);
}
else {
    color("#56364b") linear_extrude(paper_thickness) net_2d();
    if ($preview && show_fold_guides)
        color("#ff9c38")
            translate([0, 0, paper_thickness + 0.01])
                linear_extrude(0.01) fold_guides_2d();
}
