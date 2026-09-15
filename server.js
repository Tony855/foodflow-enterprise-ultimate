const express = require('express');

// 全球通用日期时间格式 YYYY-MM-DD HH:mm:ss
function formatGlobalDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatGlobalTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const net = require('net');
let redis = null;
try { redis = require('redis'); } catch(e) { /* redis可选，未安装时回退到内存Map */ }
const os = require('os');
const { execSync } = require('child_process');

// ---------- 统一配置加载（.env） ----------
// 轻量内置解析，不引入 dotenv 依赖。若已存在同名环境变量（如 systemd
// EnvironmentFile 注入的），则以环境变量为准，.env 只作为本地开发的兜底。
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
})();

const app = express();
// 信任Nginx反向代理，使 req.ip 返回真实客户端IP而非 127.0.0.1
app.set('trust proxy', true);
const PORT = Number(process.env.PORT || 3000);


// ===== 双服务器部署配置 =====
// 上传目录：可通过环境变量配置，双服务器时挂载NFS到同一目录
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
// 定时任务：只在一台服务器上设置 RUN_SCHEDULED_TASKS=true，避免重复执行
const RUN_SCHEDULED_TASKS = process.env.RUN_SCHEDULED_TASKS === 'true';
// Redis连接：双服务器时配置 REDIS_URL，共享防重复下单和登录限流状态
const REDIS_URL = process.env.REDIS_URL || null;

// ===== 通用缓存层：有Redis用Redis，无Redis回退到内存Map =====
let redisClient = null;
let redisReady = false;
async function initRedis() {
  if (!redis || !REDIS_URL) return false;
  try {
    redisClient = redis.createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.error('Redis连接错误:', err.message));
    await redisClient.connect();
    redisReady = true;
    console.log('✅ Redis缓存已连接');
    return true;
  } catch(e) {
    console.log('ℹ️ Redis未启用，使用内存缓存（单服务器模式）');
    redisReady = false;
    return false;
  }
}
const memoryCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of memoryCache) {
    if (item && item.expireAt && item.expireAt < now) memoryCache.delete(key);
  }
}, 60000);
const origMemorySet = memoryCache.set.bind(memoryCache);
memoryCache.set = function(key, value, ttlSeconds) {
  const item = ttlSeconds ? { value, expireAt: Date.now() + ttlSeconds * 1000 } : { value };
  return origMemorySet(key, item);
};
const origMemoryGet = memoryCache.get.bind(memoryCache);
memoryCache.get = function(key) {
  const item = origMemoryGet(key);
  return item ? item.value : undefined;
};
const cache = {
  async get(key) {
    if (redisReady) {
      const val = await redisClient.get(key);
      return val ? JSON.parse(val) : null;
    }
    return memoryCache.get(key) || null;
  },
  async set(key, value, ttlSeconds) {
    if (redisReady) {
      if (ttlSeconds) await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
      else await redisClient.set(key, JSON.stringify(value));
    } else {
      memoryCache.set(key, value, ttlSeconds);
    }
  },
  async del(key) {
    if (redisReady) await redisClient.del(key);
    else memoryCache.delete(key);
  }
};
// 防重复下单冷却
async function checkAndSetCooldown(key, cooldownMs) {
  const last = await cache.get('cooldown:' + key);
  const now = Date.now();
  if (last && (now - last) < cooldownMs) return false;
  await cache.set('cooldown:' + key, now, Math.ceil(cooldownMs / 1000) + 1);
  return true;
}
// 登录失败限流
async function getLoginAttempt(key) {
  const val = await cache.get('login:' + key);
  return val || { count: 0, lockUntil: 0 };
}
async function incrementLoginAttempt(key) {
  const attempt = await getLoginAttempt(key);
  attempt.count += 1;
  await cache.set('login:' + key, attempt, 24 * 3600);
  return attempt;
}
async function clearLoginAttempt(key) {
  await cache.del('login:' + key);
}
// ---------- 获取真实客户端IP（兼容Nginx反向代理） ----------
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const ips = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (ips.length > 0) return ips[0];
  }
  const xri = req.headers['x-real-ip'];
  if (xri) return xri.trim();
  return req.ip || req.connection.remoteAddress || 'unknown';
}

// ---------- IP地理位置查询 ----------
const ipLocationCache = new Map();
async function getLocationByIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'unknown') return '本地/内网';
  if (ipLocationCache.has(ip)) return ipLocationCache.get(ip);
  try {
    const http = require('http');
    const url = 'http://ip-api.com/json/' + ip + '?lang=zh-CN&fields=status,country,regionName,city';
    const result = await new Promise((resolve, reject) => {
      http.get(url, { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
    });
    if (result.status === 'success') {
      const location = (result.country || '') + ' ' + (result.regionName || '') + ' ' + (result.city || '');
      const trimmed = location.trim() || '未知';
      ipLocationCache.set(ip, trimmed);
      return trimmed;
    }
    return '未知';
  } catch (e) { return '未知'; }
}

// ---------- 中间件 ----------
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
// 静态文件服务：只暴露必要的目录，防止 server.js、.env 等敏感文件被直接下载
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny', index: false }));
app.use('/uploads', express.static(UPLOAD_DIR, { dotfiles: 'deny', index: false }));
// languages.js 是前端多语言翻译文件，单独提供路由
app.get('/languages.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'languages.js'));
});
app.get('/languages.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'languages.min.js'));
});

// 动态加载指定语言的翻译（方案二：按需加载，减少初始体积）
// 返回压缩后的JSON，只包含当前语言，不暴露全部5种语言
const i18nCache = {};
app.get('/api/i18n/:lang', (req, res) => {
  const lang = req.params.lang;
  const validLangs = ['zh', 'en', 'vi', 'th', 'km'];
  if (!validLangs.includes(lang)) {
    return res.status(400).json({ error: 'Unsupported language' });
  }
  // 内存缓存，避免每次读取文件
  if (i18nCache[lang]) {
    return res.json(i18nCache[lang]);
  }
  try {
    // 读取languages.js，提取指定语言
    const langContent = fs.readFileSync(path.join(__dirname, 'languages.js'), 'utf-8');
    // 简单解析：提取 LANGUAGES = { ... } 中的指定语言部分
    // 使用eval在沙箱中执行（仅用于提取数据）
    const sandbox = { module: {}, exports: {} };
    const vm = require('vm');
    const context = vm.createContext(sandbox);
    vm.runInContext(langContent + '; this._result = LANGUAGES["' + lang + '"];', context);
    const dict = sandbox._result || {};
    i18nCache[lang] = dict;
    // 设置缓存头
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json(dict);
  } catch (e) {
    console.error('i18n load error:', e.message);
    res.status(500).json({ error: 'Failed to load language' });
  }
});

// 根路径返回点餐首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 伪静态入口
app.get(['/login', '/manage'], (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get(['/index', '/home', '/order'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/waiter', (req, res) => {
  res.sendFile(path.join(__dirname, 'waiter.html'));
});
app.get('/kitchen', (req, res) => {
  res.sendFile(path.join(__dirname, 'kitchen.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/super', (req, res) => {
  res.sendFile(path.join(__dirname, 'super.html'));
});

// ---------- 二维码打印页面（独立路由，服务端渲染） ----------
app.get('/qr-print', async (req, res) => {
  try {
    const tableId = parseInt(req.query.tableId || '0', 10);
    const lang = ['zh', 'en', 'vi', 'th', 'km'].includes(req.query.lang) ? req.query.lang : 'zh';
    if (!tableId) return res.status(400).send('Invalid tableId');

    const table = await getAsync('SELECT name, qr_token, store_id FROM tables WHERE id = ?', [tableId]);
    if (!table) return res.status(404).send('Table not found');
    const store = await getAsync('SELECT name, qr_languages FROM stores WHERE id = ?', [table.store_id || 1]);
    const storeName = store?.name || 'FoodFlow';
    // 解析商户配置的二维码显示语言，未配置则默认只显示中文
    let displayLangs = ['zh'];
    if (store?.qr_languages) {
      const configured = store.qr_languages.split(',').map(s => s.trim()).filter(s => ['zh','en','vi','th','km'].includes(s));
      if (configured.length > 0) displayLangs = configured;
    }
    const url = `${req.protocol}://${req.get('host')}/?token=${encodeURIComponent(table.qr_token)}`;
    const qrDataUrl = await QRCode.toDataURL(url);

    // 翻译映射（服务端简单翻译，避免依赖前端i18n）
    const i18nMap = {
      zh: { table: '桌号', qrCode: '二维码', scanToOrder: '扫码点餐', download: '下载', print: '打印', orderingQrCode: '点餐二维码', copy: '复制', copied: '已复制', copyLink: '复制链接', copyFailed: '复制失败，请手动复制' },
      en: { table: 'Table', qrCode: 'QR Code', scanToOrder: 'Scan to Order', download: 'Download', print: 'Print', orderingQrCode: 'Ordering QR Code', copy: 'Copy', copied: 'Copied', copyLink: 'Copy Link', copyFailed: 'Copy failed, please copy manually' },
      vi: { table: 'Bàn', qrCode: 'Mã QR', scanToOrder: 'Quét mã để đặt hàng', download: 'Tải xuống', print: 'In', orderingQrCode: 'Mã QR đặt hàng', copy: 'Sao chép', copied: 'Đã sao chép', copyLink: 'Sao chép liên kết', copyFailed: 'Sao chép thất bại, vui lòng sao chép thủ công' },
      th: { table: 'โต๊ะ', qrCode: 'คิวอาร์โค้ด', scanToOrder: 'สแกนเพื่อสั่งอาหาร', download: 'ดาวน์โหลด', print: 'พิมพ์', orderingQrCode: 'คิวอาร์โค้ดสั่งอาหาร', copy: 'คัดลอก', copied: 'คัดลอกแล้ว', copyLink: 'คัดลอกลิงก์', copyFailed: 'คัดลอกล้มเหลว โปรดคัดลอกด้วยตัวเอง' },
      km: { table: 'តុ', qrCode: 'QR Code', scanToOrder: 'ស្កេនដើម្បីបញ្ជាទិញ', download: 'ទាញយក', print: 'បោះពុម្ព', orderingQrCode: 'កូដ QR បញ្ជាទិញ', copy: 'ចម្លង', copied: 'បានចម្លង', copyLink: 'ចម្លងតំណ', copyFailed: 'ការចម្លងបរាជ័យ សូមចម្លងដោយដៃ' }
    };
    const t = i18nMap[lang] || i18nMap.zh;

    // 读取模板文件
    const template = fs.readFileSync(path.join(__dirname, 'views', 'qr-print.html'), 'utf-8');

    // 替换变量
    const html = template
      .replace(/{{lang}}/g, lang)
      .replace(/{{table}}/g, table.name)
      .replace(/{{storeName}}/g, storeName)
      .replace(/{{qrCode}}/g, t.qrCode)
      .replace(/{{tableLabel}}/g, t.table)
      .replace(/{{orderingQrCode}}/g, t.orderingQrCode)
      .replace(/{{scanToOrder}}/g, displayLangs.map(l => (i18nMap[l] || i18nMap.zh).scanToOrder).join('\n'))
      .replace(/{{scanToOrderLines}}/g, displayLangs.map(l => '<div class="scan-line">' + (i18nMap[l] || i18nMap.zh).scanToOrder + '</div>').join(''))
      .replace(/{{download}}/g, t.download)
      .replace(/{{print}}/g, t.print)
      .replace(/{{copy}}/g, t.copy)
      .replace(/{{copied}}/g, t.copied)
      .replace(/{{copyLink}}/g, t.copyLink)
      .replace(/{{copyFailed}}/g, t.copyFailed)
      .replace(/{{url}}/g, url)
      .replace(/{{qrDataUrl}}/g, qrDataUrl)
      .replace(/{{storeNameJson}}/g, JSON.stringify(storeName))
      .replace(/{{tableJson}}/g, JSON.stringify(table.name))
      .replace(/{{tableLabelJson}}/g, JSON.stringify(t.table))
      .replace(/{{scanToOrderJson}}/g, JSON.stringify(displayLangs.map(l => (i18nMap[l] || i18nMap.zh).scanToOrder)))
      .replace(/{{qrCodeJson}}/g, JSON.stringify(t.qrCode))
      .replace(/{{qrDataUrlJson}}/g, JSON.stringify(qrDataUrl));

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('QR print error:', e);
    res.status(500).send('Failed to generate QR print page');
  }
});

app.get('/login.html', (req, res) => res.redirect('/login'));
app.get('/admin.html', (req, res) => res.redirect('/admin'));
app.get('/kitchen.html', (req, res) => res.redirect('/kitchen'));
app.get('/super.html', (req, res) => res.redirect('/super'));
app.get('/waiter.html', (req, res) => res.redirect('/waiter'));
app.get('/index.html', (req, res) => res.redirect('/'));

// ---------- 文件上传 ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 限制5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimeType = allowedTypes.test(file.mimetype);
    if (extName && mimeType) {
      return cb(null, true);
    }
    cb(new Error('只允许上传图片文件（JPG/PNG/GIF/WEBP）'));
  }
});

// ---------- MySQL 连接池 ----------
const poolConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'ordering_system',
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
};

let pool = mysql.createPool(poolConfig);

// ---------- 数据库辅助函数 ----------
let _currentDb = null;

async function runAsync(sql, params) {
  const db = _currentDb || pool;
  const [result] = await db.execute(sql, params);
  return { lastID: result.insertId, changes: result.affectedRows };
}

async function getAsync(sql, params) {
  const db = _currentDb || pool;
  const [rows] = await db.execute(sql, params);
  return rows[0] || null;
}

async function allAsync(sql, params) {
  const db = _currentDb || pool;
  const [rows] = await db.execute(sql, params);
  return rows;
}

async function withTransaction(work) {
  const conn = await pool.getConnection();
  await conn.query('START TRANSACTION');
  const prevDb = _currentDb;
  _currentDb = conn;
  try {
    const result = await work();
    await conn.query('COMMIT');
    return result;
  } catch (e) {
    await conn.query('ROLLBACK');
    throw e;
  } finally {
    _currentDb = prevDb;
    conn.release();
  }
}

// ---------- 常量 ----------
// 菜品初始化仅在首次安装时执行，无需版本号
const DEFAULT_MENU_CATEGORIES = ['招牌烧腊', '烧腊', '面食', '卤菜', '快餐', '早茶', '烧腊加料', '饮料'];
// 下单冷却记录：key为sessionToken或桌号，value为上次下单时间戳
const orderSubmissionCooldown = new Map();

// 获取下单间隔时间（秒），从数据库读取，默认30秒
async function getOrderCooldownMs() {
  try {
    const setting = await getAsync("SELECT value FROM settings WHERE `key` = 'order_interval_seconds'");
    const seconds = parseInt(setting?.value || '30', 10);
    return Math.max(0, Math.min(3600, seconds)) * 1000;
  } catch (e) {
    return 30 * 1000;
  }
}
setInterval(() => {
  const cutoff = Date.now() - 3600 * 1000; // 清理1小时前的记录
  for (const [key, ts] of orderSubmissionCooldown) {
    if (ts < cutoff) orderSubmissionCooldown.delete(key);
  }
}, 10 * 60 * 1000);

const createTableToken = () => crypto.randomBytes(12).toString('base64url');
// 密码哈希：使用bcrypt（新密码），兼容旧的SHA256
function hashPassword(pwd) {
  return bcrypt.hashSync(pwd, 10);
}
// 验证密码：自动检测bcrypt或旧SHA256
function verifyPassword(pwd, hash) {
  if (!hash) return false;
  if (hash.startsWith('$2')) {
    return bcrypt.compareSync(pwd, hash);
  }
  // 兼容旧的SHA256哈希
  return crypto.createHash('sha256').update(pwd).digest('hex') === hash;
}

// ---------- 登录限流器 ----------
const loginAttempts = new Map();

function getLoginAttempts(username, type) {
  const key = `${username}|${type}`;
  if (!loginAttempts.has(key)) {
    loginAttempts.set(key, { count: 0, lockUntil: 0, firstAttempt: 0 });
  }
  return loginAttempts.get(key);
}

function recordLoginAttempt(username, type) {
  const attempt = getLoginAttempts(username, type);
  attempt.count += 1;
  if (attempt.firstAttempt === 0) attempt.firstAttempt = Date.now();
  loginAttempts.set(`${username}|${type}`, attempt);
}

function resetLoginAttempts(username, type) {
  loginAttempts.delete(`${username}|${type}`);
}

async function isLoginLocked(username, type) {
  const settings = await getAsync("SELECT value FROM settings WHERE `key` = 'login_max_attempts'");
  const lockSettings = await getAsync("SELECT value FROM settings WHERE `key` = 'login_lock_minutes'");
  const maxAttempts = parseInt(settings?.value || '5', 10);
  const lockMinutes = parseInt(lockSettings?.value || '15', 10);
  const attempt = getLoginAttempts(username, type);
  if (attempt.lockUntil > Date.now()) {
    const remaining = Math.ceil((attempt.lockUntil - Date.now()) / 60000);
    return { locked: true, remaining, maxAttempts, lockMinutes };
  }
  if (attempt.count >= maxAttempts) {
    attempt.lockUntil = Date.now() + lockMinutes * 60 * 1000;
    loginAttempts.set(`${username}|${type}`, attempt);
    return { locked: true, remaining: lockMinutes, maxAttempts, lockMinutes };
  }
  return { locked: false, maxAttempts, lockMinutes };
}

// ---------- 读取 data/ 目录 JSON 文件 ----------
function readLegacyData(filename) {
  const filePath = path.join(__dirname, 'data', filename);
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn(`无法读取旧数据文件 ${filename}:`, error.message);
    return [];
  }
}

function readMenuCatalog() {
  const catalog = readLegacyData('roast-meat-menu.json');
  if (catalog.length === 0) throw new Error('烧腊菜单初始化文件为空或无法读取');
  return catalog;
}

