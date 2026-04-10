import { WsRpcGroup } from '@laborer/contracts/rpc'
import { Layer } from 'effect'
import { AtomRpc } from 'effect/unstable/reactivity'

import { createWsRpcProtocolLayer } from './protocol'

export class WsRpcAtomClient extends AtomRpc.Service<WsRpcAtomClient>()(
  'WsRpcAtomClient',
  {
    group: WsRpcGroup,
    protocol: Layer.suspend(() => createWsRpcProtocolLayer()),
  }
) {}
