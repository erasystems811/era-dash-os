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
// Below this, a photo displayed at the near-full phone width every product/
// cover photo actually renders at (menu page, chat header image) visibly
// blurs -- confirmed live, 2026-09-16: era-demo photos at 225x225 and
// 554x554 both looked soft/blurry stretched to fill their box, a 1200x1600
// one right next to them looked sharp. This never upscales a photo (the
// resize above only ever shrinks), it just flags one that was already too
// small before it ever reaches here, so the person uploading it can tell
// "displays sharp" from "displays blurry" before it goes live on the menu.
const LOW_RES_THRESHOLD = 1000;

// Chidera, 2026-09-16: "my menu photo is still not fiting in, make photo
// size square or photo compatible for uploading" -- the menu page's own
// photo box (menu-page-template.js's .shot) is a wide short rectangle,
// nothing close to the aspect ratio of a typical phone food photo (usually
// close to square, or portrait), so object-fit:cover at DISPLAY time had to
// crop away most of the frame to fill it -- on a 225x225 source that meant
// keeping only a thin horizontal sliver, mostly the plate rim. Cropping to
// a square HERE, at upload time (squareCrop: true, product photos only --
// never the cover/logo, which are legitimately non-square banner/mark
// shapes), makes the stored photo and the dashboard's own preview thumbnail
// exactly what shows on the live menu -- no surprise crop happening later,
// invisibly, in someone else's CSS. The display box itself is squared to
// match in the same commit (menu-page-template.js's .shot).
export function compressImageToDataUrl(file, { maxDimension = 1600, quality = 0.82, squareCrop = false } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that as an image.'));
      img.onload = () => {
        // Center-crop to a square FIRST (if asked), so every size/blur
        // calculation below reflects what actually gets stored and shown,
        // not the original un-cropped frame.
        let sourceX = 0;
        let sourceY = 0;
        let sourceW = img.width;
        let sourceH = img.height;
        if (squareCrop && img.width !== img.height) {
          const side = Math.min(img.width, img.height);
          sourceX = Math.round((img.width - side) / 2);
          sourceY = Math.round((img.height - side) / 2);
          sourceW = side;
          sourceH = side;
        }

        let width = sourceW;
        let height = sourceH;
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
        ctx.drawImage(img, sourceX, sourceY, sourceW, sourceH, 0, 0, width, height);
        // PNG (keeps transparency, e.g. a logo) stays PNG; everything else
        // becomes JPEG, which compresses a real photo far better than PNG
        // ever would.
        const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve({
          dataUrl: canvas.toDataURL(outputType, quality),
          isLowRes: Math.max(sourceW, sourceH) < LOW_RES_THRESHOLD,
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
