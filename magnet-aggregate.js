// 磁力聚合搜索：同时搜索“磁力王”和“天天磁力”，合并去重后返回磁力链接。
// 接口说明见 docs/插件开发说明.md

const meta = {
  id: "magnet.aggregate",
  name: "磁力聚合",
  version: "1.0",
  author: "ssxz",
  description: "聚合搜索 磁力王、天天磁力 两个站点的磁力链接",
  hosts: ["ciliwang360.shop", "ttbt.me", "ttbt.top"],
};

const CILIWANG = "https://www.ciliwang360.shop";
const TTBT_ENTRY = "https://d2.ttbt.me/";
const TTBT_FALLBACK = "https://so.ttbt.top";

function magnet(hash, name) {
  return "magnet:?xt=urn:btih:" + hash + "&dn=" + encodeURIComponent(name);
}

function stripTags(text) {
  return String(text || "").replace(/<[^>]+>/g, "").trim();
}

// 磁力王返回的大小单位是 KB
function sizeFromKb(kb) {
  const n = Number(kb || 0);
  if (!n) return "";
  if (n >= 1048576) return (n / 1048576).toFixed(2) + " GB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " MB";
  return n + " KB";
}

// ---- 磁力王：结果由 /api/ssbc 接口以 JSON 返回，from 是页码 ----
async function searchCiliwang(keyword, page) {
  const body = "key=" + encodeURIComponent(keyword) + "&type=all&from=" + page;
  const text = await http.post(CILIWANG + "/api/ssbc", body, {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": CILIWANG + "/list.html",
  });
  const list = (((JSON.parse(text) || {}).data || {}).infos || {}).torrent || [];
  return list
    .filter((t) => /^[0-9a-fA-F]{40}$/.test(t.infohash || ""))
    .map((t) => {
      const name = t.name_simple || stripTags(t.name_IK) || t.infohash;
      const parts = [sizeFromKb(t.size), t.createdate, "磁力王"].filter(Boolean);
      return {
        title: name,
        subtitle: parts.join(" · "),
        hash: t.infohash.toLowerCase(),
        action: { type: "magnet", url: magnet(t.infohash, name) },
      };
    });
}

// ---- 天天磁力：入口页用 iframe 套了真正的搜索站，地址写在一段 base64 里 ----
async function ttbtBase() {
  const cached = storage.get("ttbt_base");
  const cachedAt = Number(storage.get("ttbt_base_at") || 0);
  if (cached && Date.now() - cachedAt < 6 * 3600 * 1000) return cached;
  let base = TTBT_FALLBACK;
  try {
    const entry = await http.get(TTBT_ENTRY);
    const match = /atob\(\s*["']([A-Za-z0-9+\/=]+)["']\s*\)/.exec(entry);
    const decoded = match ? util.base64Decode(match[1]).trim() : "";
    if (/^https?:\/\/[^\/]+$/.test(decoded)) base = decoded;
  } catch (e) {
    log("天天磁力入口读取失败，使用备用地址", String(e && e.message || e));
  }
  storage.set("ttbt_base", base);
  storage.set("ttbt_base_at", String(Date.now()));
  return base;
}

// 结果页是 HTML：每条结果的详情链接 /detail/<40 位 hash> 里就带着磁力特征码
async function searchTtbt(keyword, page) {
  const base = await ttbtBase();
  const url = base + "/list.php?key=" + encodeURIComponent(keyword) + "&page=" + page + "&ap=1";
  const doc = await http.get(url, { Referer: base + "/" });
  const result = [];
  for (const card of html.select(doc, "div.card.border-dashed")) {
    const link = html.select(card.html, "h5.card-title a")[0];
    if (!link) continue;
    const match = /\/detail\/([0-9a-fA-F]{40})/.exec(link.attrs.href || link.attrs.url || "");
    if (!match) continue;
    const name = link.text.replace(/^\s*🧲\s*/, "").trim() || match[1];
    const size = (html.select(card.html, "p.card-text span.text-success")[0] || {}).text || "";
    const date = /更新时间：\s*([0-9-]+)/.exec(card.text);
    const parts = [size.trim(), date ? date[1] : "", "天天磁力"].filter(Boolean);
    result.push({
      title: name,
      subtitle: parts.join(" · "),
      hash: match[1].toLowerCase(),
      action: { type: "magnet", url: magnet(match[1], name) },
    });
  }
  return result;
}

async function search(keyword, page) {
  const sources = [searchCiliwang(keyword, page), searchTtbt(keyword, page)];
  const settled = await Promise.all(
    sources.map((p) => p.then((v) => ({ ok: true, list: v }), (e) => ({ ok: false, error: e })))
  );
  // 两个站都失败才报错；只坏一个时照常返回另一个的结果
  if (settled.every((s) => !s.ok)) {
    const e = settled[0].error;
    throw new Error("两个站点都无法访问：" + String((e && e.message) || e));
  }
  settled.forEach((s, i) => { if (!s.ok) log("站点 " + i + " 搜索失败", String(s.error && s.error.message || s.error)); });

  // 两个来源交替排列，并按磁力特征码去重
  const lists = settled.map((s) => (s.ok ? s.list : []));
  const seen = {};
  const merged = [];
  const longest = Math.max.apply(null, lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item || seen[item.hash]) continue;
      seen[item.hash] = true;
      merged.push(item);
    }
  }
  return merged;
}
