/**
 * Unit tests for getSandboxSetupLabel — a pure function that maps
 * sandbox setup step keys to human-readable display labels.
 *
 * Covers all Docker and Daytona provider steps, granular Docker build
 * steps, unknown steps, and the null boundary (setup complete).
 *
 * @see apps/web/src/lib/sandbox-setup-labels.ts
 * @see Issue 24: Setup step progress UI for Daytona-specific steps
 */

import { describe, expect, it } from 'vitest'
import { getSandboxSetupLabel } from '../src/lib/sandbox-setup-labels'

describe('getSandboxSetupLabel', () => {
  // -----------------------------------------------------------------------
  // Docker provider steps
  // -----------------------------------------------------------------------

  it('returns "Building container image..." for building-image', () => {
    expect(getSandboxSetupLabel('building-image')).toBe(
      'Building container image...'
    )
  })

  it('returns "Starting container..." for starting-container', () => {
    expect(getSandboxSetupLabel('starting-container')).toBe(
      'Starting container...'
    )
  })

  // -----------------------------------------------------------------------
  // Daytona provider steps
  // -----------------------------------------------------------------------

  it('returns "Creating sandbox..." for creating-sandbox', () => {
    expect(getSandboxSetupLabel('creating-sandbox')).toBe('Creating sandbox...')
  })

  it('returns "Building sandbox snapshot..." for building-snapshot', () => {
    expect(getSandboxSetupLabel('building-snapshot')).toBe(
      'Building sandbox snapshot...'
    )
  })

  it('returns "Pushing code to sandbox..." for pushing-code', () => {
    expect(getSandboxSetupLabel('pushing-code')).toBe(
      'Pushing code to sandbox...'
    )
  })

  it('returns "Configuring SSH access..." for configuring-ssh', () => {
    expect(getSandboxSetupLabel('configuring-ssh')).toBe(
      'Configuring SSH access...'
    )
  })

  it('returns "Checking Shuru availability..." for checking-shuru', () => {
    expect(getSandboxSetupLabel('checking-shuru')).toBe(
      'Checking Shuru availability...'
    )
  })

  it('returns "Restoring shared checkpoint..." for restoring-checkpoint', () => {
    expect(getSandboxSetupLabel('restoring-checkpoint')).toBe(
      'Restoring shared checkpoint...'
    )
  })

  it('returns "Building shared checkpoint..." for building-base-checkpoint', () => {
    expect(getSandboxSetupLabel('building-base-checkpoint')).toBe(
      'Building shared checkpoint...'
    )
  })

  it('returns "Allocating localhost preview port..." for allocating-port', () => {
    expect(getSandboxSetupLabel('allocating-port')).toBe(
      'Allocating localhost preview port...'
    )
  })

  it('returns "Starting Shuru sandbox..." for starting-shuru', () => {
    expect(getSandboxSetupLabel('starting-shuru')).toBe(
      'Starting Shuru sandbox...'
    )
  })

  it('returns "Starting sandbox..." for starting-sandbox', () => {
    expect(getSandboxSetupLabel('starting-sandbox')).toBe('Starting sandbox...')
  })

  // -----------------------------------------------------------------------
  // Granular Docker build steps
  // -----------------------------------------------------------------------

  it('passes through granular Docker build steps starting with "Step "', () => {
    expect(getSandboxSetupLabel('Step 4/5: RUN pnpm install')).toBe(
      'Step 4/5: RUN pnpm install'
    )
  })

  it('passes through "Step 1/3: FROM node:22"', () => {
    expect(getSandboxSetupLabel('Step 1/3: FROM node:22')).toBe(
      'Step 1/3: FROM node:22'
    )
  })

  // -----------------------------------------------------------------------
  // Unknown / fallback
  // -----------------------------------------------------------------------

  it('returns "Setting up sandbox..." for unknown steps', () => {
    expect(getSandboxSetupLabel('some-future-step')).toBe(
      'Setting up sandbox...'
    )
  })

  it('returns "Setting up sandbox..." for empty string', () => {
    expect(getSandboxSetupLabel('')).toBe('Setting up sandbox...')
  })
})
