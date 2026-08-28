const BROWSER_PREVIEW_EXTENSION = /\.(?:html?|pdf)$/i
const QUERY_OR_HASH = /[?#]/

export const isBrowserPreviewFile = (path: string): boolean =>
  BROWSER_PREVIEW_EXTENSION.test(path.split(QUERY_OR_HASH, 1)[0] ?? '')

export async function openFileInBrowser<
  Preview extends { readonly tabId: string },
>(input: {
  readonly baseUrl: string
  readonly createAssetUrl: (payload: {
    readonly relativePath: string
    readonly workspaceId: string
  }) => Promise<{ readonly relativeUrl: string }>
  readonly openPreview: (payload: {
    readonly url: string
    readonly workspaceId: string
  }) => Promise<Preview>
  readonly relativePath: string
  readonly workspaceId: string
}): Promise<{ readonly preview: Preview; readonly url: string }> {
  const asset = await input.createAssetUrl({
    relativePath: input.relativePath,
    workspaceId: input.workspaceId,
  })
  const url = new URL(asset.relativeUrl, input.baseUrl).href
  const preview = await input.openPreview({
    url,
    workspaceId: input.workspaceId,
  })
  return { preview, url }
}
