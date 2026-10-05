// 网盘分享解析：蓝奏云（不需要登录）、夸克网盘、百度网盘（下载时需要登录自己的账号）。
// 粘贴分享链接或整段分享文案即可，提取码写在后面，例如：https://xxx.lanzoui.com/abc 密码:1234
//
// 夸克和百度的分享文件不能直接下载：插件会把选中的文件转存到你自己网盘的“随身下载临时转存”目录，
// 再取下载地址；这些临时副本会在 6 小时后、下次使用插件时自动清理。
// 接口说明见 docs/插件开发说明.md

const meta = {
  id: "netdisk.share",
  name: "网盘解析",
  version: "1.5",
  author: "ssxz",
  description: "解析蓝奏云、夸克网盘、百度网盘的分享链接（支持文件夹和提取码），取出文件并下载",
  // 蓝奏云的域名很多且经常更换，用通配符覆盖
  hosts: [
    "lanzou*.com", "woozooo.com", "lanrar.com", "lanzn.com", "lanpw.com", "lanpv.com", "lanwp.com",
    "quark.cn", "baidu.com",
  ],
  clipboard: [
    "lanzou*.com", "woozooo.com", "lanzn.com", "lanpw.com", "lanpv.com", "lanwp.com",
    "pan.quark.cn", "pan.baidu.com", "yun.baidu.com",
  ],
  // 需要登录的网盘：用户在应用内的网页里登录，应用把登录状态（Cookie）保存给本插件使用
  logins: [
    {
      id: "quark",
      name: "夸克网盘",
      url: "https://pan.quark.cn/",
      required: ["__pus", "__puus"],
      // 夸克的网页版只在桌面浏览器里提供登录
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    },
    { id: "baidu", name: "百度网盘", url: "https://pan.baidu.com/", required: ["BDUSS"] },
  ],
};

// 转存用的临时目录名，以及临时副本保留多久（毫秒）
// 网盘对同一文件的并发连接很敏感（容易被拒绝或限速），所以下载不做多线程
const MULTI_THREAD = false;
const TEMP_DIR = "随身下载临时转存";
const TEMP_KEEP = 6 * 3600 * 1000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_PAGES = 6;   // 文件夹最多取 6 页（每页约 50 个文件）

function headers(referer) {
  const h = { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" };
  if (referer) h.Referer = referer;
  return h;
}

function formBody(fields) {
  return Object.keys(fields).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(fields[k])).join("&");
}

async function post(url, fields, referer) {
  const h = headers(referer);
  h["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  h["X-Requested-With"] = "XMLHttpRequest";
  const text = await http.post(url, formBody(fields), h);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("蓝奏返回了验证页面，请稍后再试");
  }
}

// ---- 从分享文案里取链接和提取码 ----

function extractLink(text) {
  const match = /https?:\/\/[A-Za-z0-9.-]+\/[^\s，。；！、【】《》<>"']+/.exec(String(text || ""));
  if (!match) return null;
  // 链接后面紧跟着“密码xxxx”之类的文字时截掉
  return match[0].replace(/(提取码|访问码|密码|口令).*$/, "").replace(/[)）\]】,，。;；!！]+$/, "");
}

function extractCode(text, link) {
  const query = /[?&](?:pwd|pass|passcode|password)=([A-Za-z0-9]{1,12})/i.exec(link || "");
  if (query) return query[1];
  const match = /(?:提取码|访问码|密码|口令|pwd)\s*(?:为|是)?\s*[:：=]?\s*[【\[(（]?\s*([A-Za-z0-9]{1,12})/i.exec(String(text || ""));
  return match ? match[1] : "";
}

// ---- 读页面里的脚本变量（只读取，不执行页面脚本） ----

function pageScript(page) {
  const blocks = html.select(page, "script").map((s) => s.html);
  return blocks.join("\n").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
}

function variables(script) {
  const vars = {};
  const re = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:'([^'\\]*)'|"([^"\\]*)")/g;
  let m;
  while ((m = re.exec(script))) {
    const value = m[2] !== undefined ? m[2] : m[3];
    if (value) vars[m[1]] = value;
  }
  const num = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(\d+)\s*[;,]/g;
  while ((m = num.exec(script))) {
    if (!(m[1] in vars)) vars[m[1]] = m[2];
  }
  return vars;
}

