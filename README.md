# 巡检插件版（电商平台价格巡检工作台）

本目录存放「浏览器插件版」价格巡检项目的辅助内容。

- 扩展本体：`extension\`（Edge 按这个路径加载；挪动路径后需要在 edge://extensions 重新「加载解压缩的扩展」，扩展 ID 会变，旧采集数据用「导入数据」恢复）
- 调试脚本：`dev-tools/`
- 界面截图：`qa/`
- 插件说明文档：`extension\README.md`
- 基表/回填工具：`extension\tools\`
- 界面截图：`qa/`（工作台 + 总览页）

## 快速使用

1. Edge 打开 `edge://extensions/` → 重新加载扩展；
2. 点扩展图标打开工作台（170 行、165 行有 SKU、151 个去重 SKU、5 行待补）；
3. 登录普惠账号 → 「普惠号巡检」；切 PLUS 账号 → 「会员号巡检」；
4. 总览页看进度、点数字筛选；勾选行 →「汇总选中」→「导出待上报 Excel」；
5. 导出 CSV → 运行 `python extension\tools\apply_results_to_xlsx.py "CSV路径"` 回填 Excel。
