import { describe, expect, it } from 'vitest'

import {
  isArm64HostRunningIntelBuild,
  resolveDesktopRuntimeInfo,
} from '../src/runtime-arch.js'

describe('resolveDesktopRuntimeInfo', () => {
  it('detects Rosetta-translated Intel builds on Apple Silicon', () => {
    const runtimeInfo = resolveDesktopRuntimeInfo({
      platform: 'darwin',
      processArch: 'x64',
      runningUnderArm64Translation: true,
    })

    expect(runtimeInfo).toEqual({
      hostArch: 'arm64',
      appArch: 'x64',
      runningUnderArm64Translation: true,
    })
    expect(isArm64HostRunningIntelBuild(runtimeInfo)).toBe(true)
  })

  it('detects native Apple Silicon builds', () => {
    const runtimeInfo = resolveDesktopRuntimeInfo({
      platform: 'darwin',
      processArch: 'arm64',
      runningUnderArm64Translation: false,
    })

    expect(runtimeInfo).toEqual({
      hostArch: 'arm64',
      appArch: 'arm64',
      runningUnderArm64Translation: false,
    })
    expect(isArm64HostRunningIntelBuild(runtimeInfo)).toBe(false)
  })

  it('passes through non-mac builds without translation', () => {
    const runtimeInfo = resolveDesktopRuntimeInfo({
      platform: 'linux',
      processArch: 'x64',
      runningUnderArm64Translation: true,
    })

    expect(runtimeInfo).toEqual({
      hostArch: 'x64',
      appArch: 'x64',
      runningUnderArm64Translation: false,
    })
  })

  it('normalizes unknown architectures to "other"', () => {
    const runtimeInfo = resolveDesktopRuntimeInfo({
      platform: 'darwin',
      processArch: 'riscv64',
      runningUnderArm64Translation: false,
    })

    expect(runtimeInfo.appArch).toBe('other')
    expect(runtimeInfo.hostArch).toBe('other')
  })
})
