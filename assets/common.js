/* ============================================================
   FoodFlow 点餐系统 - 公共 JS 库
   所有页面共享此文件，提供 API 客户端、i18n 国际化、工具函数、UI 组件、认证和音频功能
   ============================================================ */

(function (global) {
  'use strict';

  /* ===== 全局配置 ===== */
  const CONFIG = {
    API_BASE: '/api',
    DEFAULT_LANG: 'zh',
    STORAGE_KEYS: {
      adminToken: 'adminToken',
      adminLang: 'adminLang',
      waiterToken: 'waiterToken',
      waiterLang: 'waiterLang',
      kitchenToken: 'kitchenToken',
      kitchenLang: 'kitchenLang',
      customerLang: 'customerLang',
      storeId: 'storeId',
    },
  };

  /* ===== 统一 API 客户端 ===== */
  class ApiClient {
    constructor(baseUrl) {
      this.baseUrl = baseUrl || CONFIG.API_BASE;
      this.defaultHeaders = { 'Content-Type': 'application/json' };
    }

    /* 构建认证请求头：管理员密钥、服务员令牌、店铺ID */
    _getAuthHeaders() {
      const headers = {};
      const adminToken = sessionStorage.getItem(CONFIG.STORAGE_KEYS.adminToken);
      const waiterToken =
        localStorage.getItem(CONFIG.STORAGE_KEYS.waiterToken) ||
        localStorage.getItem(CONFIG.STORAGE_KEYS.kitchenToken);
      if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;
      if (waiterToken) headers['X-Waiter-Token'] = waiterToken;
      const storeId = localStorage.getItem(CONFIG.STORAGE_KEYS.storeId);
      if (storeId) headers['X-Store-Id'] = storeId;
      return headers;
    }

    /* 核心请求方法：统一处理请求头、Body序列化、错误处理 */
    async _request(method, path, options = {}) {
      const url = path.startsWith('http') ? path : this.baseUrl + path;
      const headers = {
        ...this.defaultHeaders,
        ...this._getAuthHeaders(),
        ...(options.headers || {}),
      };

      /* FormData 上传时移除 Content-Type，让浏览器自动设置 boundary */
      if (options.body instanceof FormData) {
        delete headers['Content-Type'];
      }

      const config = {
        method,
        headers,
        credentials: 'same-origin',
      };

      if (options.body !== undefined) {
        config.body =
          options.body instanceof FormData
            ? options.body
            : JSON.stringify(options.body);
      }

      try {
        const res = await fetch(url, config);
        const contentType = res.headers.get('content-type') || '';
        let data;
        if (contentType.includes('application/json')) {
          data = await res.json().catch(() => ({}));
        } else {
          data = await res.text();
        }

        if (!res.ok) {
          const error = new Error(
            (data && data.error) || `请求失败 (${res.status})`
          );
          error.status = res.status;
          error.data = data;
          throw error;
        }
        return data;
      } catch (err) {
        /* 网络错误或无状态码时统一提示 */
        if (err.name === 'TypeError' || !err.status) {
          throw new Error('网络连接失败，请检查后端服务');
        }
        throw err;
      }
    }

    /* GET 请求，支持查询参数 */
    get(path, params) {
      if (params) {
        const qs = new URLSearchParams(params).toString();
        if (qs) path += (path.includes('?') ? '&' : '?') + qs;
      }
      return this._request('GET', path);
    }

    /* POST 请求 */
    post(path, body, options) {
      return this._request('POST', path, { body, ...options });
    }

    /* PUT 请求 */
    put(path, body, options) {
      return this._request('PUT', path, { body, ...options });
    }

    /* DELETE 请求 */
    del(path, body) {
      return this._request('DELETE', path, { body });
    }

    /* 文件上传（FormData） */
    upload(path, formData) {
      return this._request('POST', path, { body: formData });
    }
  }

  const api = new ApiClient();

  /* ===== 统一 i18n 国际化系统 ===== */
  class I18n {
    constructor() {
      this.lang = CONFIG.DEFAULT_LANG;
      this.dicts = {};
      this.fallbackLang = 'zh';
      this.cacheVersion = '20260914c'; // i18n缓存版本号，更新翻译时递增以强制刷新缓存
    }

    /* 初始化：设置当前语言，合并自定义字典和全局 LANGUAGES */
    init(lang, customDicts) {
      this.lang = lang || CONFIG.DEFAULT_LANG;
      if (customDicts) {
        for (const [code, dict] of Object.entries(customDicts)) {
          this.dicts[code] = { ...(this.dicts[code] || {}), ...dict };
        }
      }
      /* 合并全局 LANGUAGES（如果存在，作为回退） */
      if (typeof LANGUAGES !== 'undefined') {
        for (const [code, dict] of Object.entries(LANGUAGES)) {
          this.dicts[code] = { ...(this.dicts[code] || {}), ...dict };
        }
      }
    }

    /* 动态按需加载指定语言的翻译（方案二：从API加载，减少初始体积）
       优先级：内存缓存 → localStorage缓存（24小时）→ API请求 → 回退中文 */
    async loadLanguage(lang) {
      const validLangs = ['zh', 'en', 'vi', 'th', 'km'];
      if (!validLangs.includes(lang)) lang = 'zh';

      /* 检查内存缓存 */
      if (this.dicts[lang] && this.dicts[lang]._loaded) {
        this.lang = lang;
        return true;
      }

      /* 检查 localStorage 缓存（24小时过期 + 版本号验证） */
      try {
        const cached = localStorage.getItem('i18n_' + lang);
        if (cached) {
          const parsed = JSON.parse(cached);
          const cacheTime = parsed._cacheTime || 0;
          const cacheVersion = parsed._cacheVersion || '';
          const isExpired = Date.now() - cacheTime > 24 * 60 * 60 * 1000;
          const isVersionMatch = cacheVersion === this.cacheVersion;
          if (!isExpired && isVersionMatch) {
            const { _cacheTime, _cacheVersion, ...data } = parsed;
            this.dicts[lang] = { ...data, _loaded: true };
            this.lang = lang;
            return true;
          }
        }
      } catch (e) {}

      /* 从 API 动态加载 */
      try {
        const res = await fetch('/api/i18n/' + lang);
        if (res.ok) {
          const data = await res.json();
          this.dicts[lang] = { ...data, _loaded: true };
          this.lang = lang;
          /* 缓存到 localStorage（24小时，带时间戳和版本号） */
          try {
            localStorage.setItem('i18n_' + lang, JSON.stringify({ ...data, _cacheTime: Date.now(), _cacheVersion: this.cacheVersion }));
          } catch (e) {}
          return true;
        }
      } catch (e) {
        console.warn('i18n dynamic load failed, using fallback:', e.message);
      }

      /* 加载失败，回退到全局 LANGUAGES 或中文 */
      this.lang = this.dicts[lang] ? lang : this.fallbackLang;
      return false;
    }

    /* 直接设置当前语言（不加载数据） */
    setLang(lang) {
      this.lang = lang;
    }

    /* 翻译核心方法：支持参数替换 {0}, {1} 或 {name} */
    t(key, params) {
      const dict = this.dicts[this.lang] || {};
      const fallback = this.dicts[this.fallbackLang] || {};
      let value = dict[key] ?? fallback[key] ?? key;

      /* 支持嵌套对象（如 categories） */
      if (typeof value === 'object' && value !== null) {
        return value;
      }

      /* 支持参数替换 */
      if (params) {
        if (Array.isArray(params)) {
          params.forEach((p, i) => {
            value = String(value).replace(`{${i}}`, p);
          });
        } else {
          for (const [k, v] of Object.entries(params)) {
            value = String(value).replace(`{${k}}`, v);
          }
        }
      }
      return value;
    }

    /* 获取分类翻译 */
    category(name) {
      const cats = this.t('categories');
      if (cats && typeof cats === 'object' && cats[name]) return cats[name];
      return name;
    }

    /* 获取当前语言的货币信息（符号、汇率、代码） */
    currency() {
      const dict = this.dicts[this.lang] || this.dicts[this.fallbackLang] || {};
      return {
        symbol: dict.currencySymbol || '$',
        rate: Number(dict.currencyRate) || 1,
        code: dict.currencyCode || this.lang.toUpperCase(),
      };
    }

    /* 格式化价格：基础货币 USD → 当前语言货币，大额货币（VND/KHR）不显示小数 */
    formatPrice(basePrice, baseCurrency) {
      const cur = this.currency();
      const rate = cur.rate || 1;
      const converted = Number(basePrice) * rate;
      const decimals = rate >= 1000 ? 0 : 2;
      return `${cur.symbol}${converted.toFixed(decimals)}`;
    }
  }

  const i18n = new I18n();

  /* ===== 工具函数集合 ===== */
  const utils = {
    /* HTML 转义，防止 XSS */
    esc(str) {
      return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c]));
    },

    /* 防抖：延迟执行，频繁调用只执行最后一次 */
    debounce(fn, delay) {
      let timer;
      return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    },

    /* 节流：限制执行频率，固定间隔内只执行一次 */
    throttle(fn, limit) {
      let inThrottle;
      return function (...args) {
        if (!inThrottle) {
          fn.apply(this, args);
          inThrottle = true;
          setTimeout(() => (inThrottle = false), limit);
        }
      };
    },

    /* 格式化日期时间（全球通用格式 YYYY-MM-DD HH:mm:ss） */
    formatDateTime(isoStr) {
      try {
        const d = new Date(isoStr);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      } catch {
        return isoStr;
      }
    },

    /* 格式化时间（全球通用格式 HH:mm:ss） */
    formatTime(date) {
      try {
        const d = date instanceof Date ? date : new Date(date);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      } catch {
        return '';
      }
    },

    /* 相对时间：刚刚 / N分钟前 / N小时前，带紧急程度等级 */
    timeAgo(isoStr) {
      const diff = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return { text: i18n.t('justNow') || '刚刚', level: 'ok' };
      if (mins < 60)
        return {
          text: `${mins} ${i18n.t('minutesAgo') || '分钟前'}`,
          level: mins >= 15 ? 'danger' : mins >= 8 ? 'warn' : 'ok',
        };
      const hours = Math.floor(mins / 60);
      return {
        text: `${hours} ${i18n.t('hoursAgo') || '小时前'}`,
        level: 'danger',
      };
    },

    /* 生成唯一 ID（时间戳+随机数） */
    uid(prefix) {
      return (
        (prefix || '') +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8)
      );
    },

    /* 深拷贝（JSON方式） */
    clone(obj) {
      return JSON.parse(JSON.stringify(obj));
    },

    /* 下载文件（Blob方式） */
    download(filename, content, mimeType) {
      const blob = new Blob([content], {
        type: mimeType || 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },

    /* 复制到剪贴板（优先 Clipboard API，降级 execCommand） */
    async copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      }
    },
  };

  /* ===== 认证辅助工具 ===== */
  const auth = {
    /* 管理员令牌（sessionStorage，关闭浏览器即失效） */
    getAdminToken() {
      return sessionStorage.getItem(CONFIG.STORAGE_KEYS.adminToken);
    },
    setAdminToken(token) {
      sessionStorage.setItem(CONFIG.STORAGE_KEYS.adminToken, token);
    },
    clearAdmin() {
      sessionStorage.removeItem(CONFIG.STORAGE_KEYS.adminToken);
    },
    isAdminLoggedIn() {
      return !!this.getAdminToken();
    },

    /* 服务员/后厨令牌（localStorage，持久化） */
    getWaiterToken() {
      return (
        localStorage.getItem(CONFIG.STORAGE_KEYS.waiterToken) ||
        localStorage.getItem(CONFIG.STORAGE_KEYS.kitchenToken)
      );
    },
    setWaiterToken(token, scope) {
      const key =
        scope === 'kitchen'
          ? CONFIG.STORAGE_KEYS.kitchenToken
          : CONFIG.STORAGE_KEYS.waiterToken;
      localStorage.setItem(key, token);
    },
    clearWaiter(scope) {
      if (scope === 'kitchen') {
        localStorage.removeItem(CONFIG.STORAGE_KEYS.kitchenToken);
      } else if (scope === 'waiter') {
        localStorage.removeItem(CONFIG.STORAGE_KEYS.waiterToken);
      } else {
        localStorage.removeItem(CONFIG.STORAGE_KEYS.waiterToken);
        localStorage.removeItem(CONFIG.STORAGE_KEYS.kitchenToken);
      }
    },

    /* 当前店铺 ID */
    getStoreId() {
      return parseInt(localStorage.getItem(CONFIG.STORAGE_KEYS.storeId) || '1', 10);
    },
    setStoreId(id) {
      localStorage.setItem(CONFIG.STORAGE_KEYS.storeId, String(id));
    },
  };

  /* ===== 音频提示工具（Web Audio API 合成音效） ===== */
  const audio = {
    _ctx: null,
    _enabled: true,

    /* 解锁音频上下文（必须在用户交互后调用，否则浏览器会阻止自动播放） */
    unlock() {
      if (!this._ctx) {
        try {
          this._ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
          /* 浏览器不支持 Web Audio */
        }
      }
      if (this._ctx && this._ctx.state === 'suspended') {
        this._ctx.resume().catch(() => {});
      }
    },

    /* 设置声音开关 */
    setEnabled(enabled) {
      this._enabled = !!enabled;
    },

    /* 获取声音开关状态 */
    isEnabled() {
      return this._enabled;
    },

    /* 新订单提示音：C大调上行琶音（C5→E5→G5→C6→E6），悠扬上扬，响亮清晰 */
    playNewOrderChime() {
      if (!this._enabled) return;
      this.unlock();
      if (!this._ctx) return;
      try {
        const now = this._ctx.currentTime;
        /* 频率：C5=523.25, E5=659.25, G5=783.99, C6=1046.50, E6=1318.51 */
        const notes = [
          [0, 523.25],
          [0.15, 659.25],
          [0.30, 783.99],
          [0.45, 1046.50],
          [0.60, 1318.51]
        ];
        notes.forEach(([t, freq], idx) => {
          const isLast = idx === notes.length - 1;
          const osc = this._ctx.createOscillator();
          const gain = this._ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.value = freq;
          const duration = isLast ? 0.8 : 0.3;
          const peak = 1.0;
          gain.gain.setValueAtTime(0.0001, now + t);
          gain.gain.exponentialRampToValueAtTime(peak, now + t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + t + duration);
          osc.connect(gain).connect(this._ctx.destination);
          osc.start(now + t);
          osc.stop(now + t + duration + 0.05);
        });
      } catch (e) {
        /* 忽略音频播放错误 */
      }
    },

    /* 催单提示音：急促的双音四声（方波+压缩器），紧迫感强 */
    playUrgeChime() {
      if (!this._enabled) return;
      this.unlock();
      if (!this._ctx) return;
      try {
        const now = this._ctx.currentTime;
        const compressor = this._ctx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-12, now);
        compressor.knee.setValueAtTime(20, now);
        compressor.ratio.setValueAtTime(8, now);
        compressor.attack.setValueAtTime(0.003, now);
        compressor.release.setValueAtTime(0.15, now);
        compressor.connect(this._ctx.destination);
        [[0, 1000], [0.15, 1400], [0.30, 1000], [0.45, 1400]].forEach(([t, freq]) => {
          [freq, freq * 1.5].forEach((f, i) => {
            const osc = this._ctx.createOscillator();
            const gain = this._ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = f;
            const peak = i === 0 ? 1.0 : 0.5;
            gain.gain.setValueAtTime(0.0001, now + t);
            gain.gain.exponentialRampToValueAtTime(peak, now + t + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.12);
            osc.connect(gain).connect(compressor);
            osc.start(now + t);
            osc.stop(now + t + 0.15);
          });
        });
      } catch (e) {
        /* 忽略音频播放错误 */
      }
    },

    /* 呼叫服务员提示音：三声清脆叮咚（正弦波+压缩器），更急促 */
    playCallChime() {
      if (!this._enabled) return;
      this.unlock();
      if (!this._ctx) return;
      try {
        const now = this._ctx.currentTime;
        const compressor = this._ctx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-12, now);
        compressor.knee.setValueAtTime(20, now);
        compressor.ratio.setValueAtTime(8, now);
        compressor.attack.setValueAtTime(0.003, now);
        compressor.release.setValueAtTime(0.15, now);
        compressor.connect(this._ctx.destination);
        [[0, 1200], [0.2, 1600], [0.4, 1200]].forEach(([t, freq]) => {
          [freq, freq * 1.5].forEach((f, i) => {
            const osc = this._ctx.createOscillator();
            const gain = this._ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = f;
            const peak = i === 0 ? 1.0 : 0.5;
            gain.gain.setValueAtTime(0.0001, now + t);
            gain.gain.exponentialRampToValueAtTime(peak, now + t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.3);
            osc.connect(gain).connect(compressor);
            osc.start(now + t);
            osc.stop(now + t + 0.35);
          });
        });
      } catch (e) {
        /* 忽略音频播放错误 */
      }
    },
  };

  /* ===== 导出到全局 SLF 对象 ===== */
  global.SLF = {
    CONFIG,
    api,
    i18n,
    utils,
    auth,
    audio,
    ApiClient,
    I18n,
  };

  /* 兼容旧代码：提供全局 t 和 esc 快捷方式 */
  global.t = function (key, params) {
    return i18n.t(key, params);
  };
  global.esc = utils.esc;
})(window);
