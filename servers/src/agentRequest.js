import crypto from 'node:crypto'
import { agents } from './relayRegistry.js'
import { fail } from './utils/respond.js'

// Match an operation's acknowledgement, never an unrelated task/status broadcast.
export function requestAgent(deviceId, type, data, { envelope, timeout = 7000 } = {}) {
  const socket = agents.get(deviceId)?.socket
  if (!socket || socket.readyState !== 1) {
    return Promise.reject(fail(503, '设备当前离线，未下发本次操作；电脑已保存的定时任务仍按原课表执行'))
  }
  const reqId = crypto.randomUUID()
  const command = type === 'command'
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onClose)
      if (error) reject(error)
      else resolve(value)
    }
    const onMessage = raw => {
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (command ? message.t !== 'cmdResult' || message.nonce !== envelope.nonce : message.t !== 'taskAck' || message.reqId !== reqId) return
      if (message.ok) finish(null, message)
      else finish(fail(400, message.error || '电脑端执行失败'))
    }
    const onClose = () => finish(fail(504, '操作下发后连接中断，执行结果未知；请重连后核查，勿直接重复操作。原本已保存的课表仍可执行'))
    const timer = setTimeout(() => finish(fail(504, '未收到本次操作的电脑端确认，结果未知；请检查设备状态或任务列表后再决定是否重试')), timeout)
    socket.on('message', onMessage)
    socket.once('close', onClose)
    socket.once('error', onClose)
    try {
      socket.send(JSON.stringify(command ? { t: type, envelope } : { t: type, data, reqId }), error => {
        if (error) onClose()
      })
    } catch { onClose() }
  })
}
