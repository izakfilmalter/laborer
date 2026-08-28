import { describe, expect, it } from 'vitest'
import { PREVIEW_WEBVIEW_PREFERENCES } from '../src/preview/WebviewPreferences.js'

const WHITESPACE_PATTERN = /\s/
const BOOLEAN_PATTERN = /^(true|false)$/

function parsePreferences(input: string): Record<string, string | undefined> {
  return Object.fromEntries(input.split(',').map((pair) => pair.split('=')))
}

describe('preview webview preferences', () => {
  const preferences = parsePreferences(PREVIEW_WEBVIEW_PREFERENCES)

  it('contains only canonical security-critical boolean preferences', () => {
    expect(Object.keys(preferences).toSorted()).toEqual(
      [
        'allowRunningInsecureContent',
        'contextIsolation',
        'experimentalFeatures',
        'nodeIntegration',
        'nodeIntegrationInSubFrames',
        'nodeIntegrationInWorker',
        'sandbox',
        'webSecurity',
        'webviewTag',
      ].toSorted()
    )
    expect(PREVIEW_WEBVIEW_PREFERENCES).not.toMatch(WHITESPACE_PATTERN)
    expect(
      Object.values(preferences).every((value) =>
        BOOLEAN_PATTERN.test(value ?? '')
      )
    ).toBe(true)
  })

  it('isolates and sandboxes the guest without exposing Node', () => {
    expect(preferences).toEqual({
      allowRunningInsecureContent: 'false',
      contextIsolation: 'true',
      experimentalFeatures: 'false',
      nodeIntegration: 'false',
      nodeIntegrationInSubFrames: 'false',
      nodeIntegrationInWorker: 'false',
      sandbox: 'true',
      webSecurity: 'true',
      webviewTag: 'false',
    })
  })
})
