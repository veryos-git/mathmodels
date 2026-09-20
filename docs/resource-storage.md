# Resources and model projects

Open **Resource library** from Start. Resources are reusable 2D inputs with
three roles: **subject**, **boundary**, and **profile**. Choose the category
before adding an SVG/DXF. Each resource can be renamed, duplicated, deleted,
or updated. All resources have drawing thumbnails, including DXF boundaries and
profiles, in both the library and the corresponding model input picker. DXF
previews are cached beside their drawing revision and regenerated when the
drawing changes.

For an image, use the existing Trace editor and **Save subject**. The save
re-runs the trace and stores the original image, current painted image, trace
settings, and resulting SVG together. **Edit image / trace** reopens that work;
**Save subject** updates the same resource. **Reset edits** returns to the
original image. Use Duplicate in the library to make a separate variant.
Paint edits are preserved as an image, not an editable history of brush strokes.

**Create model** uses a subject as a model input. Select a boundary or profile
with **Use in model**, or use the model's input pickers. Save the model with
the existing project controls. Project snapshots contain their actual inputs,
settings, face painting, and optional resource ID/revision references. Updating
or deleting a resource therefore leaves saved projects reproducible. Projects
continue to work as downloadable `.v2sproj` files.

## Files on disk

The existing `LIBRARY_DIR` setting controls the root (default `library`). No
new permissions or database are required:

```text
library/
  old-drawing.svg                   # existing uncategorized library entries
  resources/
    <stable-resource-id>/
      resource.json                # current name, role, timestamps and file paths
      revisions/
        <revision-id>/
          resource.json            # manifest for this save
          drawing.svg              # or drawing.dxf
          original.png             # original format retained
          edited.png               # current working image, when traced
projects/
  My window.v2sproj                 # self-contained model snapshot
  My window.png                    # model preview
```

Manifest `schemaVersion` is 1. Names are editable labels, while IDs remain
stable. Each manifest points to its exact input files, which can come from an
earlier revision after a rename. The server publishes the current manifest
with an atomic rename only after writing its files. Earlier revision folders
remain available for manual recovery. Deleting a resource removes its entire
folder, including revisions. Revision pruning and a revision-history UI are
not implemented.

## Existing work

**Import saved project resources** reads existing projects without modifying
them. It imports subjects, layered subjects, boundaries and sweep profiles.
Traced subjects retain their source image and settings. Older projects only
stored the edited image; their pre-edit original cannot be recovered, so the
available source is used as the reset baseline. Repeating the import skips
already imported inputs, including their trace state.

Earlier library drawings stay under **Uncategorized drawings from earlier
uploads**. Choose a category and use **Organize** on a tile to add a typed
resource. The original library file stays available.

## HTTP API

- `GET /api/resources`: list current resource manifests.
- `POST /api/resources`: create from multipart `name`, `kind`, `drawing`, and
  optionally `original`, `edited`, and `trace` (JSON settings).
- `GET /api/resources/:id`: read the current manifest.
- `GET /api/resources/:id/preview`: SVG thumbnail of the SVG or DXF drawing.
- `PUT /api/resources/:id`: update supplied fields; omitted files are retained.
- `DELETE /api/resources/:id`: delete the resource and all its revisions.
- `GET /api/resources/:id/drawing`, `/original`, `/edited`: read a stored file.
- `POST /api/resources/import`: import resources from saved projects and report
  added, existing, and skipped inputs.

Run `deno task check` and `deno task test` to check the server and storage.

The additional cusp profiles, revolved endings, filament calibration and
black-area outline preservation are described in the [workflow guide](workflows.md).
