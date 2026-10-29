// 云中继入口：REST（手机）+ /agent 长连接（电脑）+ /ws 状态推送（手机订阅）
// 只做身份注册、配对校验、密文转发与状态分发，不解密任何指令载荷
import express from 'express'
import cors from 'cors'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import devicesRouter from './routes/devices.js'
import tasksRouter from './routes/tasks.js'
import { attachWsGateway } from './wsGateway.js'
import { bindings, profiles, flushProfiles } from './relayRegistry.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// 简单请求日志
app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`)
  next()
})

// 注意挂载顺序：tasks 子路由必须先于 devices 挂载
app.use('/api/devices/:deviceId/tasks', tasksRouter)
app.use('/api/devices', devicesRouter)

// 生产部署：托管构建后的手机控制页（Control end/dist），与 REST/WS 同源，公网任意地点可访问
const STATIC_DIR =
  process.env.STATIC_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'Control end', 'dist')
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR))
  // SPA history 路由兑底：非 /api 请求一律回 index.html
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')))
  console.log(`[relay] 已托管控制页静态资源: ${STATIC_DIR}`)
}

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ code: 0, data: { service: 'campus-bell-relay', uptime: process.uptime() }, message: 'ok' })
})

// 404
app.use((req, res) => {
  res.status(404).json({ code: 404, data: null, message: `接口不存在: ${req.originalUrl}` })
})

// 全局错误中间件：统一输出 { code, data, message }
app.use((err, req, res, next) => {
  const status = err.status || 500
  const code = err.code ?? status
  if (status >= 500) console.error(err)
  res.status(status).json({ code, data: null, message: err.message || '服务器内部错误' })
})

// HTTP server + 统一 WebSocket 网关（/agent 电脑长连接 + /ws 手机状态订阅）
const server = http.createServer(app)
attachWsGateway(server)

server.listen(PORT, () => {
  console.log(`[relay] 云中继已启动: http://localhost:${PORT}（/agent /ws 长连接就绪）`)
  console.log(`[relay] 已绑定设备 ${bindings.size} 台；设备档案（含离线机）共 ${profiles.size} 台，离线设备仍会显示为“离线”`)
})

// 退出前把设备档案刷盘，避免最多丢 5s 内的档案变更（下次启动离线设备列表更准）
function shutdown() {
  flushProfiles()
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown)
process.on('message', msg => { if (msg?.type === 'shutdown') shutdown() })
