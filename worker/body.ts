import { BadRequest } from './validate'

/** 本文を上限付きで読む（Content-Length が無い・偽っている場合も上限で打ち切る） */
export async function readText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (declared > maxBytes) throw new BadRequest('リクエストが大きすぎます', 413)
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new BadRequest('リクエストが大きすぎます', 413)
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(buf)
}