// ---------- 数据库初始化 ----------
async function initializeMenuCatalog() {
  // 仅在首次安装（菜品表为空）时初始化，之后不覆盖用户的修改
  const menuCount = await getAsync('SELECT COUNT(*) AS count FROM menus');
  if (menuCount && menuCount.count > 0) return;

  const catalog = readMenuCatalog();
  await withTransaction(async () => {
    // 从菜品数据中提取唯一分类并创建（仅在分类表为空时）
    const catCount = await getAsync('SELECT COUNT(*) AS count FROM menu_categories');
    if (!catCount || catCount.count === 0) {
      const categories = [...new Set(catalog.map(item => item.category).filter(Boolean))];
      for (let i = 0; i < categories.length; i++) {
        await runAsync(
          'INSERT INTO menu_categories (name, sort) VALUES (?, ?)',
          [categories[i], i + 1]
        );
      }
    }

    // 插入菜品（包含所有必要字段）
    for (const item of catalog) {
      await runAsync(
        `INSERT INTO menus (name, emoji, price, category, \`desc\`, image, currency_code, name_en, desc_en, active, unit, show_dual, secondary_currency_code, store_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.name,
          item.emoji || '🍽️',
          Number(item.price) || 0,
          item.category || '其他',
          item.desc || '',
          item.image || '',
          'USD',
          item.name_en || '',
          item.desc_en || '',
          0,
          item.unit || '份',
          1,
          'KHR',
          1
        ]
      );
    }
  });

}

async function migrateLegacyJsonOnce() {
  const migrated = await getAsync("SELECT value FROM settings WHERE `key` = 'legacy_json_migrated_v1'");
  if (migrated) return;

  await withTransaction(async () => {
    // 导入 menu.json
    for (const item of readLegacyData('menu.json')) {
      if (!Number.isInteger(Number(item.id))) continue;
      const exists = await getAsync('SELECT id FROM menus WHERE id = ?', [Number(item.id)]);
      if (!exists) {
        await runAsync(
          'INSERT INTO menus (id, name, emoji, price, category, `desc`, image) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [Number(item.id), item.name, item.emoji || '🍽️', Number(item.price) || 0, item.category || '其他', item.desc || '', item.image || '']
        );
      }
    }
    // 导入 tables.json
    for (const table of readLegacyData('tables.json')) {
      if (!Number.isInteger(Number(table.id))) continue;
      const exists = await getAsync('SELECT id FROM tables WHERE id = ?', [Number(table.id)]);
      if (!exists) {
        await runAsync('INSERT INTO tables (id, name, status) VALUES (?, ?, ?)', [Number(table.id), table.name, table.status || 'available']);
      }
    }
    // 导入 orders.json
    for (const order of readLegacyData('orders.json')) {
      if (!Number.isInteger(Number(order.id)) || !order.table || !Array.isArray(order.items)) continue;
      const exists = await getAsync('SELECT id FROM orders WHERE id = ?', [Number(order.id)]);
      if (!exists) {
        const total = order.items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
        await runAsync(
          'INSERT INTO orders (id, table_name, items, total, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
          [Number(order.id), order.table, JSON.stringify(order.items), total, order.status || 'pending', order.createdAt || new Date().toISOString()]
        );
      }
    }
    await runAsync(
      "INSERT INTO settings (`key`, value) VALUES ('legacy_json_migrated_v1', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [new Date().toISOString()]
    );
  });
}

async function ensureOrderTables() {
  const missingTables = await allAsync(`
    SELECT DISTINCT o.table_name AS name
    FROM orders o
    LEFT JOIN tables t ON t.name = o.table_name
    WHERE t.id IS NULL
  `);
  for (const table of missingTables) {
    await runAsync('INSERT INTO tables (name, status) VALUES (?, ?)', [table.name, 'available']);
  }
}

async function rebaseCurrencyToUSDOnce() {
  const migrated = await getAsync("SELECT value FROM settings WHERE `key` = 'currency_base_usd_v1'");
  if (migrated) return;

  const usd = await getAsync("SELECT rate FROM currencies WHERE code = 'USD'");
  const oldUsdRate = usd ? Number(usd.rate) : 0;
  if (!(oldUsdRate > 0)) {
    await runAsync(
      "INSERT INTO settings (`key`, value) VALUES ('currency_base_usd_v1', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [new Date().toISOString()]
    );
    return;
  }

  const factor = 1 / oldUsdRate;
  await withTransaction(async () => {
    const currencies = await allAsync('SELECT code, rate FROM currencies');
    for (const currency of currencies) {
      await runAsync('UPDATE currencies SET rate=? WHERE code=?', [Number(currency.rate) * factor, currency.code]);
    }
    await runAsync('UPDATE currencies SET is_default=0');
    await runAsync("UPDATE currencies SET is_default=1 WHERE code='USD'");

    const orders = await allAsync('SELECT id, items, total FROM orders');
    for (const order of orders) {
      let items;
      try {
        items = JSON.parse(order.items || '[]');
      } catch (_) {
        items = [];
      }
      for (const item of items) {
        if (typeof item.base_price === 'number') item.base_price = Number(item.base_price) * oldUsdRate;
      }
      await runAsync(
        'UPDATE orders SET items=?, total=? WHERE id=?',
        [JSON.stringify(items), Number(order.total) * oldUsdRate, order.id]
      );
    }

    await runAsync(
      "INSERT INTO settings (`key`, value) VALUES ('currency_base_usd_v1', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [new Date().toISOString()]
    );
  });
}

async function syncTableStatus(tableName, storeId) {
  const table = await getAsync('SELECT id, status FROM tables WHERE name=? AND store_id=?', [tableName, storeId || 1]);
  if (!table) return;
  const active = await getAsync("SELECT COUNT(*) AS count FROM orders WHERE table_name=? AND store_id=? AND status='pending'", [tableName, storeId || 1]);
  if (active.count > 0) {
    if (table.status !== 'occupied') {
      await runAsync('UPDATE tables SET status=? WHERE id=?', ['occupied', table.id]);
    }
  } else if (table.status === 'occupied') {
    await runAsync('UPDATE tables SET status=? WHERE id=?', ['available', table.id]);
  }
}

async function initDatabase() {
  // 确保数据库存在
  try {
    await pool.getConnection();
  } catch (err) {
    if (err.code === 'ER_BAD_DB_ERROR') {

      const tempPool = mysql.createPool({
        host: poolConfig.host,
        user: poolConfig.user,
        password: poolConfig.password,
        port: poolConfig.port,
        waitForConnections: true,
        connectionLimit: 1,
        charset: 'utf8mb4',
      });
      const conn = await tempPool.getConnection();
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${poolConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      conn.release();
      await tempPool.end();
      pool = mysql.createPool(poolConfig);
    } else {
      throw err;
    }
  }

  // 创建表
  await runAsync(`
    CREATE TABLE IF NOT EXISTS menus (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      emoji VARCHAR(50),
      price DECIMAL(10,2) NOT NULL,
      category VARCHAR(255),
      \`desc\` TEXT,
      image VARCHAR(255),
      currency_code VARCHAR(10) NOT NULL DEFAULT 'USD',
      name_en VARCHAR(255),
      desc_en TEXT,
      active TINYINT NOT NULL DEFAULT 1,
      unit VARCHAR(50) NOT NULL DEFAULT '份',
      show_dual TINYINT NOT NULL DEFAULT 0,
      secondary_currency_code VARCHAR(10),
      store_id INT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 迁移 menus 表，添加 sales_count 字段（兼容旧数据库）
  const menusColumns = await allAsync('SHOW COLUMNS FROM menus');
  const menusColNames = menusColumns.map(c => c.Field);
  if (!menusColNames.includes('sales_count')) {
    await runAsync('ALTER TABLE menus ADD COLUMN sales_count INT NOT NULL DEFAULT 0');

  }

  await runAsync(`
    CREATE TABLE IF NOT EXISTS currencies (
      id INT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL DEFAULT 1,
      code VARCHAR(10) NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      name VARCHAR(255) NOT NULL,
      rate DECIMAL(10,4) NOT NULL DEFAULT 1,
      is_default TINYINT NOT NULL DEFAULT 0,
      UNIQUE KEY unique_merchant_code (merchant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS menu_categories (
      id INT PRIMARY KEY AUTO_INCREMENT,
      store_id INT NOT NULL DEFAULT 1,
      name VARCHAR(255) NOT NULL,
      sort INT NOT NULL DEFAULT 0,
      UNIQUE KEY unique_store_name (store_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS login_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      createdAt VARCHAR(50) NOT NULL,
      success TINYINT NOT NULL DEFAULT 0,
      ip VARCHAR(50),
      message TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 迁移 login_logs 表，添加缺失字段（兼容旧数据库）
  const loginLogsColumns = await allAsync('SHOW COLUMNS FROM login_logs');
  const loginLogsColNames = loginLogsColumns.map(c => c.Field);
  if (!loginLogsColNames.includes('username')) {
    await runAsync('ALTER TABLE login_logs ADD COLUMN username VARCHAR(100) DEFAULT NULL');

  }
  if (!loginLogsColNames.includes('location')) {
    await runAsync('ALTER TABLE login_logs ADD COLUMN location VARCHAR(255) DEFAULT NULL');

  }
  if (!loginLogsColNames.includes('merchant_id')) {
    await runAsync('ALTER TABLE login_logs ADD COLUMN merchant_id INT DEFAULT NULL');

  }
  if (!loginLogsColNames.includes('login_type')) {
    await runAsync('ALTER TABLE login_logs ADD COLUMN login_type VARCHAR(50) DEFAULT NULL');

  }

  // 商户管理员会话表
  await runAsync(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      admin_id INT NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at VARCHAR(50) NOT NULL,
      created_at VARCHAR(50) NOT NULL,
      ip VARCHAR(50),
      user_agent TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 超级管理员会话表
  await runAsync(`
    CREATE TABLE IF NOT EXISTS super_sessions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      super_admin_id INT NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at VARCHAR(50) NOT NULL,
      created_at VARCHAR(50) NOT NULL,
      ip VARCHAR(50),
      user_agent TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 操作审计日志表
  await runAsync(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      actor_type VARCHAR(50) NOT NULL,
      actor_id INT,
      actor_username VARCHAR(100),
      action VARCHAR(100) NOT NULL,
      target_type VARCHAR(50),
      target_id INT,
      details TEXT,
      ip VARCHAR(50),
      created_at VARCHAR(50) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS scan_sessions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      table_name VARCHAR(50) NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at VARCHAR(50) NOT NULL,
      created_at VARCHAR(50) NOT NULL,
      store_id INT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS waiters (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      can_order TINYINT NOT NULL DEFAULT 1,
      can_mark_item TINYINT NOT NULL DEFAULT 1,
      can_complete_order TINYINT NOT NULL DEFAULT 1,
      active TINYINT NOT NULL DEFAULT 1,
      store_id INT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS waiter_sessions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      waiter_id INT NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at VARCHAR(50) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS stores (
      id INT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL DEFAULT 1,
      name VARCHAR(255) NOT NULL,
      code VARCHAR(50) UNIQUE,
      address TEXT,
      active TINYINT NOT NULL DEFAULT 1,
      INDEX idx_merchant (merchant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS tables (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'available',
      qr_token VARCHAR(255),
      store_id INT NOT NULL DEFAULT 1,
      UNIQUE KEY unique_store_table (store_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT PRIMARY KEY AUTO_INCREMENT,
      table_name VARCHAR(50) NOT NULL,
      items LONGTEXT NOT NULL,
      total DECIMAL(10,2) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      createdAt VARCHAR(50) NOT NULL,
      session_token VARCHAR(255),
      store_id INT NOT NULL DEFAULT 1,
      note VARCHAR(200) DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // 兼容已存在的旧版 orders 表（没有 note 列时自动补上，已存在则忽略报错）
  try {
    await runAsync("ALTER TABLE orders ADD COLUMN note VARCHAR(200) DEFAULT ''");
  } catch (e) {
    if (!/duplicate column/i.test(e.message || '')) throw e;
  }

  await runAsync(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(255) PRIMARY KEY,
      value TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS waiter_calls (
      id VARCHAR(32) PRIMARY KEY,
      table_name VARCHAR(50) NOT NULL,
      store_id INT NOT NULL DEFAULT 1,
      session_token VARCHAR(255),
      type VARCHAR(20) DEFAULT 'call',
      message VARCHAR(255),
      status VARCHAR(20) DEFAULT 'pending',
      handled_by VARCHAR(100),
      handled_at VARCHAR(50),
      created_at VARCHAR(50) NOT NULL,
      INDEX idx_store_status (store_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // 兼容旧表：添加缺失字段
  try { await runAsync('ALTER TABLE waiter_calls ADD COLUMN type VARCHAR(20) DEFAULT "call"'); } catch (e) { /* 字段已存在 */ }
  try { await runAsync('ALTER TABLE waiter_calls ADD COLUMN message VARCHAR(255)'); } catch (e) { /* 字段已存在 */ }

  await runAsync(`
    CREATE TABLE IF NOT EXISTS reservations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      table_name VARCHAR(50) NOT NULL,
      store_id INT NOT NULL DEFAULT 1,
      customer_name VARCHAR(100) NOT NULL,
      phone VARCHAR(50),
      reservation_time VARCHAR(50) NOT NULL,
      guests INT DEFAULT 1,
      status VARCHAR(20) DEFAULT 'pending',
      created_at VARCHAR(50) NOT NULL,
      INDEX idx_store_time (store_id, reservation_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS printers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      type VARCHAR(20) DEFAULT 'network',
      ip_address VARCHAR(50),
      port INT DEFAULT 9100,
      paper_width INT DEFAULT 58,
      brand VARCHAR(50) DEFAULT 'generic',
      is_default TINYINT DEFAULT 0,
      active TINYINT DEFAULT 1,
      store_id INT NOT NULL DEFAULT 1,
      INDEX idx_store (store_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ===== 超级管理员系统 =====
  await runAsync(`
    CREATE TABLE IF NOT EXISTS merchants (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      code VARCHAR(50) UNIQUE NOT NULL,
      contact_name VARCHAR(100),
      contact_phone VARCHAR(50),
      max_stores INT NOT NULL DEFAULT 1,
      status TINYINT NOT NULL DEFAULT 1,
      expire_date DATE,
      settings JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS super_admins (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS merchant_admins (
      id INT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      active TINYINT NOT NULL DEFAULT 1,
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_merchant (merchant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 为现有表添加 merchant_id 字段（兼容旧表）
  const tablesToAlter = ['stores', 'menus', 'tables', 'orders', 'waiters', 'printers', 'waiter_calls', 'reservations', 'scan_sessions', 'currencies', 'menu_categories'];
  for (const tbl of tablesToAlter) {
    try {
      await runAsync(`ALTER TABLE ${tbl} ADD COLUMN merchant_id INT NOT NULL DEFAULT 1`);

    } catch (e) {
      if (!/duplicate column/i.test(e.message || '')) console.log(`  ! ${tbl}: ${e.message}`);
    }
  }

  // 为 merchant_admins 表添加权限字段（兼容旧表）
  const adminPermFields = ['can_manage_menu', 'can_manage_table', 'can_manage_order', 'can_delete_order', 'can_edit_order', 'can_manage_store', 'can_manage_waiter', 'can_manage_currency', 'can_manage_printer', 'can_manage_admin', 'can_view_logs'];
  for (const field of adminPermFields) {
    try {
      await runAsync(`ALTER TABLE merchant_admins ADD COLUMN ${field} TINYINT NOT NULL DEFAULT 1`);
    } catch (e) {
      if (!/duplicate column/i.test(e.message || '')) console.log(`  ! merchant_admins.${field}: ${e.message}`);
    }
  }

  // 初始化基础数据：超级管理员 + 默认商户 + 店铺 + 菜品 + 桌号
  // 创建唯一超级管理员
  const superAdminCount = await getAsync('SELECT COUNT(*) AS count FROM super_admins');
  if (superAdminCount.count === 0) {
    const superHash = hashPassword('super123');
    await runAsync("INSERT INTO super_admins (username, password_hash, display_name) VALUES (?, ?, ?)", ['superadmin', superHash, '超级管理员']);
    console.log('  + 已创建超级管理员：superadmin / super123');
  }

  // 创建默认商户（仅首次安装时）
  const merchantCount = await getAsync('SELECT COUNT(*) AS count FROM merchants');
  if (merchantCount.count === 0) {
    const defaultMerchantCode = 'FF0001';
    await runAsync("INSERT INTO merchants (name, code, contact_name, contact_phone, max_stores, status) VALUES (?, ?, ?, ?, ?, 1)",
      ['FoodFlow', defaultMerchantCode, '管理员', '', 5]);
    const defaultMerchantId = (await getAsync('SELECT id FROM merchants WHERE code=?', [defaultMerchantCode])).id;
    console.log('  + 已创建默认商户：FoodFlow (id=' + defaultMerchantId + ')');

    // 创建商户管理员
    const adminHash = hashPassword('admin123');
    await runAsync("INSERT INTO merchant_admins (merchant_id, username, password_hash, display_name) VALUES (?, ?, ?, ?)",
      [defaultMerchantId, 'admin', adminHash, 'FoodFlow管理员']);
    console.log('  + 已创建商户管理员：admin / admin123');

    // 创建默认店铺
    await runAsync("INSERT INTO stores (merchant_id, name, code, address, active) VALUES (?, ?, ?, ?, 1)",
      [defaultMerchantId, 'FoodFlow总店', 'ff-main', '']);
    const defaultStoreId = (await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [defaultMerchantId])).id;
    console.log('  + 已创建默认店铺：FoodFlow总店 (id=' + defaultStoreId + ')');

    // 创建默认货币
    for (const currency of [
      ['USD', '$', '美元', 1, 1], ['CNY', '¥', '人民币', 7, 0], ['VND', '₫', '越南盾', 25000, 0],
      ['THB', '฿', '泰铢', 32, 0], ['KHR', '៛', '柬埔寨瑞尔', 4000, 0]
    ]) {
      await runAsync('INSERT INTO currencies (merchant_id, code, symbol, name, rate, is_default) VALUES (?, ?, ?, ?, ?, ?)',
        [defaultMerchantId, ...currency]);
    }
    console.log('  + 已创建默认货币：USD/CNY/VND/THB/KHR');

    // 创建默认菜品分类
    const categories = [
      ['热销', 0], ['主食', 1], ['小吃', 2], ['饮料', 3], ['甜点', 4]
    ];
    for (const [catName, sort] of categories) {
      await runAsync('INSERT INTO menu_categories (name, sort, store_id) VALUES (?, ?, ?)', [catName, sort, defaultStoreId]);
    }
    console.log('  + 已创建默认菜品分类：热销/主食/小吃/饮料/甜点');

    // 创建默认菜品
    const defaultMenus = [
      ['招牌烧腊饭', '🍱', 8.5, '热销', '招牌烧腊配米饭', '份'],
      ['蜜汁叉烧饭', '🍖', 9.0, '热销', '蜜汁叉烧配米饭', '份'],
      ['白切鸡饭', '🍗', 7.5, '主食', '白切鸡配米饭', '份'],
      ['排骨饭', '🍖', 8.0, '主食', '红烧排骨配米饭', '份'],
      ['春卷', '🥟', 3.5, '小吃', '酥脆春卷', '份'],
      ['炸鸡翅', '🍗', 4.0, '小吃', '香酥炸鸡翅', '份'],
      ['柠檬茶', '🍋', 2.5, '饮料', '冰镇柠檬茶', '杯'],
      ['咖啡', '☕', 3.0, '饮料', '现磨咖啡', '杯'],
      ['芒果布丁', '🍮', 3.5, '甜点', '新鲜芒果布丁', '份'],
      ['双皮奶', '🥛', 3.0, '甜点', '传统双皮奶', '份']
    ];
    for (const [name, emoji, price, category, desc, unit] of defaultMenus) {
      await runAsync('INSERT INTO menus (name, emoji, price, category, `desc`, unit, active, store_id, currency_code) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
        [name, emoji, price, category, desc, unit, defaultStoreId, 'USD']);
    }
    console.log('  + 已创建默认菜品：10道示例菜品');

    // 创建默认桌号
    const defaultTables = ['A01', 'A02', 'A03', 'A04', 'A05', 'B01', 'B02', 'B03', 'B04', 'B05'];
    for (const tableName of defaultTables) {
      await runAsync('INSERT INTO tables (name, status, store_id) VALUES (?, ?, ?)', [tableName, 'available', defaultStoreId]);
    }
    console.log('  + 已创建默认桌号：A01-A05, B01-B05');
  }

  // 迁移：stores表添加qr_languages字段（二维码显示语言，逗号分隔，如zh,en,km）
  try {
    const cols = await pool.query('SHOW COLUMNS FROM stores LIKE ?', ['qr_languages']);
    if (!cols[0] || cols[0].length === 0) {
      await runAsync('ALTER TABLE stores ADD COLUMN qr_languages VARCHAR(50) DEFAULT NULL');
      console.log('  + 迁移 stores: 添加 qr_languages 字段');
    }
  } catch (e) { console.log('  stores qr_languages 迁移跳过:', e.message); }

  // 全局设置（不依赖商户）
  const backupInterval = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_interval_hours'");
  if (!backupInterval) await runAsync("INSERT INTO settings (`key`, value) VALUES ('backup_interval_hours', '24')");
  const dualCurrency = await getAsync("SELECT value FROM settings WHERE `key` = 'dual_currency_enabled'");
  if (!dualCurrency) await runAsync("INSERT INTO settings (`key`, value) VALUES ('dual_currency_enabled', '1')");
  const secondaryCurrency = await getAsync("SELECT value FROM settings WHERE `key` = 'secondary_currency_code'");
  if (!secondaryCurrency) await runAsync("INSERT INTO settings (`key`, value) VALUES ('secondary_currency_code', 'KHR')");
  else if (secondaryCurrency.value === 'CNY') await runAsync("UPDATE settings SET value='USD' WHERE `key`='secondary_currency_code'");
  const newOrderSound = await getAsync("SELECT value FROM settings WHERE `key` = 'new_order_sound_enabled'");
  if (!newOrderSound) await runAsync("INSERT INTO settings (`key`, value) VALUES ('new_order_sound_enabled', '1')");

  // 确保双货币设置为默认值（启用双币，第二货币为KHR）
  await runAsync("INSERT INTO settings (`key`, value) VALUES ('dual_currency_enabled', '1') ON DUPLICATE KEY UPDATE value='1'");
  await runAsync("INSERT INTO settings (`key`, value) VALUES ('secondary_currency_code', 'KHR') ON DUPLICATE KEY UPDATE value='KHR'");

  await rebaseCurrencyToUSDOnce();
  await ensureOrderTables();
  const tablesWithoutTokens = await allAsync("SELECT id FROM tables WHERE qr_token IS NULL OR qr_token = ''");
  for (const table of tablesWithoutTokens) await runAsync('UPDATE tables SET qr_token=? WHERE id=?', [createTableToken(), table.id]);
  const allTables = await allAsync('SELECT name, store_id FROM tables');
  for (const t of allTables) await syncTableStatus(t.name, t.store_id);

}

// ---------- ESC/POS 小票打印工具 ----------
// 兼容多品牌的 ESC/POS 命令生成器
class EscPosBuilder {
  constructor(paperWidth) {
    this.width = paperWidth || 58;
    this.charsPerLine = this.width === 80 ? 48 : 32;
    this.buffer = Buffer.alloc(0);
  }

  _append(bytes) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)]);
    return this;
  }

  // 初始化打印机
  init() {
    return this._append([0x1b, 0x40]);
  }

  // 设置对齐方式：0=左, 1=中, 2=右
  align(n) {
    return this._append([0x1b, 0x61, n]);
  }

  // 设置字体：0=标准, 1=压缩
  font(n) {
    return this._append([0x1b, 0x4d, n]);
  }

  // 加粗
  bold(on) {
    return this._append([0x1b, 0x45, on ? 1 : 0]);
  }

  // 双倍高度
  doubleHeight(on) {
    return this._append([0x1b, 0x21, on ? 0x10 : 0x00]);
  }

  // 双倍宽度
  doubleWidth(on) {
    return this._append([0x1b, 0x21, on ? 0x20 : 0x00]);
  }

  // 大字体（宽高都双倍）
  big(on) {
    return this._append([0x1b, 0x21, on ? 0x30 : 0x00]);
  }

  // 下划线
  underline(on) {
    return this._append([0x1b, 0x2d, on ? 1 : 0]);
  }

  // 打印文本（自动处理中文编码）
  text(str) {
    // 中文使用 GBK 编码，大多数热敏打印机支持
    // 这里先用 UTF-8，打印机通常会自动处理
    const buf = Buffer.from(str, 'utf8');
    return this._append(buf);
  }

  // 打印一行文本
  line(str) {
    return this.text(str || '').newline();
  }

  // 换行
  newline(n = 1) {
    for (let i = 0; i < n; i++) this._append([0x0a]);
    return this;
  }

  // 走纸
  feed(n = 3) {
    return this._append([0x1b, 0x4a, n]);
  }

  // 切纸
  cut(mode = 1) {
    // mode: 0=半切, 1=全切
    this.feed(3);
    return this._append([0x1d, 0x56, mode ? 1 : 0]);
  }

  // 打印分隔线
  separator(char = '-') {
    const line = char.repeat(this.charsPerLine);
    return this.line(line);
  }

  // 两列文本（左对齐 + 右对齐）
  twoColumn(left, right) {
    const leftStr = String(left || '');
    const rightStr = String(right || '');
    // 中文字符占2个宽度，简单处理
    const leftWidth = [...leftStr].reduce((sum, c) => sum + (/[\u4e00-\u9fa5]/.test(c) ? 2 : 1), 0);
    const rightWidth = [...rightStr].reduce((sum, c) => sum + (/[\u4e00-\u9fa5]/.test(c) ? 2 : 1), 0);
    const spaces = Math.max(1, this.charsPerLine - leftWidth - rightWidth);
    return this.line(leftStr + ' '.repeat(spaces) + rightStr);
  }

  // 打印条形码
  barcode(code, type = 2) {
    // type: 2=UPC-A, 3=UPC-E, 4=EAN13, 5=EAN8, 73=CODE128
    this._append([0x1d, 0x6b, type]);
    this._append(Buffer.from(code, 'ascii'));
    this._append([0x00]);
    return this;
  }

  // 打印二维码
  qrCode(text) {
    const data = Buffer.from(text, 'utf8');
    const len = data.length + 3;
    const pL = len & 0xff;
    const pH = (len >> 8) & 0xff;
    // 设置二维码大小
    this._append([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x08]);
    // 选择二维码模型
    this._append([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x41, 0x32, 0x00]);
    // 存储数据
    this._append([0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]);
    this._append(data);
    // 打印二维码
    this._append([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
    return this;
  }

  // 打开钱箱
  cashDrawer() {
    return this._append([0x1b, 0x70, 0x00, 0x40, 0xff]);
  }

  // 获取最终打印数据
  build() {
    return this.buffer;
  }
}

// 生成订单小票内容
function buildReceipt(order, store, printer) {
  const width = printer?.paper_width || 58;
  const pos = new EscPosBuilder(width);

  pos.init();
  pos.align(1); // 居中
  pos.big(true);
  pos.line(store?.name || 'FoodFlow');
  pos.big(false);
  pos.newline();

  if (store?.address) {
    pos.font(1); // 压缩字体
    pos.line(store.address);
    pos.font(0);
  }
  pos.separator('=');
  pos.newline();

  pos.align(0); // 左对齐
  pos.twoColumn('订单号:', `#${order.id}`);
  pos.twoColumn('桌号:', order.table);
  pos.twoColumn('时间:', formatGlobalDateTime(order.createdAt));
  if (order.note) {
    pos.line(`备注: ${order.note}`);
  }
  pos.separator();

  // 菜品列表
  pos.line('菜品');
  pos.separator('-');
  for (const item of order.items) {
    const name = item.name.length > 16 ? item.name.slice(0, 15) + '..' : item.name;
    pos.twoColumn(`${item.emoji || ''}${name} x${item.quantity}`, `$${(item.base_price * item.quantity).toFixed(2)}`);
  }
  pos.separator();

  pos.align(2); // 右对齐
  pos.bold(true);
  pos.line(`合计: $${Number(order.total).toFixed(2)}`);
  pos.bold(false);
  pos.newline();

  pos.align(1); // 居中
  pos.line('谢谢惠顾，欢迎再次光临！');
  pos.newline(2);

  // 打印订单二维码（可选）
  try {
    pos.qrCode(`order:${order.id}`);
    pos.newline();
  } catch (e) { /* 二维码打印失败不影响主流程 */ }

  pos.cut(1); // 全切
  return pos.build();
}

// 生成后厨小票（只显示待做菜品）
function buildKitchenTicket(order, store, printer) {
  const width = printer?.paper_width || 58;
  const pos = new EscPosBuilder(width);

  pos.init();
  pos.align(1);
  pos.big(true);
  pos.line('后厨订单');
  pos.big(false);
  pos.newline();
  pos.separator('=');

  pos.align(0);
  pos.twoColumn('桌号:', order.table);
  pos.twoColumn('订单号:', `#${order.id}`);
  pos.twoColumn('时间:', formatGlobalTime(order.createdAt));
  if (order.note) {
    pos.line(`备注: ${order.note}`);
  }
  pos.separator();

  const pendingItems = order.items.filter(i => i.itemStatus !== 'done');
  for (const item of pendingItems) {
    pos.bold(true);
    pos.line(`${item.emoji || ''} ${item.name} x${item.quantity}`);
    pos.bold(false);
  }
  pos.newline(3);
  pos.cut(1);
  return pos.build();
}

// 网络打印（通过 IP + 端口）
async function printToNetworkPrinter(data, ip, port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timeout = 10000;

    socket.setTimeout(timeout);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('打印机连接超时'));
    });
    socket.on('error', (err) => {
      reject(new Error(`打印机连接失败: ${err.message}`));
    });

    socket.connect(port || 9100, ip, () => {
      socket.write(data, () => {
        setTimeout(() => {
          socket.destroy();
          resolve(true);
        }, 500);
      });
    });
  });
}

// ---------- 辅助函数 ----------
function formatOrder(row) {
  let items = row.items;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch (_) {
      console.warn(`订单 ${row.id} 的 items 解析失败，原始内容:`, items);
      items = [];
    }
  } else if (!Array.isArray(items)) {
    items = [];
  }
  for (const item of items) {
    if (!item.itemStatus) item.itemStatus = 'pending';
  }
  return {
    id: row.id,
    table: row.table_name,
    items,
    total: row.total,
    status: row.status,
    createdAt: row.createdAt,
    sessionToken: row.session_token || '',
    note: row.note || ''
  };
}

async function normalizeOrderItems(items, storeId) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('订单至少需要一道菜品');
  const normalized = [];
  for (const item of items) {
    const menuId = Number(item.id);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(menuId) || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('菜品或数量无效');
    }
    const menuItem = await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [menuId, storeId || 1]);
    if (!menuItem) throw new Error(`菜品不存在（ID: ${menuId}）`);
    const currency = await getAsync('SELECT code, rate FROM currencies WHERE code=? AND merchant_id=(SELECT merchant_id FROM stores WHERE id=?)', [menuItem.currency_code || 'USD', menuItem.store_id || 1]);
    if (!currency || !(Number(currency.rate) > 0)) throw new Error(`菜品货币无效（${menuItem.currency_code || 'CNY'}）`);
    normalized.push({
      id: menuItem.id,
      name: menuItem.name,
      price: menuItem.price,
      currency_code: currency.code,
      base_price: Number(menuItem.price) / Number(currency.rate),
      quantity,
      emoji: menuItem.emoji || '🍽️',
      itemStatus: item.itemStatus || 'pending',
      show_dual: item.show_dual || menuItem.show_dual || (item.secondary_currency_code || menuItem.secondary_currency_code ? 1 : 0),
      secondary_currency_code: item.secondary_currency_code || menuItem.secondary_currency_code || '',
      unit: item.unit || menuItem.unit || '份'
    });
  }
  return normalized;
}

async function assertTableExists(table, storeId) {
  const normalized = String(table || '').trim();
  if (!normalized) throw new Error('请选择桌号');
  const existing = await getAsync('SELECT name FROM tables WHERE name = ? AND store_id = ?', [normalized, storeId || 1]);
  if (!existing) throw new Error('桌号不存在');
  return normalized;
}

async function verifyLegacyAdminPassword(inputPwd) {
  const row = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_password'");
  if (!row) return false;
  return row.value === hashPassword(inputPwd);
}

async function getWaiterFromRequest(req) {
  const token = req.get('X-Waiter-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = await getAsync('SELECT waiter_id, expires_at FROM waiter_sessions WHERE token=?', [token]);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  return await getAsync('SELECT * FROM waiters WHERE id=? AND active=1', [session.waiter_id]);
}

// 共用管理员认证逻辑：返回 { adminId, merchantId, storeId, sessionToken } 或 null
async function authenticateAdmin(req) {
  const authHeader = req.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token) {
    // 优先检查新的session token
    const session = await getAsync('SELECT * FROM admin_sessions WHERE token=?', [token]);
    if (session) {
      if (new Date(session.expires_at).getTime() <= Date.now()) {
        await runAsync('DELETE FROM admin_sessions WHERE token=?', [token]).catch(() => {});
        return { error: '登录已过期，请重新登录' };
      }
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND active=1', [session.admin_id]);
      if (admin) {
        const merchant = await getAsync('SELECT * FROM merchants WHERE id=? AND status=1', [admin.merchant_id]);
        if (merchant) {
          // 验证X-Store-Id对应的店铺是否属于当前商户，防止越权访问其他商户店铺
          let requestedStoreId = parseInt(req.get('X-Store-Id') || '0', 10);
          let validStoreId = null;
          if (requestedStoreId > 0) {
            const storeCheck = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [requestedStoreId, admin.merchant_id]);
            if (storeCheck) {
              validStoreId = requestedStoreId;
            } else {
              // 请求的店铺不属于当前商户，使用该商户的第一个店铺
              const firstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
              if (!firstStore) return { error: '该商户尚未创建店铺，请联系超级管理员' };
              validStoreId = firstStore.id;
            }
          } else {
            // 未指定店铺，使用该商户的第一个店铺
            const firstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
            if (!firstStore) return { error: '该商户尚未创建店铺，请联系超级管理员' };
            validStoreId = firstStore.id;
          }
          // 滑动过期
          const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_idle_timeout'");
          const timeoutMinutes = parseInt(timeoutSetting?.value || '30', 10);
          const newExpires = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
          runAsync('UPDATE admin_sessions SET expires_at=? WHERE token=?', [newExpires, token]).catch(() => {});
          return {
            adminId: admin.id,
            merchantId: admin.merchant_id,
            storeId: validStoreId,
            sessionToken: token
          };
        }
      }
    }
    // 兼容旧的base64 token（无过期）
    try {
      const payload = JSON.parse(Buffer.from(token, 'base64').toString());
      if (payload.adminId) {
        const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND active=1', [payload.adminId]);
        if (admin) {
          const merchant = await getAsync('SELECT * FROM merchants WHERE id=? AND status=1', [admin.merchant_id]);
          if (merchant) {
            let legacyStoreId = parseInt(req.get('X-Store-Id') || '0', 10);
            let legacyValidStoreId = null;
            if (legacyStoreId > 0) {
              const legacyStoreCheck = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [legacyStoreId, admin.merchant_id]);
              if (legacyStoreCheck) {
                legacyValidStoreId = legacyStoreId;
              } else {
                const legacyFirstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
                if (!legacyFirstStore) return { error: '该商户尚未创建店铺，请联系超级管理员' };
                legacyValidStoreId = legacyFirstStore.id;
              }
            } else {
              const legacyFirstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
              if (!legacyFirstStore) return { error: '该商户尚未创建店铺，请联系超级管理员' };
              legacyValidStoreId = legacyFirstStore.id;
            }
            return {
              adminId: admin.id,
              merchantId: admin.merchant_id,
              storeId: legacyValidStoreId
            };
          }
        }
      }
    } catch (e) { /* 不是旧格式token */ }
  }
  // 兼容旧的 X-Admin-Key 认证
  const providedKey = req.get('X-Admin-Key');
  const setting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_access_key'");
  if (providedKey && setting && providedKey === setting.value) {
    return { storeId: parseInt(req.get('X-Store-Id') || '1', 10) };
  }
  return null;
}

async function requireAdminKey(req, res, next) {
  const result = await authenticateAdmin(req);
  if (result && result.error) return res.status(401).json({ error: result.error });
  if (result) {
    req.adminId = result.adminId;
    req.merchantId = result.merchantId;
    req.adminSessionToken = result.sessionToken;
    req.storeId = result.storeId;
    // 加载管理员权限信息
    try {
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=?', [result.adminId]);
      if (admin) {
        const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [result.merchantId]);
        req.isPrimaryAdmin = primaryAdmin && primaryAdmin.id === admin.id;
        req.adminPermissions = {
          can_manage_menu: req.isPrimaryAdmin || admin.can_manage_menu ? 1 : 0,
          can_manage_table: req.isPrimaryAdmin || admin.can_manage_table ? 1 : 0,
          can_manage_order: req.isPrimaryAdmin || admin.can_manage_order ? 1 : 0,
          can_delete_order: req.isPrimaryAdmin || admin.can_delete_order ? 1 : 0,
          can_edit_order: req.isPrimaryAdmin || admin.can_edit_order ? 1 : 0,
          can_manage_store: req.isPrimaryAdmin || admin.can_manage_store ? 1 : 0,
          can_manage_waiter: req.isPrimaryAdmin || admin.can_manage_waiter ? 1 : 0,
          can_manage_currency: req.isPrimaryAdmin || admin.can_manage_currency ? 1 : 0,
          can_manage_printer: req.isPrimaryAdmin || admin.can_manage_printer ? 1 : 0,
          can_manage_admin: req.isPrimaryAdmin || admin.can_manage_admin ? 1 : 0,
          can_view_logs: req.isPrimaryAdmin || admin.can_view_logs ? 1 : 0
        };
      }
    } catch (e) { console.warn('加载管理员权限失败:', e.message); }
    return next();
  }
  return res.status(401).json({ error: '未登录或登录已过期' });
}

// 权限校验中间件工厂
function requirePermission(permKey) {
  return function(req, res, next) {
    if (req.isPrimaryAdmin || (req.adminPermissions && req.adminPermissions[permKey])) {
      return next();
    }
    return res.status(403).json({ error: '没有操作权限' });
  };
}

// 操作审计日志记录
async function logAudit(actorType, actorId, actorUsername, action, targetType, targetId, details, ip) {
  try {
    await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [actorType, actorId || null, actorUsername || '', action, targetType || null, targetId || null, details || '', ip || '', new Date().toISOString()]);
  } catch (e) { console.warn('审计日志记录失败:', e.message); }
}

async function requireAdminOrWaiter(req, res, next) {
  // 先尝试管理员认证
  const adminResult = await authenticateAdmin(req);
  if (adminResult && adminResult.error) return res.status(401).json({ error: adminResult.error });
  if (adminResult) {
    req.adminId = adminResult.adminId;
    req.merchantId = adminResult.merchantId;
    req.isAdmin = true;
    req.adminSessionToken = adminResult.sessionToken;
    req.storeId = adminResult.storeId;
    return next();
  }
  // 服务员 token 认证
  const authHeader = req.get('Authorization') || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
  const token = req.get('X-Waiter-Token') || bearerToken;
  if (token) {
    const session = await getAsync('SELECT waiter_id, expires_at FROM waiter_sessions WHERE token=?', [token]);
    if (session && new Date(session.expires_at).getTime() > Date.now()) {
      const waiter = await getAsync('SELECT * FROM waiters WHERE id=? AND active=1', [session.waiter_id]);
      if (waiter) {
        req.waiter = waiter;
        req.waiterStoreId = waiter.store_id || 1;
        req.isAdmin = false;
        // 滑动过期：距离过期小于1小时时自动续期（活跃用户不会掉线）
        const expiresTime = new Date(session.expires_at).getTime();
        if (expiresTime - Date.now() < 60 * 60 * 1000) {
          const wTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'waiter_session_timeout'");
          const wTimeoutHours = parseInt(wTimeoutSetting?.value || '12', 10);
          const newExpires = new Date(Date.now() + wTimeoutHours * 60 * 60 * 1000).toISOString();
          runAsync('UPDATE waiter_sessions SET expires_at=? WHERE token=?', [newExpires, token]).catch(()=>{});
        }
        return next();
      }
    }
  }
  return res.status(401).json({ error: '无操作权限' });
}

// ---------- 自动备份 ----------
async function collectBackupData() {
  // 注意：admin_sessions、super_sessions 为会话临时表，故意不纳入备份，恢复后需重新登录
  const tables = ['menus', 'tables', 'orders', 'currencies', 'menu_categories', 'settings', 'login_logs', 'audit_logs', 'scan_sessions', 'waiters', 'waiter_sessions', 'stores', 'waiter_calls', 'reservations', 'printers', 'merchants', 'merchant_admins', 'super_admins'];
  const data = { exportedAt: new Date().toISOString(), tables: {} };
  for (const table of tables) {
    data.tables[table] = await allAsync(`SELECT * FROM \`${table}\``);
  }
  return data;
}

async function autoBackupDatabase() {
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const data = await collectBackupData();
  const filename = path.join(backupDir, `auto-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  await runAsync("INSERT INTO settings (`key`, value) VALUES ('last_backup_at', ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [new Date().toISOString()]);

}

async function maybeAutoBackup() {
  const intervalRow = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_interval_hours'");
  const intervalHours = Number(intervalRow?.value || 24);
  const lastRow = await getAsync("SELECT value FROM settings WHERE `key` = 'last_backup_at'");
  const lastTime = lastRow ? new Date(lastRow.value).getTime() : 0;
  if (Date.now() - lastTime >= intervalHours * 60 * 60 * 1000) {
    await autoBackupDatabase();
  }
}

// 自动清理过期日志
async function autoCleanLogs() {
  try {
    const enabledRow = await getAsync("SELECT value FROM settings WHERE `key` = 'auto_clean_log_enabled'");
    if (!enabledRow || enabledRow.value !== '1' && enabledRow.value !== 'true') return;
    const daysRow = await getAsync("SELECT value FROM settings WHERE `key` = 'log_retention_days'");
    const retentionDays = parseInt(daysRow?.value || '30', 10);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const cleanLoginRow = await getAsync("SELECT value FROM settings WHERE `key` = 'clean_login_log'");
    const cleanAuditRow = await getAsync("SELECT value FROM settings WHERE `key` = 'clean_audit_log'");
    let cleaned = 0;
    if (!cleanLoginRow || cleanLoginRow.value === '1' || cleanLoginRow.value === 'true') {
      const result = await runAsync('DELETE FROM login_logs WHERE created_at < ?', [cutoff]);
      cleaned += result.affectedRows || 0;
    }
    if (!cleanAuditRow || cleanAuditRow.value === '1' || cleanAuditRow.value === 'true') {
      const result = await runAsync('DELETE FROM audit_logs WHERE created_at < ?', [cutoff]);
      cleaned += result.affectedRows || 0;
    }
    if (cleaned > 0) {
      console.log(`🧹 自动清理日志: 删除 ${cleaned} 条过期日志（保留 ${retentionDays} 天）`);
    }
  } catch (e) {
    console.warn('自动清理日志失败:', e.message);
  }
}

// ================================================================
//  路由
// ================================================================

// ----- 公开接口 -----
app.get('/api/public/config', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || '1', 10);
    const store = await getAsync('SELECT merchant_id FROM stores WHERE id=?', [storeId]);
    const merchantId = store?.merchant_id || 1;
    const currencies = await allAsync('SELECT code, symbol, name, rate, is_default FROM currencies WHERE merchant_id=? ORDER BY is_default DESC, code', [merchantId]);
    const dualRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${merchantId}_dual_currency_enabled`]) || await getAsync("SELECT value FROM settings WHERE `key` = 'dual_currency_enabled'");
    const secondaryRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${merchantId}_secondary_currency_code`]) || await getAsync("SELECT value FROM settings WHERE `key` = 'secondary_currency_code'");
    const secondaryCurrency = currencies.find(c => c.code === secondaryRow?.value) || null;
    const soundRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${merchantId}_new_order_sound_enabled`]) || await getAsync("SELECT value FROM settings WHERE `key` = 'new_order_sound_enabled'");
    const refreshRow = await getAsync("SELECT value FROM settings WHERE `key` = 'waiter_refresh_interval'");
    const maxItemsRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_order_items'");
    const maxQtyRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_item_quantity'");
    const maxNoteRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_order_note_length'");
    res.json({
      currencies,
      defaultCurrency: currencies.find(c => c.is_default) || currencies[0] || { code: 'USD', symbol: '$', rate: 1 },
      dualCurrency: { enabled: dualRow?.value === '1', currency: secondaryCurrency },
      newOrderSoundEnabled: soundRow ? soundRow.value === '1' : true,
      waiter_refresh_interval: parseInt(refreshRow?.value || '8', 10),
      max_order_items: parseInt(maxItemsRow?.value || '50', 10),
      max_item_quantity: parseInt(maxQtyRow?.value || '100', 10),
      max_order_note_length: parseInt(maxNoteRow?.value || '200', 10)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/store-info', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || '1', 10);
    const store = await getAsync('SELECT id, name, address FROM stores WHERE id=? AND active=1', [storeId]);
    if (!store) return res.status(404).json({ error: '店铺不存在' });
    res.json(store);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/public/categories', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || '1', 10);
    const rows = await allAsync('SELECT id, name, sort FROM menu_categories WHERE store_id=? ORDER BY sort', [storeId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ordering-system', timestamp: new Date().toISOString() }));

// ----- 管理员登录 -----
// ===== 商户管理员登录（用户名+密码）=====
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username || '', 'merchant_admin', '请输入用户名和密码']);
      return res.status(400).json({ error: '请输入用户名和密码' });
    }
    // 登录限流检查
    const lockStatus = await isLoginLocked(username, 'merchant_admin');
    if (lockStatus.locked) {
      return res.status(429).json({ error: `登录失败次数过多，请${lockStatus.remaining}分钟后再试` });
    }
    const admin = await getAsync('SELECT * FROM merchant_admins WHERE username=? AND active=1', [username]);
    if (!admin) {      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'merchant_admin', '用户名不存在']);
      recordLoginAttempt(username, 'merchant_admin');
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const isValid = verifyPassword(password, admin.password_hash);
    if (!isValid) {      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'merchant_admin', '密码错误']);
      recordLoginAttempt(username, 'merchant_admin');
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    // 检查商户状态
    const merchant = await getAsync('SELECT * FROM merchants WHERE id=?', [admin.merchant_id]);
    if (!merchant || merchant.status !== 1) {
      return res.status(403).json({ error: '商户账号已被禁用，请联系超级管理员' });
    }
    // 登录成功，重置登录尝试计数
    resetLoginAttempts(username, 'merchant_admin');
    await runAsync('UPDATE merchant_admins SET last_login_at=NOW() WHERE id=?', [admin.id]);
    const clientIp = getClientIp(req);
    const location = await getLocationByIp(clientIp);
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, location, merchant_id, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, location, admin.merchant_id, 'merchant_admin', '商户管理员登录成功: ' + username]);
    // 生成token并创建session记录
    const token = crypto.randomBytes(32).toString('hex');
    const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_idle_timeout'");
    const timeoutMinutes = parseInt(timeoutSetting?.value || '30', 10);
    const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
    await runAsync('INSERT INTO admin_sessions (admin_id, token, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)', [admin.id, token, expiresAt, new Date().toISOString(), clientIp, req.get('User-Agent') || '']);
    // 查询该商户的第一个管理员ID（主管理员，拥有全部权限）
    const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
    const isPrimary = primaryAdmin && primaryAdmin.id === admin.id;
    res.json({ success: true, token, merchantId: admin.merchant_id, merchantName: merchant.name, adminId: admin.id, username: admin.username, displayName: admin.display_name, isPrimary,
      permissions: {
        can_manage_menu: isPrimary || admin.can_manage_menu ? 1 : 0,
        can_manage_table: isPrimary || admin.can_manage_table ? 1 : 0,
        can_manage_order: isPrimary || admin.can_manage_order ? 1 : 0,
        can_delete_order: isPrimary || admin.can_delete_order ? 1 : 0,
        can_edit_order: isPrimary || admin.can_edit_order ? 1 : 0,
        can_manage_store: isPrimary || admin.can_manage_store ? 1 : 0,
        can_manage_waiter: isPrimary || admin.can_manage_waiter ? 1 : 0,
        can_manage_currency: isPrimary || admin.can_manage_currency ? 1 : 0,
        can_manage_printer: isPrimary || admin.can_manage_printer ? 1 : 0,
        can_manage_admin: isPrimary || admin.can_manage_admin ? 1 : 0,
        can_view_logs: isPrimary || admin.can_view_logs ? 1 : 0
      }
    });
  } catch (e) {
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, message) VALUES (?, 0, ?, ?)', [new Date().toISOString(), getClientIp(req), e.message]).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});


