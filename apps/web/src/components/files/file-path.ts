/** Ported from t3code's `filePath.ts`. */

export interface FileBreadcrumb {
  kind: 'project' | 'directory' | 'file'
  label: string
  path: string
}

export function fileBreadcrumbs(
  projectName: string,
  relativePath: string
): FileBreadcrumb[] {
  const parts = relativePath.split('/').filter(Boolean)
  return [
    { label: projectName, path: '', kind: 'project' },
    ...parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join('/'),
      kind:
        index === parts.length - 1 ? ('file' as const) : ('directory' as const),
    })),
  ]
}
