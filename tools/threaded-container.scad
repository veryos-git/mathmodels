// Adapter only: the supplied SCAD file owns all container design defaults.
use <../hgc/cylinder_shell_mode/threaded_container.scad>;

app_part = "container";
app_lid_z = 0;
app_lid_angle = 0;

if (app_part == "lid-assembled")
    translate([0, 0, app_lid_z]) rotate([0, 0, app_lid_angle]) lid();
else container();
