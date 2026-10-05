// 抖音分享链接解析：粘贴 App 里“分享 → 复制链接”得到的整段文字即可。
// 解析由第三方接口 api.bugpk.com 完成，本插件只负责提取链接、调用接口和整理结果。
// 接口说明见 docs/插件开发说明.md

const meta = {
  id: "douyin.share",
  name: "抖音解析",
  version: "1.2",
  author: "ssxz",
  description: "粘贴抖音分享内容，解析并下载视频、图文或配乐（解析由 api.bugpk.com 提供）",
  hosts: ["api.bugpk.com"],
  // 剪贴板里出现这些域名的链接时，应用会询问是否解析
  clipboard: ["douyin.com", "iesdouyin.com"],
};

const API = "https://api.bugpk.com/api/douyin";

// 从整段分享文字里找出抖音链接
function extractUrl(text) {
  const match = /https?:\/\/[A-Za-z0-9.-]*(?:douyin|iesdouyin)\.com\/[^\s，。！？"'<>]*/.exec(String(text || ""));
  return match ? match[0] : null;
}

// 文件名里去掉话题标签、@ 和换行，避免过长
function cleanTitle(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const cleaned = raw.replace(/[#@][^\s#@]+/g, "").replace(/\s+/g, " ").trim();
  return (cleaned || raw || "抖音作品").slice(0, 60);
}

function urlOf(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  return entry.url || entry.video || entry.image || "";
}

async function resolve(text) {
  const link = extractUrl(text);
  if (!link) throw new Error("没有识别到抖音链接，请粘贴分享内容");

  const body = await http.get(API + "?url=" + encodeURIComponent(link));
  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error("解析接口返回异常，请稍后再试");
  }
  if (json.code !== 200 || !json.data) throw new Error(json.msg || "解析失败");

  const data = json.data;
  const title = cleanTitle(data.title || data.desc);
  const author = data.author && data.author.name ? "@" + data.author.name : "";
  const result = [];

  // 视频
  if (data.url && /^https?:\/\//.test(data.url)) {
    const actions = [{
      type: "download",
      url: data.url,
      filename: title + ".mp4",
      label: "下载视频" + (data.size_label ? "（" + data.size_label + "）" : ""),
    }];
    // 其他清晰度
    (data.video_backup || []).forEach((backup) => {
      if (!backup.url || backup.url === data.url) return;
      const tag = [backup.quality, backup.size_label].filter(Boolean).join(" ");
      actions.push({
        type: "download",
        url: backup.url,
        filename: title + (backup.quality ? "_" + backup.quality : "") + ".mp4",
        label: "下载视频" + (tag ? "（" + tag + "）" : "（备用）"),
      });
    });
    actions.push({ type: "play", url: data.url, label: "在线播放" });
    const info = [author, data.publish_time, data.duration ? Math.round(data.duration) + " 秒" : ""];
    result.push({
      title: title,
      subtitle: info.filter(Boolean).join(" · "),
      cover: data.cover || "",
      actions: actions,
    });
  }

  // 图文：每张图一个下载项
  const images = (data.images || []).map(urlOf).filter(Boolean);
  images.forEach((image, i) => {
    result.push({
      title: title + "（图 " + (i + 1) + "/" + images.length + "）",
      subtitle: author,
      cover: image,
      action: { type: "download", url: image, filename: title + "_" + (i + 1) + ".jpg", label: "下载图片" },
    });
  });

  // 实况照片
  const live = (data.live_photo || []).map(urlOf).filter(Boolean);
  live.forEach((video, i) => {
    result.push({
      title: title + "（实况 " + (i + 1) + "/" + live.length + "）",
      subtitle: author,
      action: { type: "download", url: video, filename: title + "_live_" + (i + 1) + ".mp4", label: "下载实况" },
    });
  });

  // 配乐
  if (data.music && data.music.url) {
    result.push({
      title: data.music.title || "配乐",
      subtitle: ["配乐", data.music.author].filter(Boolean).join(" · "),
      cover: data.music.cover || "",
      action: {
        type: "download",
        url: data.music.url,
        filename: cleanTitle(data.music.title || title + "_配乐") + ".mp3",
        label: "下载配乐",
      },
    });
  }

  if (!result.length) throw new Error("没有解析到可下载的内容");
  return result;
}
