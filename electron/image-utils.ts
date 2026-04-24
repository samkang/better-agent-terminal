const MAX_LONG_EDGE = 2048
const MAX_BASE64_BYTES = 4 * 1024 * 1024
const JPEG_QUALITY = 80

export interface PreparedImage {
  dataUrl: string
  mimeType: string
  base64: string
}

/**
 * Resize a data-URL image if it exceeds dimension/size thresholds.
 * Returns a processed data URL or null on parse failure.
 */
export function prepareImageForApi(dataUrl: string): PreparedImage | null {
  const match = dataUrl.match(/^data:image\/([a-z+]+);base64,(.+)$/i)
  if (!match) return null

  const origMime = match[1].toLowerCase()
  let buf = Buffer.from(match[2], 'base64')

  // Lazy-require so headless bat-server (ELECTRON_RUN_AS_NODE) doesn't pull
  // 'electron' at server-cli startup — image upload only happens via the UI.
  const { nativeImage } = require('electron') as typeof import('electron')
  let img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return null

  const { width, height } = img.getSize()
  const longEdge = Math.max(width, height)

  if (longEdge > MAX_LONG_EDGE) {
    const scale = MAX_LONG_EDGE / longEdge
    const newW = Math.round(width * scale)
    const newH = Math.round(height * scale)
    img = img.resize({ width: newW, height: newH, quality: 'good' })
  }

  // Try PNG first for lossless types, fall back to JPEG if too large
  const isPng = origMime === 'png' || origMime === 'svg+xml' || origMime === 'bmp'
  if (isPng) {
    buf = img.toPNG()
    if (buf.length <= MAX_BASE64_BYTES) {
      const b64 = buf.toString('base64')
      return { dataUrl: `data:image/png;base64,${b64}`, mimeType: 'image/png', base64: b64 }
    }
  }

  // JPEG for everything else, or PNG that was too large
  buf = img.toJPEG(JPEG_QUALITY)
  const b64 = buf.toString('base64')
  return { dataUrl: `data:image/jpeg;base64,${b64}`, mimeType: 'image/jpeg', base64: b64 }
}
