the resulting 3d model should be wrapped around a cylinder. the cylinder should be a shell and the thickness of the shell can be defined. 

the cylinder should have a optional thread and a lid with a thread. 

you can use the [text](simple_cylindrical_screwing_container.scad) for generating the 3d model of the container on the server backend. make sure 'deno task install' installs openSCAD.
then in the frontend the 3d object that is generated with the webapp can be wrapped around it and split where the container/lid split is.



we will have the problem that the 3d model has to be stretched or squeezed in order to fit onto the desired diameter and container height. 
there is a solution for this problem. 
the user can first enter desired height and diameter of the cylinder. 
after this there will be many suggestions of possible diameter and heights. 

those are the possibilities that are closest to the desired values. the 3d model can also be automatically be repeated in x and or y direction before it is wrapped
in order to achieve the desired values more closely


---
the top surface of the cylinder is flat and boring at the moment. there should be a option to add another sketch that then will be sweeped with the same already loaded profile. the dxf is first resized to match the exact same size as the topmost surface of the cylinder lid then sweeped and the 3d part is placed ontop of the cylinder.