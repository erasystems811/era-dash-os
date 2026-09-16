// Same fix as ebos-templates/dashboard/client/src/imageUpload.js (2026-09-10
// cover-photo bug): a raw phone camera photo can be 15-50MB, which blows
// straight past Express's default json() body limit and fails as a bare
// "request failed 413" with no useful detail. Resize/compress client-side
// instead of raising the server limit -- nothing Claude needs to read a
// menu from requires more than phone-screen resolution.
export function compressImageToDataUrl(file, { maxDimension = 1600, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that as an image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width >= height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve(canvas.toDataURL(outputType, quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
