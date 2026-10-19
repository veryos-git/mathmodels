// Copyright (C) 2026 Jonas Immanuel Frey - Licensed under GPL. See LICENSE file for details
// Cylindrical container with a matching screw-on lid. Units: mm.
// Single-start right-hand thread: 1 mm pitch, 45 degree flanks.
// No external libraries. Print the lid open-side up.

/* [Display] */
view = "print"; // [print,container,lid,assembled,section]
has_lid = true;
threaded = true;
quality = 128; // [64,128,192]

/* [Dimensions] */
outer_diameter = 60;
// Height of the container including its threaded neck, without the lid.
container_height = 60;
// Minimum wall thickness at the neck and behind the lid thread.
wall_thickness = 2.4;
bottom_thickness = 2.4;
lid_top_thickness = 2.4;
neck_height = 6;
edge_chamfer = 0.5;
// 45-degree bevel on both edges of an open container's rim; 0 disables it.
top_chamfer = 0;

/* [Thread fit] */
thread_pitch = 1;
// Depth = 40% of pitch, leaving small flat crests and roots.
// Radial clearance per side; increase slightly if your printed fit is tight.
radial_clearance = 0.15;
// Total additional groove width, measured along the cylinder axis.
axial_clearance = 0.05;
// Space between the container rim and the underside of the lid roof.
rim_clearance = 0.2;

/* [Hidden] */
$fn = quality;
eps = 0.02;
thread_depth = threaded ? 0.4 * thread_pitch : 0;
crest_flat = 0.1 * thread_pitch;
outer_r = outer_diameter / 2;
neck_r = outer_r - wall_thickness - radial_clearance - thread_depth;
inner_r = has_lid ? neck_r - wall_thickness : outer_r - wall_thickness;
shoulder_z = has_lid ? container_height - neck_height : container_height;
lid_cavity_height = neck_height + rim_clearance;
lid_height = lid_cavity_height + lid_top_thickness;
rim_chamfer = has_lid ? 0 : top_chamfer;

assert(inner_r > 0 && wall_thickness > 0, "Diameter is too small for these walls");
assert(bottom_thickness > 0 && shoulder_z > bottom_thickness);
assert(lid_top_thickness > 0 && rim_clearance >= 0);
assert(thread_pitch > 0 && (!has_lid || !threaded || neck_height >= 3 * thread_pitch),
       "Neck must accommodate at least three thread pitches");
assert(radial_clearance > 0 && (!has_lid || !threaded || radial_clearance < thread_depth),
       "Radial clearance must be positive and smaller than the thread depth");
assert(axial_clearance >= 0 && axial_clearance < 0.1 * thread_pitch,
       "Axial clearance must be less than 10% of the pitch");
assert(edge_chamfer >= 0 && edge_chamfer < min(bottom_thickness, lid_top_thickness, wall_thickness));
assert(rim_chamfer >= 0 && 2*rim_chamfer < wall_thickness &&
       rim_chamfer < container_height-bottom_thickness,
       "Top chamfer must leave a flat rim and stay above the bottom");
assert(quality >= 32 && quality == floor(quality));
assert(view == "print" || view == "container" || view == "lid" ||
       view == "assembled" || view == "section" || view == "lid-assembled", "Unknown view");

