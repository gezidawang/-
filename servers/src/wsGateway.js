// 统一 WebSocket 网关：单个 WebSocketServer 按升级请求的 pathname 分发，
// 避免同一 http.Server 上挂多个带 path 的 WSS 造成路由冲突。
import { WebSocketServer } from 'ws'
import { handleAgentConnection } from './agentWs.js'
import { handlePhoneConnection } from './phoneWs.js'
import { agents } from './relayRegistry.js'

export function attachWsGateway(server) {
  const wss = new WebSocketServer({ server })

  wss.on('connection', (socket, req) => {
    const pathname = new URL(req.url, 'http://x').pathname
    if (pathname === '/agent') handleAgentConnection(socket)
    else if (pathname === '/ws') handlePhoneConnection(socket, req)
    else socket.close(4004, '未知 WebSocket 路径')
  })

  // 每 20s 心跳探测：Agent 超过 45s 无上报视为掉线，主动断开触发其重连
  setInterval(() => {
    for (const a of agents.values()) {
      if (a.socket?.readyState === 1) {
        a.socket.send(JSON.stringify({ t: 'ping' }))
        if (Date.now() - (a.lastSeen ?? 0) > 45_000) a.socket.terminate()
      }
    }
  }, 20_000)
}
