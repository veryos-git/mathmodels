const finitePositive = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return number;
};

/**
 * The three rails of a printable, right-angled hook support. The mounting
 * rail is at X=0; reach points away from the model and height reinforces it.
 */
export function hookPaths(reach, height) {
  const width = finitePositive(reach, 'Hook reach');
  const rise = finitePositive(height, 'Hook support height');
  return [
    [[0, rise], [0, 0], [width, 0]],
    [[0, rise], [width, 0]],
  ];
}

/** A millimetre SVG path that the converter can sweep with the main profile. */
export function hookSvg(reach, height) {
  const [[mount, corner, tip], [braceStart, braceEnd]] = hookPaths(reach, height);
  const [width, rise] = [tip[0], mount[1]];
  // SVG Y is downward. The converter flips it back to the coordinates above.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${rise}mm" viewBox="0 0 ${width} ${rise}"><path d="M ${mount[0]} 0 V ${rise} H ${tip[0]} M ${braceStart[0]} 0 L ${braceEnd[0]} ${rise}" fill="none" stroke="black"/></svg>`;
}
