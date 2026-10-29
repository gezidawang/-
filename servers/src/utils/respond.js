// 统一响应格式工具：所有接口返回 { code, data, message }
// code = 0 表示成功，非 0 表示业务/系统错误

export function ok(res, data = null, message = 'ok') {
  res.json({ code: 0, data, message })
}

// 构造带业务码的错误对象，交由 app.js 的全局错误中间件输出
export function fail(status, message, code = status) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}
