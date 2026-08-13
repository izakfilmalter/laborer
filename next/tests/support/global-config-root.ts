import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const xdgConfigHome = realpathSync(
  mkdtempSync(join(tmpdir(), 'laborer-vitest-config-'))
)
const xdgStateHome = realpathSync(
  mkdtempSync(join(tmpdir(), 'laborer-vitest-state-'))
)

process.env.XDG_CONFIG_HOME = xdgConfigHome
process.env.XDG_STATE_HOME = xdgStateHome

afterAll(() => {
  rmSync(xdgConfigHome, { force: true, recursive: true })
  rmSync(xdgStateHome, { force: true, recursive: true })
})