// ===== 超级管理员登录 =====
app.post('/api/super/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username || '', 'super_admin', '请输入用户名和密码']);
      return res.status(400).json({ error: '请输入用户名和密码' });
    }
    // 登录限流检查
    const lockStatus = await isLoginLocked(username, 'super_admin');
    if (lockStatus.locked) {
      return res.status(429).json({ error: `登录失败次数过多，请${lockStatus.remaining}分钟后再试` });
    }
    // IP白名单检查
    const ipWhitelistSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'super_ip_whitelist'");
    const clientIp = getClientIp(req);
    if (ipWhitelistSetting && ipWhitelistSetting.value && ipWhitelistSetting.value.trim()) {
      const whitelist = ipWhitelistSetting.value.split(',').map(ip => ip.trim()).filter(Boolean);
      if (whitelist.length > 0 && !whitelist.includes(clientIp)) {
        await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, 'super_admin', 'IP不在白名单内']);
        return res.status(403).json({ error: '当前IP不允许登录超级管理员后台' });
      }
    }
    const superAdmin = await getAsync('SELECT * FROM super_admins WHERE username=?', [username]);
    if (!superAdmin) {      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, 'super_admin', '用户名不存在']);
      recordLoginAttempt(username, 'super_admin');
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const isValid = verifyPassword(password, superAdmin.password_hash);
    if (!isValid) {      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, 'super_admin', '密码错误']);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    // 登录成功，重置登录尝试计数
    resetLoginAttempts(username, 'super_admin');
    await runAsync('UPDATE super_admins SET last_login_at=NOW() WHERE id=?', [superAdmin.id]);
    const superLocation = await getLocationByIp(clientIp);
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, location, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, superLocation, 'super_admin', '超级管理员登录成功: ' + username]);
    // 生成token并创建session记录
    const token = crypto.randomBytes(32).toString('hex');
    const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'super_idle_timeout'");
    const timeoutMinutes = parseInt(timeoutSetting?.value || '60', 10);
    const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
    await runAsync('INSERT INTO super_sessions (super_admin_id, token, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)', [superAdmin.id, token, expiresAt, new Date().toISOString(), clientIp, req.get('User-Agent') || '']);
    res.json({ success: true, token, admin: { id: superAdmin.id, username: superAdmin.username, display_name: superAdmin.display_name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 超级管理员认证中间件 =====
async function requireSuperAdmin(req, res, next) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '未登录' });
    // 检查session是否存在且未过期
    const session = await getAsync('SELECT * FROM super_sessions WHERE token=?', [token]);
    if (!session) return res.status(401).json({ error: '登录已过期，请重新登录' });
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await runAsync('DELETE FROM super_sessions WHERE token=?', [token]).catch(() => {});
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    // 滑动过期：每次请求刷新过期时间
    const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'super_idle_timeout'");
    const timeoutMinutes = parseInt(timeoutSetting?.value || '60', 10);
    const newExpires = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
    runAsync('UPDATE super_sessions SET expires_at=? WHERE token=?', [newExpires, token]).catch(() => {});
    const superAdmin = await getAsync('SELECT * FROM super_admins WHERE id=?', [session.super_admin_id]);
    if (!superAdmin) return res.status(401).json({ error: '登录已过期' });
    req.superAdmin = superAdmin;
    req.superSessionToken = token;
    next();
  } catch (e) {
    res.status(401).json({ error: '认证失败' });
  }
}

