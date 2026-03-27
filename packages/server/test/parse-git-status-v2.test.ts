/**
 * Unit tests for the git status porcelain v2 parser.
 *
 * Tests cover all entry types from `git status -z --porcelain=v2`:
 * - Ordinary changed entries (type `1`)
 * - Renamed/copied entries (type `2`)
 * - Unmerged/conflict entries (type `u`)
 * - Untracked entries (type `?`)
 * - Ignored entries (type `!`)
 * - Edge cases: empty output, files with spaces/unicode, severity merging
 *
 * All test data uses NUL-delimited format (as produced by `-z` flag).
 * The porcelain v2 format is documented at:
 * https://git-scm.com/docs/git-status#_porcelain_format_version_2
 *
 * @see Issue #3: Git status porcelain v2 parser + unit tests
 */

import { describe, expect, it } from 'vitest'
import { parseGitStatusV2 } from '../src/lib/parse-git-status-v2.js'

// ---------------------------------------------------------------------------
// Helpers to build porcelain v2 output lines
// ---------------------------------------------------------------------------

/**
 * Build an ordinary changed entry (type `1`).
 * Format: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 *
 * For simplicity, we use placeholder values for sub/mH/mI/mW/hH/hI fields
 * since the parser only cares about XY and path.
 */
const ordinary = (xy: string, path: string): string =>
  `1 ${xy} N... 100644 100644 100644 abc1234 def5678 ${path}`

/**
 * Build a rename/copy entry (type `2`).
 * Format: `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>`
 *
 * Note: the origPath is a separate NUL-delimited field, so we return
 * them as two separate parts to be joined with \0.
 */
const rename = (
  xy: string,
  score: string,
  newPath: string,
  origPath: string
): string =>
  `2 ${xy} N... 100644 100644 100644 abc1234 def5678 ${score} ${newPath}\0${origPath}`

/**
 * Build an unmerged entry (type `u`).
 * Format: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
 */
const unmerged = (xy: string, path: string): string =>
  `u ${xy} N... 100644 100644 100644 100644 abc1234 def5678 ghi9012 ${path}`

/** Build an untracked entry. */
const untracked = (path: string): string => `? ${path}`

/** Build an ignored entry. */
const ignored = (path: string): string => `! ${path}`

