import { createServer } from 'node:http'
import { readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
async function loadEnv() {
  try {
    const source = await readFile(path.join(root, '.env.local'), 'utf8')
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
    }
  } catch {}
}
await loadEnv()
const dataDir = path.resolve(root, process.env.DATA_DIR || '../backend/data')
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 4170)
const stages = ['research', 'emerging', 'growing', 'mature', 'maintenance', 'declining']
const stageLabels = { research: '研究階段', emerging: '新興階段', growing: '成長階段', mature: '成熟階段', maintenance: '維護階段', declining: '淘汰／停滯' }
const categoryPrefixes = { 1: 'LANG', 2: 'AI', 3: 'NET', 4: 'DB', 5: 'OS', 6: 'SEC', 7: 'TOOL', 8: 'HW' }

async function loadItems() {
  const files = (await readdir(dataDir)).filter(file => file.endsWith('.json')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return Promise.all(files.map(async file => JSON.parse(await readFile(path.join(dataDir, file), 'utf8'))))
}
function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data)
}
async function body(req) {
  let raw = ''
  for await (const part of req) { raw += part; if (raw.length > 1_000_000) throw new Error('Request body is too large') }
  return JSON.parse(raw || '{}')
}
function validate(item) {
  if (!item || !item.name?.zh || !item.name?.en || !item.domain_category?.id || !item.description || !item.purpose || !item.paradigm || !Array.isArray(item.key_points) || !item.function_categories?.primary || !Array.isArray(item.function_categories.secondary) || !Array.isArray(item.relations) || !stages.includes(item.stage)) return '欄位不完整或格式錯誤，請確認 JSON 內容。'
  return ''
}
async function generate(topic) {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('請在 admin-tool/.env.local 設定 GEMINI_API_KEY。')
  const items = await loadItems()
  const categories = [...new Map(items.map(item => item.domain_category ?? item.category).filter(Boolean).map(item => [String(item.id), item])).values()]
  const functions = [...new Map(items.flatMap(item => [item.function_categories?.primary, ...(item.function_categories?.secondary ?? [])]).filter(Boolean).map(item => [item.id, item])).values()]
  const prompt = `你是電腦科學百科的審慎編輯。請先用 Google Search 查證主題，再依查到的證據建立一筆繁體中文 JSON 草稿。主題：${topic}

編輯規則：
- 「harness」在 AI agent 領域可能是泛稱或工程慣例，不一定是標準化技術或單一產品。先辨明實際用法；若沒有一致定義，要在 description 明確寫出「用法尚未標準化」，不要把它包裝成已定義的整合產品。
- 只寫搜尋結果能支持的事實。不要臆造起源、年份、功能、產品、標準或業界共識；缺少證據時以空字串或空陣列表示。
- created_at 只在來源能確認技術起源年份時填 YYYY-01-01，否則填空字串。不要用模型猜年份。
- 只可使用下列既有領域分類與作用分類，欄位值必須完整照抄：
領域分類：${JSON.stringify(categories)}
作用分類：${JSON.stringify(functions)}
- 關聯項目只能使用下列既有項目的 ID 和名稱；沒有直接關係就回傳空陣列：${JSON.stringify(items.map(item => ({ id: item.id, name: item.name?.zh ?? item.name?.en ?? item.name })))}
- 概念型條目不要假稱為特定軟體框架。description 說明核心意義及邊界；purpose 說明用途；paradigm 只填來源支持的設計方式，否則留空。key_points 填 2 至 4 點，避免重複或宣傳式語句。
- stage 只可為 research、emerging、growing、mature、maintenance、declining。若主題是泛稱概念，選 emerging 並在 description 說明這是編輯分類，不代表正式標準。
- 回覆只能是 JSON 物件，不要 Markdown 或前言。結構：{"name":{"zh":"","en":""},"domain_category":{"id":1,"name":"","description":""},"stage":"emerging","development_stage":{"value":"emerging","label":"新興階段"},"description":"","purpose":"","paradigm":"","key_points":[],"function_categories":{"primary":{"id":"","name":"","label":"","description":""},"secondary":[]},"created_at":"","relations":[]}`
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.GEMINI_MODEL || 'gemini-2.5-flash')}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 } }),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || `Gemini API 回應 ${response.status}`)
  const generatedText = payload.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('').trim()
  if (!generatedText) throw new Error('Gemini 沒有回傳可用的草稿。')
  const text = generatedText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let draft
  try { draft = JSON.parse(text) } catch { throw new Error('Gemini 回覆格式不完整，請再產生一次。') }
  const sources = (payload.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []).flatMap(chunk => chunk.web?.uri ? [{ title: chunk.web.title || chunk.web.uri, url: chunk.web.uri }] : [])
  draft.sources = [...new Map(sources.map(source => [source.url, source])).values()]
  if (!draft.sources.length) throw new Error('Gemini 沒有提供可檢查的搜尋來源，這次草稿未提供。請再試一次。')
  const category = categories.find(item => String(item.id) === String(draft.domain_category?.id))
  if (!category) throw new Error('Gemini 草稿使用了不存在的領域分類，請重新產生。')
  draft.domain_category = category
  const canonical = entry => functions.find(item => item.id === entry?.id)
  const primary = canonical(draft.function_categories?.primary)
  if (!primary) throw new Error('Gemini 草稿使用了不存在的作用分類，請重新產生。')
  draft.function_categories = { primary, secondary: (draft.function_categories.secondary ?? []).map(canonical).filter(item => item && item.id !== primary.id) }
  if (!stages.includes(draft.stage)) throw new Error('Gemini 回傳了無效的發展階段，請再產生一次。')
  if (!Array.isArray(draft.key_points) || !Array.isArray(draft.relations)) throw new Error('Gemini 草稿欄位不完整，請再產生一次。')
  const byId = new Map(items.map(item => [String(item.id), item]))
  draft.relations = (draft.relations ?? []).flatMap(relation => {
    const target = byId.get(String(relation.target_id))
    return target ? [{ ...relation, target_id: target.id, target_name: target.name?.zh ?? target.name?.en ?? String(target.name) }] : []
  })
  draft.development_stage = { value: draft.stage, label: stageLabels[draft.stage] }
  return draft
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`)
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && (!process.env.ADMIN_TOKEN || req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN)) return send(res, 401, { error: process.env.ADMIN_TOKEN ? '管理 token 不正確' : '請先設定 ADMIN_TOKEN。' })
      if (req.method === 'GET' && url.pathname === '/api/technologies') return send(res, 200, await loadItems())
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        const input = await body(req)
        const topic = String(input.topic || '').trim().slice(0, 300)
        if (!topic) return send(res, 400, { error: '請輸入科技項目主題。' })
        return send(res, 200, await generate(topic))
      }
      if (req.method === 'POST' && url.pathname === '/api/technologies') {
        const item = await body(req)
        const issue = validate(item)
        if (issue) return send(res, 400, { error: issue })
        if (item.id) return send(res, 400, { error: '新增資料的 ID 由系統指派。' })
        const prefix = categoryPrefixes[item.domain_category.id] || 'TECH'
        const items = await loadItems()
        const seq = Math.max(0, ...items.map(entry => Number(String(entry.id).match(new RegExp(`^${prefix}-(\\d+)$`))?.[1] || 0))) + 1
        item.id = `${prefix}-${String(seq).padStart(3, '0')}`
        const filename = path.join(dataDir, `${item.id}.json`)
        await writeFile(filename, `${JSON.stringify(item, null, 2)}\n`, { flag: 'wx' })
        return send(res, 201, item)
      }
      const match = url.pathname.match(/^\/api\/technologies\/([A-Z]+-\d{3,})$/)
      if (match && ['PUT', 'DELETE'].includes(req.method)) {
        const id = match[1]
        const filename = path.join(dataDir, `${id}.json`)
        if (!(await readdir(dataDir)).includes(`${id}.json`)) return send(res, 404, { error: '找不到項目。' })
        if (req.method === 'DELETE') { await unlink(filename); return send(res, 200, { id, deleted: true }) }
        const item = await body(req)
        const issue = validate(item)
        if (issue) return send(res, 400, { error: issue })
        item.id = id
        const temp = `${filename}.tmp`
        await writeFile(temp, `${JSON.stringify(item, null, 2)}\n`)
        await rename(temp, filename)
        return send(res, 200, item)
      }
      return send(res, 404, { error: '找不到 API 路由。' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8')
    const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const filename = path.resolve(root, 'public', `.${requested}`)
    if (!filename.startsWith(path.resolve(root, 'public') + path.sep)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8')
    const content = await readFile(filename)
    const type = filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(req.method === 'HEAD' ? undefined : content)
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500
    send(res, status, { error: error.message || '伺服器發生錯誤。' })
  }
})

server.listen(port, host, () => console.log(`CS Encyclopedia Admin at http://${host}:${port}\nData directory: ${dataDir}`))
