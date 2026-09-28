# Trace Review Translated v0.2.0

新增无需模型的 **Agent trace 语义反编译**实验视图，并设为默认阅读模式。

- 按用户轮次把多条工具调用合成为“定位材料、阅读分析、判断汇总、生成产物、检查结果”等阶段。
- 显示 trace 记录的文件变更、执行中的失败尝试和未识别操作。
- 区分工具记录与 Agent 自己的说法；每个阶段都可点回原始事件与 JSON。
- 保留此前的「自然语言翻译」和「原始轨迹」视图。
- 整个过程在本机按规则运行，不调用外部总结模型。规则覆盖有限，具体边界见仓库的 `docs/semantic-decompiler.md`。

下载 Apple Silicon 版本的 `Trace-Review-Translated-0.2.0-arm64.dmg`，打开后将应用拖入 Applications。首次运行如被 macOS 拦截，请在 Finder 中右键应用并选择「打开」。
