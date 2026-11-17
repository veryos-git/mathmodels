// Copyright (C) [Jonas Immanuel Frey] - Licensed under GPL

// One-piece paper house net for an A4 sheet. Every dimension is in millimetres.
// The four walls stand in one row; each roof half folds down from the top of
// its own long wall, so the net is only one wall plus one roof half tall.
// There is no floor. Folds are cut as dashed slits (perforations), so the net
// stays in one piece and creases easily.
//
// Layout of the flat net (top face becomes the outside, # = glue tabs):
//
//                   ridge tab
//            /\    +-------------+    /\    +-------------+
//         # /  \  #|   roof 1    |#  /  \  #|   roof 3    |
//        # /    \ #|             |# /    \ #|             |
//         /      \#|             |#/      \#|             |
//   +---+----------+-------------+----------+-------------+
//   |tab|  wall 0  |   wall 1    |  wall 2  |   wall 3    |
//   |   |   door   |             |   logo   |             |
//   +---+----------+-------------+----------+-------------+
//
// Walls 0 and 2 are the gable walls, walls 1 and 3 the long walls. The left
// tab closes the house behind the end of wall 3. The roof side tabs glue
// inside the gables; roof 3 lies on the gable tab of wall 0 and on the ridge
// tab of roof 1.

/* [Output] */
output = "flat"; // [flat:Flat 3D model, cut:Cutting template, folded:Folded model]
paper_thickness = 0.3; // [0.1:0.05:0.8]

/* [House] */
// Length of the two long walls that carry the roof halves.
house_length = 80; // [40:1:130]
// Width of the two gable walls.
house_depth = 55; // [30:1:90]
// Wall height from the bottom edge to the eaves.
wall_height = 100; // [40:1:160]
// Height of the ridge above the eaves.
roof_height = 40; // [15:1:70]

/* [Door] */
// Arched door in wall 0.
door_width = 18; // [8:1:40]
door_height = 34; // [10:1:80]

/* [Folds and glue] */
glue_tab = 7; // [4:0.5:12]
fold_slit_width = 0.45; // [0.2:0.05:0.8]
fold_dash_length = 2.6; // [1:0.1:5]
fold_dash_gap = 2; // [1:0.5:5]

/* [Sheet] */
// A4 landscape. Used for the fit check and the outline in the flat preview.
sheet_width = 297; // [150:1:500]
sheet_height = 210; // [100:1:500]
sheet_margin = 5; // [0:1:20]

/* [Hidden] */
logo_file = "veryos_logo.svg";
logo_width = 18;
logo_height = logo_width * 31.2528266758 / 43.9095293518;
logo_line = 0.42;
logo_dash_pitch = 1.35;
logo_dash_width = 0.7;
// Paper kept around every opening.
border = 3;
// Cut between a roof side tab and the gable edge beside it in the flat net.
tab_gap = 1;
// Clearance at the ends of every tab.
tab_end = 2;
fold_end_gap = 1.4;
$fn = 48;

// Derived dimensions.
half_depth = house_depth / 2;
roof_slant = sqrt(pow(half_depth, 2) + pow(roof_height, 2));
roof_pitch = atan2(roof_height, half_depth);
// Rise of the gable edges per mm of width; the roof side tabs follow it.
gable_rise = roof_height / half_depth;
roof_tab_low = tab_gap * roof_slant / half_depth;
// Roof side tabs get narrower on steep, short roofs, so that both fit in a gable.
roof_tab = min(glue_tab, (roof_slant - tab_end - roof_tab_low - 2) / (2 * gable_rise));
ridge_tab_inset = glue_tab + tab_end;
x_wall = [glue_tab,
          glue_tab + house_depth,
          glue_tab + house_depth + house_length,
          glue_tab + 2 * house_depth + house_length];
net_width = glue_tab + 2 * (house_depth + house_length);
net_height = wall_height + roof_slant + glue_tab;
fits_sheet = net_width <= sheet_width - 2 * sheet_margin
             && net_height <= sheet_height - 2 * sheet_margin;
// The logo sits as high in the gable of wall 2 as the roof tabs glued inside
// it allow.
logo_top = roof_height * (1 - (logo_width / 2 + 1) / half_depth)
           - roof_tab * roof_slant / half_depth;
logo_y = wall_height + logo_top - logo_height / 2;

function wall_width(index) = index % 2 == 0 ? house_depth : house_length;

assert(output == "flat" || output == "cut" || output == "folded",
       "Choose flat, cut or folded output.");
assert(2 * roof_tab < house_depth - 2 * border,
       "Both roof tabs inside a gable need room; use a smaller glue_tab.");
assert(roof_tab >= 4,
       "The roof is too short and steep for 4 mm side glue tabs; make the house deeper or the roof lower.");
