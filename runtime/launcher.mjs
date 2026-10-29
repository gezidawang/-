// Both launchers use only Node built-ins. The panel is available on loopback only.
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { relayUrl } from './relay-url.mjs'

const role = process.argv[2]
if (!['relay', 'agent'].includes(role)) throw new Error('Usage: launcher.mjs relay|agent [root]')
const root = path.resolve(process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const port = Number(process.env.BELL_LAUNCHER_PORT || (role === 'relay' ? 3002 : 3210))
const relayPort = Number(process.env.PORT || 3001)
const panelUrl = `http://127.0.0.1:${port}`
const token = crypto.randomBytes(24).toString('hex')
const dataDir = path.join(root, role === 'relay' ? 'launcher-data' : 'agent-data')
fs.mkdirSync(dataDir, { recursive: true })
const configFile = path.join(dataDir, role === 'relay' ? 'launcher.json' : 'settings.json')
const read = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
function save(value) {
  fs.writeFileSync(`${configFile}.tmp`, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(`${configFile}.tmp`, configFile)
}
const state = { role, running: false, connected: false, publicUrl: '', tunnel: '未启动', logs: [], error: '',
  localUrl: `http://127.0.0.1:${relayPort}`, localUrls: [], pairingCode: '', deviceName: '', fingerprint: '', cloudUrl: read(configFile).cloudUrl || '' }
function log(message) {
  for (const line of String(message).split(/\r?\n/).filter(Boolean)) {
    state.logs.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}`)
    if (state.logs.length > 100) state.logs.shift()
    console.log(line)
  }
}
function openPanel() {
  if (process.env.BELL_NO_OPEN === '1' || process.platform !== 'win32') return
  // Use a fixed loopback URL, with no shell interpolation of user-provided text.
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', panelUrl], { windowsHide: true, stdio: 'ignore' })
  child.on('error', err => log(`请手动打开 ${panelUrl}：${err.message}`))
  child.unref()
}
function requestJson(url) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: 1200 }, res => {
      let body = ''
      res.on('data', c => { body += c; if (body.length > 16384) req.destroy() })
      res.on('error', () => resolve(null))
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let quitting = false
const managed = new Set()
class Service {
  constructor(name, executable, args, onData = () => {}) {
    Object.assign(this, { name, executable, args, onData, child: null, enabled: false, retries: 0, timer: null })
    managed.add(this)
  }
  start() {
    if (quitting || this.child) return
    this.enabled = true
    log(`[${this.name}] 正在启动`)
    const child = spawn(this.executable, this.args, { cwd: root, windowsHide: true,
      env: { ...process.env, PORT: String(relayPort) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    this.child = child
    this.startedAt = Date.now()
    let pending = ''
    const data = chunk => {
      pending = (pending + chunk.toString()).slice(-32768)
      this.onData(pending)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop()
      for (const line of lines) log(`[${this.name}] ${line}`)
    }
    child.stdout.on('data', data)
    child.stderr.on('data', data)
    child.on('message', msg => {
      if (this.name === '打铃程序' && msg?.type === 'agent-status') {
        state.connected = !!msg.connected
        state.pairingCode = msg.pairingCode || ''
        state.deviceName = msg.name || ''
        state.fingerprint = msg.fingerprint || ''
        state.localTaskCount = msg.localTaskCount || 0
        state.nextBellAt = msg.nextBellAt || null
      }
    })
    child.on('error', err => { state.error = `${this.name}无法启动：${err.message}`; log(state.error) })
    child.on('close', code => {
      if (this.child === child) this.child = null
      if (this.name === '打铃程序') { state.running = false; state.connected = false }
      if (this.name === '公网隧道') { state.publicUrl = ''; state.tunnel = '已断开' }
      if (this.name === '中继后端') state.running = false
      if (this.enabled && !quitting) {
        if (Date.now() - this.startedAt > 60000) this.retries = 0
        const wait = Math.min(30000, 2000 * 2 ** Math.min(this.retries++, 4))
        log(`[${this.name}] 已退出 (${code})，${wait / 1000} 秒后重试`)
        this.timer = setTimeout(() => this.start(), wait)
      }
    })
    if (this.name === '打铃程序') state.running = true
  }
  async stop() {
    this.enabled = false
    clearTimeout(this.timer)
    const child = this.child
    if (!child) return
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 3000)
      child.once('close', () => { clearTimeout(timer); resolve() })
      if (child.connected && this.name !== '公网隧道') {
        child.send({ type: 'shutdown' }, err => { if (err) child.kill() })
      } else child.kill()
    })
  }
}
const agent = role === 'agent' ? new Service('打铃程序', process.execPath, [path.join(root, 'src', 'index.js')]) : null
const backend = role === 'relay' ? new Service('中继后端', process.execPath, [path.join(root, 'servers', 'src', 'app.js')]) : null
const cf = process.env.BELL_CLOUDFLARED || path.join(root, 'bin', 'cloudflared.exe')
const tunnel = role === 'relay' ? new Service('公网隧道', cf,
  ['tunnel', '--url', `http://127.0.0.1:${relayPort}`, '--protocol', 'http2', '--edge-ip-version', '4', '--retries', '5'], text => {
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)
    if (match) { state.publicUrl = match[0]; state.tunnel = '已生成网址' }
  }) : null

function networkUrls() {
  return [...new Set(Object.values(os.networkInterfaces()).flat().filter(n => n && !n.internal && n.family === 'IPv4')
    .map(n => `http://${n.address}:${relayPort}`))]
}
async function portBusy(number) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: number })
    socket.setTimeout(800)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}
