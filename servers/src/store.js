// 云中继本地数据持久化：relay-data/ 下 JSON 文件读写（当前仅 bindings）
// 与 pc-agent 侧同名模块保持同样的"先写 .tmp 再 rename"原子替换约定
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay-data')
fs.mkdirSync(DATA_DIR, { recursive: true })

export function readJson(name, fallback) {
  const file = path.join(DATA_DIR, name)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(name, data) {
  const file = path.join(DATA_DIR, name)
  // 先写临时文件再重命名，避免进程中途被杀导致 JSON 半截损坏
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts)
}
