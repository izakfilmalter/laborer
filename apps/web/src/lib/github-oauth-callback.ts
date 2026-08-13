export const parseGithubOAuthCallback = (
  callbackUrl: string,
  expectedState: string
): string => {
  const parsed = new URL(callbackUrl)
  const code = parsed.searchParams.get('code')
  if (!code) {
    throw new Error('No authorization code found in the URL.')
  }
  const state = parsed.searchParams.get('state')
  if (expectedState.length === 0 || state !== expectedState) {
    throw new Error('The GitHub authorization response could not be verified.')
  }
  return code
}