// ===== 商户管理 CRUD =====
app.get('/api/super/merchants', requireSuperAdmin, async (req, res) => {
  try {
    const rows = await allAsync(`SELECT m.*, 
      (SELECT COUNT(*) FROM stores WHERE merchant_id=m.id) as store_count,
      (SELECT username FROM merchant_admins WHERE merchant_id=m.id LIMIT 1) as admin_username,
      (SELECT display_name FROM merchant_admins WHERE merchant_id=m.id LIMIT 1) as admin_display_name
      FROM merchants m ORDER BY m.code ASC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/super/merchants', requireSuperAdmin, async (req, res) => {
  try {
    const { name, code, username, password, contact_name, contact_phone, max_stores } = req.body || {};
    if (!name) return res.status(400).json({ error: '商户名称必填' });
    if (!username || !username.trim()) return res.status(400).json({ error: '登录账号必填' });
    const adminUsername = username.trim();
    // 检查用户名是否已存在
    const userExists = await getAsync('SELECT id FROM merchant_admins WHERE username=?', [adminUsername]);
    if (userExists) return res.status(400).json({ error: '登录账号已存在' });
    // 商户编码：用户自定义或自动生成
    let merchantCode = (code && code.trim()) ? code.trim() : '';
    if (merchantCode) {
      // 检查自定义编码是否已存在
      const codeExists = await getAsync('SELECT id FROM merchants WHERE code=?', [merchantCode]);
      if (codeExists) return res.status(400).json({ error: '商户编码已存在' });
    } else {
      // 自动生成商户编码：年份2位+月份2位+4位序号（每月重置），如 26090001
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const monthPrefix = yy + mm;
      // 查询当月已有商户数，序号从1开始递增
      const monthCountRow = await getAsync("SELECT COUNT(*) AS cnt FROM merchants WHERE code LIKE ?", [monthPrefix + '%']);
      let seq = monthCountRow.cnt + 1;
      let generatedCode, codeExists;
      do {
        generatedCode = monthPrefix + String(seq).padStart(4, '0');
        codeExists = await getAsync('SELECT id FROM merchants WHERE code=?', [generatedCode]);
        if (codeExists) seq++;
      } while (codeExists);
      merchantCode = generatedCode;
    }
    const result = await runAsync('INSERT INTO merchants (name, code, contact_name, contact_phone, max_stores, status) VALUES (?, ?, ?, ?, ?, 1)', [name, merchantCode, contact_name || '', contact_phone || '', max_stores || 1]);
    const newMerchantId = result.lastID;
    // 密码为空则自动生成8位随机密码
    let adminPassword = (password && password.trim()) ? password.trim() : '';
    if (!adminPassword) {
      const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let i = 0; i < 8; i++) adminPassword += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const adminHash = hashPassword(adminPassword);
    await runAsync('INSERT INTO merchant_admins (merchant_id, username, password_hash, display_name) VALUES (?, ?, ?, ?)', [newMerchantId, adminUsername, adminHash, name + '管理员']);
    // 为新商户初始化默认货币
    for (const currency of [
      ['USD', '$', '美元', 1, 1], ['CNY', '¥', '人民币', 7, 0], ['VND', '₫', '越南盾', 25000, 0],
      ['THB', '฿', '泰铢', 32, 0], ['KHR', '៛', '柬埔寨瑞尔', 4000, 0]
    ]) await runAsync('INSERT INTO currencies (merchant_id, code, symbol, name, rate, is_default) VALUES (?, ?, ?, ?, ?, ?)', [newMerchantId, ...currency]);
    // 自动创建默认店铺（确保商户登录后有自己的店铺，避免越权访问其他商户数据）
    const defaultStoreName = name + '总店';
    const defaultStoreCode = merchantCode.toLowerCase() + '-main';
    await runAsync('INSERT INTO stores (merchant_id, name, code, address, active) VALUES (?, ?, ?, ?, 1)', [newMerchantId, defaultStoreName, defaultStoreCode, '']);
    await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'create_merchant', 'merchant', newMerchantId,
      `创建商户「${name}」(编码: ${merchantCode}, 账号: ${adminUsername})`, getClientIp(req));
    res.json({ success: true, id: newMerchantId, adminUsername, defaultPassword: adminPassword });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/super/merchants/:id', requireSuperAdmin, async (req, res) => {
  try {
    const { name, username, password, contact_name, contact_phone, max_stores, status } = req.body || {};
    // 注意：商户编码(code)不允许修改，此处忽略该字段
    await runAsync('UPDATE merchants SET name=?, contact_name=?, contact_phone=?, max_stores=?, status=? WHERE id=?', [name, contact_name || '', contact_phone || '', max_stores || 1, status ?? 1, req.params.id]);
    // 查询该商户的主管理员（id最小的），只更新主管理员账号，避免覆盖商户后台创建的其他子管理员
    const primaryAdmin = await getAsync('SELECT id, username FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [req.params.id]);
    if (primaryAdmin) {
      // 更新登录账号（仅当提供了新账号且与当前值不同时）
      if (username && username.trim() && username.trim() !== primaryAdmin.username) {
        const exists = await getAsync('SELECT id FROM merchant_admins WHERE username=? AND id<>?', [username.trim(), primaryAdmin.id]);
        if (exists) return res.status(400).json({ error: '登录账号已被使用' });
        await runAsync('UPDATE merchant_admins SET username=? WHERE id=?', [username.trim(), primaryAdmin.id]);
      }
      // 更新主管理员密码（如果提供了非空密码）
      if (password && password.trim()) {
        const hash = hashPassword(password.trim());
        await runAsync('UPDATE merchant_admins SET password_hash=? WHERE id=?', [hash, primaryAdmin.id]);
      }
    }
    const updatedMerchant = await getAsync('SELECT name, code FROM merchants WHERE id=?', [req.params.id]);
    await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'update_merchant', 'merchant', req.params.id,
      `编辑商户「${updatedMerchant?.name || '未知'}」的信息`, getClientIp(req));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/super/merchants/:id', requireSuperAdmin, async (req, res) => {
  try {
    if (req.params.id === '1') return res.status(400).json({ error: '不能删除默认商户' });
    const merchant = await getAsync('SELECT * FROM merchants WHERE id=?', [req.params.id]);
    const storeIds = (await allAsync('SELECT id FROM stores WHERE merchant_id=?', [req.params.id])).map(s => s.id);
    await runAsync('DELETE FROM merchants WHERE id=?', [req.params.id]);
    await runAsync('DELETE FROM merchant_admins WHERE merchant_id=?', [req.params.id]);
    await runAsync('DELETE FROM stores WHERE merchant_id=?', [req.params.id]);
    await runAsync('DELETE FROM currencies WHERE merchant_id=?', [req.params.id]);
    await runAsync('DELETE FROM login_logs WHERE merchant_id=?', [req.params.id]);
    if (storeIds.length > 0) {
      const placeholders = storeIds.map(() => '?').join(',');
      for (const tbl of ['menus', 'tables', 'orders', 'waiters', 'printers', 'reservations', 'waiter_calls', 'scan_sessions', 'menu_categories']) {
        await runAsync(`DELETE FROM \`${tbl}\` WHERE store_id IN (${placeholders})`, storeIds);
      }
    }
    await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'delete_merchant', 'merchant', req.params.id,
      `删除商户「${merchant?.name || '未知'}」(编码: ${merchant?.code || '-'})`, getClientIp(req));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 重置商户管理员密码
