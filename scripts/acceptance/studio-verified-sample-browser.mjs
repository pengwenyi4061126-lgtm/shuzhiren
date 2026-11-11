#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const cdpBase = (process.env.STUDIO_CDP_URL ?? "http://127.0.0.1:9222").replace(/\/$/, "");
const studioUrl = process.env.STUDIO_URL ?? "http://127.0.0.1:3000/studio";
const screenshotPath = path.resolve(process.env.STUDIO_ACCEPTANCE_SCREENSHOT ?? "sample-assets/digital-host/studio-verified-sample.png");

async function main() {
  const target = await findStudioTarget();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(cdp, "document.readyState === 'complete' && document.body.innerText.includes('一个内容项目')", 30_000, "Studio 页面未完成加载");
    await clickButton(cdp, "载入 4090 样片");
    await waitFor(cdp, "document.body.innerText.includes('4090 已验证样片 · 氨基酸洁面慕斯')", 20_000, "4090 样片项目未被选中");
    await waitFor(cdp, "[...document.querySelectorAll('button')].some((button) => button.textContent?.includes('用审核声线生成配音') && !button.disabled)", 20_000, "审核声线不可用");
    await clickButton(cdp, "用审核声线生成配音");
    await waitFor(cdp, "Boolean(document.querySelector('audio[src^=\\\"blob:\\\"]')) && [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('生成并预览视频') && !button.disabled)", 25_000, "已生成 WAV 未成为可用录播音频");
    await clickButton(cdp, "生成并预览视频");
    await waitFor(cdp, "document.body.innerText.includes('自动质量检查通过') && [...document.querySelectorAll('video')].some((video) => video.src.startsWith('blob:') && video.videoWidth === 720 && video.videoHeight === 1280)", 110_000, "录播视频未完成生成或质检");
    await captureScreenshot(cdp, screenshotPath);
    const evidence = await cdp.evaluate(`(() => ({
      projectLoaded: document.body.innerText.includes('4090 已验证样片 · 氨基酸洁面慕斯'),
      photoLoaded: document.body.innerText.includes('已从项目批准素材载入'),
      qualityPassed: document.body.innerText.includes('自动质量检查通过'),
      audio: [...document.querySelectorAll('audio')].map((audio) => ({ blob: audio.src.startsWith('blob:'), duration: audio.duration, readyState: audio.readyState })),
      recording: [...document.querySelectorAll('video')].map((video) => ({ blob: video.src.startsWith('blob:'), width: video.videoWidth, height: video.videoHeight, duration: video.duration, readyState: video.readyState })).find((video) => video.blob) ?? null,
      errors: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent?.trim()).filter(Boolean)
    }))()`);
    if (!evidence.projectLoaded || !evidence.photoLoaded || !evidence.qualityPassed || !evidence.audio.some((audio) => audio.blob) || evidence.recording?.width !== 720 || evidence.recording?.height !== 1280 || evidence.errors.length) {
      throw new Error(`验收证据不完整：${JSON.stringify(evidence)}`);
    }
    console.log(JSON.stringify({ status: "passed", screenshot: screenshotPath, ...evidence }, null, 2));
  } catch (error) {
    await captureScreenshot(cdp, screenshotPath.replace(/(\.[^.]+)?$/, ".failed$1")).catch(() => undefined);
    const diagnostic = await cdp.evaluate(`(() => ({
      alerts: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent?.trim()).filter(Boolean),
      buttons: [...document.querySelectorAll('button')].filter((button) => /配音|预览视频/.test(button.textContent ?? '')).map((button) => ({ text: button.textContent?.trim(), disabled: button.disabled })),
      audio: [...document.querySelectorAll('audio')].map((audio) => ({ src: audio.src, duration: audio.duration, readyState: audio.readyState })),
      videos: [...document.querySelectorAll('video')].map((video) => ({ src: video.src, width: video.videoWidth, height: video.videoHeight, duration: video.duration, readyState: video.readyState }))
    }))()`).catch(() => null);
    console.error(`STUDIO_BROWSER_DIAGNOSTIC: ${JSON.stringify(diagnostic)}`);
    throw error;
  } finally {
    cdp.close();
  }
}

async function findStudioTarget() {
  const response = await fetch(`${cdpBase}/json/list`);
  if (!response.ok) throw new Error(`CDP target listing failed: HTTP ${response.status}`);
  const targets = await response.json();
  const target = targets.find((item) => item.type === "page" && item.url.startsWith(studioUrl));
  if (!target?.webSocketDebuggerUrl) throw new Error(`没有找到 Studio CDP 页面：${studioUrl}`);
  return target;
}

async function clickButton(cdp, label) {
  const result = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(${JSON.stringify(label)}));
    if (!button) return { clicked: false, reason: 'missing' };
    if (button.disabled) return { clicked: false, reason: 'disabled' };
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return { clicked: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!result?.clicked) throw new Error(`无法点击“${label}”：${JSON.stringify(result)}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: result.x, y: result.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: result.x, y: result.y, button: "left", clickCount: 1 });
}

async function waitFor(cdp, expression, timeoutMs, reason) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return;
    await delay(300);
  }
  const tail = await cdp.evaluate("document.body.innerText.slice(-2000)").catch(() => "");
  throw new Error(`${reason}。页面末尾：${tail}`);
}

async function captureScreenshot(cdp, output) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, Buffer.from(result.data, "base64"));
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "CDP error"));
      else pending.resolve(message.result ?? {});
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
    return result.result?.value;
  }

  close() { this.socket.close(); }
}

main().catch((error) => {
  console.error(`STUDIO_BROWSER_ACCEPTANCE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
