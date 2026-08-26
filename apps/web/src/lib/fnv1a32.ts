// biome-ignore-all lint/suspicious/noBitwiseOperators: FNV-1a is defined over 32-bit XOR and unsigned wraparound arithmetic — the operators are the algorithm, not an optimization.

/**
 * 32-bit FNV-1a hash.
 *
 * Used for diff patch cache keys and viewer item versions, where the
 * only requirement is that identical input hashes alike and different
 * input almost never does. Not suitable for anything security-related.
 */

const FNV_OFFSET_BASIS_32 = 0x81_1c_9d_c5
const FNV_PRIME_32 = 0x01_00_01_93

export const fnv1a32 = (input: string): number => {
  let hash = FNV_OFFSET_BASIS_32 >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0
  }
  return hash >>> 0
}
