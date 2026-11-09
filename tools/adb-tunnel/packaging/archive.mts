import {createHash} from 'node:crypto'
import {gzipSync, gunzipSync} from 'node:zlib'

export interface ArchiveFile {path: string, data: Buffer, executable?: boolean}
export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** Fixed uid/gid, modes, ordering and zero timestamps; no platform tar extensions. */
export function archiveFiles(root: string, files: ArchiveFile[]): Buffer {
  const parts: Buffer[] = []
  const entry = (path: string, data: Buffer, mode: number, directory = false) => {
    if (!/^[A-Za-z0-9@._/-]+$/.test(path) || Buffer.byteLength(path) > 100) {
      throw new Error('Unsupported release archive path')
    }
    const header = Buffer.alloc(512)
    header.write(path, 0)
    const octal = (value: number, offset: number, length: number) =>
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii')
    octal(mode, 100, 8)
    octal(0, 108, 8)
    octal(0, 116, 8)
    octal(data.length, 124, 12)
    octal(0, 136, 12)
    header.fill(32, 148, 156)
    header.write(directory ? '5' : '0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    parts.push(header, data)
    if (data.length % 512) parts.push(Buffer.alloc(512 - data.length % 512))
  }
  entry(root + '/', Buffer.alloc(0), 0o755, true)
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    entry(`${root}/${file.path}`, file.data, file.executable ? 0o755 : 0o644)
  }
  parts.push(Buffer.alloc(1024))
  const result = gzipSync(Buffer.concat(parts), {level: 9})
  // Gzip's OS byte must not distinguish macOS and Linux builders.
  result[9] = 255
  return result
}

/** Read only our bounded regular-file release format, never symlinks or traversal. */
export function unpackRelease(archive: Buffer, root: string): ArchiveFile[] {
  const tar = gunzipSync(archive, {maxOutputLength: 16 * 1024 * 1024})
  const files: ArchiveFile[] = []
  const names = new Set<string>()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) return files
    const string = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').split('\0')[0]!
    const name = string(0, 100)
    const sizeText = string(124, 12)
    const expected = parseInt(string(148, 8).trim(), 8)
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    const type = string(156, 1)
    if (!/^[0-7]+$/.test(sizeText) || actual !== expected || string(257, 6) !== 'ustar') {
      throw new Error('Invalid release archive header')
    }
    const size = parseInt(sizeText, 8)
    if (type === '5' && name === root + '/' && size === 0) {
      offset += 512
      continue
    }
    const path = name.slice(root.length + 1)
    if (type !== '0' || !name.startsWith(root + '/') || !path ||
        !/^[A-Za-z0-9@._/-]+$/.test(path) || path.split('/').some(part => part === '..' || part === '.' || !part) ||
        names.has(path) || offset + 512 + size > tar.length) {
      throw new Error('Unsafe release archive entry')
    }
    names.add(path)
    files.push({path, data: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)),
      executable: (parseInt(string(100, 8), 8) & 0o111) !== 0})
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('Truncated release archive')
}