app.post('/api/super/merchants/:id/reset-password', requireSuperAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    const newPwd = password || 'admin123';
    const hash = hashPassword(newPwd);
    await runAsync('UPDATE merchant_admins SET password_hash=? WHERE merchant_id=?', [hash, req.params.id]);
    const merchantForLog = await getAsync('SELECT name, code FROM merchants WHERE id=?', [req.params.id]);
    await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'reset_merchant_password', 'merchant', req.params.id,
      `重置商户「${merchantForLog?.name || '未知'}」的管理员密码`, getClientIp(req));
    res.json({ success: true, newPassword: newPwd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超级管理员仪表盘统计
app.get('/api/super/stats', requireSuperAdmin, async (req, res) => {
  try {
    const merchantCount = await getAsync('SELECT COUNT(*) as count FROM merchants');
    const storeCount = await getAsync('SELECT COUNT(*) as count FROM stores');
    const orderCount = await getAsync('SELECT COUNT(*) as count FROM orders');
    const todayOrders = await getAsync("SELECT COUNT(*) as count FROM orders WHERE DATE(createdAt)=CURDATE()");
    const todayRevenue = await getAsync("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE DATE(createdAt)=CURDATE() AND status='done'");
    // 在线客户端：当前未过期的扫码会话数
    const now = new Date().toISOString();
    const onlineClients = await getAsync('SELECT COUNT(*) as count FROM scan_sessions WHERE expires_at > ?', [now]);
    // 累计扫码连接总数
    const totalScanSessions = await getAsync('SELECT COUNT(*) as count FROM scan_sessions');
    // 今日新增扫码连接数
    const todayScanSessions = await getAsync("SELECT COUNT(*) as count FROM scan_sessions WHERE DATE(created_at)=CURDATE()");
    res.json({
      merchantCount: merchantCount.count,
      storeCount: storeCount.count,
      orderCount: orderCount.count,
      todayOrders: todayOrders.count,
      todayRevenue: Number(todayRevenue.total) || 0,
      onlineClients: onlineClients.count,
      totalScanSessions: totalScanSessions.count,
      todayScanSessions: todayScanSessions.count
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超级管理员：服务器负载监控
app.get('/api/super/server-stats', requireSuperAdmin, async (req, res) => {
  try {
    // CPU 使用率：两次采样计算差值
    function getCpuTimes() {
      const cpus = os.cpus();
      let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
      for (const cpu of cpus) {
        user += cpu.times.user;
        nice += cpu.times.nice;
        sys += cpu.times.sys;
        idle += cpu.times.idle;
        irq += cpu.times.irq;
      }
      return { user, nice, sys, idle, irq, total: user + nice + sys + idle + irq };
    }
    const start = getCpuTimes();
    await new Promise(r => setTimeout(r, 300));
    const end = getCpuTimes();
    const idleDiff = end.idle - start.idle;
    const totalDiff = end.total - start.total;
    const cpuUsage = totalDiff > 0 ? ((1 - idleDiff / totalDiff) * 100).toFixed(1) : 0;

    // 内存
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = ((usedMem / totalMem) * 100).toFixed(1);

    // 磁盘使用率（执行 df 命令，取根分区）
    let diskUsage = 0, diskTotal = 0, diskUsed = 0;
    try {
      const dfOutput = execSync('df -B1 / | tail -1', { encoding: 'utf8' }).trim().split(/\s+/);
      diskTotal = parseInt(dfOutput[1]) || 0;
      diskUsed = parseInt(dfOutput[2]) || 0;
      diskUsage = diskTotal > 0 ? ((diskUsed / diskTotal) * 100).toFixed(1) : 0;
    } catch (e) { diskUsage = 0; }

    // 系统运行时间
    const uptimeSeconds = os.uptime();
    const uptimeDays = Math.floor(uptimeSeconds / 86400);
    const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
    const uptimeMins = Math.floor((uptimeSeconds % 3600) / 60);

    // Node.js 进程内存
    const processMem = process.memoryUsage();

    // 负载均衡
    const loadAvg = os.loadavg();

    res.json({
      cpu: {
        usage: parseFloat(cpuUsage),
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || 'Unknown'
      },
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        usage: parseFloat(memUsage),
        processRss: processMem.rss,
        processHeapUsed: processMem.heapUsed,
        processHeapTotal: processMem.heapTotal
      },
      disk: {
        total: diskTotal,
        used: diskUsed,
        free: diskTotal - diskUsed,
        usage: parseFloat(diskUsage)
      },
      system: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        uptime: uptimeSeconds,
        uptimeFormatted: `${uptimeDays}天 ${uptimeHours}时 ${uptimeMins}分`,
        loadAvg: loadAvg.map(v => v.toFixed(2)),
        nodeVersion: process.version
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超级管理员：所有门店总览
app.get('/api/super/stores', requireSuperAdmin, async (req, res) => {
  try {
    const stores = await allAsync('SELECT s.*, m.name as merchant_name FROM stores s LEFT JOIN merchants m ON s.merchant_id = m.id ORDER BY s.id');
    res.json(stores);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超级管理员：所有登录日志
app.get('/api/super/login-logs', requireSuperAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const logs = await allAsync('SELECT l.*, m.name as merchant_name FROM login_logs l LEFT JOIN merchants m ON l.merchant_id = m.id ORDER BY l.id DESC LIMIT ?', [limit]);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超级管理员获取全局设置
app.get('/api/super/settings', requireSuperAdmin, async (req, res) => {
  try {
    const rows = await allAsync("SELECT `key`, value FROM settings WHERE `key` IN ('super_idle_timeout', 'admin_idle_timeout', 'qr_session_timeout', 'order_interval_seconds', 'waiter_refresh_interval', 'waiter_session_timeout', 'max_order_items', 'max_item_quantity', 'max_order_note_length', 'login_max_attempts', 'login_lock_minutes', 'super_ip_whitelist', 'call_limit_enabled', 'call_limit_max', 'call_limit_window_minutes', 'call_limit_cooldown_minutes', 'auto_clean_log_enabled', 'log_retention_days', 'clean_login_log', 'clean_audit_log')");
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({
      super_idle_timeout: parseInt(settings.super_idle_timeout || '60', 10),
      admin_idle_timeout: parseInt(settings.admin_idle_timeout || '30', 10),
      qr_session_timeout: parseInt(settings.qr_session_timeout || '45', 10),
      waiter_session_timeout: parseInt(settings.waiter_session_timeout || '12', 10),
      order_interval_seconds: parseInt(settings.order_interval_seconds || '30', 10),
      waiter_refresh_interval: parseInt(settings.waiter_refresh_interval || '8', 10),
      max_order_items: parseInt(settings.max_order_items || '50', 10),
      max_item_quantity: parseInt(settings.max_item_quantity || '100', 10),
      max_order_note_length: parseInt(settings.max_order_note_length || '200', 10),
      login_max_attempts: parseInt(settings.login_max_attempts || '5', 10),
      login_lock_minutes: parseInt(settings.login_lock_minutes || '15', 10),
      super_ip_whitelist: settings.super_ip_whitelist || '',
      call_limit_enabled: (settings.call_limit_enabled || '1') !== '0',
      call_limit_max: parseInt(settings.call_limit_max || '3', 10),
      call_limit_window_minutes: parseInt(settings.call_limit_window_minutes || '5', 10),
      call_limit_cooldown_minutes: parseInt(settings.call_limit_cooldown_minutes || '10', 10),
      auto_clean_log_enabled: (settings.auto_clean_log_enabled || '0') !== '0',
      log_retention_days: parseInt(settings.log_retention_days || '30', 10),
      clean_login_log: (settings.clean_login_log || '1') !== '0',
      clean_audit_log: (settings.clean_audit_log || '1') !== '0',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超级管理员更新全局设置
app.put('/api/super/settings', requireSuperAdmin, async (req, res) => {
  try {
    const { super_idle_timeout, admin_idle_timeout, qr_session_timeout, order_interval_seconds, waiter_refresh_interval, waiter_session_timeout, max_order_items, max_item_quantity, max_order_note_length, login_max_attempts, login_lock_minutes, super_ip_whitelist, call_limit_enabled, call_limit_max, call_limit_window_minutes, call_limit_cooldown_minutes, auto_clean_log_enabled, log_retention_days, clean_login_log, clean_audit_log } = req.body || {};
    if (super_idle_timeout !== undefined) {
      const mins = Math.max(1, Math.min(1440, parseInt(super_idle_timeout, 10) || 60));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('super_idle_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(mins), String(mins)]);
    }
    if (admin_idle_timeout !== undefined) {
      const mins = Math.max(1, Math.min(1440, parseInt(admin_idle_timeout, 10) || 30));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('admin_idle_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(mins), String(mins)]);
    }
    if (qr_session_timeout !== undefined) {
      const mins = Math.max(0, Math.min(1440, parseInt(qr_session_timeout, 10) || 0));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('qr_session_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(mins), String(mins)]);
    }
    if (waiter_session_timeout !== undefined) {
      const hours = Math.max(1, Math.min(168, parseInt(waiter_session_timeout, 10) || 12));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('waiter_session_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(hours), String(hours)]);
    }
    if (order_interval_seconds !== undefined) {
      const secs = Math.max(0, Math.min(3600, parseInt(order_interval_seconds, 10) || 30));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('order_interval_seconds', ?) ON DUPLICATE KEY UPDATE value=?", [String(secs), String(secs)]);
    }
    if (waiter_refresh_interval !== undefined) {
      const secs = Math.max(3, Math.min(300, parseInt(waiter_refresh_interval, 10) || 8));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('waiter_refresh_interval', ?) ON DUPLICATE KEY UPDATE value=?", [String(secs), String(secs)]);
    }
    if (max_order_items !== undefined) {
      const val = Math.max(1, Math.min(200, parseInt(max_order_items, 10) || 50));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('max_order_items', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (max_item_quantity !== undefined) {
      const val = Math.max(1, Math.min(999, parseInt(max_item_quantity, 10) || 100));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('max_item_quantity', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (max_order_note_length !== undefined) {
      const val = Math.max(10, Math.min(1000, parseInt(max_order_note_length, 10) || 200));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('max_order_note_length', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (login_max_attempts !== undefined) {
      const val = Math.max(1, Math.min(20, parseInt(login_max_attempts, 10) || 5));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('login_max_attempts', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (login_lock_minutes !== undefined) {
      const val = Math.max(1, Math.min(1440, parseInt(login_lock_minutes, 10) || 15));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('login_lock_minutes', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (super_ip_whitelist !== undefined) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('super_ip_whitelist', ?) ON DUPLICATE KEY UPDATE value=?", [String(super_ip_whitelist || ''), String(super_ip_whitelist || '')]);
    }
    if (call_limit_enabled !== undefined) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('call_limit_enabled', ?) ON DUPLICATE KEY UPDATE value=?", [call_limit_enabled ? '1' : '0', call_limit_enabled ? '1' : '0']);
    }
    if (call_limit_max !== undefined) {
      const val = Math.max(1, Math.min(20, parseInt(call_limit_max, 10) || 3));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('call_limit_max', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (call_limit_window_minutes !== undefined) {
      const val = Math.max(1, Math.min(60, parseInt(call_limit_window_minutes, 10) || 5));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('call_limit_window_minutes', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (call_limit_cooldown_minutes !== undefined) {
      const val = Math.max(1, Math.min(120, parseInt(call_limit_cooldown_minutes, 10) || 10));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('call_limit_cooldown_minutes', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (auto_clean_log_enabled !== undefined) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('auto_clean_log_enabled', ?) ON DUPLICATE KEY UPDATE value=?", [auto_clean_log_enabled ? '1' : '0', auto_clean_log_enabled ? '1' : '0']);
    }
    if (log_retention_days !== undefined) {
      const val = Math.max(1, Math.min(365, parseInt(log_retention_days, 10) || 30));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('log_retention_days', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (clean_login_log !== undefined) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('clean_login_log', ?) ON DUPLICATE KEY UPDATE value=?", [clean_login_log ? '1' : '0', clean_login_log ? '1' : '0']);
    }
    if (clean_audit_log !== undefined) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('clean_audit_log', ?) ON DUPLICATE KEY UPDATE value=?", [clean_audit_log ? '1' : '0', clean_audit_log ? '1' : '0']);
    }
    await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'update_settings', 'settings', null,
      '更新系统全局设置', getClientIp(req));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超级管理员：操作审计日志
app.get('/api/super/audit-logs', requireSuperAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const logs = await allAsync('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', [limit]);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超级管理员登出
app.post('/api/super/logout', requireSuperAdmin, async (req, res) => {
  try {
    if (req.superSessionToken) {
      await runAsync('DELETE FROM super_sessions WHERE token=?', [req.superSessionToken]).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超级管理员修改密码
app.post('/api/super/change-password', requireSuperAdmin, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ error: '请输入旧密码和新密码' });
    if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少6位' });
    if (!verifyPassword(oldPassword, req.superAdmin.password_hash)) {
      return res.status(401).json({ error: '旧密码错误' });
    }
    const hash = hashPassword(newPassword);
    await runAsync('UPDATE super_admins SET password_hash=? WHERE id=?', [hash, req.superAdmin.id]);
    await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'change_password', 'super_admin', req.superAdmin.id, '修改超级管理员登录密码', getClientIp(req));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 商户管理员登出
app.post('/api/admin/logout', requireAdminKey, async (req, res) => {
  try {
    if (req.adminSessionToken) {
      await runAsync('DELETE FROM admin_sessions WHERE token=?', [req.adminSessionToken]).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/login-logs', requireAdminKey, async (req, res) => {
  try {
    const merchantId = req.merchantId || 1;
    const rows = await allAsync('SELECT * FROM login_logs WHERE merchant_id = ? ORDER BY id DESC LIMIT 200', [merchantId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 服务员登录 -----
app.post('/api/waiter/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username || '', 'waiter', '请输入账号和密码']);
      return res.status(400).json({ error: '请输入服务员账号和密码' });
    }
    // 登录限流检查
    const lockStatus = await isLoginLocked(username, 'waiter');
    if (lockStatus.locked) {
      return res.status(429).json({ error: `登录失败次数过多，请${lockStatus.remaining}分钟后再试` });
    }
    const waiter = await getAsync('SELECT * FROM waiters WHERE username=? AND active=1', [String(username).trim()]);
    if (!waiter) {      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'waiter', '账号不存在']);
      recordLoginAttempt(username, 'waiter');
      return res.status(401).json({ error: '服务员账号或密码错误' });
    }
    if (!verifyPassword(password, waiter.password_hash)) {      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, merchant_id, login_type, message) VALUES (?, 0, ?, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, waiter.merchant_id, 'waiter', '密码错误']);
      recordLoginAttempt(username, 'waiter');
      return res.status(401).json({ error: '服务员账号或密码错误' });
    }
    resetLoginAttempts(username, 'waiter');
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, merchant_id, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, waiter.merchant_id, 'waiter', '服务员登录成功']);
    const token = crypto.randomBytes(24).toString('base64url');
    const waiterTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'waiter_session_timeout'");
    const waiterTimeoutHours = parseInt(waiterTimeoutSetting?.value || '12', 10);
    const expiresAt = new Date(Date.now() + waiterTimeoutHours * 60 * 60 * 1000).toISOString();
    await runAsync('INSERT INTO waiter_sessions (waiter_id, token, expires_at) VALUES (?, ?, ?)', [waiter.id, token, expiresAt]);
    const store = await getAsync('SELECT name FROM stores WHERE id=?', [waiter.store_id || 1]);
    res.json({ token, storeId: waiter.store_id || 1, storeName: store?.name || '', waiter: { id: waiter.id, username: waiter.username, display_name: waiter.display_name, can_order: waiter.can_order, can_mark_item: waiter.can_mark_item, can_complete_order: waiter.can_complete_order, store_id: waiter.store_id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 服务员概览 -----
app.get('/api/waiter/overview', async (req, res) => {
  try {
    const waiter = await getWaiterFromRequest(req);
    if (!waiter) return res.status(401).json({ error: '请先登录服务员账号' });
    const storeId = waiter.store_id || 1;
    const store = await getAsync('SELECT name FROM stores WHERE id=?', [storeId]);
    const tables = await allAsync('SELECT * FROM tables WHERE store_id=? ORDER BY id', [storeId]);
    const rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND status != 'canceled' ORDER BY createdAt DESC", [storeId]);
    res.json({ waiter, storeName: store?.name || '', tables, orders: rows.map(formatOrder) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 服务员管理（管理员）-----
app.get('/api/admin/waiters', requireAdminKey, async (req, res) => {
  try {
    const rows = await allAsync('SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE store_id=? ORDER BY id', [req.storeId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/waiters', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const { username, password, display_name, can_order, can_mark_item, can_complete_order, store_id } = req.body || {};
    if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写服务员资料' });
    const targetStoreId = store_id || req.storeId || 1;
    const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [targetStoreId, req.merchantId]);
    if (!store) return res.status(400).json({ error: '店铺不存在' });
    const result = await runAsync(
      'INSERT INTO waiters (username, password_hash, display_name, can_order, can_mark_item, can_complete_order, store_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [String(username).trim(), hashPassword(password), display_name, can_order ? 1 : 0, can_mark_item ? 1 : 0, can_complete_order ? 1 : 0, targetStoreId]
    );
    res.status(201).json(await getAsync('SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE id=?', [result.lastID]));
  } catch (e) {
    if (String(e.message).includes('Duplicate entry')) return res.status(409).json({ error: '服务员账号已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/waiters/:id', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync('SELECT * FROM waiters WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!current) return res.status(404).json({ error: '服务员不存在' });
    const next = { ...current, ...req.body };
    await runAsync(
      'UPDATE waiters SET username=?, display_name=?, can_order=?, can_mark_item=?, can_complete_order=?, active=? WHERE id=? AND store_id=?',
      [String(next.username||current.username).trim(), next.display_name||current.display_name, next.can_order?1:0, next.can_mark_item?1:0, next.can_complete_order?1:0, next.active?1:0, id, req.storeId]
    );
    if (req.body.password) await runAsync('UPDATE waiters SET password_hash=? WHERE id=? AND store_id=?', [hashPassword(req.body.password), id, req.storeId]);
    res.json(await getAsync('SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE id=? AND store_id=?', [id, req.storeId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/waiters/:id', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync('SELECT id FROM waiters WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!current) return res.status(404).json({ error: '服务员不存在' });
    await runAsync('DELETE FROM waiters WHERE id=? AND store_id=?', [id, req.storeId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 店铺管理 -----
app.get('/api/admin/stores', requireAdminKey, async (req, res) => {
  try {
    res.json(await allAsync('SELECT * FROM stores WHERE merchant_id=? ORDER BY id', [req.merchantId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/stores', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const { name, code, address } = req.body || {};
    if (!name) return res.status(400).json({ error: '店铺名称必填' });
    // 门店数量限制校验
    const merchantId = req.merchantId || 1;
    const merchant = await getAsync('SELECT * FROM merchants WHERE id=?', [merchantId]);
    const storeCount = await getAsync('SELECT COUNT(*) as count FROM stores WHERE merchant_id=?', [merchantId]);
    if (merchant && storeCount.count >= merchant.max_stores) {
      return res.status(403).json({ error: '已达到门店数量上限（' + merchant.max_stores + '家），请联系超级管理员升级' });
    }
    const result = await runAsync('INSERT INTO stores (name, code, address, active, merchant_id) VALUES (?, ?, ?, 1, ?)', [name, code || '', address || '', merchantId]);
    res.status(201).json(await getAsync('SELECT * FROM stores WHERE id=?', [result.lastID]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/stores/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [id, req.merchantId]);
    if (!current) return res.status(404).json({ error: '店铺不存在' });
    const qrLanguages = req.body.qr_languages !== undefined ? (req.body.qr_languages || null) : current.qr_languages;
    await runAsync('UPDATE stores SET name=?, code=?, address=?, active=?, qr_languages=? WHERE id=? AND merchant_id=?', [req.body.name || current.name, req.body.code || current.code, req.body.address ?? current.address, req.body.active === undefined ? current.active : (req.body.active ? 1 : 0), qrLanguages, id, req.merchantId]);
    res.json(await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [id, req.merchantId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/stores/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [id, req.merchantId]);
    if (!current) return res.status(404).json({ error: '店铺不存在' });
    if (id === 1) return res.status(400).json({ error: '默认总店不能删除' });
    await runAsync('DELETE FROM stores WHERE id=? AND merchant_id=?', [id, req.merchantId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/stores/:id/copy-menu', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const targetStoreId = parseInt(req.params.id);
    // 校验目标店铺属于当前商户
    const targetStore = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [targetStoreId, req.merchantId]);
    if (!targetStore) return res.status(404).json({ error: '店铺不存在' });
    // 源店铺：当前商户的第一个店铺（总店）
    const sourceStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [req.merchantId]);
    if (!sourceStore) return res.status(400).json({ error: '未找到源店铺' });
    const sourceStoreId = sourceStore.id;
    if (targetStoreId === sourceStoreId) return res.status(400).json({ error: '总店无需复制自身' });
    const sourceMenus = await allAsync('SELECT * FROM menus WHERE store_id = ? AND merchant_id=?', [sourceStoreId, req.merchantId]);
    if (sourceMenus.length === 0) return res.status(404).json({ error: '总店暂无菜品可复制' });
    const existingMenus = await allAsync('SELECT name FROM menus WHERE store_id = ?', [targetStoreId]);
    const existingNames = new Set(existingMenus.map(m => m.name));
    const menusToCopy = sourceMenus.filter(menu => !existingNames.has(menu.name));
    if (menusToCopy.length === 0) return res.json({ success: true, copied: 0, message: '目标店铺已包含全部菜品，无需复制' });
    const uploadDir = UPLOAD_DIR;
    let copiedCount = 0;
    for (const menu of menusToCopy) {
      let newImage = '';
      if (menu.image) {
        const srcPath = path.join(uploadDir, menu.image);
        if (fs.existsSync(srcPath)) {
          const ext = path.extname(menu.image);
          const newFilename = Date.now() + '_' + Math.random().toString(36).slice(2,6) + ext;
          const destPath = path.join(uploadDir, newFilename);
          fs.copyFileSync(srcPath, destPath);
          newImage = newFilename;
        }
      }
      await runAsync(
        `INSERT INTO menus (name, emoji, price, category, \`desc\`, image, currency_code, name_en, desc_en, active, unit, show_dual, secondary_currency_code, store_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          menu.name, menu.emoji, menu.price, menu.category, menu.desc,
          newImage || menu.image,
          menu.currency_code || 'USD',
          menu.name_en || '', menu.desc_en || '',
          menu.active !== undefined ? menu.active : 1,
          menu.unit || '份',
          menu.show_dual || 0,
          menu.secondary_currency_code || '',
          targetStoreId
        ]
      );
      copiedCount++;
    }
    res.json({ success: true, copied: copiedCount, skipped: sourceMenus.length - copiedCount, message: `成功复制 ${copiedCount} 道菜品` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 菜单 -----
app.get('/api/menu', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || '1', 10);
    const rows = await allAsync('SELECT * FROM menus WHERE active = 1 AND store_id = ? ORDER BY id', [storeId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/menu', requireAdminKey, async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM menus WHERE store_id=? ORDER BY id', [req.storeId || 1]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/menu', requireAdminKey, requirePermission('can_manage_menu'), upload.single('image'), async (req, res) => {
  try {
    const { name, emoji, price, category, desc, name_en, desc_en, unit, show_dual, secondary_currency_code, currency_code = 'USD' } = req.body;
    if (!name || !price) return res.status(400).json({ error: '名称和价格必填' });
    const currency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [currency_code, req.merchantId]);
    if (!currency) return res.status(400).json({ error: '货币类型不存在' });
    const image = req.file ? req.file.filename : '';
    const result = await runAsync(
      'INSERT INTO menus (name, emoji, price, category, `desc`, image, currency_code, name_en, desc_en, unit, show_dual, secondary_currency_code, store_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, emoji || '🍽️', parseFloat(price), category || '其他', desc || '', image, currency_code, name_en || '', desc_en || '', unit || '份', show_dual ? 1 : 0, secondary_currency_code || '', req.storeId || 1]
    );
    const newItem = await getAsync('SELECT * FROM menus WHERE id = ?', [result.lastID]);
    res.status(201).json(newItem);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/menu/:id', requireAdminKey, requirePermission('can_manage_menu'), upload.single('image'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, emoji, price, category, desc, name_en, desc_en, unit, show_dual, secondary_currency_code, currency_code } = req.body;
    const current = await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!current) return res.status(404).json({ error: '菜品不存在' });
    const nextCurrency = currency_code || current.currency_code || 'USD';
    const currency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [nextCurrency, req.merchantId]);
    if (!currency) return res.status(400).json({ error: '货币类型不存在' });
    let image = req.file ? req.file.filename : current.image;
    if (req.file && current.image) {
      const oldPath = path.join(__dirname, 'uploads', current.image);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await runAsync(
      'UPDATE menus SET name=?, emoji=?, price=?, category=?, `desc`=?, image=?, currency_code=?, name_en=?, desc_en=?, unit=?, show_dual=?, secondary_currency_code=? WHERE id=? AND store_id=?',
      [name || current.name, emoji || current.emoji, Number.isFinite(Number(price)) ? Number(price) : current.price, category || current.category, desc ?? current.desc, image, nextCurrency, name_en ?? current.name_en ?? '', desc_en ?? current.desc_en ?? '', unit || current.unit || '份', show_dual === undefined ? (current.show_dual || 0) : (show_dual ? 1 : 0), secondary_currency_code ?? current.secondary_currency_code ?? '', id, req.storeId]
    );
    const updated = await getAsync('SELECT * FROM menus WHERE id = ?', [id]);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/menu/:id', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const item = await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!item) return res.status(404).json({ error: '菜品不存在' });
    if (item.image) {
      const imgPath = path.join(__dirname, 'uploads', item.image);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
    await runAsync('DELETE FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/menu/:id/status', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const item = await getAsync('SELECT id FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!item) return res.status(404).json({ error: '菜品不存在' });
    const active = req.body.active ? 1 : 0;
    await runAsync('UPDATE menus SET active=? WHERE id=? AND store_id=?', [active, id, req.storeId]);
    res.json(await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 菜品分类 -----
app.get('/api/menu-categories', requireAdminKey, async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM menu_categories WHERE store_id=? ORDER BY sort, id', [req.storeId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/menu-categories', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: '分类名称必填' });
    const maxSort = await getAsync('SELECT MAX(sort) as max FROM menu_categories WHERE store_id=?', [req.storeId]);
    const nextSort = (maxSort && maxSort.max !== null) ? maxSort.max + 1 : 0;
    const result = await runAsync('INSERT INTO menu_categories (name, sort, store_id) VALUES (?, ?, ?)', [name, nextSort, req.storeId]);
    const row = await getAsync('SELECT * FROM menu_categories WHERE id = ? AND store_id = ?', [result.lastID, req.storeId]);
    res.status(201).json(row);
  } catch (e) {
    if (String(e.message).includes('Duplicate entry')) return res.status(409).json({ error: '分类已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/menu-categories/:id', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: '分类名称必填' });
    const current = await getAsync('SELECT name FROM menu_categories WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!current) return res.status(404).json({ error: '分类不存在' });
    await withTransaction(async () => {
      await runAsync('UPDATE menu_categories SET name=? WHERE id=? AND store_id=?', [name, id, req.storeId]);
      await runAsync('UPDATE menus SET category=? WHERE category=? AND store_id=?', [name, current.name, req.storeId]);
    });
    res.json(await getAsync('SELECT * FROM menu_categories WHERE id = ? AND store_id = ?', [id, req.storeId]));
  } catch (e) {
    if (String(e.message).includes('Duplicate entry')) return res.status(409).json({ error: '分类已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/menu-categories/:id', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync('SELECT name FROM menu_categories WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!current) return res.status(404).json({ error: '分类不存在' });
    const remaining = await getAsync("SELECT name FROM menu_categories WHERE id != ? AND store_id = ? ORDER BY sort, id LIMIT 1", [id, req.storeId]);
    let fallback = remaining ? remaining.name : '其他';
    await withTransaction(async () => {
      if (!remaining) await runAsync("INSERT IGNORE INTO menu_categories (name, sort, store_id) VALUES ('其他', 0, ?)", [req.storeId]);
      await runAsync('DELETE FROM menu_categories WHERE id = ? AND store_id = ?', [id, req.storeId]);
      await runAsync('UPDATE menus SET category=? WHERE category=? AND store_id=?', [fallback, current.name, req.storeId]);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/menu-categories/sort', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
    await withTransaction(async () => {
      for (let i = 0; i < ids.length; i++) {
        await runAsync('UPDATE menu_categories SET sort = ? WHERE id = ? AND store_id = ?', [i, ids[i], req.storeId]);
      }
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 桌号 -----
app.get('/api/tables', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || req.get('X-Store-Id') || '1', 10);
    const rows = await allAsync('SELECT * FROM tables WHERE store_id=? ORDER BY id', [storeId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tables', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
  try {
    const { name, status } = req.body;
    if (!name) return res.status(400).json({ error: '桌号名称必填' });
    const result = await runAsync(
      'INSERT INTO tables (name, status, store_id) VALUES (?, ?, ?)',
      [name, status || 'available', req.storeId || 1]
    );
    await runAsync('UPDATE tables SET qr_token=? WHERE id=?', [createTableToken(), result.lastID]);
    const newTable = await getAsync('SELECT * FROM tables WHERE id = ?', [result.lastID]);
    res.status(201).json(newTable);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/orders/:id/items/:index', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const index = parseInt(req.params.index);
    
    // 1. 查询订单
    const row = await getAsync('SELECT * FROM orders WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    
    // 2. 权限检查
    const orderStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    if (row.store_id !== orderStoreId) return res.status(403).json({ error: '无权操作此订单' });
    if (!req.isAdmin && req.waiter && !req.waiter.can_mark_item) return res.status(403).json({ error: '该服务员没有标记菜品权限' });
    if (row.status === 'done') return res.status(409).json({ error: '已结算订单不能修改菜品状态' });
    
    // 3. 解析 items（与 formatOrder 一致）
    let items = row.items;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch (e) {
        console.error(`订单 ${id} 的 items 解析失败:`, items, e);
        items = [];
      }
    } else if (!Array.isArray(items)) {
      items = [];
    }
    
    // 4. 校验序号
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: `该订单暂无菜品，无法切换状态（订单ID: ${id}）` });
    }
    if (index < 0 || index >= items.length) {
      return res.status(400).json({ 
        error: `菜品序号无效，当前共 ${items.length} 道菜品，请求序号 ${index}（从0开始）`
      });
    }
    
    // 5. 检查是否已完成
    if (items[index].itemStatus === 'done' && req.body.itemStatus !== 'done') {
      return res.status(409).json({ error: '已完成菜品不能改回制作中' });
    }
    
    // 6. 更新状态
    const nextStatus = req.body.itemStatus === 'done' ? 'done' : 'pending';
    items[index].itemStatus = nextStatus;
    await runAsync('UPDATE orders SET items=? WHERE id=?', [JSON.stringify(items), id]);
    
    // 7. 返回更新后的订单
    const updatedRow = await getAsync('SELECT * FROM orders WHERE id = ?', [id]);
    res.json(formatOrder(updatedRow));
    
  } catch (e) {
    console.error('切换菜品状态失败:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/tables/:id', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await getAsync('SELECT * FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!existing) return res.status(404).json({ error: '桌号不存在' });
    const newName = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
    const newStatus = req.body.status || existing.status;
    if (!newName) return res.status(400).json({ error: '桌号名称不能为空' });
    if (!['available', 'occupied', 'reserved'].includes(newStatus)) {
      return res.status(400).json({ error: '无效的桌号状态' });
    }
    try {
      await runAsync('UPDATE tables SET name=?, status=? WHERE id=? AND store_id=?', [newName, newStatus, id, req.storeId]);
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: '该桌号名称已存在，请换一个' });
      }
      throw e;
    }
    if (newName !== existing.name) {
      // 桌号改名后，同步更新该桌尚未结算的订单的桌号，避免改名后订单与桌号对不上；
      // 已结算的历史订单保留原桌号，便于对账。
      await runAsync("UPDATE orders SET table_name=? WHERE table_name=? AND store_id=? AND status='pending'", [newName, existing.name, req.storeId]);
    }
    const updated = await getAsync('SELECT * FROM tables WHERE id = ?', [id]);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tables/:id', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await getAsync('SELECT * FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!existing) return res.status(404).json({ error: '桌号不存在' });
    const orderCount = await getAsync("SELECT COUNT(*) AS count FROM orders WHERE table_name = ? AND store_id = ? AND status != 'canceled'", [existing.name, req.storeId]);
    if (orderCount.count > 0) return res.status(409).json({ error: '该桌仍有未完成订单，不能删除' });
    await runAsync('DELETE FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 订单 -----
app.get('/api/orders', requireAdminOrWaiter, async (req, res) => {
  try {
    let storeId;
    if (req.isAdmin) {
      storeId = req.storeId || 1;
    } else {
      storeId = req.waiterStoreId || 1;
    }
    const status = req.query.status;
    let sql = 'SELECT * FROM orders WHERE store_id=?';
    const params = [storeId];
    if (status) {
      sql += ' AND status=?';
      params.push(status);
    }
    sql += ' ORDER BY createdAt DESC';
    const rows = await allAsync(sql, params);
    const formatted = rows.map(formatOrder);
    res.json(formatted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders/:id(\\d+)', requireAdminOrWaiter, async (req, res) => {
  try {
    const orderStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const row = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [req.params.id, orderStoreId]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    res.json(formatOrder(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const table = await assertTableExists(req.body.table, req.storeId || 1);
    const tableStore = await getAsync('SELECT store_id FROM tables WHERE name=? AND store_id=?', [table, req.storeId || 1]);
    const storeId = tableStore?.store_id || 1;
    // 支持两种认证方式：Authorization Bearer token（管理员）和 X-Admin-Key（旧版兼容）
    const adminAuth = await authenticateAdmin(req);
    const adminKey = req.get('X-Admin-Key');
    const keySetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_access_key'");
    const isAdmin = Boolean((adminAuth && !adminAuth.error) || (adminKey && keySetting && adminKey === keySetting.value));
    if (adminAuth && !adminAuth.error) {
      req.adminId = adminAuth.adminId;
      req.merchantId = adminAuth.merchantId;
      req.storeId = adminAuth.storeId;
      // 管理员下单权限检查（主管理员除外）
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=?', [req.adminId]);
      if (admin) {
        const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [req.merchantId]);
        const isPrimaryAdmin = primaryAdmin && primaryAdmin.id === admin.id;
        if (!isPrimaryAdmin && !admin.can_manage_order) {
          return res.status(403).json({ error: '没有下单权限' });
        }
      }
    }
    const waiter = await getWaiterFromRequest(req);
    const isWaiter = Boolean(waiter && waiter.can_order);
    if (waiter && !waiter.can_order) return res.status(403).json({ error: '该服务员没有下单权限' });
    if (isWaiter && waiter.store_id !== storeId) return res.status(403).json({ error: '不能为其他店铺的桌号下单' });
    let sessionToken = null;
    let sessionStoreId = null;
    if (!isAdmin && !isWaiter) {
      const token = req.body.sessionToken || null;
      if (!token) return res.status(401).json({ error: '请重新扫码后再下单' });
      const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [token]);
      if (!session) return res.status(401).json({ error: '请重新扫码后再下单' });
      if (new Date(session.expires_at).getTime() < Date.now()) return res.status(410).json({ error: '二维码已过期，请重新扫码' });
      if (session.table_name !== table) return res.status(403).json({ error: '扫码桌号与下单桌号不一致' });
      sessionStoreId = session.store_id || 1;
      sessionToken = token;
    }
    // 确定最终的storeId：优先使用session中的store_id，其次使用桌号查询的store_id
    const finalStoreId = sessionStoreId || storeId;
    const cooldownKey = sessionToken || table;
    const now = Date.now();
    const canSubmit = await checkAndSetCooldown(cooldownKey, 3000);
    if (!canSubmit) {
      return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
    }
    const cooldownMs = await getOrderCooldownMs();
    const lastSubmission = orderSubmissionCooldown.get(cooldownKey) || 0;
    if (cooldownMs > 0 && now - lastSubmission < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - (now - lastSubmission)) / 1000);
      return res.status(429).json({ error: `下单过于频繁，请等待${waitSec}秒后再试` });
    }
    const items = await normalizeOrderItems(req.body.items, finalStoreId);
    const maxItemsRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_order_items'");
    const maxItems = parseInt(maxItemsRow?.value || '50', 10);
    if (items.length > maxItems) return res.status(400).json({ error: `单次下单菜品数量不能超过${maxItems}种` });
    const maxQtyRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_item_quantity'");
    const maxQty = parseInt(maxQtyRow?.value || '100', 10);
    for (const item of items) {
      if (Number(item.quantity) > maxQty) return res.status(400).json({ error: `单个菜品数量不能超过${maxQty}份` });
    }
    orderSubmissionCooldown.set(cooldownKey, now);
    const calculatedTotal = items.reduce((sum, item) => sum + (Number(item.base_price) || Number(item.price)) * item.quantity, 0);
    const itemsJson = JSON.stringify(items);
    const createdAt = new Date().toISOString();
    // 顾客备注：仅接受字符串，去除首尾空白，限制长度，防止异常输入
    let note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    const maxNoteRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_order_note_length'");
    const maxNoteLen = parseInt(maxNoteRow?.value || '200', 10);
    if (note.length > maxNoteLen) note = note.slice(0, maxNoteLen);
    const result = await runAsync(
      'INSERT INTO orders (table_name, items, total, status, createdAt, session_token, store_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [table, itemsJson, calculatedTotal, 'pending', createdAt, sessionToken, finalStoreId, note]
    );
    // 二维码无操作过期：下单后重置session过期时间（从下单时间开始重新计算）
    if (sessionToken) {
      try {
        const qrTimeoutRow = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
        const qrTimeoutMins = parseInt(qrTimeoutRow?.value || '45', 10);
        if (qrTimeoutMins > 0) {
          const newExpires = new Date(Date.now() + qrTimeoutMins * 60 * 1000).toISOString();
          await runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [newExpires, sessionToken]);
        }
      } catch (e) {}
    }
    // 更新菜品销量
    for (const item of items) {
      if (item.id) {
        await runAsync('UPDATE menus SET sales_count = sales_count + ? WHERE id = ? AND store_id = ?', [Number(item.quantity) || 1, item.id, finalStoreId]);
      }
    }
    const newRow = await getAsync('SELECT * FROM orders WHERE id = ?', [result.lastID]);
    await syncTableStatus(table, finalStoreId);
    // 返回新的session过期时间，供前端同步
    // 自动打印小票
    try {
      const autoPrintRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`auto_print_receipt_${finalStoreId}`]);
      const autoPrintEnabled = !autoPrintRow || autoPrintRow.value === '1' || autoPrintRow.value === 'true'; // 默认开启
      if (autoPrintEnabled) {
        const defaultPrinter = await getAsync('SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1', [finalStoreId]);
        if (defaultPrinter && defaultPrinter.type === 'network' && defaultPrinter.ip_address) {
          const storeInfo = await getAsync('SELECT * FROM stores WHERE id=?', [finalStoreId]);
          const printData = buildReceipt(newRow, storeInfo, defaultPrinter);
          try {
            await printToNetworkPrinter(printData, defaultPrinter.ip_address, defaultPrinter.port);

          } catch (printErr) {
            console.error(`[AutoPrint] Failed to print order #${newRow.id}:`, printErr.message);
          }
        }
      }
    } catch (autoPrintErr) {
      console.error('[AutoPrint] Error:', autoPrintErr.message);
    }

    const responseData = { success: true, orderId: newRow.id, order: formatOrder(newRow) };
    if (sessionToken) {
      const updatedSession = await getAsync('SELECT expires_at FROM scan_sessions WHERE token=?', [sessionToken]);
      if (updatedSession) responseData.newExpiresAt = updatedSession.expires_at;
    }
    res.status(201).json(responseData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/orders/:id(\\d+)', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = req.params.id;
    const { table, items, status, note } = req.body;
    const orderStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const existing = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, orderStoreId]);
    if (!existing) return res.status(404).json({ error: '订单不存在' });
    if (existing.status === 'done') return res.status(409).json({ error: '已完成订单不能编辑' });
    // 管理员修改订单需要 can_edit_order 权限
    if (req.isAdmin && !req.isPrimaryAdmin && !(req.adminPermissions && req.adminPermissions.can_edit_order)) {
      return res.status(403).json({ error: '无权修改订单' });
    }

    // 解析现有 items（与 formatOrder 一致）
    let currentItems = existing.items;
    if (typeof currentItems === 'string') {
      try { currentItems = JSON.parse(currentItems); } catch (_) { currentItems = []; }
    } else if (!Array.isArray(currentItems)) {
      currentItems = [];
    }

    // 如果请求中没有 items，则保留当前 items；否则使用新的（需要规范化和验证）
    let newItems = [];
    if (items === undefined || items === null) {
      newItems = currentItems;
    } else {
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'items 必须是数组' });
      }
      if (items.length === 0) {
        newItems = [];
      } else {
        // 规范化新 items（从菜单中获取最新价格等信息）
        newItems = await normalizeOrderItems(items, orderStoreId);
        // 保留原有的 itemStatus（如果前端传了）
        for (let i = 0; i < newItems.length; i++) {
          if (items[i] && (items[i].itemStatus === 'done' || items[i].itemStatus === 'pending')) {
            newItems[i].itemStatus = items[i].itemStatus;
          }
        }
      }
    }

    // 计算总价
    const calculatedTotal = newItems.reduce((sum, item) => sum + (Number(item.base_price) || Number(item.price)) * item.quantity, 0);

    // 管理员操作订单需要can_manage_order权限（服务员不受此限制，走自己的权限位）
    if (req.isAdmin && !req.isPrimaryAdmin && !(req.adminPermissions && req.adminPermissions.can_edit_order)) {
      return res.status(403).json({ error: '没有订单修改权限' });
    }
    // 如果状态要改为 done，检查服务员权限和是否所有菜品都已完成
    if (status === 'done') {
      if (!req.isAdmin && req.waiter && !req.waiter.can_complete_order) {
        return res.status(403).json({ error: '该服务员没有结算订单权限' });
      }
      if (newItems.some(item => item.itemStatus !== 'done')) {
        return res.status(409).json({ error: '存在未完成菜品，请先完成或删除该菜品后再结算订单' });
      }
    }

    // 处理桌号更新
    const nextTable = table === undefined ? existing.table_name : await assertTableExists(table, req.storeId);

    // 序列化 items 为 JSON 字符串存储
    const itemsJson = JSON.stringify(newItems);

    // 处理备注更新（未传则保留原值）
    let nextNote = existing.note || '';
    if (typeof note === 'string') {
      nextNote = note.trim().slice(0, 200);
    }

    // 更新订单
    await runAsync(
      'UPDATE orders SET table_name=?, items=?, total=?, status=?, note=? WHERE id=?',
      [nextTable, itemsJson, calculatedTotal, status || existing.status, nextNote, id]
    );

    const updatedRow = await getAsync('SELECT * FROM orders WHERE id = ?', [id]);
    await syncTableStatus(nextTable, req.storeId);
    if (nextTable !== existing.table_name) await syncTableStatus(existing.table_name, req.storeId);

    res.json(formatOrder(updatedRow));
  } catch (e) {
    console.error('更新订单失败:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/orders/:id(\\d+)', requireAdminKey, requirePermission('can_delete_order'), async (req, res) => {
  try {
    const id = req.params.id;
    const { password } = req.body || {};
    if (!password || !(await verifyLegacyAdminPassword(password))) {
      return res.status(401).json({ error: '管理员密码验证失败' });
    }
    const existing = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!existing) return res.status(404).json({ error: '订单不存在' });
    const result = await runAsync('DELETE FROM orders WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (result.changes === 0) return res.status(404).json({ error: '订单不存在' });
    if (existing) await syncTableStatus(existing.table_name, existing.store_id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 呼叫服务员（含次数限制） -----
app.post('/api/public/call-waiter', async (req, res) => {
  try {
    const { table, sessionToken } = req.body || {};
    if (!table) return res.status(400).json({ error: '桌号不能为空' });
    // 通过 sessionToken 获取 store_id，无 token 时兜底为 1
    let callStoreId = req.storeId || 1;
    if (sessionToken) {
      const session = await getAsync('SELECT store_id FROM scan_sessions WHERE token=?', [sessionToken]);
      if (session) callStoreId = session.store_id || 1;
    }
    const tableRow = await getAsync('SELECT id, store_id FROM tables WHERE name=? AND store_id=?', [table, callStoreId]);
    if (!tableRow) return res.status(404).json({ error: '桌号不存在' });
    // 读取呼叫限制配置
    const limitRows = await allAsync("SELECT `key`, value FROM settings WHERE `key` IN ('call_limit_enabled','call_limit_max','call_limit_window_minutes','call_limit_cooldown_minutes')");
    const limitCfg = {};
    limitRows.forEach(r => { limitCfg[r.key] = r.value; });
    const limitEnabled = (limitCfg.call_limit_enabled || '1') !== '0';
    const maxCalls = parseInt(limitCfg.call_limit_max || '3', 10);
    const windowMinutes = parseInt(limitCfg.call_limit_window_minutes || '5', 10);
    const cooldownMinutes = parseInt(limitCfg.call_limit_cooldown_minutes || '10', 10);
    if (limitEnabled) {
      // 查询时间窗口内该桌号的呼叫次数
      const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
      const countRow = await getAsync(
        "SELECT COUNT(*) AS cnt FROM waiter_calls WHERE table_name=? AND store_id=? AND (type='call' OR type='' OR type IS NULL) AND created_at >= ?",
        [table, tableRow.store_id, windowStart]
      );
      const callCount = countRow?.cnt || 0;
      if (callCount >= maxCalls) {
        // 查询最后一次呼叫时间，计算剩余冷却时间
        const lastCall = await getAsync(
          "SELECT created_at FROM waiter_calls WHERE table_name=? AND store_id=? AND (type='call' OR type='' OR type IS NULL) ORDER BY created_at DESC LIMIT 1",
          [table, tableRow.store_id]
        );
        let cooldownRemaining = cooldownMinutes;
        if (lastCall) {
          const elapsed = (Date.now() - new Date(lastCall.created_at).getTime()) / 60000;
          cooldownRemaining = Math.max(0, Math.ceil(cooldownMinutes - elapsed));
        }
        return res.status(429).json({ error: '呼叫过于频繁', cooldownMinutes: cooldownRemaining });
      }
    }
    const callId = crypto.randomBytes(8).toString('hex');
    await runAsync(
      'INSERT INTO waiter_calls (id, table_name, store_id, session_token, status, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [callId, table, tableRow.store_id, sessionToken || '', 'pending', 'call', new Date().toISOString()]
    );
    res.json({ success: true, callId, message: '已通知服务员' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 获取呼叫列表（服务员/管理员） -----
app.get('/api/waiter-calls', requireAdminOrWaiter, async (req, res) => {
  try {
    const storeId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const rows = await allAsync(
      'SELECT * FROM waiter_calls WHERE store_id=? AND status="pending" ORDER BY created_at DESC',
      [storeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 处理呼叫 -----
app.put('/api/waiter-calls/:id/handle', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = req.params.id;
    const storeId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const existing = await getAsync('SELECT * FROM waiter_calls WHERE id=? AND store_id=?', [id, storeId]);
    if (!existing) return res.status(404).json({ error: '呼叫记录不存在' });
    const handler = req.isAdmin ? 'admin' : (req.waiter?.display_name || 'waiter');
    await runAsync(
      'UPDATE waiter_calls SET status=?, handled_by=?, handled_at=? WHERE id=? AND store_id=?',
      ['handled', handler, new Date().toISOString(), id, storeId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 桌台预约 -----
app.post('/api/public/reservations', async (req, res) => {
  try {
    const { table, customerName, phone, reservationTime, guests } = req.body || {};
    if (!table || !customerName || !reservationTime) {
      return res.status(400).json({ error: '桌号、顾客姓名和预约时间必填' });
    }
    const tableRow = await getAsync('SELECT id, store_id, status FROM tables WHERE name=? AND store_id=?', [table, req.storeId || 1]);
    if (!tableRow) return res.status(404).json({ error: '桌号不存在' });
    const result = await runAsync(
      'INSERT INTO reservations (table_name, store_id, customer_name, phone, reservation_time, guests, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [table, tableRow.store_id, customerName, phone || '', reservationTime, parseInt(guests) || 1, 'pending', new Date().toISOString()]
    );
    await runAsync('UPDATE tables SET status=? WHERE id=?', ['reserved', tableRow.id]);
    res.status(201).json({ success: true, reservationId: result.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 获取预约列表 -----
app.get('/api/admin/reservations', requireAdminKey, async (req, res) => {
  try {
    const storeId = req.storeId || 1;
    const rows = await allAsync(
      'SELECT * FROM reservations WHERE store_id=? ORDER BY reservation_time DESC',
      [storeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 更新预约状态 -----
app.put('/api/admin/reservations/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body || {};
    const reservation = await getAsync('SELECT * FROM reservations WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!reservation) return res.status(404).json({ error: '预约不存在' });
    if (!['pending', 'confirmed', 'canceled', 'completed'].includes(status)) {
      return res.status(400).json({ error: '无效的预约状态' });
    }
    await runAsync('UPDATE reservations SET status=? WHERE id=? AND store_id=?', [status, id, req.storeId]);
    // 如果预约取消或完成，且桌台仍为 reserved，恢复为 available
    if (status === 'canceled' || status === 'completed') {
      const table = await getAsync('SELECT id, status FROM tables WHERE name=? AND store_id=?', [reservation.table_name, req.storeId]);
      if (table && table.status === 'reserved') {
        const active = await getAsync("SELECT COUNT(*) AS count FROM orders WHERE table_name=? AND store_id=? AND status='pending'", [reservation.table_name, req.storeId]);
        if (active.count === 0) await runAsync('UPDATE tables SET status=? WHERE id=?', ['available', table.id]);
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 订单打印数据 -----
app.get('/api/orders/:id(\\d+)/print', requireAdminOrWaiter, async (req, res) => {
  try {
    const row = await getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    const printStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    if (row.store_id !== printStoreId) return res.status(403).json({ error: '无权访问此订单' });
    const order = formatOrder(row);
    const store = await getAsync('SELECT name, address FROM stores WHERE id=?', [row.store_id || 1]);
    res.json({
      order,
      store: store || { name: 'FoodFlow', address: '' },
      printedAt: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 打印机管理 -----
app.get('/api/admin/printers', requireAdminKey, async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM printers WHERE store_id=? ORDER BY id', [req.storeId || 1]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/printers', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
  try {
    const { name, type, ip_address, port, paper_width, brand, is_default } = req.body || {};
    if (!name) return res.status(400).json({ error: '打印机名称必填' });
    if (is_default) await runAsync('UPDATE printers SET is_default=0 WHERE store_id=?', [req.storeId || 1]);
    const result = await runAsync(
      'INSERT INTO printers (name, type, ip_address, port, paper_width, brand, is_default, active, store_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      [name, type || 'network', ip_address || '', port || 9100, paper_width || 58, brand || 'generic', is_default ? 1 : 0, req.storeId || 1]
    );
    res.status(201).json(await getAsync('SELECT * FROM printers WHERE id=?', [result.lastID]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/printers/:id', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!current) return res.status(404).json({ error: '打印机不存在' });
    const { name, type, ip_address, port, paper_width, brand, is_default, active } = req.body || {};
    if (is_default) await runAsync('UPDATE printers SET is_default=0 WHERE store_id=?', [current.store_id]);
    await runAsync(
      'UPDATE printers SET name=?, type=?, ip_address=?, port=?, paper_width=?, brand=?, is_default=?, active=? WHERE id=? AND store_id=?',
      [name || current.name, type || current.type, ip_address ?? current.ip_address, port || current.port, paper_width || current.paper_width, brand || current.brand, is_default !== undefined ? (is_default ? 1 : 0) : current.is_default, active !== undefined ? (active ? 1 : 0) : current.active, id, req.storeId]
    );
    res.json(await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [id, req.storeId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/printers/:id', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync('SELECT id FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!current) return res.status(404).json({ error: '打印机不存在' });
    await runAsync('DELETE FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 执行打印 -----
app.post('/api/orders/:id(\\d+)/print', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = req.params.id;
    const printStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const row = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, printStoreId]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    const order = formatOrder(row);
    const store = await getAsync('SELECT name, address FROM stores WHERE id=? AND merchant_id=?', [row.store_id || 1, req.merchantId || 1]);
    const printerId = req.body?.printer_id;
    let printer;
    if (printerId) {
      printer = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=? AND active=1', [printerId, row.store_id]);
    } else {
      printer = await getAsync('SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1', [row.store_id || 1]);
    }

    const printData = buildReceipt(order, store, printer);

    // 如果指定了网络打印机，直接发送打印
    if (printer && printer.type === 'network' && printer.ip_address) {
      try {
        await printToNetworkPrinter(printData, printer.ip_address, printer.port);
        return res.json({ success: true, printed: true, printer: printer.name });
      } catch (e) {
        return res.status(502).json({ success: false, error: e.message, printData: printData.toString('base64') });
      }
    }

    // 否则返回打印数据，由前端处理（浏览器打印/WebUSB）
    res.json({ success: true, printed: false, printData: printData.toString('base64'), message: '请使用前端打印' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 后厨打印 -----
app.post('/api/orders/:id(\\d+)/print-kitchen', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = req.params.id;
    const row = await getAsync('SELECT * FROM orders WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    const order = formatOrder(row);
    const store = await getAsync('SELECT name, address FROM stores WHERE id=?', [row.store_id || 1]);
    const printer = await getAsync('SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1', [row.store_id || 1]);
    const printData = buildKitchenTicket(order, store, printer);

    if (printer && printer.type === 'network' && printer.ip_address) {
      try {
        await printToNetworkPrinter(printData, printer.ip_address, printer.port);
        return res.json({ success: true, printed: true });
      } catch (e) {
        return res.status(502).json({ success: false, error: e.message, printData: printData.toString('base64') });
      }
    }
    res.json({ success: true, printed: false, printData: printData.toString('base64') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 测试打印 -----
// 自动打印设置 - 获取
app.get('/api/admin/settings/auto-print', requireAdminKey, async (req, res) => {
  try {
    const storeId = req.storeId || 1;
    const row = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`auto_print_receipt_${storeId}`]);
    const enabled = row ? (row.value === '1' || row.value === 'true') : true; // 默认开启
    res.json({ enabled: enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 自动打印设置 - 保存
app.post('/api/admin/settings/auto-print', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
  try {
    const storeId = req.storeId || 1;
    const { enabled } = req.body || {};
    const key = `auto_print_receipt_${storeId}`;
    const existing = await getAsync("SELECT value FROM settings WHERE `key` = ?", [key]);
    if (existing) {
      await runAsync("UPDATE settings SET value = ? WHERE `key` = ?", [enabled ? '1' : '0', key]);
    } else {
      await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?)", [key, enabled ? '1' : '0']);
    }
    res.json({ success: true, enabled: enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/printers/test', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
  try {
    const { printer_id } = req.body || {};
    const printer = await getAsync('SELECT * FROM printers WHERE id=? AND active=1', [printer_id]);
    if (!printer) return res.status(404).json({ error: '打印机不存在或未启用' });
    if (printer.type !== 'network' || !printer.ip_address) {
      return res.status(400).json({ error: '仅支持网络打印机测试' });
    }
    const pos = new EscPosBuilder(printer.paper_width || 58);
    pos.init();
    pos.align(1);
    pos.big(true);
    pos.line('测试打印');
    pos.big(false);
    pos.newline();
    pos.line(`打印机: ${printer.name}`);
    pos.line(`品牌: ${printer.brand}`);
    pos.line(`纸宽: ${printer.paper_width}mm`);
    pos.line(`时间: ${formatGlobalDateTime(new Date())}`);
    pos.newline();
    pos.separator();
    pos.line('如果您看到此内容，说明打印机正常工作！');
    pos.newline(2);
    pos.cut(1);

    await printToNetworkPrinter(pos.build(), printer.ip_address, printer.port);
    res.json({ success: true, message: '测试打印已发送' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 数据导出（CSV） -----
app.get('/api/admin/export/:type', requireAdminKey, async (req, res) => {
  try {
    const type = req.params.type;
    let rows = [], filename = '', headers = [];

    if (type === 'orders') {
      rows = await allAsync('SELECT * FROM orders WHERE store_id=? ORDER BY id DESC LIMIT 1000', [req.storeId]);
      filename = `orders_${new Date().toISOString().slice(0,10)}.csv`;
      headers = ['订单号','桌号','状态','金额','备注','下单时间'];
    } else if (type === 'menu') {
      rows = await allAsync('SELECT * FROM menus WHERE store_id=? ORDER BY id', [req.storeId]);
      filename = `menu_${new Date().toISOString().slice(0,10)}.csv`;
      headers = ['ID','名称','英文名','价格','货币','分类','单位','状态'];
    } else if (type === 'sales') {
      // 销量统计
      rows = await allAsync(`
        SELECT m.id, m.name, m.price, SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)) AS total_qty,
               SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS DECIMAL(10,2)) * m.price) AS total_revenue
        FROM orders o
        JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
          ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
        JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
        WHERE o.store_id=? AND o.status = 'done'
        GROUP BY m.id, m.name, m.price
        ORDER BY total_qty DESC
      `, [req.storeId]);
      filename = `sales_${new Date().toISOString().slice(0,10)}.csv`;
      headers = ['菜品ID','菜品名称','单价','销量','销售额'];
    } else {
      return res.status(400).json({ error: '不支持的导出类型' });
    }

    // 生成 CSV
    const csvRows = [headers.join(',')];
    for (const row of rows) {
      if (type === 'orders') {
        csvRows.push([row.id, row.table_name, row.status, row.total, `"${(row.note||'').replace(/"/g,'""')}"`, row.createdAt].join(','));
      } else if (type === 'menu') {
        csvRows.push([row.id, `"${row.name}"`, `"${row.name_en||''}"`, row.price, row.currency_code, `"${row.category||''}"`, row.unit, row.active].join(','));
      } else if (type === 'sales') {
        csvRows.push([row.id, `"${row.name}"`, row.price, row.total_qty || 0, row.total_revenue || 0].join(','));
      }
    }
    const csv = '\uFEFF' + csvRows.join('\n'); // BOM for Excel

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 每日营业报表 -----
app.get('/api/admin/reports/daily', requireAdminKey, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(date + 'T00:00:00.000Z');
    const endOfDay = new Date(date + 'T23:59:59.999Z');

    // 当日订单统计
    const orderStats = await getAsync(`
      SELECT
        COUNT(*) AS total_orders,
        SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS completed_orders,
        SUM(CASE WHEN status='canceled' THEN 1 ELSE 0 END) AS canceled_orders,
        SUM(CASE WHEN status='done' THEN total ELSE 0 END) AS total_revenue,
        AVG(CASE WHEN status='done' THEN total END) AS avg_order_value
      FROM orders
      WHERE store_id=? AND createdAt >= ? AND createdAt <= ?
    `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);

    // 各桌台收入
    const tableRevenue = await allAsync(`
      SELECT table_name, COUNT(*) AS orders, SUM(total) AS revenue
      FROM orders
      WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt <= ?
      GROUP BY table_name
      ORDER BY revenue DESC
    `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);

    // 菜品销量排行（当日）
    const dishRanking = await allAsync(`
      SELECT m.name, m.emoji,
             SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)) AS quantity
      FROM orders o
      JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
        ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
      JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
      WHERE o.store_id=? AND o.status='done' AND o.createdAt >= ? AND o.createdAt <= ?
      GROUP BY m.id, m.name, m.emoji
      ORDER BY quantity DESC
      LIMIT 10
    `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);

    // 小时分布
    const hourlyStats = await allAsync(`
      SELECT HOUR(createdAt) AS hour, COUNT(*) AS orders, SUM(total) AS revenue
      FROM orders
      WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt <= ?
      GROUP BY HOUR(createdAt)
      ORDER BY hour
    `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);

    res.json({
      date,
      summary: {
        totalOrders: orderStats?.total_orders || 0,
        completedOrders: orderStats?.completed_orders || 0,
        canceledOrders: orderStats?.canceled_orders || 0,
        totalRevenue: Number(orderStats?.total_revenue || 0),
        avgOrderValue: Number(orderStats?.avg_order_value || 0),
      },
      tableRevenue,
      dishRanking,
      hourlyStats,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 营业汇总：今日营业额、本月营业额、热销菜品排行
app.get('/api/admin/reports/summary', requireAdminKey, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const todayStats = await getAsync(`
      SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
      FROM orders WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt <= ?
    `, [req.storeId, todayStart.toISOString(), todayEnd.toISOString()]);

    const monthStats = await getAsync(`
      SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
      FROM orders WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt <= ?
    `, [req.storeId, monthStart.toISOString(), monthEnd.toISOString()]);

    const topDishes = await allAsync(`
      SELECT id, name, emoji, sales_count, price, category
      FROM menus WHERE store_id=? AND active=1 AND sales_count > 0
      ORDER BY sales_count DESC LIMIT 10
    `, [req.storeId]);

    res.json({
      today: { revenue: Number(todayStats?.revenue || 0), orders: todayStats?.orders || 0 },
      month: { revenue: Number(monthStats?.revenue || 0), orders: monthStats?.orders || 0 },
      topDishes,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 账户信息（只读）
app.get('/api/admin/info', requireAdminKey, async (req, res) => {
  try {
    const admin = await getAsync('SELECT id, username, display_name, merchant_id, created_at, last_login_at, active FROM merchant_admins WHERE id=?', [req.adminId]);
    const merchant = await getAsync('SELECT id, name, code, contact_name, contact_phone, max_stores, status, created_at FROM merchants WHERE id=?', [admin?.merchant_id]);
    const storeCount = await getAsync('SELECT COUNT(*) as count FROM stores WHERE merchant_id=?', [admin?.merchant_id]);
    res.json({ admin, merchant, storeCount: storeCount?.count || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 获取全局配置（包含超时设置）
app.get('/api/public/global-config', async (req, res) => {
  try {
    const idleSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_idle_timeout'");
    const qrSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
    const intervalSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'order_interval_seconds'");
    res.json({
      admin_idle_timeout: parseInt(idleSetting?.value || '30', 10),
      qr_session_timeout: parseInt(qrSetting?.value || '45', 10),
      order_interval_seconds: parseInt(intervalSetting?.value || '30', 10),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 催单（顾客催单） -----
app.post('/api/orders/:id(\\d+)/urge', async (req, res) => {
  try {
    const id = req.params.id;
    const order = await getAsync('SELECT * FROM orders WHERE id=?', [id]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status !== 'pending') return res.status(400).json({ error: '订单已完成或已取消' });

    // 记录催单（使用 waiter_calls 表，type=urge）
    const callId = crypto.randomBytes(16).toString('hex');
    await runAsync(
      'INSERT INTO waiter_calls (id, table_name, type, message, status, store_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [callId, order.table_name, 'urge', `订单 #${id} 顾客催单`, 'pending', order.store_id || 1, new Date().toISOString()]
    );

    res.json({ success: true, message: '已通知后厨，请稍候' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 商户管理员管理 -----
app.get('/api/admin/admins', requireAdminKey, async (req, res) => {
  try {
    const rows = await allAsync('SELECT id, username, display_name, active, last_login_at, created_at, (id = (SELECT MIN(id) FROM merchant_admins ma2 WHERE ma2.merchant_id = merchant_admins.merchant_id)) AS is_primary, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs FROM merchant_admins WHERE merchant_id=? ORDER BY id', [req.merchantId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/admins', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
  try {
    const { username, password, display_name, active } = req.body || {};
    if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写管理员资料' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    const exists = await getAsync('SELECT id FROM merchant_admins WHERE username=?', [String(username).trim()]);
    if (exists) return res.status(400).json({ error: '用户名已存在' });
    const result = await runAsync(
      'INSERT INTO merchant_admins (merchant_id, username, password_hash, display_name, active) VALUES (?, ?, ?, ?, ?)',
      [req.merchantId, String(username).trim(), hashPassword(password), display_name, active ? 1 : 0]
    );
    await logAudit('merchant_admin', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'create_admin', 'merchant_admin', result.lastID, `创建管理员: ${username}`, req.ip);
    res.status(201).json(await getAsync('SELECT id, username, display_name, active, created_at, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs FROM merchant_admins WHERE id=?', [result.lastID]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/admins/:id', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { display_name, active, password, permissions } = req.body || {};
    const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]);
    if (!admin) return res.status(404).json({ error: '管理员不存在' });
    const primaryAdminId = await getAsync('SELECT MIN(id) AS min_id FROM merchant_admins WHERE merchant_id=?', [req.merchantId]);
    const isPrimaryAdmin = primaryAdminId && primaryAdminId.min_id === admin.id;
    if (isPrimaryAdmin) return res.status(400).json({ error: '主管理员拥有全部权限，不可修改权限和状态' });
    if (id === req.adminId && active === 0) return res.status(400).json({ error: '不能禁用当前登录账号' });
    const fields = [];
    const values = [];
    if (display_name !== undefined) { fields.push('display_name=?'); values.push(display_name); }
    if (active !== undefined) { fields.push('active=?'); values.push(active ? 1 : 0); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
      fields.push('password_hash=?'); values.push(hashPassword(password));
    }
    // 处理权限字段
    if (permissions && typeof permissions === 'object') {
      const permFields = ['can_manage_menu', 'can_manage_table', 'can_manage_order', 'can_delete_order', 'can_edit_order', 'can_manage_store', 'can_manage_waiter', 'can_manage_currency', 'can_manage_printer', 'can_manage_admin', 'can_view_logs'];
      for (const field of permFields) {
        if (permissions[field] !== undefined) {
          fields.push(field + '=?');
          values.push(permissions[field] ? 1 : 0);
        }
      }
    }
    if (fields.length) {
      values.push(id);
      values.push(req.merchantId);
      await runAsync(`UPDATE merchant_admins SET ${fields.join(',')} WHERE id=? AND merchant_id=?`, values);
    }
    await logAudit('merchant_admin', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'update_admin', 'merchant_admin', id, `更新管理员: ${admin.username}`, req.ip);
    res.json(await getAsync('SELECT id, username, display_name, active, created_at, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/admins/:id', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.adminId) return res.status(400).json({ error: '不能删除当前登录账号' });
    const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]);
    if (admin) {
      const primaryAdminIdDel = await getAsync('SELECT MIN(id) AS min_id FROM merchant_admins WHERE merchant_id=?', [req.merchantId]);
      if (primaryAdminIdDel && primaryAdminIdDel.min_id === admin.id) return res.status(400).json({ error: '主管理员不可删除' });
    }
    if (!admin) return res.status(404).json({ error: '管理员不存在' });
    await runAsync('DELETE FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]);
    await logAudit('merchant_admin', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'delete_admin', 'merchant_admin', id, `删除管理员: ${admin.username}`, req.ip);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 商户操作日志 -----
app.get('/api/admin/audit-logs', requireAdminKey, requirePermission('can_view_logs'), async (req, res) => {
  try {
    const rows = await allAsync(
      "SELECT id, actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at FROM audit_logs WHERE actor_type='merchant_admin' AND actor_id IN (SELECT id FROM merchant_admins WHERE merchant_id=?) ORDER BY id DESC LIMIT 200",
      [req.merchantId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 管理员操作 -----
app.post('/api/admin/change-password', requireAdminKey, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: '请提供旧密码和新密码' });
    }
    const isValid = await verifyLegacyAdminPassword(oldPassword);
    if (!isValid) return res.status(401).json({ error: '旧密码错误' });
    const hash = hashPassword(newPassword);
    await runAsync("UPDATE settings SET value = ? WHERE `key` = 'admin_password'", [hash]);
    res.json({ success: true, message: '密码已更新' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reset-data', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: '请输入管理员密码' });
    const merchantId = req.merchantId;
    if (!merchantId) return res.status(400).json({ error: '商户信息缺失' });
    // 验证当前商户管理员密码
    const admin = await getAsync('SELECT password_hash FROM merchant_admins WHERE id=?', [req.adminId]);
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      return res.status(401).json({ error: '密码错误，重置失败' });
    }
    // 只重置当前商户的订单相关数据
    await runAsync('DELETE FROM orders WHERE merchant_id = ?', [merchantId]);
    await runAsync('DELETE FROM waiter_calls WHERE merchant_id = ?', [merchantId]);
    await runAsync('DELETE FROM scan_sessions WHERE merchant_id = ?', [merchantId]);
    await runAsync('DELETE FROM reservations WHERE merchant_id = ?', [merchantId]);
    res.json({ success: true, message: '订单数据已重置' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ----- 超级管理员数据备份与恢复 -----
app.get('/api/super/backup/export', requireSuperAdmin, async (req, res) => {
  try {
    const data = await collectBackupData();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="foodflow-full-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/super/backup/import', requireSuperAdmin, async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.tables || typeof data.tables !== 'object') return res.status(400).json({ error: '备份文件格式无效' });
    await withTransaction(async () => {
      // 注意：admin_sessions、super_sessions 为会话临时表，故意不纳入恢复，恢复后需重新登录
      for (const table of ['menus', 'tables', 'orders', 'currencies', 'menu_categories', 'login_logs', 'audit_logs', 'scan_sessions', 'waiters', 'waiter_sessions', 'stores', 'waiter_calls', 'reservations', 'printers', 'merchants', 'merchant_admins', 'super_admins']) {
        const rows = Array.isArray(data.tables[table]) ? data.tables[table] : [];
        await runAsync(`DELETE FROM \`${table}\``);
        for (const row of rows) {
          const keys = Object.keys(row).filter(k => !['id'].includes(k));
          const placeholders = keys.map(() => '?').join(', ');
          const values = keys.map(k => row[k]);
          if (keys.length) {
            await runAsync(`INSERT INTO \`${table}\` (${keys.map(k => `\`${k}\``).join(', ')}) VALUES (${placeholders})`, values);
          }
        }
      }
    });
    res.json({ success: true, message: '备份已导入' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/super/backup/settings', requireSuperAdmin, async (req, res) => {
  try {
    const intervalRow = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_interval_hours'");
    const lastBackupRow = await getAsync("SELECT value FROM settings WHERE `key` = 'last_backup_at'");
    res.json({ intervalHours: parseInt(intervalRow?.value || '24', 10), lastBackupAt: lastBackupRow?.value || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/super/backup/settings', requireSuperAdmin, async (req, res) => {
  try {
    const { intervalHours } = req.body || {};
    const hours = Math.max(1, Math.min(168, parseInt(intervalHours, 10) || 24));
    await runAsync("INSERT INTO settings (`key`, value) VALUES ('backup_interval_hours', ?) ON DUPLICATE KEY UPDATE value=?", [String(hours), String(hours)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/super/backup/now', requireSuperAdmin, async (req, res) => {
  try {
    await autoBackupDatabase();
    res.json({ success: true, message: '备份已生成' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/super/reset-data', requireSuperAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: '请提供超级管理员密码' });
    // 验证超级管理员密码（使用verifyPassword兼容bcrypt和旧SHA256）
    if (!verifyPassword(password, req.superAdmin.password_hash)) {
      return res.status(401).json({ error: '密码错误，重置失败' });
    }
    await runAsync('DELETE FROM orders');
    await runAsync('ALTER TABLE orders AUTO_INCREMENT = 1');
    await runAsync('DELETE FROM waiter_calls');
    await runAsync('ALTER TABLE waiter_calls AUTO_INCREMENT = 1');
    await runAsync('DELETE FROM scan_sessions');
    await runAsync('ALTER TABLE scan_sessions AUTO_INCREMENT = 1');
    await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'reset_all_data', 'system', null, '重置所有订单数据', getClientIp(req));
    res.json({ success: true, message: '所有订单数据已重置' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 货币管理 -----
app.get('/api/currencies', requireAdminKey, async (req, res) => {
  try { res.json(await allAsync('SELECT * FROM currencies WHERE merchant_id=? ORDER BY is_default DESC, code', [req.merchantId])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/currencies', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
  try {
    const { code, symbol, name, rate, is_default } = req.body;
    if (!code || !symbol || !name || !(Number(rate) > 0)) return res.status(400).json({ error: '货币资料不完整' });
    await withTransaction(async () => {
      if (is_default) await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [req.merchantId]);
      const result = await runAsync('INSERT INTO currencies (merchant_id, code, symbol, name, rate, is_default) VALUES (?, ?, ?, ?, ?, ?)', [req.merchantId, String(code).toUpperCase(), symbol, name, Number(rate), is_default ? 1 : 0]);
      res.status(201).json(await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [result.lastID, req.merchantId]));
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
  try {
    const current = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [req.params.id, req.merchantId]);
    if (!current) return res.status(404).json({ error: '货币不存在' });
    const next = { ...current, ...req.body };
    if (!(Number(next.rate) > 0)) return res.status(400).json({ error: '汇率必须大于 0' });
    await withTransaction(async () => {
      if (next.is_default) await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [req.merchantId]);
      await runAsync('UPDATE currencies SET code=?,symbol=?,name=?,rate=?,is_default=? WHERE id=? AND merchant_id=?', [String(next.code).toUpperCase(), next.symbol, next.name, Number(next.rate), next.is_default ? 1 : 0, current.id, req.merchantId]);
    });
    res.json(await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [current.id, req.merchantId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
  try {
    const current = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [req.params.id, req.merchantId]);
    if (!current) return res.status(404).json({ error: '货币不存在' });
    if (current.is_default) return res.status(409).json({ error: '默认货币不能删除，请先设置其他默认货币' });
    await runAsync('DELETE FROM currencies WHERE id=? AND merchant_id=?', [current.id, req.merchantId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 显示设置 -----
app.get('/api/admin/display-settings', requireAdminKey, async (req, res) => {
  try {
    const mid = req.merchantId || 1;
    const enabled = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${mid}_dual_currency_enabled`]);
    const secondary = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${mid}_secondary_currency_code`]);
    const enabledFallback = enabled || await getAsync("SELECT value FROM settings WHERE `key` = 'dual_currency_enabled'");
    const secondaryFallback = secondary || await getAsync("SELECT value FROM settings WHERE `key` = 'secondary_currency_code'");
    res.json({ enabled: enabledFallback?.value === '1', secondaryCurrencyCode: secondaryFallback?.value || 'USD' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/display-settings', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
  try {
    const mid = req.merchantId || 1;
    const enabled = req.body.enabled ? '1' : '0';
    const secondary = String(req.body.secondaryCurrencyCode || 'USD');
    await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [`merchant_${mid}_dual_currency_enabled`, enabled]);
    await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [`merchant_${mid}_secondary_currency_code`, secondary]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 新订单提示音设置（总开关） -----
app.get('/api/admin/notification-settings', requireAdminKey, async (req, res) => {
  try {
    const mid = req.merchantId || 1;
    const row = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${mid}_new_order_sound_enabled`]);
    const fallback = row || await getAsync("SELECT value FROM settings WHERE `key` = 'new_order_sound_enabled'");
    res.json({ enabled: fallback ? fallback.value === '1' : true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/notification-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const mid = req.merchantId || 1;
    const enabled = req.body.enabled ? '1' : '0';
    await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [`merchant_${mid}_new_order_sound_enabled`, enabled]);
    res.json({ success: true, enabled: enabled === '1' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 二维码 -----
app.get('/api/qrcode/:table', async (req, res) => {
  const tableName = String(req.params.table || '').trim();
  try {
    const table = await getAsync('SELECT name, qr_token FROM tables WHERE name = ?', [tableName]);
    if (!table) return res.status(404).json({ error: '桌号不存在' });
    const url = `${req.protocol}://${req.get('host')}/?token=${encodeURIComponent(table.qr_token)}`;
    const qrDataUrl = await QRCode.toDataURL(url);
    res.json({ qrDataUrl, url, table: tableName });
  } catch (e) {
    res.status(500).json({ error: '生成二维码失败' });
  }
});

app.get('/api/tables/:id/qrcode', requireAdminKey, async (req, res) => {
  try {
    const table = await getAsync('SELECT name, qr_token, store_id FROM tables WHERE id = ? AND store_id = ?', [req.params.id, req.storeId]);
    if (!table) return res.status(404).json({ error: '桌号不存在' });
    const store = await getAsync('SELECT name FROM stores WHERE id = ?', [table.store_id || 1]);
    const url = `${req.protocol}://${req.get('host')}/?token=${encodeURIComponent(table.qr_token)}`;
    const qrDataUrl = await QRCode.toDataURL(url);
    res.json({ qrDataUrl, url, table: table.name, storeName: store?.name || '' });
  } catch (e) {
    res.status(500).json({ error: '生成二维码失败' });
  }
});

// ----- 顾客二维码桌码解析 -----
app.get('/api/public/table-token/:token', async (req, res) => {
  try {
    const table = await getAsync('SELECT name, store_id FROM tables WHERE qr_token=?', [req.params.token]);
    if (!table) return res.status(404).json({ error: '无效或已失效的桌码' });
    const sessionToken = crypto.randomBytes(24).toString('base64url');
    const qrTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
    const qrTimeoutMinutes = parseInt(qrTimeoutSetting?.value || '45', 10);
    // 0表示永不过期，设置为year 9999
    const expiresAt = qrTimeoutMinutes > 0
      ? new Date(Date.now() + qrTimeoutMinutes * 60 * 1000).toISOString()
      : new Date('9999-12-31T23:59:59Z').toISOString();
    await runAsync('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?, ?, ?, ?, ?)', [table.name, sessionToken, expiresAt, new Date().toISOString(), table.store_id || 1]);
    res.json({ table: table.name, storeId: table.store_id || 1, sessionToken, expiresAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/table-session/:token/orders', async (req, res) => {
  try {
    const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [req.params.token]);
    if (!session) return res.status(404).json({ error: '扫码会话不存在，请重新扫码' });
    if (new Date(session.expires_at).getTime() < Date.now()) return res.status(410).json({ error: '二维码已过期，请重新扫码' });
    // 二维码无操作过期：每次有效请求都重置过期时间（最后一次操作后N分钟过期）
    const qrTimeoutS = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
    const qrTimeoutMins = parseInt(qrTimeoutS?.value || '45', 10);
    if (qrTimeoutMins > 0) {
      const newQrExpires = new Date(Date.now() + qrTimeoutMins * 60 * 1000).toISOString();
      runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [newQrExpires, req.params.token]).catch(()=>{});
    }
    const rows = await allAsync("SELECT * FROM orders WHERE table_name=? AND store_id=? AND session_token=? AND status!='canceled' ORDER BY createdAt DESC", [session.table_name, session.store_id || 1, req.params.token]);
    res.json({ table: session.table_name, orders: rows.map(formatOrder) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/table-session/:token/info', async (req, res) => {
  try {
    const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [req.params.token]);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    if (new Date(session.expires_at).getTime() < Date.now()) return res.status(410).json({ error: '会话已过期' });
    // 二维码无操作过期：每次有效请求都重置过期时间（最后一次操作后N分钟过期）
    const qrTimeoutS2 = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
    const qrTimeoutMins2 = parseInt(qrTimeoutS2?.value || '45', 10);
    let expiresAt2 = session.expires_at;
    if (qrTimeoutMins2 > 0) {
      expiresAt2 = new Date(Date.now() + qrTimeoutMins2 * 60 * 1000).toISOString();
      runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [expiresAt2, req.params.token]).catch(()=>{});
    }
    res.json({ table: session.table_name, storeId: session.store_id || 1, sessionToken: req.params.token, expiresAt: expiresAt2 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/public/table-session/:token', async (req, res) => {
  try {
    await runAsync('DELETE FROM scan_sessions WHERE token=?', [req.params.token]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 全局错误处理 ----------
// API 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API 接口不存在', path: req.path });
});

// 全局错误处理中间件
app.use((err, req, res, next) => {
  console.error('未处理的错误:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误', message: err.message });
});

// ---------- 启动 ----------
const isInitOnly = process.argv.includes('--init-only');

initDatabase().then(async () => {
  if (isInitOnly) {

    process.exit(0);
  }
  // 初始化Redis（双服务器部署时用于共享状态）
  await initRedis();
  app.listen(PORT, '0.0.0.0', () => {

    console.log(`📁 数据库: MySQL (${poolConfig.database})`);

    // 定时任务：只在 RUN_SCHEDULED_TASKS=true 的服务器上执行，避免双服务器重复执行
    if (RUN_SCHEDULED_TASKS) {
      console.log('⏰ 定时任务已启用（自动备份、日志清理）');
      maybeAutoBackup().catch(err => console.error('自动备份失败:', err.message));
      setInterval(() => {
        maybeAutoBackup().catch(err => console.error('自动备份失败:', err.message));
      }, 5 * 60 * 1000);
      // 每天检查一次是否需要清理日志
      autoCleanLogs().catch(err => console.error('日志清理失败:', err.message));
      setInterval(() => {
        autoCleanLogs().catch(err => console.error('日志清理失败:', err.message));
      }, 24 * 60 * 60 * 1000);
    } else {
      console.log('⏭️ 定时任务未启用（设置 RUN_SCHEDULED_TASKS=true 启用）');
    }
  });
}).catch(err => {
  console.error('❌ 数据库初始化失败:', err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => pool.end().then(() => process.exit(0)));
}

// 未捕获异常处理，防止服务器崩溃
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
});