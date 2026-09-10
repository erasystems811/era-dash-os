// Resizes and compresses an image client-side before it's ever turned into
// a data: URI and sent to the server -- a raw phone photo can be 15-50MB,
// which blew straight past even a generous server body-size limit. Found
// live, 2026-09-10: a real cover-photo upload failed with a raw
// "PayloadTooLargeError" the UI could only show as a generic save error,
// so a photo that was simply too big looked exactly like nothing had
// happened at all. Raising the server limit further just moves the same
// wall further out -- this is the actual fix: nothing this app displays a
// photo at (a menu header, a logo, a product photo) needs more than phone-
// screen resolution, so there's no real quality tradeoff.
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
        // PNG (keeps transparency, e.g. a logo) stays PNG; everything else
        // becomes JPEG, which compresses a real photo far better than PNG
        // ever would.
        const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve(canvas.toDataURL(outputType, quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
