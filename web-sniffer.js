// 网页视频嗅探：粘贴一个网页地址，找出这个网页播放时加载的音视频文件（mp4、m3u8 等）。
// 做法是用应用内不可见的浏览器打开网页，记录它请求过的媒体地址；不破解任何加密或付费内容，
// 受版权保护（DRM）的视频、需要登录或付费才能看的视频嗅探不到或无法下载。

const meta = {
  id: "web.sniffer",
  name: "网页视频嗅探",
  version: "1.0",
  author: "ssxz",
  description: "粘贴网页地址，找出页面里的视频和音频并下载，支持 m3u8",
  // 要打开用户给出的任意网页，所以不限定域名
  hosts: ["*"],
};

const KIND = {
  m3u8: "m3u8 视频", mp4: "MP4 视频", m4v: "MP4 视频", mov: "MOV 视频", webm: "WebM 视频",
  flv: "FLV 视频", mkv: "MKV 视频", mp3: "MP3 音频", m4a: "M4A 音频", aac: "AAC 音频",
  flac: "FLAC 音频", ogg: "OGG 音频", wav: "WAV 音频",
};

function extractUrl(text) {
  const match = /https?:\/\/[^\s"'<>，。！？]+/.exec(String(text || ""));
  return match ? match[0] : null;
}

function cleanTitle(text) {
  return String(text || "").replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

function hostOf(link) {
  const m = /^https?:\/\/([^\/?#]+)/.exec(link);
  return m ? m[1] : "";
}

async function resolve(text) {
  const link = extractUrl(text);
  if (!link) throw new Error("请粘贴一个网页地址（以 http:// 或 https:// 开头）");

  // 粘贴的本身就是媒体地址时不用再打开网页
  const direct = /\.(m3u8|mp4|m4v|mov|webm|flv|mkv|mp3|m4a|aac|flac|ogg|wav)(\?|#|$)/i.exec(link);
  const found = direct
    ? { title: "", url: link, media: [{ url: link, type: direct[1].toLowerCase(), referer: "", userAgent: "" }] }
    : await web.sniff(link, { timeout: 20000 });

  const media = found.media || [];
  if (!media.length) {
    throw new Error("没有在这个网页里发现视频或音频。可能需要登录、手动点击播放，或视频受版权保护");
  }
  const base = cleanTitle(found.title) || hostOf(link) || "网页视频";
  return media.map((item, index) => {
    const title = media.length > 1 ? base + " " + (index + 1) : base;
    const headers = {};
    if (item.referer) headers["Referer"] = item.referer;
    if (item.userAgent) headers["User-Agent"] = item.userAgent;
    const isHls = item.type === "m3u8";
    return {
      title: title,
      subtitle: (KIND[item.type] || "媒体文件") + " · " + hostOf(item.url),
      actions: [
        {
          type: "download",
          url: item.url,
          // m3u8 会按分片下载并合并成一个 .ts 文件
          filename: title + "." + (isHls ? "ts" : item.type),
          headers: headers,
          hls: isHls,
          label: "下载",
        },
        { type: "play", url: item.url, headers: headers, label: "在线播放" },
      ],
    };
  });
}
