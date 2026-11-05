// Copyright (C) [Jonas Immanuel Frey] - Licensed under GPL

// One-piece paper lantern net. All dimensions are in millimetres.
// Roof shapes are upright silhouettes; the folded lantern is open on top.

/* [Output] */
output = "flat"; // [flat:Flat STL, cut:2D SVG or DXF, assembled:Folded preview, wall:Selected wall from outside]
// Guides appear only in the flat F5 preview, never in exported cutting geometry.
show_fold_guides = true;
paper_thickness = 0.3; // [0.1:0.05:1]

/* [House] */
// Square floor and width of each wall.
house_size = 50; // [30:1:90]
wall_height = 55; // [35:1:100]
roof_height = 18; // [0:1:40]
roof_style = "mixed"; // [mixed, gable, crooked, stepped, flat]

/* [Windows] */
// One centred window per wall. Cross leaves four panes joined by paper bars.
window_style = "cross"; // [cross, plain]
window_width = 24; // [10:1:60]
window_height = 32; // [10:1:70]
window_bar = 2; // [1:0.5:5]

/* [Glue tabs] */
glue_tab_width = 6; // [3:0.5:12]
// Clearance at the floor and eaves so neighbouring folds do not bunch up.
tab_inset = 2; // [1:0.5:5]

/* [Hidden] */
// The app supplies normalized polygons: [wall, centre_x, centre_y, width, points, paths, rotation].
decorations = is_undef(app_decorations) ? [] : app_decorations;
wall_windows = is_undef(app_wall_windows) ? [true, true, true, true] : app_wall_windows;
wall_index = 0;
has_windows = wall_windows[0] || wall_windows[1] || wall_windows[2] || wall_windows[3];
minimum_border = 2;
tab_taper = glue_tab_width * 0.6;
guide_width = 0.25;
mixed_roofs = ["crooked", "gable", "stepped", "gable"];
flat_span = house_size + 2 * (wall_height + (roof_style == "flat" ? 0 : roof_height));

assert(output == "flat" || output == "cut" || output == "assembled" || output == "wall",
       "Choose flat, cut, assembled or wall output.");
assert(roof_style == "mixed" || roof_style == "gable" || roof_style == "crooked"
       || roof_style == "stepped" || roof_style == "flat", "Unknown roof style.");
assert(window_style == "cross" || window_style == "plain", "Unknown window style.");
assert(house_size > 0 && wall_height > 0 && roof_height >= 0 && paper_thickness > 0,
       "House size, wall height and thickness must be positive; roof height cannot be negative.");
assert(glue_tab_width > 0 && tab_inset > 0
       && wall_height > 2 * (tab_inset + tab_taper),
       "Tabs need positive width/inset and enough wall height for their tapered ends.");
assert(house_size > 2 * (glue_tab_width + minimum_border),
       "House walls need room for both corner glue areas and a cutout.");
assert(!has_windows || (window_width > 0 && window_height > 0
       && window_width <= house_size - 2 * (glue_tab_width + minimum_border)
       && window_height <= wall_height - 2 * minimum_border),
       "Windows must leave 2 mm borders and space for the folded glue tabs.");
assert(!has_windows || window_style != "cross" || (window_bar >= 1
       && window_bar < min(window_width, window_height) - 2),
       "Window bars must be at least 1 mm wide and leave panes wider than 1 mm.");

echo(str("Floor: ", house_size, " x ", house_size,
         " mm; flat footprint: ", flat_span, " x ", flat_span, " mm."));

function wall_roof(index) = roof_style == "mixed" ? mixed_roofs[index] : roof_style;

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

module window_cutout_2d() {
    translate([house_size / 2, wall_height / 2])
        difference() {
            square([window_width, window_height], center = true);
            if (window_style == "cross") {
                square([window_bar, window_height + 2], center = true);
                square([window_width + 2, window_bar], center = true);
            }
        }
}

module wall_2d(index) {
    difference() {
        wall_outline_2d(wall_roof(index));
        if (wall_windows[index]) window_cutout_2d();
        // Protect the perimeter, floor fold and folded corner glue areas.
        intersection() {
            offset(delta = -minimum_border) wall_outline_2d(wall_roof(index));
            translate([glue_tab_width + minimum_border, minimum_border])
                square([house_size - 2 * (glue_tab_width + minimum_border),
                        wall_height + roof_height]);
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
    for (index = [0:3])
        place_flat_wall(index) {
            translate([0, -guide_width / 2]) square([house_size, guide_width]);
            translate([house_size - guide_width / 2, tab_inset])
                square([guide_width, wall_height - 2 * tab_inset]);
        }
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
else {
    color("#56364b") linear_extrude(paper_thickness) net_2d();
    if ($preview && show_fold_guides)
        color("#ff9c38")
            translate([0, 0, paper_thickness + 0.01])
                linear_extrude(0.01) fold_guides_2d();
}
