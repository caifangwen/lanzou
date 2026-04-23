// api/parse.js - 蓝奏云直链解析 Vercel Serverless Function

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url, pwd } = req.method === 'POST' ? req.body : req.query;

  if (!url) {
    return res.status(400).json({ code: 400, msg: '缺少 url 参数' });
  }

  try {
    const result = await parseLanzou(url, pwd || '');
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ code: 500, msg: err.message });
  }
}

/**
 * 主解析函数
 */
async function parseLanzou(shareUrl, pwd = '') {
  // 规范化 URL
  const url = normalizeUrl(shareUrl);

  // 第一步：获取分享页面 HTML
  const pageHtml = await fetchText(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.lanzoui.com/',
  });

  // 判断是否需要密码
  const needPwd = pageHtml.includes('id="pwdload"') || pageHtml.includes('id="passwddiv"');

  let ajaxData;

  if (needPwd && !pwd) {
    return { code: 403, msg: '需要提取码', need_pwd: true };
  }

  if (needPwd && pwd) {
    // 带密码请求
    ajaxData = await fetchWithPassword(pageHtml, url, pwd);
  } else {
    // 无密码请求
    ajaxData = await fetchDirect(pageHtml, url);
  }

  if (!ajaxData) {
    throw new Error('解析失败：无法获取文件信息');
  }

  // 第二步：从 ajax 响应中提取下载链接
  const downloadUrl = await extractDownloadUrl(ajaxData, url);

  return {
    code: 200,
    msg: 'ok',
    name: ajaxData.inf || ajaxData.name || '',
    url: downloadUrl,
    need_pwd: false,
  };
}

/**
 * 无密码直接解析
 */
async function fetchDirect(pageHtml, pageUrl) {
  // 提取 iframe src
  const iframeMatch = pageHtml.match(/src="(\/fn\?[^"]+)"/);
  if (!iframeMatch) {
    // 尝试另一种格式
    return await fetchAjaxFromPage(pageHtml, pageUrl);
  }

  const iframeSrc = 'https://www.lanzoui.com' + iframeMatch[1];
  const iframeHtml = await fetchText(iframeSrc, {
    'User-Agent': 'Mozilla/5.0',
    'Referer': pageUrl,
  });

  return await fetchAjaxFromPage(iframeHtml, iframeSrc);
}

/**
 * 带密码解析
 */
async function fetchWithPassword(pageHtml, pageUrl, pwd) {
  const baseUrl = new URL(pageUrl);
  const origin = baseUrl.origin;

  // 提取 action 参数
  const signMatch = pageHtml.match(/var\s+skdklds\s*=\s*['"]([^'"]+)['"]/);
  const sign = signMatch ? signMatch[1] : '';

  // 提取其他隐藏参数
  const params = extractHiddenParams(pageHtml);

  const body = new URLSearchParams({
    action: 'downprocess',
    sign: sign,
    p: pwd,
    ...params,
  });

  const resp = await fetchJson(`${origin}/ajaxm.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': pageUrl,
      'User-Agent': 'Mozilla/5.0',
    },
    body: body.toString(),
  });

  if (resp && resp.zt === 0) {
    return null; // 密码错误
  }

  return resp;
}

/**
 * 从页面 HTML 中提取 ajax 请求参数并请求
 */
async function fetchAjaxFromPage(html, referer) {
  const baseUrl = new URL(referer);
  const origin = baseUrl.origin;

  // 提取 ajax 参数（通常在 JS 变量中）
  const signMatch = html.match(/var\s+skdklds\s*=\s*['"]([^'"]+)['"]/);
  if (!signMatch) return null;

  const params = extractHiddenParams(html);

  const body = new URLSearchParams({
    action: 'downprocess',
    sign: signMatch[1],
    ves: 1,
    ...params,
  });

  return await fetchJson(`${origin}/ajaxm.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': referer,
      'User-Agent': 'Mozilla/5.0',
    },
    body: body.toString(),
  });
}

/**
 * 从 ajax 响应中获取真实下载链接
 */
async function extractDownloadUrl(ajaxData, referer) {
  if (!ajaxData || ajaxData.zt !== 1) {
    throw new Error('获取下载信息失败：' + (ajaxData?.inf || '未知错误'));
  }

  // ajaxData.dom + ajaxData.url 拼接得到中转链接
  const midUrl = ajaxData.dom + '/file/' + ajaxData.url;

  // 跟随跳转获取真实直链
  try {
    const resp = await fetch(midUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': referer,
      },
    });

    if (resp.status === 302 || resp.status === 301) {
      return resp.headers.get('location') || midUrl;
    }
  } catch (e) {
    // 忽略，返回中转链接
  }

  return midUrl;
}

/**
 * 提取页面中的隐藏参数
 */
function extractHiddenParams(html) {
  const params = {};
  const matches = html.matchAll(/name="([^"]+)"\s+value="([^"]*)"/g);
  for (const m of matches) {
    params[m[1]] = m[2];
  }
  return params;
}

/**
 * 规范化蓝奏云 URL
 */
function normalizeUrl(url) {
  url = url.trim();
  // 将各域名统一为 lanzoui.com
  url = url.replace(/lanzoux\.com|lanzous\.com|lanzoun\.com|lanzoub\.com/, 'lanzoui.com');
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }
  return url;
}

async function fetchText(url, headers = {}) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.text();
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.json();
}
