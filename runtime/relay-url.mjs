export function relayUrl(raw, websocket = false) {
  const text = String(raw || '').trim()
  if (!text) return ''
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请输入 http:// 或 https:// 开头的中继地址，不支持账号密码形式的网址')
  }
  if (url.pathname !== '/' && url.pathname !== '/agent' && url.pathname !== '/agent/') {
    throw new Error('请填写中继首页地址，不要带控制页面路径')
  }
  url.search = ''
  url.hash = ''
  url.protocol = websocket
    ? (['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:')
    : (['https:', 'wss:'].includes(url.protocol) ? 'https:' : 'http:')
  url.pathname = websocket ? '/agent' : '/'
  return websocket ? url.href : url.href.replace(/\/$/, '')
}
