

help me to create a paper mode. 
this mode is a svg that is a foldable paper model. the flat 2d paper model is generated with openscad. the default template is a template of a house. the parameters of the openscad can be changed via web UI. 
the paper house 3d model is then visualized and presented in a small 3d view. 

the default .scad that generates a house does not include any windows. 
windows and other decorations have to be added by adding svg/dxf patterns. they are assumed to only be simple connected paths. those paths are thickened and only the inner cutouts are used in the paper svg. 


svg's can be added . by default they are converted to a frame and only the cutouts (without the outer most outline) are converted to a svg , which then can be placed , resized, and translated on the main paper  template svg. 
the result should be downloadable and can then be used in a software with a CNC paper cutter .

for more details see /home/mintuser/code/mathmodels/hgc_requirements_documentation/paper_mode_hgc/readme_hgc.md