/** Join entries with NUL bytes (matching `-z` output). */
const join = (...entries: string[]): string => entries.join('\0')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseGitStatusV2', () => {
  describe('empty and trivial inputs', () => {
    it('returns empty array for empty string', () => {
      expect(parseGitStatusV2('')).toEqual([])
    })

    it('returns empty array for a single NUL byte', () => {
      expect(parseGitStatusV2('\0')).toEqual([])
    })

    it('returns empty array for multiple NUL bytes', () => {
      expect(parseGitStatusV2('\0\0\0')).toEqual([])
    })
  })

  describe('ordinary changed entries (type 1)', () => {
    it('parses a simple modified file (working tree)', () => {
      const output = join(ordinary('.M', 'src/index.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/index.ts', status: 'modified' },
      ])
    })

    it('parses a staged modified file (index)', () => {
      const output = join(ordinary('M.', 'src/index.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/index.ts', status: 'modified' },
      ])
    })

    it('parses a file modified in both index and working tree', () => {
      const output = join(ordinary('MM', 'src/index.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/index.ts', status: 'modified' },
      ])
    })

    it('parses a staged added file', () => {
      const output = join(ordinary('A.', 'src/new-file.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/new-file.ts', status: 'added' },
      ])
    })

    it('parses a staged deleted file', () => {
      const output = join(ordinary('D.', 'src/old-file.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/old-file.ts', status: 'deleted' },
      ])
    })

    it('parses a working tree deleted file', () => {
      const output = join(ordinary('.D', 'src/removed.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/removed.ts', status: 'deleted' },
      ])
    })

    it('parses type-changed file (T status)', () => {
      // T means the type of file changed (e.g., regular -> symlink)
      const output = join(ordinary('.T', 'src/link.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/link.ts', status: 'modified' },
      ])
    })

    it('parses multiple ordinary entries', () => {
      const output = join(
        ordinary('.M', 'src/a.ts'),
        ordinary('A.', 'src/b.ts'),
        ordinary('D.', 'src/c.ts'),
        ''
      )
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/b.ts', status: 'added' },
        { path: 'src/c.ts', status: 'deleted' },
      ])
    })
  })

  describe('untracked entries (type ?)', () => {
    it('parses a single untracked file', () => {
      const output = join(untracked('new-file.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'new-file.ts', status: 'added' },
      ])
    })

    it('parses multiple untracked files', () => {
      const output = join(
        untracked('docs/readme.md'),
        untracked('src/new.ts'),
        ''
      )
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'docs/readme.md', status: 'added' },
        { path: 'src/new.ts', status: 'added' },
      ])
    })
  })

  describe('renamed/copied entries (type 2)', () => {
    it('parses a staged rename', () => {
      const output = join(
        rename('R.', 'R100', 'src/new-name.ts', 'src/old-name.ts'),
        ''
      )
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/new-name.ts', status: 'modified' },
        { path: 'src/old-name.ts', status: 'deleted' },
      ])
    })

    it('parses a staged copy', () => {
      const output = join(
        rename('C.', 'C085', 'src/copy.ts', 'src/original.ts'),
        ''
      )
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/copy.ts', status: 'modified' },
        { path: 'src/original.ts', status: 'deleted' },
      ])
    })

    it('parses a rename with working tree modification', () => {
      // Renamed in index, then also modified in working tree
      const output = join(rename('RM', 'R090', 'src/new.ts', 'src/old.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        // Both R (index) and M (wt) map to modified, so result is modified
        { path: 'src/new.ts', status: 'modified' },
        { path: 'src/old.ts', status: 'deleted' },
      ])
    })

    it('handles rename followed by another entry', () => {
      const output = join(
        rename('R.', 'R100', 'src/b.ts', 'src/a.ts'),
        ordinary('.M', 'src/c.ts'),
        ''
      )
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/a.ts', status: 'deleted' },
        { path: 'src/b.ts', status: 'modified' },
        { path: 'src/c.ts', status: 'modified' },
      ])
    })
  })

  describe('unmerged/conflict entries (type u)', () => {
    it('parses both-modified conflict (UU)', () => {
      const output = join(unmerged('UU', 'src/conflict.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/conflict.ts', status: 'modified' },
      ])
    })

    it('parses added-by-both conflict (AA)', () => {
      const output = join(unmerged('AA', 'src/both-added.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/both-added.ts', status: 'modified' },
      ])
    })

    it('parses deleted-by-both conflict (DD)', () => {
      const output = join(unmerged('DD', 'src/both-deleted.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/both-deleted.ts', status: 'modified' },
      ])
    })

    it('parses added-by-us conflict (AU)', () => {
      const output = join(unmerged('AU', 'src/au.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/au.ts', status: 'modified' },
      ])
    })

    it('parses deleted-by-them conflict (UD)', () => {
      const output = join(unmerged('UD', 'src/ud.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/ud.ts', status: 'modified' },
      ])
    })

    it('parses added-by-them conflict (UA)', () => {
      const output = join(unmerged('UA', 'src/ua.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/ua.ts', status: 'modified' },
      ])
    })

    it('parses deleted-by-us conflict (DU)', () => {
      const output = join(unmerged('DU', 'src/du.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/du.ts', status: 'modified' },
      ])
    })
  })

  describe('ignored entries (type !)', () => {
    it('skips ignored files', () => {
      const output = join(
        ignored('node_modules/package/index.js'),
        ordinary('.M', 'src/real.ts'),
        ''
      )
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/real.ts', status: 'modified' },
      ])
    })
  })

  describe('severity precedence (partially staged files)', () => {
    it('deleted > modified: staged delete + wt modified resolves to deleted', () => {
      // This can happen if a file is staged for deletion but then recreated and modified
      const output = join(ordinary('DM', 'src/file.ts'), '')
      // D maps to deleted (severity 3), M maps to modified (severity 2)
      // deleted wins
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/file.ts', status: 'deleted' },
      ])
    })

    it('deleted > added: staged delete + wt added resolves to deleted', () => {
      const output = join(ordinary('DA', 'src/file.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/file.ts', status: 'deleted' },
      ])
    })

    it('modified > added: staged add + wt modified resolves to modified', () => {
      const output = join(ordinary('AM', 'src/file.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/file.ts', status: 'modified' },
      ])
    })

    it('same severity is idempotent', () => {
      const output = join(ordinary('MM', 'src/file.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/file.ts', status: 'modified' },
      ])
    })
  })

  describe('files with special characters in paths', () => {
    it('handles paths with spaces', () => {
      const output = join(ordinary('.M', 'src/my file.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/my file.ts', status: 'modified' },
      ])
    })

    it('handles paths with unicode characters', () => {
      const output = join(ordinary('.M', 'src/日本語.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/日本語.ts', status: 'modified' },
      ])
    })

    it('handles paths with emoji', () => {
      const output = join(untracked('docs/🚀.md'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'docs/🚀.md', status: 'added' },
      ])
    })

    it('handles deeply nested paths', () => {
      const output = join(ordinary('.M', 'a/b/c/d/e/f/g/h/file.ts'), '')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'a/b/c/d/e/f/g/h/file.ts', status: 'modified' },
      ])
    })

    it('handles renamed file with spaces in both paths', () => {
      const output = join(
        rename('R.', 'R100', 'src/new name.ts', 'src/old name.ts'),
        ''
      )
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/new name.ts', status: 'modified' },
        { path: 'src/old name.ts', status: 'deleted' },
      ])
    })
  })

  describe('mixed entry types', () => {
    it('parses a realistic mixed output', () => {
      const output = join(
        ordinary('.M', 'package.json'),
        ordinary('A.', 'src/new-feature.ts'),
        ordinary('D.', 'src/deprecated.ts'),
        rename('R.', 'R095', 'src/utils/helpers.ts', 'src/helpers.ts'),
        untracked('TODO.md'),
        unmerged('UU', 'src/conflict.ts'),
        ''
      )
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'TODO.md', status: 'added' },
        { path: 'package.json', status: 'modified' },
        { path: 'src/conflict.ts', status: 'modified' },
        { path: 'src/deprecated.ts', status: 'deleted' },
        { path: 'src/helpers.ts', status: 'deleted' },
        { path: 'src/new-feature.ts', status: 'added' },
        { path: 'src/utils/helpers.ts', status: 'modified' },
      ])
    })

    it('sorts output alphabetically by path', () => {
      const output = join(
        ordinary('.M', 'z.ts'),
        ordinary('.M', 'a.ts'),
        ordinary('.M', 'm.ts'),
        ''
      )
      const result = parseGitStatusV2(output)
      const paths = result.map((e) => e.path)
      expect(paths).toEqual(['a.ts', 'm.ts', 'z.ts'])
    })

    it('deduplicates when same file appears in multiple entries', () => {
      // A file could theoretically appear in both ordinary and untracked
      // (unlikely in practice, but the parser should handle it)
      const output = join(
        ordinary('.M', 'src/file.ts'),
        ordinary('D.', 'src/file.ts'),
        ''
      )
      // deleted (severity 3) > modified (severity 2)
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/file.ts', status: 'deleted' },
      ])
    })
  })

  describe('without trailing NUL', () => {
    it('handles output without trailing NUL byte', () => {
      // Some git versions might not include a trailing NUL
      const output = ordinary('.M', 'src/index.ts')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/index.ts', status: 'modified' },
      ])
    })

    it('handles untracked entry without trailing NUL', () => {
      const output = untracked('new.ts')
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'new.ts', status: 'added' },
      ])
    })
  })

  describe('rename entry edge cases', () => {
    it('handles multiple consecutive renames', () => {
      const output = join(
        rename('R.', 'R100', 'b.ts', 'a.ts'),
        rename('R.', 'R090', 'd.ts', 'c.ts'),
        ''
      )
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'a.ts', status: 'deleted' },
        { path: 'b.ts', status: 'modified' },
        { path: 'c.ts', status: 'deleted' },
        { path: 'd.ts', status: 'modified' },
      ])
    })

    it('handles rename where new path already has a status', () => {
      // Rename to a path that was also modified in working tree
      const output = join(
        rename('R.', 'R100', 'src/target.ts', 'src/source.ts'),
        ordinary('.M', 'src/target.ts'),
        ''
      )
      // Rename gives 'modified' to target, then ordinary gives another 'modified'
      // Both are 'modified', so result is 'modified'
      expect(parseGitStatusV2(output)).toEqual([
        { path: 'src/source.ts', status: 'deleted' },
        { path: 'src/target.ts', status: 'modified' },
      ])
    })
  })
})
