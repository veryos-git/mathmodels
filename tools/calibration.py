"""Labeled, flat-bottom transmission tabs attached to a handling spine."""
import argparse
import json
import trimesh
from gothic import solid_union

# Seven-segment patch numbers embossed on the handling spine, outside the
# optical sample area. Samples run from left to right, 1 through N.
DIGITS = ['abcedf','bc','abdeg','abcdg','bcfg','acdfg','acdefg','abc','abcdefg','abcdfg']
SEGMENTS = {'a':(0,1.8,1.2,.25),'b':(.6,.9,.25,1.6),'c':(.6,-.9,.25,1.6),
            'd':(0,-1.8,1.2,.25),'e':(-.6,-.9,.25,1.6),'f':(-.6,.9,.25,1.6),'g':(0,0,1.2,.25)}
def coupon(thicknesses):
    if not 2 <= len(thicknesses) <= 16 or any(not 0 < t <= 10 for t in thicknesses):
        raise ValueError('Use 2–16 patches between 0 and 10 mm thick')
    meshes = []
    def block(size, position):
        mesh = trimesh.creation.box(size); mesh.apply_translation(position); meshes.append(mesh)
    width = len(thicknesses)*12
    block([width,6,1.2], [width/2-6,-3,0.6])
    for i,t in enumerate(thicknesses):
        block([10,20.2,t], [i*12,10,t/2])
        label = str(i+1)
        for j,digit in enumerate(label):
            for seg in DIGITS[int(digit)]:
                x,y,w,h = SEGMENTS[seg]
                block([w,h,.5], [i*12+(j-(len(label)-1)/2)*2+x,y-3,1.4])
    return solid_union(meshes)
if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('output'); ap.add_argument('--thicknesses',required=True)
    args = ap.parse_args()
    coupon(json.loads(args.thicknesses)).export(args.output)
