import { adjustImage, compositeLineArt, denoiseImage, thresholdImage } from './image-editor.js';

let source, overlay, adjusted, gray, width, height, adjustmentKey;
self.onmessage = ({ data: { id, image, params, adjustments = null, templates } }) => {
  try {
    if (image) {
      ({ width, height } = image);
      source = image;
    }
    if (templates !== undefined) overlay = templates;
    if (!source) return;
    const key = JSON.stringify(adjustments);
    if (image || templates !== undefined || key !== adjustmentKey) {
      adjusted = adjustments ? adjustImage(source, adjustments) : null;
      gray = denoiseImage(compositeLineArt(adjusted ?? source, overlay));
      adjustmentKey = key;
    }
    const result = thresholdImage(gray, width, height, params);
    // Keep the cached pixels when transferring a preview to the main thread.
    const preview = adjusted ? { ...adjusted, data: adjusted.data.slice() } : null;
    self.postMessage({ id, image: result, adjusted: preview },
      preview ? [result.data.buffer, preview.data.buffer] : [result.data.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
