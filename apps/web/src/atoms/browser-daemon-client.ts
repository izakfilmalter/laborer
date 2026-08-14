import { DaemonRpcs } from '@laborer/shared/rpc'
import { AtomRpc } from 'effect/unstable/reactivity'

import { rendererRpcProtocol } from './renderer-rpc-protocol'

const daemonProtocol = rendererRpcProtocol('server')

/** One typed client and one RPC runtime for the daemon's unified browser socket. */
export class BrowserDaemonClient extends AtomRpc.Service<BrowserDaemonClient>()(
  'BrowserDaemonClient',
  {
    group: DaemonRpcs,
    protocol: daemonProtocol,
  }
) {}
