// 必应每日壁纸：用必应官方的壁纸接口列出最近约半个月的每日壁纸，可按关键词筛选并下载。
// 官方接口只保留最近 15 天左右的壁纸，更早的查不到。图片版权归各自的摄影师所有（副标题里有署名），请仅作个人壁纸使用。

const meta = {
  id: "bing.wallpaper",
  name: "必应壁纸",
  version: "1.0",
  author: "ssxz",
  description: "搜索并下载必应每日壁纸（最近约 15 天），输入“最新”查看全部",
  hosts: ["bing.com"],
};

// 国内访问 cn.bing.com 比 www.bing.com 稳定
const BASE = "https://cn.bing.com";

// 这些关键词表示“不筛选，全部列出”
const ALL_WORDS = ["最新", "全部", "所有", "今日", "今天", "壁纸", "必应", "bing", "*", "all"];

function niceDate(text) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(text || ""));
  return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
}

// “标题 (© 摄影师/图库)” → 拆成说明和署名
function splitCopyright(text) {
  const m = /^(.*?)\s*[（(]\s*(©.*?)\s*[)）]\s*$/.exec(String(text || ""));
  return m ? { caption: m[1], credit: m[2] } : { caption: String(text || ""), credit: "" };
}

async function fetchRecent() {
  // 接口一次最多给 8 张，idx 最大为 7，两次请求合起来是最近 15 天
  const pages = await Promise.all([0, 7].map((idx) =>
    http.getJson(BASE + "/HPImageArchive.aspx?format=js&n=8&mkt=zh-CN&idx=" + idx).catch(() => null)));
  const seen = {};
  const list = [];
  for (const page of pages) {
    for (const image of ((page || {}).images || [])) {
      if (!image.urlbase || seen[image.urlbase]) continue;
      seen[image.urlbase] = true;
      list.push(image);
    }
  }
  if (!list.length) throw new Error("没有取到壁纸列表，请检查网络后重试");
  list.sort((a, b) => String(b.startdate).localeCompare(String(a.startdate)));
  return list;
}

async function search(keyword, page) {
  if (page > 1) return [];
  const word = String(keyword || "").trim().toLowerCase();
  const all = await fetchRecent();
  const list = !word || ALL_WORDS.includes(word)
    ? all
    : all.filter((image) => (image.title + " " + image.copyright).toLowerCase().includes(word));
  if (!list.length) {
    throw new Error("最近 15 天的壁纸里没有和“" + keyword + "”相关的，输入“最新”可以查看全部");
  }
  return list.map((image) => {
    const date = niceDate(image.startdate);
    const info = splitCopyright(image.copyright);
    const name = (date + " " + (image.title || info.caption || "必应壁纸")).trim();
    const file = (suffix, label) => ({
      type: "download",
      url: BASE + image.urlbase + suffix,
      filename: name + " " + label + ".jpg",
      label: "下载 " + label,
    });
    return {
      title: image.title || info.caption || "必应壁纸",
      subtitle: [date, info.caption, info.credit].filter(Boolean).join(" · "),
      cover: BASE + image.urlbase + "_320x240.jpg",
      actions: [
        file("_UHD.jpg", "4K 原图"),
        file("_1920x1080.jpg", "1080P 横屏"),
        file("_1080x1920.jpg", "手机竖屏"),
      ],
    };
  });
}
