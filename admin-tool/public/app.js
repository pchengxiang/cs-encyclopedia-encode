const $ = selector => document.querySelector(selector)
const tokenInput = $('#token')
const tokenKey = 'cs-encyclopedia-admin-token'
let items = []
let selected = null
let isNew = false
let toastTimer
tokenInput.value = sessionStorage.getItem(tokenKey) || ''

function showBusy(text) { $('#busy-text').textContent = text; $('#busy').classList.remove('hidden') }
function hideBusy() { $('#busy').classList.add('hidden') }
function notify(message, error = false) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.toggle('error', error); toast.classList.remove('hidden')
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add('hidden'), 4500)
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': tokenInput.value.trim(), ...options.headers } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `請求失敗 (${response.status})`)
  return data
}
function escaped(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]) }
function renderList() {
  const keyword = $('#search').value.trim().toLocaleLowerCase()
  const filtered = items.filter(item => `${item.id} ${item.name?.zh} ${item.name?.en} ${item.description}`.toLocaleLowerCase().includes(keyword))
  $('#items').innerHTML = filtered.length ? filtered.map(item => `<button class="item ${selected?.id === item.id ? 'active' : ''}" data-id="${escaped(item.id)}"><span class="item-id">${escaped(item.id)}</span><strong>${escaped(item.name?.zh || item.name)}</strong><small>${escaped((item.domain_category ?? item.category)?.name || '未分類')}</small></button>`).join('') : '<p class="empty">沒有符合的科技項目</p>'
  $('#total').textContent = items.length
}
function showEditor(item, draft = false) {
  selected = item; isNew = draft
  $('#editor-kicker').textContent = draft ? 'NEW DRAFT' : item?.id || 'EDITOR'
  $('#editor-title').textContent = draft ? '檢視生成草稿' : item?.name?.zh || '選取一筆資料'
  $('#placeholder').classList.toggle('hidden', Boolean(item))
  for (const selector of ['#json', '#hint', '#actions']) $(selector).classList.toggle('hidden', !item)
  $('#summary').classList.toggle('hidden', !item || draft)
  $('#sources').classList.toggle('hidden', !item?.sources?.length)
  $('#delete').classList.toggle('hidden', !item || draft)
  if (!item) { $('#json').value = ''; return }
  $('#json').value = JSON.stringify(item, null, 2)
  if (item.sources?.length) $('#sources').innerHTML = `<strong>Gemini 搜尋來源</strong>${item.sources.map(source => `<a href="${escaped(source.url)}" target="_blank" rel="noopener noreferrer">${escaped(source.title)} ↗</a>`).join('')}`
  if (!draft) {
    const category = item.domain_category ?? item.category
    const stage = item.development_stage?.label || item.stage || '未設定階段'
    $('#summary').innerHTML = [category?.name, stage, item.name?.en].filter(Boolean).map(value => `<span>${escaped(value)}</span>`).join('')
  }
  $('#editor-message').textContent = draft ? '草稿尚未寫入資料檔，確認內容後再儲存。' : '可直接編輯 JSON 欄位。'
  renderList()
}
async function reload() {
  showBusy('讀取資料中')
  try { items = await api('/api/technologies'); renderList(); if (selected && !isNew) { const current = items.find(item => item.id === selected.id); showEditor(current || null) } }
  catch (error) { notify(error.message, true) }
  finally { hideBusy() }
}
$('#items').addEventListener('click', event => {
  const button = event.target.closest('[data-id]')
  if (button) showEditor(items.find(item => String(item.id) === button.dataset.id) || null)
})
$('#search').addEventListener('input', renderList)
$('#reload').addEventListener('click', reload)
tokenInput.addEventListener('change', () => { sessionStorage.setItem(tokenKey, tokenInput.value.trim()); notify('管理 token 已更新') })
$('#generate-form').addEventListener('submit', async event => {
  event.preventDefault(); showBusy('正在向 Gemini 產生草稿')
  try { const draft = await api('/api/generate', { method: 'POST', body: JSON.stringify({ topic: $('#topic').value.trim() }) }); showEditor(draft, true); notify('草稿已產生，請檢查內容後儲存。') }
  catch (error) { notify(error.message, true) }
  finally { hideBusy() }
})
$('#save').addEventListener('click', async () => {
  showBusy('儲存中')
  try {
    const item = JSON.parse($('#json').value)
    const saved = await api(isNew ? '/api/technologies' : `/api/technologies/${encodeURIComponent(selected.id)}`, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(item) })
    await reload(); showEditor(items.find(entry => entry.id === saved.id) || saved); notify(`已儲存 ${saved.id}`)
  } catch (error) { notify(error.message, true) }
  finally { hideBusy() }
})
$('#delete').addEventListener('click', async () => {
  if (!selected || !window.confirm(`確定刪除「${selected.name?.zh || selected.name}」(${selected.id})？此操作會刪除 JSON 資料檔。`)) return
  showBusy('刪除中')
  try { await api(`/api/technologies/${encodeURIComponent(selected.id)}`, { method: 'DELETE' }); showEditor(null); await reload(); notify('項目已刪除') }
  catch (error) { notify(error.message, true) }
  finally { hideBusy() }
})
reload()
