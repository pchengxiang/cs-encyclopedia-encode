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
  const technologyIndex = items.map(item => ({
    id: item.id,
    name_zh: item.name?.zh ?? item.name,
    name_en: item.name?.en ?? item.name?.zh ?? item.name,
    category: (item.domain_category ?? item.category)?.name ?? '',
    description: item.description ?? '',
    purpose: item.purpose ?? '',
    paradigm: item.paradigm ?? '',
  }))
  const prompt = `你是電腦科學百科的審慎編輯。請先使用 Google Search 查證主題，再建立一筆繁體中文 JSON 草稿。

主題：${topic}

## 查證原則

- 先確認主題在可信來源中的實際用法，再撰寫條目。優先採用官方文件、標準文件、原始研究或技術維護者的說明；必要時以其他可靠來源交叉核對。
- 搜尋結果必須直接支持你寫入的事實。不要只根據搜尋摘要推斷細節；若無法確認，使用空字串或空陣列。
- 不得臆造起源、年份、功能、產品、標準、分類共識或技術關係。
- 若不同來源對主題的定義或用法不一致，請在 description 簡要指出差異或範圍，不要將其中一種用法寫成唯一共識。
- 「harness」在 AI agent 領域可能是泛稱或工程慣例，不一定是標準化技術或單一產品。若查證後沒有一致定義，description 必須明確包含「用法尚未標準化」，並說明本條目整理的是概念或工程實踐，不得包裝成已定義的整合產品。
- created_at 僅在來源明確確認技術起源年份時填入 YYYY-01-01；否則填空字串。不要以首次提及、發布日期或模型推測代替起源年份。
- 若來源不足以支持建立條目，仍回傳指定 JSON 結構，將無法確認的欄位留空，並在 description 說明證據限制。

## 分類規則

只可使用下列既有領域分類與作用分類。選用時，欄位值必須完整照抄，不得自行改名、翻譯或新增分類：

領域分類：${JSON.stringify(categories)}
作用分類：${JSON.stringify(functions)}

- 選擇最能描述主題核心用途的領域分類與一個主要作用分類。
- 只有在來源支持且確實有不同功能時，才加入次要作用分類；不要為了填滿欄位而增加分類。
- 若提供的分類都不適用，使用清單中最接近的分類，不得建立新分類。
- 概念型條目的 stage 使用 emerging，並在 description 說明這是百科的編輯分類，不代表正式標準或業界共識。
- stage 只可為 research、emerging、growing、mature、maintenance、declining。若不是泛稱概念，依來源支持的證據選擇；無法判斷時選 emerging，並避免暗示這是客觀或正式認定。
- development_stage.value 必須與 stage 相同；label 必須使用對應中文：research「研究階段」、emerging「新興階段」、growing「成長階段」、mature「成熟階段」、maintenance「維護階段」、declining「衰退階段」。

## 條目撰寫規則

- name.zh 使用清楚、自然的繁體中文名稱；若沒有穩定中文譯名，可保留常用英文名稱。name.en 填入來源使用的英文名稱；來源未提供時留空。
- description 說明核心意義與適用邊界。避免宣傳語、絕對化承諾，以及將可能性描述成保證。
- purpose 說明此技術或概念解決什麼問題、用於什麼目的；來源不足時留空。
- paradigm 只填來源明確支持的設計方式或技術典範；沒有直接證據時留空。不要把常見實作範例寫成所有實作都遵循的規則。
- key_points 填 2 至 4 個簡短、彼此不重複且有來源支持的重點。若可確認的重點不足 2 個，依證據填寫，不要補湊。
- 不要把概念、工程模式或泛稱誤寫成特定軟體框架、產品或標準。
- relations 僅列百科目錄中與主題有直接技術關係的項目。同屬一個大分類、常一起出現或僅有一般性關聯，都不足以建立關係。
- 請逐項比較目錄內項目的 ID、名稱、分類、摘要、用途和典範，再判斷關聯；不可只依搜尋結果決定百科內部關聯。
- 最多列出 5 個關聯項目。若目錄中存在明確的直接關係，至少列出最強的一項；若無直接關係，回傳空陣列，不要勉強建立關聯。
- 每個 target_id 必須逐字取自目錄；target_name 必須使用該筆目錄項目的繁體中文名稱。
- relation_type 只可使用 related_technology、implementation、implementation_of、related_language。只有來源或條目內容能支持實作關係時，才使用 implementation 或 implementation_of；否則使用 related_technology。related_language 僅用於直接的程式語言關係。
- 每一筆關聯不得重複 target_id。

既有項目目錄：${JSON.stringify(technologyIndex)}

## 輸出要求

- 只回傳一個可直接解析的 JSON 物件，不要 Markdown、程式碼區塊、前言、註解或 JSON 外的文字。
- 使用標準 JSON：字串以雙引號包住，不得使用尾逗號、undefined、NaN 或註解。
- 所有文字內容使用繁體中文；技術名稱、專有名詞與必要的英文術語可保留英文。
- 欄位必須完整符合下列結構與順序；無法確認的字串填空字串，無項目填空陣列：

{
  "name": {
    "zh": "",
    "en": ""
  },
  "domain_category": {
    "id": 1,
    "name": "",
    "description": ""
  },
  "stage": "emerging",
  "development_stage": {
    "value": "emerging",
    "label": "新興階段"
  },
  "description": "",
  "purpose": "",
  "paradigm": "",
  "key_points": [],
  "function_categories": {
    "primary": {
      "id": "",
      "name": "",
      "label": "",
      "description": ""
    },
    "secondary": []
  },
  "created_at": "",
  "relations": [],
  "sources": []
}

## 來源欄位

- sources 是來源陣列。每筆來源使用 {"title":"","url":""}。
- 僅列出實際開啟並用於撰寫內容的來源；URL 必須是來源頁面網址，不得填搜尋結果頁。
- 優先列 2 至 5 個最相關來源；若只找到一個可靠來源，列一個；若沒有可用來源，回傳空陣列。
- 不要在來源欄位以外加入無法由 JSON 結構表示的引用格式。
- 輸出前自我檢查 JSON 語法、欄位完整性、分類值、階段對應、關聯 ID 與來源網址。`
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
  const relationTypes = new Set(['related_technology', 'implementation', 'implementation_of', 'related_language'])
  const checkedRelations = (draft.relations ?? []).flatMap(relation => {
    const target = byId.get(String(relation.target_id))
    return target && relationTypes.has(relation.relation_type)
      ? [{ ...relation, target_id: target.id, target_name: target.name?.zh ?? target.name?.en ?? String(target.name) }]
      : []
  })
  draft.relations = [...new Map(checkedRelations.map(relation => [`${relation.target_id}:${relation.relation_type}`, relation])).values()].slice(0, 5)
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