async function startTunnel() {
  if (!state.running) throw new Error('后端尚未就绪，请稍候再试')
  if (!fs.existsSync(cf)) throw new Error('未找到 cloudflared.exe，局域网仍可使用。请将隧道程序放入 bin 文件夹')
  if (tunnel.child || tunnel.enabled) return
  state.tunnel = '正在生成网址'
  tunnel.start()
}
async function startRelay() {
  state.localUrls = networkUrls()
  const health = await requestJson(`http://127.0.0.1:${relayPort}/api/health`)
  if (health?.data?.service === 'campus-bell-relay') {
    state.running = true
    log('检测到本机中继已运行，复用现有后端；退出此面板不会停止外部后端。')
  } else {
    if (await portBusy(relayPort)) throw new Error(`端口 ${relayPort} 已被其他程序或旧版中继占用，请先关闭该程序再重开启动器`)
    backend.start()
    for (let i = 0; i < 50 && !quitting; i++) {
      const result = await requestJson(`http://127.0.0.1:${relayPort}/api/health`)
      if (result?.data?.service === 'campus-bell-relay') { state.running = true; break }
      await delay(200)
    }
    if (!state.running) throw new Error('中继尚未就绪，请查看日志；启动器会继续尝试恢复后端')
  }
  if (read(configFile).publicEnabled !== false) await startTunnel()
}
let busy = false
async function action(name, body) {
  if (busy) throw new Error('正在处理，请稍候')
  busy = true
  try {
    state.error = ''
    if (name === 'configure' && role === 'agent') {
      const url = relayUrl(body.cloudUrl)
      if (agent.child?.connected) {
        const child = agent.child
        const reqId = crypto.randomUUID()
        await new Promise((resolve, reject) => {
          const finish = error => {
            clearTimeout(timer)
            child.off('message', onMessage)
            child.off('close', onClose)
            if (error) reject(error)
            else resolve()
          }
          const onMessage = message => {
            if (message?.type === 'relay-configured' && message.reqId === reqId) finish(message.ok ? null : new Error(message.error))
          }
          const onClose = () => finish(new Error('打铃程序在保存地址时退出，请重新打开面板核查配置'))
          const timer = setTimeout(() => finish(new Error('地址配置尚未确认，请查看日志；本地定时任务仍由运行中的程序执行')), 20000)
          child.on('message', onMessage)
          child.once('close', onClose)
          child.send({ type: 'configure-relay', reqId, cloudUrl: url }, error => { if (error) finish(error) })
        })
      } else {
        const settings = read(configFile, { musicDirs: [], autoStart: false })
        save({ ...settings, cloudUrl: url, launcherConfigured: true })
        agent.retries = 0
        agent.start()
      }
      state.cloudUrl = url
    } else if (name === 'restart' && role === 'agent') {
      await agent.stop()
      agent.retries = 0
      agent.start()
    } else if (name === 'tunnel' && role === 'relay') {
      const enabled = !!body.enabled
      save({ ...read(configFile), publicEnabled: enabled })
      if (enabled) await startTunnel()
      else { await tunnel.stop(); state.tunnel = '已关闭'; state.publicUrl = '' }
    } else if (name === 'quit') {
      setTimeout(() => shutdown(), 100)
    } else throw new Error('不支持的操作')
  } finally { busy = false }
}
const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel.html'), 'utf8')
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return }
  if (req.method === 'GET' && req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(html.replaceAll('__TOKEN__', token)); return
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (req.method === 'GET' && req.url === '/status') {
    res.end(JSON.stringify({ ...state, service: `campus-bell-launcher-${role}`, publicEnabled: read(configFile).publicEnabled !== false })); return
  }
  if (req.method !== 'POST' || req.headers['x-launcher-token'] !== token || req.headers.origin !== panelUrl) {
    res.writeHead(403).end(JSON.stringify({ error: '请求未授权，请从启动面板操作' })); return
  }
  try {
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 8192) throw new Error('请求过大') }
    await action(req.url.slice(1), JSON.parse(body || '{}'))
    res.end(JSON.stringify({ ok: true }))
  } catch (err) { state.error = err.message; res.writeHead(400).end(JSON.stringify({ error: err.message })) }
})
async function shutdown() {
  if (quitting) return
  quitting = true
  log('正在停止本启动器管理的程序；已保存的课表和配对信息会保留。')
  clearInterval(monitor)
  await Promise.all([...managed].map(service => service.stop()))
  server.close(() => process.exit(0))
  server.closeIdleConnections()
}
let monitor
server.on('error', async err => {
  if (err.code === 'EADDRINUSE') {
    const other = await requestJson(`${panelUrl}/status`)
    if (other?.service === `campus-bell-launcher-${role}`) { openPanel(); process.exit(0) }
  }
  console.error(`启动面板无法打开：${err.message}`)
  process.exit(1)
})
server.listen(port, '127.0.0.1', async () => {
  log(`启动面板：${panelUrl}。关闭网页不会停止程序；退出请点击面板内的“退出程序”。`)
  openPanel()
  try {
    if (role === 'relay') await startRelay()
    else {
      const settings = read(configFile)
      if (settings.cloudUrl || settings.launcherConfigured || process.env.RELAY_URL) agent.start()
      else log('首次使用：请在面板填写中继地址，或选择局域网自动发现。')
    }
  } catch (err) { state.error = err.message; log(err.message) }
  monitor = setInterval(async () => {
    if (role !== 'relay' || quitting) return
    const health = await requestJson(`http://127.0.0.1:${relayPort}/api/health`)
    state.running = health?.data?.service === 'campus-bell-relay'
    state.localUrls = networkUrls()
    if (state.running && read(configFile).publicEnabled !== false && !tunnel.enabled) {
      try { await startTunnel() } catch { /* initial startup already reports missing binary */ }
    }
  }, 4000)
})
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown)
