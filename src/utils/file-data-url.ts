export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to read file as data URL'))
      }
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read file as data URL'))
    reader.readAsDataURL(file)
  })
}

export function filenameForPastedImage(file: File): string {
  const name = file.name?.trim()
  if (name) return name
  const extension = file.type.split('/')[1] || 'png'
  return `clipboard-${Date.now()}.${extension}`
}
