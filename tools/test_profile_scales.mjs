import assert from 'node:assert/strict';
import { bindProfileScales, PROFILE_SCALE_GROUPS, PROFILE_POSITION_FIELDS, profilePositionSettings, profileScaleSettings } from '../static/profile-scales.js';

const inputs = new Map();
for (const id of PROFILE_POSITION_FIELDS) inputs.set(id, { value: '0' });
for (const group of PROFILE_SCALE_GROUPS) {
  for (const id of [group.width, group.height, group.width + 'Slider', group.height + 'Slider', group.lock]) {
    inputs.set(id, { value: '1', checked: false });
  }
}
const get = id => inputs.get(id);
const changes = [], errors = [];
const controls = bindProfileScales({ get, changed: (...args) => changes.push(args), invalid: error => errors.push(error) });
const edit = (id, value, event = id.endsWith('Slider') ? 'input' : 'change') => {
  get(id).value = String(value); get(id)['on' + event]();
};
for (const group of PROFILE_SCALE_GROUPS) {
  controls.restore();
  edit(group.width + 'Slider', 2);
  edit(group.height, 3);
  assert.equal(get(group.width).value, '2', 'Y leaves X unchanged when unlocked');
  get(group.lock).checked = true; get(group.lock).onchange();
  edit(group.width + 'Slider', 4);
  assert.equal(get(group.height).value, '6', 'lock preserves the current 2:3 ratio');
  edit(group.height + 'Slider', 3);
  assert.equal(get(group.width).value, '2', 'either axis drives the linked pair');
  edit(group.height, 12, 'change');
  assert.equal(get(group.width).value, '8');
  assert.equal(get(group.height + 'Slider').max, '12', 'exact entries remain reachable by slider');
  assert.deepEqual(changes.at(-1), [group.name, true]);
  edit(group.width, '', 'change');
  assert.equal(get(group.width).value, '8', 'invalid changes restore the previous value');
  for (const other of PROFILE_SCALE_GROUPS.filter(g => g !== group)) {
    assert.equal(Number(get(other.width).value), other.name === 'cusp' ? .55 : 1);
  }
  const saved = { settings: Object.fromEntries(PROFILE_SCALE_GROUPS.flatMap(g =>
    [[g.width, get(g.width).value], [g.height, get(g.height).value]])), profileScaleLocks: controls.snapshotLocks() };
  controls.restore(); controls.restore(saved);
  assert.equal(get(group.lock).checked, true);
  edit(group.height, 6);
  assert.equal(get(group.width).value, '4', 'saved lock and ratio survive reopening');
}
assert.equal(errors.length, 3);
const legacy = { settings: { profileScale: '2', cuspWidth: '.4', cuspHeight: '.7' } };
assert.deepEqual(profileScaleSettings(legacy), {
  profileScale: 2, profileHeightScale: 1, cuspWidth: .8, cuspHeight: .7, grooveWidth: 2, grooveHeight: 1,
});
assert.equal(profileScaleSettings({ ...legacy, tracery: { profile: { data: 'custom section' } } }).cuspWidth, .4);
controls.restore(legacy);
assert.equal(get('grooveWidthSlider').value, '2');
assert.deepEqual(controls.snapshotLocks(), { main: false, cusp: false, groove: false });
controls.restore();
assert.equal(get('grooveWidth').value, '1', 'new work resets migrated settings');
controls.restore({ settings: { profileZ: 1.2, grooveZ: -.3, cuspZ: .4 } });
assert.equal(get('grooveZ').value, '-0.3');
assert.deepEqual(profilePositionSettings({settings:{profileZ:'NaN',cuspZ:'0.123'}}), {profileZ:0,cuspZ:.123,grooveZ:0});
controls.restore();
for (const id of PROFILE_POSITION_FIELDS) assert.equal(get(id).value, '0', 'new work clears vertical offsets');
console.log('Profile controls: independent axes, proportional locks, numeric validation and project migration passed.');