assert(door_width <= house_depth - 2 * border && door_height > door_width / 2
       && door_height <= wall_height - border,
       "The door must fit in wall 0 with 3 mm of paper around it.");
echo(str("Flat net: ", net_width, " x ", net_height, " mm; sheet ", sheet_width,
         " x ", sheet_height, " mm with ", sheet_margin, " mm margin: ",
         fits_sheet ? "fits" : "DOES NOT FIT", ". Folded house: ", house_length,
         " x ", house_depth, " x ", wall_height + roof_height, " mm."));

// ---------------------------------------------------------------------------
// Two-dimensional artwork

// Arched door, open at the bottom edge of the wall.
module door_2d() {
    n_radius = door_width / 2;
    translate([-n_radius, -1])
        square([door_width, door_height - n_radius + 1]);
    translate([0, door_height - n_radius])
        circle(r = n_radius);
}

// A dashed engraving of the VeryOS mark. The outline is broken into small
// slits, so the logo stays attached to the paper instead of falling out.
module logo_outline_2d() {
    difference() {
        resize([logo_width, 0], auto = true)
            import(logo_file, center = true);
        offset(delta = -logo_line)
            resize([logo_width, 0], auto = true)
                import(logo_file, center = true);
    }
}

module logo_engraving_2d() {
    intersection() {
        logo_outline_2d();
        for (n_x = [-logo_width / 2 : logo_dash_pitch : logo_width / 2])
            translate([n_x - logo_dash_width / 2, -logo_width / 2])
                square([logo_dash_width, logo_width]);
    }
}

// ---------------------------------------------------------------------------
// Parts in local coordinates: x along the part, y up from its lower fold.

module wall_outline_2d(index) {
    if (index % 2 == 0)
        polygon([[0, 0], [house_depth, 0], [house_depth, wall_height],
                 [half_depth, wall_height + roof_height], [0, wall_height]]);
    else
        square([house_length, wall_height]);
}

module wall_openings_2d(index) {
    if (index == 0)
        translate([half_depth, 0]) door_2d();
    if (index == 2)
        translate([half_depth, logo_y]) logo_engraving_2d();
}

module wall_2d(index) {
    difference() {
        wall_outline_2d(index);
        wall_openings_2d(index);
    }
}

// Left edge of wall 0; glues behind the right end of wall 3.
module corner_tab_2d() {
    polygon([
        [0, tab_end],
        [-glue_tab, tab_end + glue_tab * 0.6],
        [-glue_tab, wall_height - tab_end - glue_tab * 0.6],
        [0, wall_height - tab_end]
    ]);
}

// Left edge of a roof half, y from the eave. Its lower edge runs parallel to
// the gable edge beside it in the flat net. Its top is cut back so that, glued
// inside the gable, it stays on its own half of the gable.
module roof_side_tab_2d() {
    polygon([
        [0, roof_tab_low],
        [-roof_tab, roof_tab_low + roof_tab * gable_rise],
        [-roof_tab, roof_slant - tab_end - roof_tab * gable_rise],
        [0, roof_slant - tab_end]
    ]);
}

// Top edge of roof 1; glues under the top edge of roof 3.
module ridge_tab_2d() {
    polygon([
        [ridge_tab_inset, roof_slant],
        [house_length - ridge_tab_inset, roof_slant],
        [house_length - ridge_tab_inset - glue_tab * 0.6, roof_slant + glue_tab],
        [ridge_tab_inset + glue_tab * 0.6, roof_slant + glue_tab]
    ]);
}

// Left gable edge of wall 0, in wall coordinates. Roof 3 has no tab on its
// free end; it is glued onto this tab instead.
gable_corner = [0, wall_height];
gable_along = [half_depth, roof_height] / roof_slant;
gable_out = [-roof_height, half_depth] / roof_slant;

module gable_tab_2d() {
    polygon([
        gable_corner + gable_along * tab_end,
        gable_corner + gable_along * (tab_end + glue_tab) + gable_out * glue_tab,
        gable_corner + gable_along * (roof_slant - tab_end - glue_tab)
            + gable_out * glue_tab,
        gable_corner + gable_along * (roof_slant - tab_end)
    ]);
}

// ---------------------------------------------------------------------------
// Flat net

module roof_1_2d() {
    square([house_length, roof_slant]);
    roof_side_tab_2d();
    translate([house_length, 0]) mirror([1, 0]) roof_side_tab_2d();
    ridge_tab_2d();
}

module roof_3_2d() {
    square([house_length, roof_slant]);
    roof_side_tab_2d();
}

module net_solid_2d() {
    union() {
        for (n_index = [0:3])
            translate([x_wall[n_index], 0]) wall_2d(n_index);
        translate([x_wall[0], 0]) {
            corner_tab_2d();
            gable_tab_2d();
        }
        translate([x_wall[1], wall_height]) roof_1_2d();
        translate([x_wall[3], wall_height]) roof_3_2d();
    }
}

