// Tasks become effective only after the target PC has saved and acknowledged them.
import { Router } from 'express'
import { agents, bindings, agentRecord } from '../relayRegistry.js'
import { ok, fail } from '../utils/respond.js'
import { requestAgent } from '../agentRequest.js'

const router = Router({ mergeParams: true })
const TASK_ID_RE = /^task-[0-9a-f]{8}$/i
function validateTask(data) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time || '')) return 'time 必须为 HH:mm 格式'
  if (!['once', 'daily', 'weekly'].includes(data.repeat)) return 'repeat 必须是 once/daily/weekly'
  if (!['play', 'playTrack', 'playFile', 'playByName', 'pause', 'stop', 'setVolume'].includes(data.actionType)) return '无效任务动作'
  const days = data.repeatDays || []
  if (!Array.isArray(days) || days.some(d => !Number.isInteger(d) || d < 1 || d > 7) || (data.repeat === 'weekly' && !days.length)) return '每周任务需选择有效星期（1 到 7）'
  if (data.actionType === 'playByName' && !String(data.actionPayload?.name || '').trim()) return '请提供曲目名'
  if (data.runAt && (!Number.isFinite(Date.parse(data.runAt)) || !/(Z|[+-]\d{2}:\d{2})$/i.test(data.runAt))) return 'runAt 必须为带时区的有效日期'
  return null
}
function proxy(deviceId, type, data) {
  const record = agents.get(deviceId)
  if (record?.socket?.readyState === 1 && record.protocolVersion < 2) {
    return Promise.reject(fail(409, '电脑端版本过旧，无法确认本次任务落盘；请先更新电脑端'))
  }
  return requestAgent(deviceId, type, data)
}
router.get('/', (req, res, next) => {
  const record = agentRecord(req.params.deviceId)
  if (!record) return next(fail(404, '设备不存在'))
  ok(res, record.tasks ?? [], record.socket?.readyState === 1 ? '电脑端最近上报的课表' : '设备离线，显示最后上报的课表快照；本次尚未与电脑核对')
})
router.post('/', async (req, res, next) => {
  if (!bindings.has(req.params.deviceId)) return next(fail(403, '设备未绑定'))
  const error = validateTask(req.body || {})
  if (error) return next(fail(400, error))
  try {
    const response = await proxy(req.params.deviceId, 'taskCreate', req.body)
    ok(res, response.result, '电脑端已确认本次任务保存；断网后仍按本地课表执行')
  } catch (error) { next(error) }
})
router.put('/:taskId', async (req, res, next) => {
  if (!bindings.has(req.params.deviceId)) return next(fail(403, '设备未绑定'))
  if (!TASK_ID_RE.test(req.params.taskId)) return next(fail(400, '非法任务 id'))
  const data = req.body || {}
  if (data.time !== undefined || data.repeat !== undefined || data.actionType !== undefined) {
    const error = validateTask(data)
    if (error) return next(fail(400, error))
  }
  try {
    const response = await proxy(req.params.deviceId, 'taskUpdate', { ...data, id: req.params.taskId })
    ok(res, response.result, '电脑端已确认本次课表更新')
  } catch (error) { next(error) }
})
router.delete('/:taskId', async (req, res, next) => {
  if (!bindings.has(req.params.deviceId)) return next(fail(403, '设备未绑定'))
  if (!TASK_ID_RE.test(req.params.taskId)) return next(fail(400, '非法任务 id'))
  try {
    await proxy(req.params.deviceId, 'taskDelete', { id: req.params.taskId })
    ok(res, null, '电脑端已确认删除任务')
  } catch (error) { next(error) }
})
export default router
