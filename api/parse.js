// api/parse.js - 蓝奏云直链解析 Vercel Serverless Function
// 更新于 2026-04-23，适配最新参数结构: wp_sign / ajaxdata / websignkey

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, pwd } = req.method === 'POST' ? req.body : req.query;
  if (!url) return res.status(400).json({ code: 400, msg: '缺少 url 参数' });

  try {
    const result = await parseLanzou(url.trim(), pwd || '');
    return res.status(200).json(result);
  } catch (err) {
    console.error('[lanzou]', err.message);
    return res.status(500).json({ code: 500, msg: err.message });
  }
}

async function parseLanzou(shareUrl, pwd = '') {
  const pageUrl = normalizeUrl(shareUrl);
  const baseOrigin = new URL(pageUrl).origin;
  const pageHtml = await get(pageUrl, {
    'User-Agent': UA,
    'Referer': baseOrigin + '/',
  });

  const needPwd =
    pageHtml.includes('id="pwdload"') ||
    pageHtml.includes('id="passwddiv"') ||
    pageHtml.includes('function down_p()');

  if (needPwd && !pwd) {
    return { code: 403, msg: '需要提取码', need_pwd: true };
  }

  let ajaxHtml = pageHtml;
  let ajaxReferer = pageUrl;
  if (!needPwd) {
    const iframeSrc = extractIframeSrc(pageHtml);
    if (iframeSrc) {
      const iframeUrl = toAbsoluteUrl(iframeSrc, pageUrl);
      ajaxHtml = await get(iframeUrl, { 'User-Agent': UA, 'Referer': pageUrl });
      ajaxReferer = iframeUrl;
    }
  }

  const ajaxData = needPwd
    ? await ajaxWithPwd(pageHtml, pageUrl, baseOrigin, pwd)
    : await ajaxDirect(ajaxHtml, ajaxReferer, baseOrigin);

  if (!ajaxData) throw new Error('参数提取失败，页面结构可能已更新');
  if (ajaxData.zt === 0) return { code: 403, msg: '提取码错误', need_pwd: true };
  if (ajaxData.zt !== 1) throw new Error(`ajaxm 响应异常: zt=${ajaxData.zt}, inf=${ajaxData.inf}`);

  const midUrl = buildMidUrl(ajaxData, pageUrl);
  const finalUrl = await follow302(midUrl, pageUrl);
  return { code: 200, msg: 'ok', name: ajaxData.inf || '', url: finalUrl, need_pwd: false };
}

async function ajaxDirect(html, referer, origin) {
  const params = extractAjaxParams(html);
  if (!params) return null;

  const body = new URLSearchParams({
    action: 'downprocess',
    websignkey: params.ajaxdata,
    signs: params.ajaxdata,
    sign: params.wp_sign,
    websign: params.websign || '',
    kd: 1,
    ves: 1,
  });

  return postAjax(origin + params.ajaxUrl, body.toString(), referer);
}

async function ajaxWithPwd(html, pageUrl, origin, pwd) {
  const sign = extractSign(html);
  if (!sign) return null;

  const fileMatch = html.match(/ajaxm\.php\?file=(\d+)/);
  const ajaxUrl = fileMatch ? `/ajaxm.php?file=${fileMatch[1]}` : '/ajaxm.php';

  const body = new URLSearchParams({
    action: 'downprocess',
    sign,
    p: pwd,
  });

  return postAjax(origin + ajaxUrl, body.toString(), pageUrl);
}

function extractAjaxParams(html) {
  let wpSign = (html.match(/var\s+wp_sign\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  if (!wpSign) {
    wpSign = (html.match(/var\s+skdklds\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  }

  const ajaxdata =
    (html.match(/var\s+ajaxdata\s*=\s*['"]([^'"]+)['"]/) || [])[1] ||
    (html.match(/var\s+websignkey\s*=\s*['"]([^'"]+)['"]/) || [])[1] ||
    '';

  const websign = (html.match(/var\s+websign\s*=\s*['"]([^'"]*)['"]/) || ['', ''])[1];
  const ajaxUrlMatch = html.match(/url\s*:\s*['"](\/?ajaxm\.php[^'"]*)['"]/);
  const ajaxUrl = ajaxUrlMatch ? ajaxUrlMatch[1] : '/ajaxm.php';
  if (!wpSign) return null;

  return { wp_sign: wpSign, ajaxdata, websign, ajaxUrl };
}

function extractIframeSrc(html) {
  const m = html.match(/<iframe[^>]+src=['"]([^'"]+)['"]/i);
  return m ? m[1] : null;
}

function extractSign(html) {
  const patterns = [
    /var\s+skdklds\s*=\s*['"]([^'"]+)['"]/,
    /var\s+wp_sign\s*=\s*['"]([^'"]+)['"]/,
    /['"]sign['"]\s*:\s*['"]([^'"]+)['"]/,
    /sign\s*=\s*['"]([^'"]+)['"]/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return match[1];
  }
  return '';
}

function toAbsoluteUrl(rawUrl, baseUrl) {
  if (!rawUrl) return '';
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  return new URL(rawUrl, baseUrl).toString();
}

function buildMidUrl(ajaxData, referer) {
  const base = ajaxData.dom ? toAbsoluteUrl(ajaxData.dom, referer) : new URL(referer).origin;
  const path = (ajaxData.url || '').replace(/^\/+/, '');
  return `${base.replace(/\/+$/, '')}/file/${path}`;
}

async function postAjax(url, body, referer) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': referer,
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });
  if (!resp.ok) throw new Error(`ajaxm.php HTTP ${resp.status}`);
  return resp.json();
}

async function follow302(url, referer) {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Referer': referer, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const loc = resp.headers.get('location');
    if ((resp.status === 301 || resp.status === 302) && loc) return loc;
  } catch (_) {}
  return url;
}

async function get(url, headers = {}) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`GET ${url} → HTTP ${resp.status}`);
  return resp.text();
}

function normalizeUrl(url) {
  url = url.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  return url;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
