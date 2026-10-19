export const PROFILE_SCALE_GROUPS = [
  { name: 'main', width: 'profileScale', height: 'profileHeightScale', lock: 'profileScaleLock', position: 'profileZ' },
  { name: 'cusp', width: 'cuspWidth', height: 'cuspHeight', lock: 'cuspScaleLock', position: 'cuspZ' },
  { name: 'groove', width: 'grooveWidth', height: 'grooveHeight', lock: 'grooveScaleLock', position: 'grooveZ' },
];
export const PROFILE_SCALE_FIELDS = PROFILE_SCALE_GROUPS.flatMap(g => [g.width, g.height]);
export const PROFILE_POSITION_FIELDS = PROFILE_SCALE_GROUPS.map(g => g.position);
export const PROFILE_TRANSFORM_FIELDS = [...PROFILE_SCALE_FIELDS, ...PROFILE_POSITION_FIELDS];

export function profilePositionSettings(project = {}) {
  return Object.fromEntries(PROFILE_POSITION_FIELDS.map(key => {
    const value = Number(project.settings?.[key] ?? 0);
    return [key, Number.isFinite(value) ? value : 0];
  }));
}

/** Keep older projects the same size while giving each section its own scales. */
export function profileScaleSettings(project = {}) {
  const saved = project.settings ?? {};
  const values = { profileScale: 1, profileHeightScale: 1, cuspWidth: .55, cuspHeight: .55,
    grooveWidth: saved.profileScale ?? 1, grooveHeight: 1 };
  for (const key of PROFILE_SCALE_FIELDS) {
    const value = Number(saved[key] ?? values[key]);
    values[key] = Number.isFinite(value) && value > 0 ? value : 1;
  }
  if (saved.profileHeightScale === undefined && !project.tracery?.profile?.data) {
    values.cuspWidth = Number((values.cuspWidth * values.profileScale).toPrecision(12));
  }
  return values;
}

/** Link X/Y proportionally, preserving the current ratio when locked. */
export function bindProfileScales({ get, changed, invalid }) {
  const groups = PROFILE_SCALE_GROUPS.map(group => {
    const numbers = [get(group.width), get(group.height)];
    const sliders = [get(group.width + 'Slider'), get(group.height + 'Slider')];
    const lock = get(group.lock);
    let previous, ratio;
    function sync() {
      previous = numbers.map(input => Number(input.value));
      ratio = previous[1] / previous[0];
      sliders.forEach((slider, i) => {
        // Exact numeric entries and old projects may exceed the slider's usual range.
        slider.min = String(Math.min(.01, previous[i]));
        slider.max = String(Math.max(10, previous[i]));
        slider.value = numbers[i].value;
      });
    }
    function update(axis, value, commit) {
      if (!Number.isFinite(value) || value <= 0) {
        if (commit) {
          numbers.forEach((input, i) => { input.value = String(previous[i]); });
          invalid('Profile width and height must be greater than zero.');
        }
        return;
      }
      const next = [...previous];
      next[axis] = value;
      if (lock.checked) next[1 - axis] = axis === 0 ? value * ratio : value / ratio;
      if (next.some(v => !Number.isFinite(v) || v <= 0)) return;
      numbers.forEach((input, i) => { input.value = String(Number(next[i].toPrecision(12))); });
      // Keep the lock ratio fixed for the entire drag, avoiding cumulative rounding.
      const lockedRatio = ratio;
      sync();
      if (lock.checked) ratio = lockedRatio;
      changed(group.name, commit);
    }
    numbers.forEach((input, axis) => {
      input.onchange = () => update(axis, Number(input.value), true);
      sliders[axis].oninput = () => update(axis, Number(sliders[axis].value), false);
      sliders[axis].onchange = () => update(axis, Number(sliders[axis].value), true);
    });
    lock.onchange = sync;
    sync();
    return { ...group, sync };
  });
  return {
    sync: () => groups.forEach(group => group.sync()),
    snapshotLocks: () => Object.fromEntries(groups.map(group => [group.name, get(group.lock).checked])),
    restore(project = {}) {
      for (const [id, value] of Object.entries(profileScaleSettings(project))) get(id).value = String(value);
      for (const [id, value] of Object.entries(profilePositionSettings(project))) get(id).value = String(value);
      for (const group of groups) {
        get(group.lock).checked = !!project.profileScaleLocks?.[group.name];
        group.sync();
      }
    },
  };
}
