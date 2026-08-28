/**
 * The writing setting has to survive being stored as a string.
 *
 * It lives in the app_settings key/value table, so anything can be in that
 * column — an older shape, a half-written value, nothing at all. A commit must
 * never be blocked by a setting, so decoding degrades field by field.
 *
 * @see packages/shared/src/source-control-writing.ts
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SOURCE_CONTROL_MODEL,
  DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS,
  decodeSourceControlWritingSettings,
  encodeSourceControlWritingSettings,
} from '../src/source-control-writing.js'

describe('decodeSourceControlWritingSettings', () => {
  it('defaults to repository conventions when nothing is stored', () => {
    expect(decodeSourceControlWritingSettings(undefined)).toEqual(
      DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS
    )
    expect(decodeSourceControlWritingSettings(null).mode).toBe(
      'repo_conventions'
    )
    expect(decodeSourceControlWritingSettings('').mode).toBe('repo_conventions')
  })

  it('round-trips a saved setting', () => {
    const saved = {
      customInstructions: 'Mention the ticket',
      followPrTemplate: false,
      model: 'anthropic/claude-opus-5',
      mode: 'custom',
    } as const

    expect(
      decodeSourceControlWritingSettings(
        encodeSourceControlWritingSettings(saved)
      )
    ).toEqual(saved)
  })

  it('falls back per field rather than discarding a partial value', () => {
    const decoded = decodeSourceControlWritingSettings(
      '{"mode":"conventional_commits","followPrTemplate":"yes"}'
    )

    expect(decoded.mode).toBe('conventional_commits')
    // A non-boolean cannot answer the question, so the default does.
    expect(decoded.followPrTemplate).toBe(true)
    expect(decoded.model).toBe(DEFAULT_SOURCE_CONTROL_MODEL)
  })

  it('treats an unknown mode and a blank model as unset', () => {
    const decoded = decodeSourceControlWritingSettings(
      '{"mode":"haiku","model":"   "}'
    )

    expect(decoded.mode).toBe('repo_conventions')
    expect(decoded.model).toBe(DEFAULT_SOURCE_CONTROL_MODEL)
  })

  it('survives a value that is not JSON at all', () => {
    expect(decodeSourceControlWritingSettings('not json')).toEqual(
      DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS
    )
    expect(decodeSourceControlWritingSettings('"a string"')).toEqual(
      DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS
    )
  })
})