// 解析 data: { 'a': 1, 'b': name } 这样的对象，变量名换成它的值
function properties(source, vars) {
  const out = {};
  const re = /['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*('[^']*'|"[^"]*"|[A-Za-z_$][\w$]*|\d+)/g;
  let m;
  while ((m = re.exec(source))) {
    const token = m[2];
    if (token[0] === "'" || token[0] === '"') out[m[1]] = token.slice(1, -1);
    else if (/^\d+$/.test(token)) out[m[1]] = token;
    else if (token in vars) out[m[1]] = vars[token];
  }
  return out;
}

function dataObjects(script, vars) {
  const list = [];
  const re = /\bdata\s*:\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(script))) list.push(properties(m[1], vars));
  return list;
}

function unavailable(page) {
  return /文件(?:夹)?取消分享了|文件(?:夹)?不存在|文件(?:夹)?已取消分享|来晚了/.test(page);
}

// ---- 文件夹 ----

async function listFolder(link, origin, page, script, code) {
  const vars = variables(script);
  const fields = dataObjects(script, vars).filter((o) => o.lx && o.fid && o.t && o.k).pop();
  const urlMatch = /url\s*:\s*['"]([^'"]*filemoreajax\.php[^'"]*)['"]/.exec(script);
  if (!fields || !urlMatch) throw new Error("蓝奏文件夹页面格式已变化，暂时无法解析");
  const needCode = /id="pwdload"|id="passwddiv"|type="password"/.test(page);
  if (needCode && !code) throw new Error("这个分享需要提取码，请在链接后面加上“密码:xxxx”再解析");
  const api = origin + (urlMatch[1][0] === "/" ? "" : "/") + urlMatch[1];

  const result = [];
  let retries = 0;
  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    if (pg > 1) await util.sleep(700);
    const data = await post(api, Object.assign({}, fields, { pg: String(pg), pwd: code }), link);
    const status = Number(data.zt);
    if (status === 3) throw new Error("提取码错误，请检查后重试");
    if (status === 4) {
      // 请求太快，稍等后重试这一页
      if (++retries > 2) break;
      await util.sleep(1500);
      pg--;
      continue;
    }
    if (status !== 1 || !Array.isArray(data.text) || !data.text.length) break;
    data.text.forEach((row) => {
      if (!/^i[A-Za-z0-9]+$/.test(String(row.id || ""))) return;
      result.push({
        title: row.name_all || row.name || row.id,
        subtitle: [row.size, row.time].filter(Boolean).join(" · "),
        fileUrl: origin + "/" + row.id,   // 自定义字段，点击时传回 detail()
      });
    });
    if (data.text.length < 50) break;
  }
  if (!result.length) throw new Error("文件夹里没有文件，或提取码不正确");
  return result;
}

// ---- 单个文件：取下载参数 → 取文件地址 → 交给浏览器走完验证 ----

