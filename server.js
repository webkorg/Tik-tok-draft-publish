// server.js
// Личный инструмент для пакетной отправки видео в черновики (inbox) TikTok
// через официальный TikTok Content Posting API.
//
// Как это работает:
// 1. Заходишь на /  -> жмёшь "Войти через TikTok" -> проходишь OAuth один раз.
// 2. Токены сохраняются в data/tokens.json (только на твоей машине).
// 3. На главной странице выбираешь несколько видео -> жмёшь "Отправить в черновики".
// 4. Сервер по очереди инициализирует загрузку каждого видео через
//    /v2/post/publish/inbox/video/init/, заливает файл и опрашивает статус.
//
// TikTok сам присылает уведомление в inbox аккаунта на каждое видео —
// дальше пост нужно вручную открыть и опубликовать внутри приложения TikTok.
// Это официальный режим "Upload to Inbox", он не публикует ничего напрямую
// и не обходит никакую модерацию — TikTok всё равно проверяет контент,
// когда ты сам нажимаешь "Опубликовать" в приложении.

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

const DATA_DIR = path.join(__dirname, 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: UPLOAD_DIR });

// ---------- Работа с токенами ----------

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return null;
  return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
}

async function refreshAccessTokenIfNeeded() {
  const tokens = loadTokens();
  if (!tokens) return null;

  const isExpired = Date.now() >= tokens.obtained_at + tokens.expires_in * 1000 - 60_000;
  if (!isExpired) return tokens;

  const resp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });
  const data = await resp.json();
  if (data.access_token) {
    const updated = { ...tokens, ...data, obtained_at: Date.now() };
    saveTokens(updated);
    return updated;
  }
  return tokens;
}

// ---------- OAuth ----------

app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_key: CLIENT_KEY,
    scope: 'video.upload,video.publish,user.info.basic',
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    state,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Нет кода авторизации в ответе TikTok.');

  try {
    const resp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: CLIENT_KEY,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await resp.json();
    if (!data.access_token) {
      return res.status(400).send('Не удалось получить токен: ' + JSON.stringify(data));
    }
    saveTokens({ ...data, obtained_at: Date.now() });
    res.redirect('/?connected=1');
  } catch (err) {
    res.status(500).send('Ошибка авторизации: ' + err.message);
  }
});

app.get('/auth/status', async (req, res) => {
  const tokens = await refreshAccessTokenIfNeeded();
  res.json({ connected: !!tokens });
});

// ---------- Загрузка видео в черновики ----------

// TikTok Content Posting API ограничивает inbox/video/init шестью
// запросами в минуту на токен, поэтому между видео делаем небольшую паузу.
const DELAY_BETWEEN_UPLOADS_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadOneVideo(filePath, accessToken) {
  const stat = fs.statSync(filePath);
  const videoSize = stat.size;
  // Простая схема: один чанк на файл (подходит для типичных TikTok-роликов).
  // Для очень больших файлов TikTok рекомендует бить на чанки по 5-64MB.
  const chunkSize = videoSize;

  const initResp = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: 1,
      },
    }),
  });
  const initData = await initResp.json();
  if (!initData.data || !initData.data.upload_url) {
    throw new Error('Init не удался: ' + JSON.stringify(initData));
  }

  const { publish_id, upload_url } = initData.data;
  const fileBuffer = fs.readFileSync(filePath);

  const putResp = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
    },
    body: fileBuffer,
  });

  if (!putResp.ok) {
    throw new Error(`Загрузка файла не удалась: HTTP ${putResp.status}`);
  }

  return publish_id;
}

async function checkStatus(publishId, accessToken) {
  const resp = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const data = await resp.json();
  return data.data ? data.data.status : 'UNKNOWN';
}

app.post('/api/upload-batch', upload.array('videos', 20), async (req, res) => {
  const tokens = await refreshAccessTokenIfNeeded();
  if (!tokens) {
    return res.status(401).json({ error: 'Сначала авторизуйся через /auth/login' });
  }

  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'Файлы не получены' });
  }

  const results = [];

  for (const file of files) {
    try {
      const publishId = await uploadOneVideo(file.path, tokens.access_token);
      results.push({ file: file.originalname, publish_id: publishId, status: 'отправлено' });
    } catch (err) {
      results.push({ file: file.originalname, status: 'ошибка', error: err.message });
    } finally {
      fs.unlink(file.path, () => {});
    }
    await sleep(DELAY_BETWEEN_UPLOADS_MS);
  }

  res.json({ results });
});

app.post('/api/status', async (req, res) => {
  const tokens = await refreshAccessTokenIfNeeded();
  if (!tokens) return res.status(401).json({ error: 'Не авторизован' });

  const { publish_id } = req.body;
  const status = await checkStatus(publish_id, tokens.access_token);
  res.json({ status });
});

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
