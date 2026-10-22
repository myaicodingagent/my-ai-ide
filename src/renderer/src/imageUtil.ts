// Prepares a picture for sending to Claude: large screenshots are scaled down (the model does not use pixels
// beyond about 1.5k on the long side, and the API rejects images over 5 MB) and big ones are re-encoded as JPEG.

export interface ChatImage {
  id: number
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string // base64 without the "data:" prefix
  preview: string // data URL for the thumbnail
}

const MAX_EDGE = 1568
const KEEP_AS_IS_BYTES = 800_000
const SUPPORTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
let nextId = 1

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That is not an image the app can read.'))
    img.src = url
  })

/** Turns a pasted or dropped image file into something that can be attached. Throws a readable error if it cannot. */
export async function toChatImage(file: File): Promise<ChatImage> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name || 'That file'} is not an image.`)
  const original = await readAsDataUrl(file)
  let dataUrl = original
  let mediaType = (SUPPORTED.includes(file.type) ? file.type : 'image/png') as ChatImage['mediaType']

  const img = await loadImage(original)
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight)
  // Small, supported pictures go as they are (GIFs would lose their animation otherwise).
  const needsWork = longEdge > MAX_EDGE || file.size > KEEP_AS_IS_BYTES || !SUPPORTED.includes(file.type)
  if (needsWork) {
    const scale = Math.min(1, MAX_EDGE / longEdge)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not process the image.')
    ctx.fillStyle = '#ffffff' // JPEG has no transparency
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    mediaType = 'image/jpeg'
  }
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
  if (data.length * 0.75 > 4_800_000) throw new Error('That image is still too large after shrinking it.')
  return { id: nextId++, name: file.name || 'pasted image', mediaType, data, preview: dataUrl }
}