// Sweep a trapezoid around a right-handed helix. Equal radial depth and
// axial flank run give 45 degree flanks (90 degree included angle).
// The male ridge fades into the neck at either end. The female cutter
// continues beyond both ends so the lid can screw all the way on and off.
module thread_ridge(female = false) {
    start_z = female ? -thread_pitch : thread_pitch / 2;
    end_z = female ? neck_height + thread_pitch : neck_height - thread_pitch / 2;
    steps = ceil((end_z - start_z) / thread_pitch * quality);
    root = neck_r + (female ? radial_clearance : 0);
    play = female ? axial_clearance / 2 : 0;
    points = [for (i = [0:steps])
        let(z = start_z + (end_z - start_z) * i / steps,
            a = 360 * z / thread_pitch,
            fade = female ? 1 : min(1, (z - start_z) / thread_pitch * 2,
                                      (end_z - z) / thread_pitch * 2),
            depth = thread_depth * fade,
            half_tip = crest_flat / 2 + play,
            profile = [[root - eps, -half_tip - depth - eps],
                       [root + depth, -half_tip],
                       [root + depth, half_tip],
                       [root - eps, half_tip + depth + eps]])
        for (p = profile) [p[0] * cos(a), p[0] * sin(a), z + p[1]]];
    // Clockwise winding as viewed from outside, as required by OpenSCAD.
    faces = concat(
        [[3, 2, 1, 0]],
        [for (i = [0:steps-1], j = [0:3])
            [4*i+j, 4*i+(j+1)%4, 4*(i+1)+(j+1)%4]],
        [for (i = [0:steps-1], j = [0:3])
            [4*i+j, 4*(i+1)+(j+1)%4, 4*(i+1)+j]],
        [[4*steps, 4*steps+1, 4*steps+2, 4*steps+3]]);
    polyhedron(points = points, faces = faces, convexity = 16);
}

module container() {
    difference() {
        union() {
            rotate_extrude() polygon([
                [0, 0], [outer_r-edge_chamfer, 0],
                [outer_r, edge_chamfer], [outer_r, shoulder_z-rim_chamfer],
                [outer_r-rim_chamfer, shoulder_z],
                [0, shoulder_z]]);
            if (has_lid) translate([0, 0, shoulder_z-eps])
                cylinder(r = neck_r, h = neck_height+eps);
            if (has_lid && threaded) translate([0, 0, shoulder_z]) thread_ridge();
        }
        translate([0, 0, bottom_thickness])
            cylinder(r = inner_r, h = container_height);
        if (rim_chamfer > 0) translate([0, 0, container_height-rim_chamfer])
            cylinder(r1 = inner_r, r2 = inner_r+rim_chamfer+eps,
                     h = rim_chamfer+eps);
    }
}

// Defined open-side down with its opening at z=0. In this orientation the
// lid and the neck use exactly the same helical phase.
module lid() {
    difference() {
        rotate_extrude() polygon([
            [0, 0], [outer_r, 0], [outer_r, lid_height-edge_chamfer],
            [outer_r-edge_chamfer, lid_height], [0, lid_height]]);
        translate([0, 0, -eps])
            cylinder(r = neck_r+radial_clearance, h = lid_cavity_height+eps);
        // Clip the groove to the cavity so it cannot cut into the lid roof.
        if (threaded) intersection() {
            thread_ridge(female = true);
            translate([0, 0, -eps])
                cylinder(r = outer_r+eps, h = lid_cavity_height+eps);
        }
        // Small opening bevel makes it easier to find the first thread.
        if (threaded) translate([0, 0, -eps])
            cylinder(r1 = neck_r+radial_clearance+thread_depth+eps,
                     r2 = neck_r+radial_clearance,
                     h = thread_depth+eps);
    }
}

module print_lid() {
    translate([0, 0, lid_height]) rotate([180, 0, 0]) lid();
}

module assembled() {
    color("LightSkyBlue") container();
    color("Wheat") translate([0, 0, shoulder_z]) lid();
}

if (view == "container") container();
else if (view == "lid-assembled") translate([0, 0, shoulder_z]) lid();
else if (view == "lid") print_lid();
else if (view == "assembled") assembled();
else if (view == "section") difference() {
    assembled();
    translate([-outer_r-1, -outer_r-1, -1])
        cube([outer_diameter+2, outer_r+1, container_height+lid_height+2]);
}
else {
    color("LightSkyBlue") container();
    color("Wheat") translate([outer_diameter+10, 0, 0]) print_lid();
}