// Dashed perforations. A fold is a line of short slits; paper bridges between
// the slits keep the net in one piece and make the fold easy to crease.
module dash_line_2d(n_from, n_to) {
    n_delta = n_to - n_from;
    n_length = norm(n_delta);
    n_count = floor((n_length - 2 * fold_end_gap + fold_dash_gap)
                    / (fold_dash_length + fold_dash_gap));
    if (n_count >= 1)
        for (n_i = [0 : n_count - 1]) {
            n_position = fold_end_gap + fold_dash_length / 2
                + n_i * (fold_dash_length + fold_dash_gap);
            translate(n_from + n_delta * n_position / n_length)
                rotate(atan2(n_delta[1], n_delta[0]))
                    square([fold_dash_length, fold_slit_width], center = true);
        }
}

module fold_slits_2d() {
    // Corner tab root and the three wall corners.
    dash_line_2d([x_wall[0], tab_end], [x_wall[0], wall_height - tab_end]);
    for (n_x = [x_wall[1], x_wall[2], x_wall[3]])
        dash_line_2d([n_x, 0], [n_x, wall_height]);
    // Eaves of the long walls.
    for (n_index = [1, 3])
        dash_line_2d([x_wall[n_index], wall_height],
                     [x_wall[n_index] + house_length, wall_height]);
    // Roof side tab roots: both ends of roof 1, the left end of roof 3.
    for (n_x = [x_wall[1], x_wall[2], x_wall[3]])
        dash_line_2d([n_x, wall_height + roof_tab_low],
                     [n_x, wall_height + roof_slant - tab_end]);
    dash_line_2d([x_wall[1] + ridge_tab_inset, wall_height + roof_slant],
                 [x_wall[2] - ridge_tab_inset, wall_height + roof_slant]);
    translate([x_wall[0], 0])
        dash_line_2d(gable_corner + gable_along * tab_end,
                     gable_corner + gable_along * (roof_slant - tab_end));
}

module net_2d() {
    difference() {
        net_solid_2d();
        fold_slits_2d();
    }
}

// ---------------------------------------------------------------------------
// Folded model. Ideal folds; tabs sit one paper thickness inside.

// Wall 0 faces -x, wall 1 -y, wall 2 +x, wall 3 +y; z = 0 is the inner face.
module place_wall(index) {
    n_half = (index % 2 == 0 ? house_length : house_depth) / 2;
    rotate([0, 0, [270, 0, 90, 180][index]])
        translate([-wall_width(index) / 2, -n_half + paper_thickness, 0])
            rotate([90, 0, 0])
                children();
}

module place_roof(index) {
    rotate([0, 0, [270, 0, 90, 180][index]])
        translate([-house_length / 2, -half_depth, wall_height])
            rotate([roof_pitch, 0, 0])
                children();
}

module sheet_3d() {
    linear_extrude(paper_thickness) children();
}

module roof_side_tab_3d() {
    translate([2 * paper_thickness, 0, 0])
        rotate([0, -90, 0])
            sheet_3d() roof_side_tab_2d();
}

module assembled() {
    color("#e8dcc4")
        for (n_index = [0:3])
            place_wall(n_index) sheet_3d() wall_2d(n_index);
    color("#9c3d2e") {
        place_roof(1) sheet_3d() square([house_length, roof_slant]);
        place_roof(3) sheet_3d() square([house_length, roof_slant]);
    }
    color("#c9a66b") {
        place_wall(0) {
            translate([2 * paper_thickness, 0, 0])
                rotate([0, -90, 0])
                    sheet_3d() corner_tab_2d();
            translate(gable_corner)
                rotate(a = -90, v = [half_depth, roof_height, 0])
                    translate([-gable_corner[0], -gable_corner[1], -paper_thickness])
                        sheet_3d() gable_tab_2d();
        }
        place_roof(1) {
            roof_side_tab_3d();
            translate([house_length, 0, 0]) mirror([1, 0, 0]) roof_side_tab_3d();
            translate([0, roof_slant, 0])
                rotate([-2 * roof_pitch, 0, 0])
                    translate([0, -roof_slant, -paper_thickness])
                        sheet_3d() ridge_tab_2d();
        }
        place_roof(3) roof_side_tab_3d();
    }
}

// ---------------------------------------------------------------------------

if (output == "cut")
    net_2d();
else if (output == "folded")
    assembled();
else {
    color("#e8dcc4") sheet_3d() net_2d();
    if ($preview) {
        color("#e9923f") translate([0, 0, paper_thickness + 0.01])
            linear_extrude(0.01) fold_slits_2d();
        %translate([-(sheet_width - net_width) / 2,
                    -(sheet_height - net_height) / 2, -0.3])
            cube([sheet_width, sheet_height, 0.2]);
    }
}
