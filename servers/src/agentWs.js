// /agent WebSocket 处理：真实 Agent 的注册、心跳、状态/曲库/任务上报，
// 并把手机提交的加密指令原样转发（中继不解密，端到端加密口径）
import { agents, pushToPhones, rememberProfile, flushProfiles } from './relayRegistry.js'

/** 由 wsGateway 在 pathname==='/agent' 时调用 */
export function handleAgentConnection(socket) {
  let deviceId = null

    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      switch (msg.t) {
        case 'register': {
          deviceId = msg.deviceId
          const prev = agents.get(deviceId)
          // 同 DeviceID 旧连接存在（Agent 重启）则踢掉，保证单设备单连接
          if (prev?.socket && prev.socket !== socket && prev.socket.readyState === 1) {
            prev.socket.close()
          }
          agents.set(deviceId, {
            ...(prev ?? {}),
            socket,
            deviceId,
            name: msg.name,
            publicKey: msg.publicKey,
            fingerprint: msg.fingerprint,
            protocolVersion: msg.protocolVersion || 1,
            lastSeen: Date.now(),
          })
          rememberProfile(deviceId) // 档案落盘：中继重启后该设备即使离线也不会从列表消失
          console.log(`[relay] 设备注册: ${msg.name} (${deviceId}) 指纹 ${msg.fingerprint}`)
          pushToPhones(deviceId, { t: 'online', online: true })
          break
        }

        // 以下消息均附带设备数据缓存，供手机 REST 拉取与 WS 推送
        // 任何来自设备的上报都算心跳：刷新 lastSeen 并同步到离线档案
        case 'pairing':
          if (!deviceId) return
          agents.get(deviceId).pairing = { code: msg.code, expiresAt: msg.expiresAt }
          break
        case 'status': {
          if (!deviceId) return
          agents.get(deviceId).status = msg.status
          pushToPhones(deviceId, { t: 'status', status: msg.status })
          break
        }
        case 'library':
          if (!deviceId) return
          Object.assign(agents.get(deviceId), {
            playlists: msg.playlists,
            library: msg.library,
            musicDirs: msg.musicDirs,
          })
          // 全量透传给手机：曲目明细 + 手动扫描结果（scan），否则手机端无法刷新候选与反馈
          pushToPhones(deviceId, { t: 'library', playlists: msg.playlists, musicDirs: msg.musicDirs, library: msg.library, scan: msg.scan })
          break
        case 'tasks':
          if (!deviceId) return
          agents.get(deviceId).tasks = msg.tasks
          pushToPhones(deviceId, { t: 'tasks', tasks: msg.tasks })
          break
        case 'history':
          if (!deviceId) return
          agents.get(deviceId).history = msg.history
          pushToPhones(deviceId, { t: 'history', history: msg.history })
          break
        case 'settings':
          if (!deviceId) return
          agents.get(deviceId).settings = msg.settings
          break
        case 'cmdResult':
          if (!deviceId) return
          // 指令执行结果透传给手机（含失败告警，如防重放拒绝）
          pushToPhones(deviceId, { t: 'cmdResult', ok: msg.ok, action: msg.action, nonce: msg.nonce, error: msg.error, status: msg.status })
          break
        case 'pong':
          break // 心跳时间戳由 switch 后的统一刷新处理
      }
      // 统一刷新心跳时间戳与离线档案（注册分支已自行处理首次建档）
      if (deviceId && msg.t !== 'register') {
        const rec = agents.get(deviceId)
        if (rec) {
          rec.lastSeen = Date.now()
          rememberProfile(deviceId)
        }
      }
    })

  socket.on('close', () => {
    if (deviceId && agents.get(deviceId)?.socket === socket) {
      agents.get(deviceId).socket = null
      rememberProfile(deviceId) // 把“最后一次已知状态”存盘，重启中继后仍能看到这台离线设备
      flushProfiles() // 断开是重同步点，立即落盘不等 5s 周期
      console.log(`[relay] 设备离线: ${deviceId}`)
      // 离线状态即时反映到手机
      pushToPhones(deviceId, { t: 'online', online: false })
      pushToPhones(deviceId, { t: 'status', status: null, offline: true })
    }
  })
  socket.on('error', error => console.warn(`[relay] 设备连接错误 ${deviceId || '未注册'}：${error.message}`))
}
