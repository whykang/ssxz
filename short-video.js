// 短视频聚合解析：抖音、快手、小红书、B 站、微博、西瓜等 33+ 平台。
// 解析由第三方接口 api-new.ifphp.com（BugPk-Api）完成，接口 Key 已内置。
// 接口文档：https://api-new.ifphp.com/docs/5    插件接口说明见 docs/插件开发说明.md

const meta = {
  id: "shortvideo.aggregate",
  name: "短视频聚合解析",
  version: "1.2",
  author: "ssxz",
  description: "粘贴分享内容，解析并下载抖音、快手、小红书、B站、微博等平台的视频或图文",
  hosts: ["api-new.ifphp.com"],
  // 剪贴板 / 新建任务 / 系统分享里出现这些域名的链接时交给本插件
  clipboard: [
    "douyin.com", "iesdouyin.com",
    "kuaishou.com", "chenzhongtech.com", "gifshow.com",
    "xiaohongshu.com", "xhslink.com",
    "bilibili.com", "b23.tv",
    "weibo.com", "weibo.cn",
    "ixigua.com", "toutiao.com",
    "haokan.baidu.com", "weishi.qq.com", "pearvideo.com",
    "acfun.cn", "zhihu.com", "meipai.com", "huya.com",
    "pipix.com", "izuiyou.com", "oasis.weibo.cn",
    "tiktok.com", "youtube.com", "youtu.be",
    "twitter.com", "x.com", "instagram.com",
    "doubao.com", "jianying.com", "channels.weixin.qq.com",
  ],
};

const API = "https://api-new.ifphp.com/api/svparse";

// 接口 Key
const API_KEY = "bp_live_2dbf7ad7f00f6249fa5fa86c5e8b5f33a6d8c65e99cc8840e2b119592947470b";

// 从整段分享文字里取出第一个链接
function extractUrl(text) {
  const match = /https?:\/\/[^\s，。！？"'<>]+/.exec(String(text || ""));
  return match ? match[0] : null;
}

// 文件名里去掉话题标签、@ 和换行，避免过长
function cleanTitle(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const cleaned = raw.replace(/[#@][^\s#@]+/g, "").replace(/\s+/g, " ").trim();
  return (cleaned || raw || "短视频").slice(0, 60);
}

function isUrl(value) {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

// 列表里的元素可能是字符串，也可能是 {url: ...} 之类的对象
function urlOf(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return isUrl(entry) ? entry : "";
  const value = entry.url || entry.video || entry.video_url || entry.image || entry.src || "";
  return isUrl(value) ? value : "";
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

// 取第一个是链接的字段
function firstUrl(data, keys) {
  for (const key of keys) {
    if (isUrl(data[key])) return data[key];
  }
  return "";
}

function extOf(url, fallback) {
  const match = /\.([a-zA-Z0-9]{2,5})(?:\?|#|$)/.exec(String(url).split("?")[0]);
  const ext = match ? match[1].toLowerCase() : "";
  return /^(mp4|mov|m4v|webm|flv|mkv|jpg|jpeg|png|webp|gif|heic|mp3|m4a|aac)$/.test(ext) ? ext : fallback;
}

// 优先用接口自己给的说明（网关对无效 Key 实际返回的是 403，而不是文档写的 401）
function errorMessage(status, json) {
  const text = (json && (json.message || json.msg || json.error)) || "";
  if (text) return text;
  if (status === 401) return "接口 Key 无效";
  if (status === 403) return "接口余额、点数或套餐不足";
  if (status === 429) return "调用太频繁，请稍后再试";
  return "解析失败（" + status + "）";
}

async function resolve(text) {
  const link = extractUrl(text);
  if (!link) throw new Error("没有识别到链接，请粘贴分享内容");
  const response = await http.request({
    url: API + "?url=" + encodeURIComponent(link),
    headers: { "X-API-Key": API_KEY },
  });
  let json = null;
  try {
    json = JSON.parse(response.body);
  } catch (e) {}
  const code = json ? Number(json.code) : NaN;
  if (response.status !== 200 || !json || code !== 200 || !json.data) {
    throw new Error(errorMessage(response.status !== 200 ? response.status : code, json));
  }

  // 不同平台返回的字段不完全一样，这里按常见的几种写法都认一遍
  const data = json.data;
  const title = cleanTitle(data.title || data.desc || data.description);
  const authorName = data.author && typeof data.author === "object"
    ? (data.author.name || data.author.nickname)
    : data.author;
  const author = authorName ? "@" + authorName : "";
  const cover = firstUrl(data, ["cover", "cover_url", "pic", "thumbnail"]);
  const result = [];

  // 视频
  const video = firstUrl(data, ["url", "video_url", "video", "play", "playurl", "download_url"]);
  if (video) {
    const actions = [{
      type: "download",
      url: video,
      filename: title + "." + extOf(video, "mp4"),
      label: "下载视频" + ([data.label, data.size_label].filter(Boolean).length
        ? "（" + [data.label, data.size_label].filter(Boolean).join(" ") + "）" : ""),
    }];
    // 其他清晰度 / 备用地址
    const seen = {};
    seen[video] = true;
    listOf(data.video_backup).concat(listOf(data.urls)).concat(listOf(data.backup)).forEach((backup) => {
      const url = urlOf(backup);
      if (!url || seen[url]) return;
      seen[url] = true;
      const tag = typeof backup === "object"
        ? [backup.label || backup.quality, backup.size_label].filter(Boolean).join(" ") : "";
      actions.push({
        type: "download",
        url: url,
        filename: title + (backup.quality ? "_" + backup.quality : "_备用") + "." + extOf(url, "mp4"),
        label: "下载视频（" + (tag || "备用") + "）",
      });
    });
    actions.push({ type: "play", url: video, label: "在线播放" });
    const info = [author, data.publish_time, data.duration ? Math.round(Number(data.duration)) + " 秒" : ""];
    result.push({ title: title, subtitle: info.filter(Boolean).join(" · "), cover: cover, actions: actions });
  }

  // 图文：每张图一个下载项
  const images = listOf(data.images).concat(listOf(data.pics)).concat(listOf(data.imgurl)).map(urlOf).filter(Boolean);
  images.forEach((image, i) => {
    result.push({
      title: title + "（图 " + (i + 1) + "/" + images.length + "）",
      subtitle: author,
      cover: image,
      action: {
        type: "download",
        url: image,
        filename: title + "_" + (i + 1) + "." + extOf(image, "jpg"),
        label: "下载图片",
      },
    });
  });

  // 实况照片
  const live = listOf(data.live_photo).map(urlOf).filter(Boolean);
  live.forEach((item, i) => {
    result.push({
      title: title + "（实况 " + (i + 1) + "/" + live.length + "）",
      subtitle: author,
      action: { type: "download", url: item, filename: title + "_live_" + (i + 1) + ".mp4", label: "下载实况" },
    });
  });

  // 配乐
  const music = data.music && typeof data.music === "object" ? data.music : null;
  const musicUrl = music ? urlOf(music) : (isUrl(data.music) ? data.music : "");
  if (musicUrl) {
    const musicTitle = (music && music.title) || title + "_配乐";
    result.push({
      title: musicTitle,
      subtitle: ["配乐", music && music.author].filter(Boolean).join(" · "),
      cover: (music && isUrl(music.cover) && music.cover) || "",
      action: {
        type: "download",
        url: musicUrl,
        filename: cleanTitle(musicTitle) + "." + extOf(musicUrl, "mp3"),
        label: "下载配乐",
      },
    });
  }

  if (!result.length) throw new Error("没有解析到可下载的内容");
  return result;
}
