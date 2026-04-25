import { promises as fs } from 'fs'
import os from 'os'
import * as path from 'path'
import { prepareImageForApi } from '../image-utils'

// Save a data URL (data:image/png;base64,...) to a temp file with resize.
export async function dataUrlToTempFile(dataUrl: string): Promise<string | null> {
  const prepared = prepareImageForApi(dataUrl)
  if (!prepared) return null
  const ext = prepared.mimeType === 'image/png' ? 'png' : 'jpg'
  const buf = Buffer.from(prepared.base64, 'base64')
  const dir = path.join(os.tmpdir(), 'bat-codex-images')
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  await fs.writeFile(filePath, buf)
  return filePath
}