async function fileDownload(fileUrl, code, knownName) {
  const origin = /^https?:\/\/[^\/]+/.exec(fileUrl)[0];
  let page = await http.get(fileUrl, headers());
  if (unavailable(page)) throw new Error("文件已取消分享或不存在");
  let script = pageScript(page);
  let frameUrl = fileUrl;
  const title = /<title>([^<]*)<\/title>/.exec(page);
  let name = knownName || (title ? title[1].replace(/\s*[-—|]\s*蓝奏.*$/, "").trim() : "");

  const needCode = /function\s+down_p\s*\(/.test(script) || /type="password"/.test(page);
  if (!needCode) {
    // 没有提取码的文件，下载参数在内嵌的 iframe 页面里
    const frame = html.select(page, "iframe[src]").map((f) => f.attrs.src).filter(Boolean)[0];
    if (frame) {
      frameUrl = origin + (frame[0] === "/" ? "" : "/") + frame;
      page = await http.get(frameUrl, headers(fileUrl));
      script = pageScript(page);
    }
  } else if (!code) {
    throw new Error("这个文件需要提取码，请在链接后面加上“密码:xxxx”再解析");
  }

  const vars = variables(script);
  const params = dataObjects(script, vars).filter((o) => o.action === "downprocess" && o.sign).pop() || {};
  if (!params.sign && vars.wp_sign) params.sign = vars.wp_sign;
  // 请求地址可能直接写在 url 里，也可能放在 domain1 / domain2 这样的变量里
  const apis = [];
  const direct = /url\s*:\s*['"]([^'"]*ajax(?:m|file)\.php\?file=\d+)['"]/.exec(script);
  if (direct) apis.push(direct[1].indexOf("http") === 0 ? direct[1] : origin + (direct[1][0] === "/" ? "" : "/") + direct[1]);
  Object.keys(vars).forEach((key) => {
    if (/^https?:\/\/[^\/]+\/ajax(?:m|file)\.php\?file=\d+$/.test(vars[key])) apis.push(vars[key]);
  });
  if (!params.sign || !apis.length) throw new Error("蓝奏分享页面格式已变化，暂时无法解析");

  const fields = needCode
    ? { action: "downprocess", sign: params.sign, p: code, kd: "1" }
    : {
        action: "downprocess",
        sign: params.sign,
        signs: vars.ajaxdata || params.signs || "",
        websignkey: params.websignkey || vars.ajaxdata || "",
        websign: params.websign || "",
        kd: "1",
        ves: "1",
      };

  let data = null;
  let lastError = null;
  for (const api of apis) {
    try {
      data = await post(api, fields, frameUrl);
      if (Number(data.zt) === 1) break;
      lastError = new Error(data.inf && typeof data.inf === "string" ? data.inf : "提取码错误或链接已失效");
      data = null;
    } catch (e) {
      lastError = e;
    }
  }
  if (!data) throw lastError || new Error("获取下载地址失败");
  if (data.inf && typeof data.inf === "string" && /\.\w{1,8}$/.test(data.inf)) name = data.inf;

  // 这个地址前面有一道浏览器验证，交给应用内的浏览器去走，拿到最终的文件地址
  const file = await web.download(data.dom + "/file/" + data.url, { referer: frameUrl, timeout: 25000 });
  const requestHeaders = { "Accept-Language": "zh-CN,zh;q=0.9" };
  if (file.userAgent) requestHeaders["User-Agent"] = file.userAgent;
  if (file.cookie) requestHeaders.Cookie = file.cookie;
  return {
    name: name || file.filename || "蓝奏文件",
    url: file.url,
    headers: requestHeaders,
  };
}

function fileItem(title, subtitle, file) {
  return {
    title: title,
    subtitle: subtitle,
    action: { type: "download", url: file.url, filename: file.name, headers: file.headers, multiThread: MULTI_THREAD, label: "下载" },
  };
}

// ======================================================================== 夸克网盘

const QUARK_API = "https://drive-pc.quark.cn/1/clouddrive/";
const QUARK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 quark-cloud-drive/2.5.20";

function quarkHeaders(cookie) {
  const h = {
    "User-Agent": QUARK_UA,
    "Origin": "https://pan.quark.cn",
    "Referer": "https://pan.quark.cn/",
    "Content-Type": "application/json;charset=UTF-8",
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

function queryString(params) {
  return Object.keys(params).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&");
}

// 调用夸克接口并返回 data；登录失效时提示重新登录
async function quarkCall(method, path, params, body, cookie) {
  const url = QUARK_API + path + "?" + queryString(Object.assign({ pr: "ucpro", fr: "pc" }, params || {}));
  const options = { url: url, method: method, headers: quarkHeaders(cookie) };
  if (body) options.body = JSON.stringify(body);
  const response = await http.request(options);
  let json = null;
  try {
    json = JSON.parse(response.body);
  } catch (e) {}
  if (response.status === 401 || (json && (json.status === 401 || json.code === 31001))) {
    if (cookie) auth.expire("quark");
    auth.require("quark");
  }
  if (!json) throw new Error("夸克请求失败（" + response.status + "）");
  const ok = json.status === 200 || json.code === 0;
  if (!ok) throw new Error(json.message || "夸克请求失败（" + (json.code || response.status) + "）");
  return json.data || {};
}

function quarkTime(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function sizeText(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "";
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

// 列出分享里某个目录下的文件（不需要登录）
async function quarkList(share, parent) {
  const result = [];
  for (let page = 1; page <= 5; page++) {
    const data = await quarkCall("GET", "share/sharepage/detail", {
      pwd_id: share.shareId,
      stoken: share.stoken,
      pdir_fid: parent,
      force: 0,
      _page: page,
      _size: 100,
      _fetch_total: 1,
      _sort: "file_type:asc,file_name:asc",
      ver: 2,
    }, null, auth.cookie("quark"));
    const list = Array.isArray(data.list) ? data.list : [];
    list.forEach((f) => {
      if (!f.fid) return;
      const isDir = f.dir === true || f.dir === 1 || f.file_type === 0;
      result.push({
        title: f.file_name || f.fid,
        subtitle: [isDir ? "文件夹" : sizeText(f.size), quarkTime(f.updated_at)].filter(Boolean).join(" · "),
        folder: isDir,
        kind: "quark",
        shareId: share.shareId,
        stoken: share.stoken,
        fid: f.fid,
        token: f.share_fid_token || "",
        parent: parent,
      });
    });
    if (list.length < 100) break;
  }
  return result;
}

async function quarkResolve(link, code) {
  const id = /\/s\/([A-Za-z0-9]+)/.exec(link);
  if (!id) throw new Error("夸克分享链接格式不对");
  let data;
  try {
    data = await quarkCall("POST", "share/sharepage/token", {}, {
      pwd_id: id[1],
      passcode: code || "",
      support_visit_limit_private_share: true,
    }, auth.cookie("quark"));
  } catch (e) {
    const message = String((e && e.message) || e);
    if (/提取码/.test(message) && !code) throw new Error("这个分享需要提取码，请在链接后面加上“提取码:xxxx”再解析");
    throw e;
  }
  if (!data.stoken) throw new Error("夸克没有返回分享凭证，链接可能已失效");
  const files = await quarkList({ shareId: id[1], stoken: data.stoken }, "0");
  if (!files.length) throw new Error("分享里没有文件");
  return files;
}

// 在自己网盘的某个目录下列出子项（需要登录）
async function quarkOwnList(parent, cookie) {
  const result = [];
  for (let page = 1; page <= 5; page++) {
    const data = await quarkCall("GET", "file/sort", {
      pdir_fid: parent,
      _page: page,
      _size: 100,
      _fetch_total: 1,
      _sort: "file_type:asc,updated_at:desc",
    }, null, cookie);
    const list = Array.isArray(data.list) ? data.list : [];
    list.forEach((f) => result.push(f));
    if (list.length < 100) break;
  }
  return result;
}

async function quarkMkdir(parent, name, cookie) {
  const data = await quarkCall("POST", "file", {}, {
    pdir_fid: parent,
    file_name: name,
    dir_path: "",
    dir_init_lock: false,
  }, cookie);
  if (!data.fid) throw new Error("夸克创建临时目录失败");
  return data.fid;
}

async function quarkTask(taskId, cookie) {
  for (let i = 0; i < 25; i++) {
    const data = await quarkCall("GET", "task", { task_id: taskId, retry_index: i }, null, cookie);
    if (data.status === 3 || data.status === 4) throw new Error(data.message || "夸克转存失败");
    if (data.status === 2 || data.finished_at > 0) return data;
    await util.sleep(800);
  }
  throw new Error("夸克转存超时，请稍后再试");
}

// 取下载地址：转存到自己网盘的临时目录 → 取直链
async function quarkDownload(item) {
  const cookie = auth.require("quark");

  // 找到（或创建）临时目录
  const root = await quarkOwnList("0", cookie);
  const existing = root.filter((f) => (f.dir === true || f.file_type === 0) && f.file_name === TEMP_DIR)[0];
  const tempRoot = existing ? existing.fid : await quarkMkdir("0", TEMP_DIR, cookie);

  // 清理以前留下的、已超过保留时间的临时副本。只删本插件自己建的 tr_<时间戳> 目录
  if (existing) {
    try {
      const old = (await quarkOwnList(tempRoot, cookie)).filter((f) => {
        const m = /^tr_(\d{13})$/.exec(f.file_name || "");
        return m && Date.now() - Number(m[1]) > TEMP_KEEP;
      }).map((f) => f.fid);
      if (old.length) {
        await quarkCall("POST", "file/delete", {}, { action_type: 2, filelist: old, exclude_fids: [] }, cookie);
      }
    } catch (e) {
      log("清理夸克临时目录失败", String((e && e.message) || e));
    }
  }

  const target = await quarkMkdir(tempRoot, "tr_" + Date.now(), cookie);
  const save = await quarkCall("POST", "share/sharepage/save", {}, {
    pwd_id: item.shareId,
    stoken: item.stoken,
    pdir_fid: item.parent || "0",
    to_pdir_fid: target,
    fid_list: [item.fid],
    fid_token_list: [item.token],
    scene: "link",
  }, cookie);
  if (!save.task_id) throw new Error("夸克转存没有返回任务，分享可能已失效");
  const task = await quarkTask(save.task_id, cookie);
  const saved = ((task.save_as || {}).save_as_top_fids || [])[0];
  if (!saved) throw new Error("夸克转存完成但没有返回文件");

  const data = await quarkCall("POST", "file/download", { sys: "win32", ve: "3.23.2" }, { fids: [saved] }, cookie);
  const list = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : [data]);
  const file = list.filter((f) => f && (f.download_url || f.url))[0];
  if (!file) throw new Error("夸克没有返回下载地址（大文件可能需要会员或客户端）");
  return [{
    title: item.title,
    subtitle: item.subtitle || "",
    action: {
      type: "download",
      url: file.download_url || file.url,
      filename: file.file_name || item.title,
      headers: { "Cookie": cookie, "User-Agent": QUARK_UA, "Referer": "https://pan.quark.cn/" },
      multiThread: MULTI_THREAD,
      label: "下载",
    },
  }];
}

// ======================================================================== 百度网盘

const BAIDU_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BAIDU_APP = "250528";

// 把分享凭证放进 Cookie 的 BDCLND 里（去掉原来的同名项）
function baiduCookie(cookie, sekey) {
  const pairs = String(cookie || "").split(";").map((p) => p.trim()).filter((p) => p && !/^BDCLND=/i.test(p));
  if (sekey) pairs.push("BDCLND=" + encodeURIComponent(sekey));
  return pairs.join("; ");
}

function baiduMessage(json, fallback) {
  const errno = Number(json.errno !== undefined ? json.errno : json.error_code);
  const text = json.err_msg || json.show_msg || json.errmsg || json.error_msg || "";
  if (text && text !== "success") return text;
  if (errno === -12) return "提取码错误，请检查后重试";
  if (errno === -9 || errno === 31066) return "文件或分享已失效";
  if (errno === 12) return "转存失败：文件已存在或超出单次转存数量";
  if (errno === -10 || errno === 20) return "网盘空间不足或需要验证，请到百度网盘里处理后再试";
  return fallback + "（errno=" + errno + "）";
}

// 调用百度接口；errno 为 -6 说明登录失效。allow 里的 errno 也算成功
async function baiduCall(options, loggedIn, fallback, allow) {
  const response = await http.request(options);
  let json = null;
  try {
    json = JSON.parse(response.body);
  } catch (e) {}
  if (response.status === 401 || (json && Number(json.errno) === -6)) {
    if (loggedIn) auth.expire("baidu");
    auth.require("baidu");
  }
  if (!json) throw new Error(fallback + "（" + response.status + "）");
  const errno = Number(json.errno !== undefined ? json.errno : (json.error_code !== undefined ? json.error_code : 0));
  if (errno !== 0 && !(allow || []).includes(errno)) {
    const error = new Error(baiduMessage(json, fallback));
    error.errno = errno;
    throw error;
  }
  return json;
}

async function baiduShareList(share, dir) {
  const cookie = auth.cookie("baidu") || "";
  const result = [];
  let info = null;
  for (let page = 1; page <= 5; page++) {
    const params = {
      method: "list",
      shorturl: share.surl,
      page: page,
      num: 100,
      root: dir === "/" ? 1 : 0,
      dir: dir,
    };
    if (share.sekey) params.sekey = share.sekey;
    let json;
    try {
      json = await baiduCall({
        url: "https://pan.baidu.com/rest/2.0/xpan/share?" + queryString(params),
        headers: {
          "User-Agent": BAIDU_UA,
          "Referer": "https://pan.baidu.com/s/1" + share.surl,
          "Cookie": baiduCookie(cookie, share.sekey),
        },
      }, false, "百度分享列表获取失败");
    } catch (e) {
      // 没带提取码时百度返回的是 -9（与“分享已失效”同一个错误码）
      if (!share.sekey && (e.errno === -12 || e.errno === 2 || e.errno === -9)) {
        throw new Error("这个分享需要提取码（或已失效），请在链接后面加上“提取码:xxxx”再解析");
      }
      throw e;
    }
    if (!info) info = json;
    const list = Array.isArray(json.list) ? json.list : [];
    list.forEach((f) => {
      const isDir = Number(f.isdir) === 1;
      result.push({
        title: f.server_filename || f.path,
        subtitle: isDir ? "文件夹" : sizeText(f.size),
        folder: isDir,
        kind: "baidu",
        surl: share.surl,
        sekey: share.sekey,
        shareId: String(share.shareId || json.share_id || ""),
        uk: String(share.uk || json.uk || ""),
        fsId: String(f.fs_id || ""),
        path: f.path,
      });
    });
    if (list.length < 100) break;
  }
  return result;
}

async function baiduResolve(link, code) {
  const query = /[?&]surl=([A-Za-z0-9_-]+)/.exec(link);
  const path = /\/s\/[A-Za-z0-9_-]([A-Za-z0-9_-]+)/.exec(link);
  const surl = query ? query[1] : (path ? path[1] : "");
  if (!surl) throw new Error("百度分享链接格式不对");

  let sekey = "";
  if (code) {
    const json = await baiduCall({
      url: "https://pan.baidu.com/share/verify?surl=" + encodeURIComponent(surl),
      method: "POST",
      body: formBody({ pwd: code, vcode_str: "", vcode: "" }),
      headers: {
        "User-Agent": BAIDU_UA,
        "Referer": "https://pan.baidu.com/s/1" + surl,
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": auth.cookie("baidu") || "",
      },
    }, false, "百度提取码验证失败");
    // 返回的凭证是 URL 编码过的，这里还原成原文
    sekey = decodeURIComponent(json.randsk || "");
    if (!sekey) throw new Error("百度没有返回分享凭证");
  }
  const files = await baiduShareList({ surl: surl, sekey: sekey }, "/");
  if (!files.length) throw new Error("分享里没有文件");
  return files;
}

function baiduWebHeaders(cookie) {
  return { "Cookie": cookie, "User-Agent": BAIDU_UA, "Referer": "https://pan.baidu.com/disk/main" };
}

async function baiduToken(cookie) {
  const json = await baiduCall({
    url: "https://pan.baidu.com/api/gettemplatevariable?" + queryString({
      clienttype: 0, app_id: BAIDU_APP, web: 1, fields: '["bdstoken"]',
    }),
    headers: baiduWebHeaders(cookie),
  }, true, "获取百度会话失败");
  const token = (json.result || {}).bdstoken;
  if (!token) auth.expire("baidu");
  return token;
}

async function baiduMkdir(path, cookie, token) {
  const json = await baiduCall({
    url: "https://pan.baidu.com/api/create?" + queryString({
      a: "commit", channel: "chunlei", web: 1, app_id: BAIDU_APP, clienttype: 0, bdstoken: token,
    }),
    method: "POST",
    body: formBody({ path: path, isdir: 1, size: "", block_list: "[]", method: "post", dataType: "json" }),
    headers: Object.assign({ "Content-Type": "application/x-www-form-urlencoded" }, baiduWebHeaders(cookie)),
  }, true, "百度创建临时目录失败");
  // 重名时百度可能自动改名，以返回的实际路径为准
  return json.path || path;
}

// 取下载地址：转存到自己网盘的临时目录 → 取直链
async function baiduDownload(item) {
  const cookie = auth.require("baidu");
  if (!/^\d+$/.test(item.fsId) || !item.shareId || !item.uk) throw new Error("百度分享信息不完整，请重新解析链接");
  const token = await baiduToken(cookie);
  const root = "/" + TEMP_DIR;

  // 临时目录是否已存在；顺便清理超过保留时间的旧副本。只删本插件自己建的 /随身下载临时转存/tr_<时间戳>
  const listing = await baiduCall({
    url: "https://pan.baidu.com/api/list?" + queryString({
      channel: "chunlei", clienttype: 0, app_id: BAIDU_APP, web: 1, order: "time", desc: 1, dir: root, num: 200, page: 1,
    }),
    headers: baiduWebHeaders(cookie),
  }, true, "读取百度临时目录失败", [-9]);
  if (Number(listing.errno) === -9) {
    await baiduMkdir(root, cookie, token);
  } else {
    const old = (listing.list || []).map((f) => f.path).filter((p) => {
      const m = new RegExp("^/" + TEMP_DIR + "/tr_(\\d{13})$").exec(p || "");
      return m && Date.now() - Number(m[1]) > TEMP_KEEP;
    });
    if (old.length) {
      try {
        await baiduCall({
          url: "https://pan.baidu.com/api/filemanager?" + queryString({
            async: 2, onnest: "fail", opera: "delete", bdstoken: token, newVerify: 1,
            clienttype: 0, app_id: BAIDU_APP, web: 1,
          }),
          method: "POST",
          body: formBody({ filelist: JSON.stringify(old) }),
          headers: Object.assign({ "Content-Type": "application/x-www-form-urlencoded" }, baiduWebHeaders(cookie)),
        }, true, "清理百度临时目录失败");
      } catch (e) {
        log("清理百度临时目录失败", String((e && e.message) || e));
      }
    }
  }

  const target = await baiduMkdir(root + "/tr_" + Date.now(), cookie, token);
  const params = {
    shareid: item.shareId, from: item.uk, channel: "chunlei", ondup: "newcopy",
    web: 1, app_id: BAIDU_APP, bdstoken: token, clienttype: 0,
  };
  if (item.sekey) params.sekey = item.sekey;
  const transfer = await baiduCall({
    url: "https://pan.baidu.com/share/transfer?" + queryString(params),
    method: "POST",
    body: formBody({ fsidlist: "[" + item.fsId + "]", path: target }),
    headers: {
      "Cookie": baiduCookie(cookie, item.sekey),
      "User-Agent": BAIDU_UA,
      "Origin": "https://pan.baidu.com",
      "Referer": "https://pan.baidu.com/s/1" + item.surl,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  }, true, "百度转存失败");
  const saved = ((transfer.extra || {}).list || [])[0];
  if (!saved || !saved.to_fs_id) throw new Error("百度转存没有返回文件信息");

  const metas = await baiduCall({
    url: "https://pan.baidu.com/api/filemetas?" + queryString({
      dlink: 1, fsids: "[" + saved.to_fs_id + "]", bdstoken: token, clienttype: 0, app_id: BAIDU_APP, web: 1,
    }),
    headers: baiduWebHeaders(cookie),
  }, true, "获取百度下载地址失败");
  const dlink = ((metas.info || [])[0] || {}).dlink;
  if (!dlink) throw new Error("百度没有返回下载地址");
  const savedPath = saved.to || (target + "/" + item.title);
  const found = await baiduDownloadTarget(dlink, savedPath, cookie);
  return [{
    title: item.title,
    subtitle: item.subtitle || "",
    action: { type: "download", url: found.url, filename: item.title, headers: found.headers, multiThread: MULTI_THREAD, label: "下载" },
  }];
}

// 百度的下载服务器对“哪个地址 + 哪些登录凭证 + 哪种客户端标识”很挑剔，而且会变。
// 这里把几种组合各请求 1 个字节试一遍，返回第一组能用的；都不行就把百度给的原因报出来
const BAIDU_DOWNLOAD_UA = ["netdisk;P2SP;3.0.20.138", "pan.baidu.com", "netdisk"];
const BAIDU_PCS_APP = ["250528", "266719", "778750"];

async function baiduDownloadTarget(dlink, path, cookie) {
  const pairs = String(cookie || "").split(";").map((p) => p.trim()).filter((p) => /^[\x21-\x7e]+$/.test(p));
  const pick = (re) => pairs.filter((p) => re.test(p)).join("; ");
  // 下载服务器在另一个域名下：网盘页面的 STOKEN 对它无效，带上反而可能校验失败，所以先只带 BDUSS
  const cookies = [pick(/^BDUSS=/i), pick(/^(BDUSS|BDUSS_BFESS|STOKEN|BAIDUID)=/i)].filter((c, i, all) => c && all.indexOf(c) === i);
  // 按文件路径取文件的接口实测可用，排在前面；网页接口给的 dlink 目前会报 sign error，留作后备
  const byPath = BAIDU_PCS_APP.map((app) =>
    "https://d.pcs.baidu.com/rest/2.0/pcs/file?" + queryString({ method: "download", app_id: app, path: path }));
  const urls = [byPath[0], dlink].concat(byPath.slice(1));
  const failures = [];
  for (let u = 0; u < urls.length; u++) {
    for (let c = 0; c < cookies.length; c++) {
      for (const ua of BAIDU_DOWNLOAD_UA) {
        const headers = { "Cookie": cookies[c], "User-Agent": ua };
        let reason = "";
        try {
          const response = await http.request({
            url: urls[u], followRedirects: false,
            headers: Object.assign({ "Range": "bytes=0-0" }, headers),
          });
          if (response.status >= 200 && response.status < 400) return { url: urls[u], headers: headers };
          try {
            const json = JSON.parse(response.body);
            reason = (json.error_msg || json.errmsg || "") + (json.error_code ? "（" + json.error_code + "）" : "");
          } catch (e) {}
          reason = reason || ("HTTP " + response.status);
        } catch (e) {
          reason = String((e && e.message) || e);
        }
        failures.push(reason);
        log("百度下载试探失败", "地址" + u, "凭证" + c, ua, reason);
      }
    }
  }
  throw new Error("百度拒绝了下载请求：" + (failures[0] || "未知原因"));
}

// ======================================================================== 入口

function hostOf(link) {
  const m = /^https?:\/\/([^\/?#]+)/.exec(link);
  return m ? m[1].toLowerCase() : "";
}

// 粘贴的可能是整段分享文案
async function resolve(text) {
  const link = extractLink(text);
  if (!link) throw new Error("没有识别到分享链接");
  const code = extractCode(text, link);
  const host = hostOf(link);
  if (/(^|\.)quark\.cn$/.test(host)) return await quarkResolve(link, code);
  if (/(^|\.)baidu\.com$/.test(host)) return await baiduResolve(link, code);

  // 蓝奏云
  const origin = /^https?:\/\/[^\/]+/.exec(link)[0];
  const page = await http.get(link, headers());
  if (unavailable(page)) throw new Error("分享已取消或不存在");
  const script = pageScript(page);
  if (/filemoreajax\.php/.test(script)) {
    const files = await listFolder(link, origin, page, script, code);
    // 把提取码带到每个文件上（文件夹里的文件通常不再单独要提取码）
    files.forEach((f) => { f.code = code; });
    return files;
  }
  const file = await fileDownload(link, code, "");
  return [fileItem(file.name, "蓝奏云", file)];
}

// 点击某一项时调用：文件夹返回它的子项；文件才去取下载地址（地址有时效，不能提前取）
async function detail(item) {
  if (item.kind === "quark") {
    return item.folder
      ? await quarkList({ shareId: item.shareId, stoken: item.stoken }, item.fid)
      : await quarkDownload(item);
  }
  if (item.kind === "baidu") {
    return item.folder
      ? await baiduShareList({ surl: item.surl, sekey: item.sekey, shareId: item.shareId, uk: item.uk }, item.path)
      : await baiduDownload(item);
  }
  const file = await fileDownload(item.fileUrl, item.code || "", item.title);
  return [fileItem(file.name, item.subtitle || "", file)];
}
