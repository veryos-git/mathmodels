// Copyright (C) 2026 Jonas Immanuel Frey - Licensed under GPL. See LICENSE file for details
// A very simple BIC lighter case, reverse-engineered from bic_sleeve_plain.stl.
//
// The part is a thin elliptical tube, closed at the bottom and open at the top.
// A BIC Maxi (J26, full size) lighter drops in from above and a small hole in
// the floor lets you push it back out with a finger.
//
// What makes a lighter actually slide in and stay put is the INNER cavity, so
// the cavity is the thing this script is built around: it is the lighter size
// plus a fit clearance. The outside is then just the cavity plus the wall. The
// original STL cavity (25.85 x 15.1 mm) is a Maxi (25 x 14.5 mm) plus ~0.4 mm
// per side, which is exactly what the defaults below reproduce.
//
// Units: mm. No external libraries needed.

/* [Lighter: BIC Maxi J26] */
// Across the wide flat faces of the lighter.
lighter_width = 25.0;
// Front to back of the lighter.
lighter_depth = 14.5;

/* [Fit] */
// Gap per side between the lighter and the inner wall. THIS is the number that
// decides whether the lighter slides in and holds: 0.25 snug, 0.4 standard,
// 0.6 loose. Increase it if your printer tends to over-extrude.
fit_clearance = 0.25;

/* [Case] */
// Side wall and bottom floor thickness.
wall = 1.0;
floor_thickness = 2.0;
// Overall height of the sleeve. The cavity is this minus the floor, so it sets
// how far the lighter sinks in and how much of the metal top stays exposed.
height = 70.9;

/* [Details] */
// 45 degree chamfer on the outer top and bottom edges.
edge_chamfer = 0.4;
// Smaller lead-inm chamfer at the inner mouth so the lighter starts in easily.
mouth_chamfer = 0.4;
// Diameter of the finger push-out hole through the floor.
hole_diameter = 12.0;

/* [Quality] */
// Facets per full circle.
$fn = 96;

/* [Hidden] */
eps = 0.01;
// The inner cavity is driven by the lighter plus the clearance - the critical
// dimension. Everything outside is derived from it by adding the wall.
in_a  = lighter_width / 2 + fit_clearance;
in_b  = lighter_depth / 2 + fit_clearance;
out_a = in_a + wall;
out_b = in_b + wall;
hole_r = hole_diameter / 2;

assert(edge_chamfer + mouth_chamfer < wall,
       "Chamfers would eat through the top rim; reduce them or thicken the wall.");

// An ellipse with the given semi-axes.
module oval(a, b) scale([a, b]) circle(r = 1);

// Outer body: a full-size tube whose top and bottom outer edges are chamfered.
// hull() between the inset end caps and the full-size middle makes the 45 slopes.
module outer_body() {
    c = edge_chamfer;
    hull() {
        linear_extrude(eps)                oval(out_a - c, out_b - c);
        translate([0, 0, c])               linear_extrude(height - 2 * c) oval(out_a, out_b);
        translate([0, 0, height - eps])    linear_extrude(eps) oval(out_a - c, out_b - c);
    }
}

// Cavity to hollow out: an elliptical bore from the floor up and out the top,
// plus a flared lead-in at the mouth.
module cavity() {
    translate([0, 0, floor_thickness])
        linear_extrude(height) oval(in_a, in_b);
    c = mouth_chamfer;
    translate([0, 0, height - c])
        hull() {
            linear_extrude(eps) oval(in_a, in_b);
            translate([0, 0, c]) linear_extrude(eps) oval(in_a + c, in_b + c);
        }
}

// Finger push-out hole with a small countersink on the underside.
module push_hole() {
    cs = 0.5;
    translate([0, 0, -eps]) cylinder(h = floor_thickness + 2 * eps, r = hole_r);
    translate([0, 0, -eps]) cylinder(h = cs + eps, r1 = hole_r + cs, r2 = hole_r);
}

module lighter_case() {
    difference() {
        outer_body();
        cavity();
        push_hole();
    }
}

lighter_case();
