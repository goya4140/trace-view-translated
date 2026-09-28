# Trace Review Translated v0.1.0

基于 [Picrew/trace_view](https://github.com/Picrew/trace_view) v0.0.9 的首个中文阅读版本。

## 新增

- 「原始轨迹 / 自然语言翻译」切换，按用户提问组织多轮对话。
- 用中文概括模型请求、工具调用和返回、上下文事件与 Token 用量记录。
- 同一轮的 Token 用量快照合并显示；每一步都能回看原始事件与 JSON。
- 与原版独立的 macOS 应用名称、Bundle ID 和本地端口（`127.0.0.1:7861`）。

翻译由本地规则生成，不调用外部模型；遇到无法判断的记录会提示查看原始数据。

## 安装

下载 `Trace-Review-Translated-0.1.0-arm64.dmg`，打开并将应用拖入 Applications。此包适用于 Apple Silicon Mac。应用采用临时签名，尚未经过 Apple 公证；首次启动如被系统拦截，可在 Finder 中右键应用并选择「打开」。
