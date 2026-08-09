const GITHUB_HTTPS_REMOTE_REGEX =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
const GITHUB_SSH_REMOTE_REGEX = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/

/** Parse a GitHub owner and repository from a supported origin URL. */
const parseGithubRepo = (
  remoteUrl: string
): { readonly owner: string; readonly repo: string } | null => {
  const trimmedRemoteUrl = remoteUrl.trim()
  const httpsMatch = trimmedRemoteUrl.match(GITHUB_HTTPS_REMOTE_REGEX)
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] }
  }

  const sshMatch = trimmedRemoteUrl.match(GITHUB_SSH_REMOTE_REGEX)
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] }
  }

  return null
}

export { parseGithubRepo }
