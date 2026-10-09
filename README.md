# Alipan Sync

Obsidian 笔记与阿里云盘双向同步插件。（Obsidian plugin for two-way sync between your vault and Alipan.）

## 特性

| | |
|---|---|
| 双向同步 | 多设备间同步笔记 · Two-way sync across devices |
| 增量同步 | 只传输变更文件，大型笔记库也能快速同步 · Incremental sync |
| OAuth 授权 | 简单授权即可连接阿里云盘 · OAuth authorization |
| 远端文件浏览器 | 可视化管理云端文件 · Remote explorer |
| 智能冲突解决 | 字符级比较自动合并，或按时间戳保留最新 · Smart conflict resolution |
| 宽松同步模式 | 针对数千笔记的仓库优化性能 · Loose sync mode |
| 大文件处理 | 设置大小限制跳过大文件 · Large file handling |
| 状态与日志 | 清晰的同步进度提示与详细日志 · Status tracking & logging |

## 安装

**社区插件**：设置 → 第三方插件 → 浏览 → 搜索 "Alipan Sync" → 安装并启用。

**手动安装**：从 [Releases](https://github.com/nowszhao/obsidian-alipan-sync/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放入 `<vault>/.obsidian/plugins/alipan-sync/`，重启 Obsidian 后启用。

## 注意事项

- 首次同步耗时较长（文件较多时）
- 同步前请先备份

## 致谢

本项目 fork 自 [Obsidian Nutstore Sync](https://github.com/nutstore/obsidian-nutstore-sync)（[坚果云 / Nutstore](https://github.com/nutstore)），将其 WebDAV 后端替换为阿里云盘开放 API。感谢原作者的同步框架。

## License

[GNU AGPL-3.0](LICENSE)，与原始项目保持一致
