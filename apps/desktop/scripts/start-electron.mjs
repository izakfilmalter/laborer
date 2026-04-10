import { spawn } from 'node:child_process'

import { desktopDir, resolveElectronPath } from './electron-launcher.mjs'

const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...childEnv } = process.env

const child = spawn(resolveElectronPath(), ['dist-electron/main.js'], {
  stdio: 'inherit',
  cwd: desktopDir,
  env: childEnv,
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 0)
})
