import { denoiseImage, thresholdImage } from './image-editor.js';

let gray, width, height;
self.onmessage = ({ data: { id, image, params } }) => {
  try {
    if (image) {
      ({ width, height } = image);
      gray = denoiseImage(image);
    }
    if (!gray) return;
    const result = thresholdImage(gray, width, height, params);
    self.postMessage({ id, image: result }, [result.data.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
