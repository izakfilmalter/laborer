import { useAtomValue } from '@effect/atom-react/Hooks'

import { LaborerClient } from '@/atoms/laborer-client'

const currentGithubUser$ = LaborerClient.query('github.currentUser', {})

/**
 * The GitHub login this machine is authenticated as, or null when unknown.
 *
 * Null covers both "still loading" and "not logged in", because callers treat
 * them identically: until we know who "me" is, nothing can be ruled out as
 * mine, so author grouping simply shows every attributed author. That is a
 * readable intermediate state rather than a flicker of wrong grouping.
 */
export const useCurrentGithubLogin = (): string | null => {
  const result = useAtomValue(currentGithubUser$)
  if (result._tag !== 'Success') {
    return null
  }
  return result.value.login
}
