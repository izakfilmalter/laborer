const TRAILING_SLASHES = /\/+$/

const basename = (path: string): string =>
  path.replace(TRAILING_SLASHES, '').split('/').at(-1) ?? path

export function serializeFileMention(path: string): string {
  const relativePath = path.replace(TRAILING_SLASHES, '')
  const label = basename(relativePath)
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
  const destination = encodeURI(relativePath)
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F')
    .replaceAll('\\', '%5C')
  return `[${label}](${destination})`
}
