// 云中继注册表：真实 Agent 的长连接、设备档案、配对状态与手机订阅枢纽
// 中继只见密文与元数据，不存播放明文内容
import { readJson, writeJson } from './store.js'

// deviceId -> { socket, deviceId, name, publicKey, fingerprint, online,
//               pairing:{code,expiresAt}, status, tasks, history, settings,
//               playlists, library, musicDirs, lastSeen }
export const agents = new Map()

// ---------- 设备档案持久化 ----------
// agents 是内存态：中继一重启（--watch 热重启、主机关机、崩溃恢复），
// 当前离线的设备就会从列表里凭空消失。所以把设备档案（含最后一次状态/曲库/任务快照）
// 落盘到 relay-data/devices.json，重启后离线设备仍以“离线”展示，而不是不见了。
const _savedProfiles = readJson('devices.json', [])
export const profiles = new Map(
  (Array.isArray(_savedProfiles) ? _savedProfiles : []).map((p) => [p.deviceId, p]),
)

let profilesDirty = false

export function flushProfiles() {
  if (!profilesDirty) return
  profilesDirty = false
  writeJson('devices.json', [...profiles.values()])
}

// 状态每秒上报，逐次写盘会拖慢中继；档案最终一致即可 → 每 5s 批量落盘
setInterval(flushProfiles, 5000).unref()

// 档案只存展示所需的元数据与最后一次上报快照，绝不含 socket
const PROFILE_FIELDS = [
  'name', 'publicKey', 'fingerprint', 'lastSeen',
  'status', 'tasks', 'history', 'settings', 'playlists', 'library', 'musicDirs',
]

/** 把内存中的 Agent 记录快照成离线档案（供中继重启后恢复展示） */
export function rememberProfile(id) {
  const a = agents.get(id)
  if (!a) return
  let p = profiles.get(id)
  if (!p) {
    p = { deviceId: id }
    profiles.set(id, p)
  }
  for (const f of PROFILE_FIELDS) {
    if (a[f] !== undefined) p[f] = a[f]
  }
  profilesDirty = true
}

/** 设备解绑且已离线：档案一并清除，列表不再显示 */
export function forgetProfile(id) {
  profiles.delete(id)
  flushProfiles()
}

// 绑定关系：配对码绑定成功后登记，落盘到 relay-data/bindings.json，
// 中继重启自动读回 → 手机无需每次重新输入配对码（对齐 UU"一次绑定长期有效"体验）
const _memBindings = readJson('bindings.json', [])
export const bindings = new Set(Array.isArray(_memBindings) ? _memBindings : [])
const persistBindings = () => writeJson('bindings.json', [...bindings])
// 包装 Set 的 add/delete，任何变更即时同步落盘；has 只读走原生即可
const _rawAdd = bindings.add.bind(bindings)
const _rawDelete = bindings.delete.bind(bindings)
bindings.add = (id) => { const r = _rawAdd(id); persistBindings(); return r }
bindings.delete = (id) => { const r = _rawDelete(id); persistBindings(); return r }

// 手机 WS 订阅集合：deviceId -> Set<ws>
export const phoneSubs = new Map()

// ---------- 设备别名/备注 ----------
// 学校多台电脑的自动名称（主机名-电脑）几乎长一样，极易认不清。
// 别名是“管理标注”而非设备属性，所以存在中继侧（与 bindings 同机制），
// 不依赖被控电脑、不要求 Agent 在线或改代码，且多台手机共享同一份标注。
const _memAliases = readJson('aliases.json', [])
export const aliases = new Map(
  (Array.isArray(_memAliases) ? _memAliases : []).map((a) => [a.deviceId, a]),
)

function persistAliases() {
  writeJson('aliases.json', [...aliases.values()])
}

/** 设置（alias/note 均为空串时等于清除标注） */
export function setAlias(deviceId, { alias, note }) {
  const rec = { deviceId, alias: alias ?? '', note: note ?? '', updatedAt: Date.now() }
  if (!rec.alias && !rec.note) {
    aliases.delete(deviceId)
  } else {
    aliases.set(deviceId, rec)
  }
  persistAliases()
  return aliases.get(deviceId) ?? { deviceId, alias: '', note: '' }
}

export function forgetAlias(deviceId) {
  if (!aliases.delete(deviceId)) return
  persistAliases()
}

// 固定配对码不设过期时间（Agent 上报 expiresAt 为 null/Infinity）：视为永不过期
const isPairingFresh = (pairing) => !pairing?.code ? false : pairing.expiresAt == null || pairing.expiresAt > Date.now()

export function agentView(id, bound = false) {
  const a = agentRecord(id)
  if (!a) return null
  const al = aliases.get(id)
  return {
    id: a.deviceId,
    name: a.name,
    alias: al?.alias ?? '', // 用户自定义备注名，前端优先展示；未标注时回退到设备名
    note: al?.note ?? '', // 自由备注（位置/用途等），仅展示不参与逻辑
    online: a.socket?.readyState === 1,
    fingerprint: a.fingerprint,
    bound,
    pairingActive: isPairingFresh(a.pairing),
    status: a.status ?? null,
    currentTrack: a.status?.currentTrack ?? '',
    playing: a.status?.playing ?? false,
    volume: a.status?.volume ?? 0,
    lastSeen: a.lastSeen ?? null, // 只读心跳时间戳（毫秒），供总监控面板显示“x 秒前更新”
  }
}

/** 读设备记录：优先内存在线记录，回退到离线档案（中继重启后仍能列出设备与上次快照） */
export function agentRecord(id) {
  return agents.get(id) ?? profiles.get(id) ?? null
}

export function listViews(boundFilter = null) {
  const out = []
  // 在线设备 + 仅有离线档案的设备，两者并集，避免离线即“消失”
  for (const id of new Set([...agents.keys(), ...profiles.keys()])) {
    const v = agentView(id, bindings.has(id))
    if (!v) continue
    if (boundFilter === true && !v.bound) continue
    if (boundFilter === false && v.bound) continue
    out.push(v)
  }
  return out
}

/** 向订阅了该设备的手机推送事件 */
export function pushToPhones(deviceId, msg) {
  const subs = phoneSubs.get(deviceId)
  if (!subs) return
  const raw = JSON.stringify(msg)
  for (const ws of subs) {
    if (ws.readyState === 1) ws.send(raw)
  }
}

/** 向 Agent 发送消息（离线返回 false） */
export function sendToAgent(deviceId, msg) {
  const a = agents.get(deviceId)
  if (!a?.socket || a.socket.readyState !== 1) return false
  a.socket.send(JSON.stringify(msg))
  return true
}

export function findAgentByPairingCode(code) {
  for (const a of agents.values()) {
    if (a.pairing?.code === code && isPairingFresh(a.pairing)) return a
  }
  return null
}
