// /ws WebSocket 处理：手机控制页订阅某设备的实时状态/上下线/指令结果/曲库/任务推送
import { phoneSubs, agents } from './relayRegistry.js'

/** 由 wsGateway 在 pathname==='/ws' 时调用 */
export function handlePhoneConnection(socket, req) {
  const deviceId = new URL(req.url, 'http://x').searchParams.get('deviceId')
  if (!deviceId) {
    socket.close(4000, '缺少 deviceId')
    return
  }
  if (!phoneSubs.has(deviceId)) phoneSubs.set(deviceId, new Set())
  phoneSubs.get(deviceId).add(socket)

  // 连接即回放当前快照，避免手机白屏等下一次事件
  const a = agents.get(deviceId)
  if (a) {
    socket.send(
      JSON.stringify({
        t: 'snapshot',
        status: a.status ?? null,
        playlists: a.playlists ?? [],
        tasks: a.tasks ?? [],
        history: a.history ?? [],
        online: a.socket?.readyState === 1,
      }),
    )
  }

  socket.on('close', () => phoneSubs.get(deviceId)?.delete(socket))
  // 手机可请求电脑端轮换配对码（设置页"重新生成配对码"）
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.t === 'rotatePairing' && a?.socket?.readyState === 1) {
        a.socket.send(JSON.stringify({ t: 'rotatePairing' }))
      }
    } catch {
      /* 忽略非法帧 */
    }
  })
}
