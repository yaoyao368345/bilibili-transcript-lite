# B站字幕提取器 Lite

基于 [DFameMaster/bilibili-transcript](https://github.com/DFameMaster/bilibili-transcript) 改进的 B 站字幕提取用户脚本。保留原项目的字幕读取与导出能力，重点改善分 P 视频、批量下载和使用体验。

## 功能

- 读取视频可用字幕，切换分 P 和字幕语言；点击字幕可跳转到对应播放时间。
- 搜索、定位、复制字幕，支持 TXT、MD、CSV、XML、HTML、SRT、VTT、ASS、LRC、JSON 导出。
- 批量选择视频并下载字幕；点击“开始下载”后输入名称，再选择保存方式。

## 相比原项目的改进

- **分 P 读取修复**：按当前 P 对应的 CID 获取字幕，支持页面内切 P，避免误读第一 P。
- **更易读的 Lite 界面**：简化主窗口和设置，批量选择列表使用高对比度文字、选中状态与计数。
- **长字幕体验**：支持全文搜索与高亮，较长的字幕列表分批显示，切 P 或切语言时及时取消过期操作。
- **批量下载整理**：手动命名后，可保存为同名文件夹；Firefox 等不支持目录选择的浏览器可下载包含该文件夹的 ZIP。ZIP 在本地生成。
- **导出修正**：改进 Markdown 和 HTML 内容转义，批量 HTML 按所选格式导出。

## 安装与使用

用篡改猴或脚本猫安装 [用户脚本](bilibili-transcript.user.js)，或打开 [Raw 安装链接](https://raw.githubusercontent.com/yaoyao368345/bilibili-transcript-lite/main/bilibili-transcript.user.js)。保存后刷新 B 站视频页；若安装过原版，请先停用原版，避免重复运行。

批量下载流程：选择视频 → 开始下载 → 输入名称并确认 → 下载 ZIP 或选择保存位置。支持目录写入的浏览器可以直接保存文件夹；其他浏览器使用 ZIP。

本项目沿用原项目的 [MIT 许可证](LICENSE)及 `Copyright (c) 2026 sxt` 声明。脚本运行时不依赖第三方框架。
