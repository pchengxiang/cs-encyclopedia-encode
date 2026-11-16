# CS Encyclopedia Admin

獨立的科技項目管理工具。使用 Node.js 內建模組，無需安裝 npm 套件。可列出、搜尋、編輯、刪除 JSON 項目，也可使用 Gemini 建立附 Google Search 來源的可編輯草稿。生成會使用 Gemini 搜尋 grounding，可能產生額外 API 費用。

## 啟動

1. 複製 `.env.example` 為 `.env.local`。
2. 設定自己的 `ADMIN_TOKEN`，並填入 Google AI Studio 的 `GEMINI_API_KEY`。
3. 確認 `DATA_DIR` 指向百科的資料目錄。預設 `../backend/data`，也可設定絕對路徑。
4. 在此資料夾執行 `npm start`，再開啟 `http://localhost:4170`。
5. 在管理頁面底部輸入相同的 `ADMIN_TOKEN`。

此工具預設只監聽本機 `127.0.0.1`，可透過 `HOST` 與 `PORT` 設定。Gemini key 僅由伺服器使用。生成會透過 Google Search 查證，並將 Gemini 回傳的來源附在草稿的 `sources` 欄位；請仍自行檢查來源與內容。生成結果是草稿，按下儲存後才會寫入資料檔。修改或刪除前請確認 `DATA_DIR` 指向正確的位置。
