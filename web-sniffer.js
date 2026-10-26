// 网页视频嗅探：粘贴网页地址后，在应用里打开这个网页（可以正常浏览、登录、点播放），
// 同时自动收集网页加载的音视频资源（mp4、m3u8 等），点右下角的按钮查看、下载或播放。
// 识别规则参考猫抓（cat-catch）：按扩展名，或按服务器返回的文件类型判断。不破解任何加密或付费内容。
// 需要随身下载新版（支持 browse 动作）。

const meta = {
  id: "web.sniffer",
  name: "网页视频嗅探",
  version: "2.0",
  author: "ssxz",
  description: "粘贴网页地址，在应用里打开网页并自动嗅探视频和音频，支持 m3u8",
  // 嗅探在应用的浏览器里进行，插件本身只需要识别链接
  hosts: ["*"],
};

function extractUrl(text) {
  const match = /https?:\/\/[^\s"'<>，。！？]+/.exec(String(text || ""));
  if (match) return match[0];
  // 没写 http 的网址，比如 www.example.com/video
  const bare = /(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>，。！？]*)?)/i.exec(String(text || ""));
  return bare ? "https://" + bare[1] : null;
}

async function resolve(text) {
  const link = extractUrl(text);
  if (!link) throw new Error("请粘贴一个网页地址");
  return [{
    title: "在网页中嗅探",
    subtitle: link,
    actions: [{ type: "browse", url: link, label: "打开网页" }],
  }];
}
