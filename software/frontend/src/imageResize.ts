// Shrinks a photo in the browser before it's uploaded for recognition: at
// most 1024 px on the long side, re-encoded as JPEG. Smaller uploads and
// cheaper recognition — and redrawing on a canvas drops the EXIF data,
// including the GPS position a phone camera writes into it.

export const MAX_SIDE = 1024
const QUALITY = 0.8

// The size to draw at: the long side capped, the aspect kept
export function fitWithin(width: number, height: number, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  // createImageBitmap applies the photo's rotation (EXIF orientation)
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function shrinkPhoto(file: Blob): Promise<Blob> {
  const img = await decode(file)
  try {
    const { width, height } = fitWithin(img.width, img.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas is not available')
    ctx.drawImage(img.source, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
    if (!blob) throw new Error('Could not process the photo')
    return blob
  } finally {
    img.close()
  }
}
