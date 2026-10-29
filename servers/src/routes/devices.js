// 设备 REST 接口（真实中继版）：列表、配对绑定、公钥获取、加密指令转发、曲库与设置
import { Router } from 'express'
import crypto from 'node:crypto'
import { WebSocket } from 'ws'
import { agents, bindings, listViews, agentView, agentRecord, forgetProfile, forgetAlias, setAlias, pushToPhones, findAgentByPairingCode, sendToAgent } from '../relayRegistry.js'
import { ok, fail } from '../utils/respond.js'
import { requestAgent } from '../agentRequest.js'

const router = Router()

// GET /api/devices 已注册设备列表（含在线状态/指纹/绑定状态）
router.get('/', (req, res) => {
  ok(res, listViews())
})
// POST /api/devices/pair 配对码绑定：校验电脑屏幕显示的固定 6 位码（FR-01-04，固定码长期有效）
router.post('/pair', (req, res, next) => {
  const { code } = req.body || {}
  if (!/^\d{6}$/.test(code || '')) return next(fail(400, '配对码必须是 6 位数字'))
  const agent = findAgentByPairingCode(code)
  if (!agent) return next(fail(403, '配对码无效，请核对电脑屏幕上显示的固定配对码'))
  bindings.add(agent.deviceId)
  // 固定配对码不作废：可重复用于多台手机绑定；绑定信任最终由手机端指纹核对建立
  console.log(`[relay] 手机已绑定设备 ${agent.name} (${agent.deviceId})，指纹 ${agent.fingerprint}`)
  ok(res, agentView(agent.deviceId, true), '配对成功，请核对设备指纹与电脑屏幕显示一致')
})

// POST /api/devices/:id/unpair 解绑（FR-01-06）
router.post('/:id/unpair', (req, res, next) => {
  if (!agentRecord(req.params.id)) return next(fail(404, `设备不存在: ${req.params.id}`))
  bindings.delete(req.params.id)
  forgetAlias(req.params.id) // 解绑即清除该设备的别名/备注，不残留无关标注
  // 已离线（只剩档案）的设备解绑后连档案一起清除；在线设备保留记录，发未绑定状态
  if (!agents.has(req.params.id)) forgetProfile(req.params.id)
  ok(res, null, '已解绑，旧绑定关系立即失效')
})

// PUT /api/devices/:id/alias 设置设备别名与备注（解决“多台电脑认不清”）
// 存在中继侧：不需 Agent 在线、不改被控电脑，多台手机看到同一份标注
router.put('/:id/alias', (req, res, next) => {
  if (!agentRecord(req.params.id)) return next(fail(404, `设备不存在: ${req.params.id}`))
  if (!bindings.has(req.params.id)) return next(fail(403, '设备未绑定，无法标注'))
  // 去首尾空白后截断；全空白视为清除该项（两个都空则等效删标注）
  const alias = String(req.body?.alias ?? '').trim().slice(0, 20)
  const note = String(req.body?.note ?? '').trim().slice(0, 50)
  const saved = setAlias(req.params.id, { alias, note })
  // 即时推给已订阅该设备的手机，不等下一轮轮询
  pushToPhones(req.params.id, { t: 'alias', alias: saved.alias, note: saved.note })
  ok(res, { alias: saved.alias, note: saved.note }, alias ? `已命名为“${alias}”` : '标注已更新')
})

// GET /api/devices/:id 设备详情（含公钥，供手机端加密指令）
router.get('/:id', (req, res, next) => {
  const a = agentRecord(req.params.id)
  if (!a) return next(fail(404, `设备不存在: ${req.params.id}`))
  ok(res, { ...agentView(req.params.id, bindings.has(req.params.id)), publicKey: a.publicKey })
})

// POST /api/devices/:id/command 转发端到端加密指令（中继不见明文）
// body: { envelope: { encKey, iv, ct, tag, ts, nonce } }（均为 base64）
router.post('/:id/command', async (req, res, next) => {
  if (!bindings.has(req.params.id)) return next(fail(403, '设备未绑定，请先用配对码绑定'))
  const { encKey, iv, ct, tag, ts, nonce } = req.body?.envelope || {}
  if (!encKey || !iv || !ct || !tag || !nonce) return next(fail(400, '加密指令字段不完整'))
  try {
    const result = await requestAgent(req.params.id, 'command', null, { envelope: req.body.envelope })
    ok(res, { accepted: true, executed: true, ...result }, '电脑端已确认本次操作；实际出声仍取决于音频设备')
  } catch (error) { next(error) }
})

// GET /api/devices/:id/library 曲库与歌单（Agent 扫描上报的缓存；离线时回退到上次同步的档案快照）
router.get('/:id/library', (req, res, next) => {
  const a = agentRecord(req.params.id)
  if (!a) return next(fail(404, `设备不存在: ${req.params.id}`))
  ok(res, { playlists: a.playlists ?? [], library: a.library ?? [], musicDirs: a.musicDirs ?? [] })
})

// GET /api/devices/:id/browse?path=xxx 浏览电脑目录（只读元数据，转发给 Agent 应答）
router.get('/:id/browse', async (req, res, next) => {
  if (!bindings.has(req.params.id)) return next(fail(403, '设备未绑定'))
  const a = agents.get(req.params.id)
  if (!a?.socket || a.socket.readyState !== WebSocket.OPEN) return next(fail(503, '设备当前离线，无法浏览目录'))
  const reqId = crypto.randomUUID()
  const onMsg = (raw) => {
    try {
      const m = JSON.parse(raw.toString())
      if (m.t === 'browseResult' && m.reqId === reqId) {
        clearTimeout(timer)
        a.socket.off('message', onMsg)
        if (m.error) return next(fail(400, m.error))
        ok(res, m.data)
      }
    } catch {
      /* 非 JSON 帧忽略 */
    }
  }
  const timer = setTimeout(() => {
    a.socket.off('message', onMsg)
    next(fail(504, '电脑未在 5 秒内响应浏览请求'))
  }, 5000)
  a.socket.on('message', onMsg)
  sendToAgent(req.params.id, { t: 'browse', reqId, path: req.query.path || '' })
})

// GET /api/devices/:id/settings 设备设置缓存
router.get('/:id/settings', (req, res, next) => {
  const a = agentRecord(req.params.id)
  if (!a) return next(fail(404, `设备不存在: ${req.params.id}`))
  if (!bindings.has(req.params.id)) return next(fail(403, '设备未绑定'))
  ok(res, a.settings ?? { musicDirs: [], autoStart: false, cloudUrl: '' })
})

// PUT /api/devices/:id/settings 设置下发到 Agent 落盘
router.put('/:id/settings', (req, res, next) => {
  if (!bindings.has(req.params.id)) return next(fail(403, '设备未绑定'))
  const sent = sendToAgent(req.params.id, { t: 'settingsUpdate', data: req.body || {} })
  if (!sent) return next(fail(503, '设备当前离线，设置无法下发'))
  ok(res, req.body, '设置已下发到电脑')
})

// GET /api/devices/:id/history 任务执行历史缓存（FR-03-05）
router.get('/:id/history', (req, res, next) => {
  const a = agentRecord(req.params.id)
  if (!a) return next(fail(404, `设备不存在: ${req.params.id}`))
  ok(res, a.history ?? [])
})

export default router
