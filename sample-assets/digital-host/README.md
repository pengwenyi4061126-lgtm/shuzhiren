# 数字人样本素材包

这是一套可重复验收的基础样本：

- `host-portrait.png`：AI 生成的虚构成年数字人头像，941 × 1672，适合照片录播；SHA-256 `52681702eada8ad42cedf1dc283066784194b5f91e9c5153f335bceb3914c18c`。
- `host-voice.wav`：远端 CosyVoice 生成的中文口播，24 kHz、单声道、约 43.44 秒；SHA-256 `3ae050544186d4846ae2b43f46ca795d19fcd378f164faa10b42875ec972614e`。
- `product-card.svg`：氨基酸洁面慕斯商品画面，用于商品信息展示和录播制作包。
- `sample-project.json`：一个内容项目、两个输出的样本配置与审核资料。
- `sample-live-trial.sh`：从动态 Avatar 会话到 RTMP、录制、指标和证据的 4090 短时试播脚本位于 `scripts/acceptance/`。

## 使用边界

头像照片只用于录播；直播试播使用远端已发布的 LiveTalking Avatar，不把静态照片冒充直播 Avatar。样本商品信息均来自项目内的 Demo 商品资料，正式上架前应替换为真实商品与授权资料。

## 质量门

1. 图片必须能被浏览器解码，人物脸部清晰且构图适合 9:16。
2. 音频必须是可解码 WAV，24 kHz、单声道，时长与脚本一致。
3. 录播成片需要有视频、音频、字幕和商品事实；预览确认后才能保存。
4. 直播试播需要动态会话、RTMP `output_connected=true`、输出 FPS、AIGC 标识帧和 MP4 录制证据。
