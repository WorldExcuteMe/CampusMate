# T10 通用文档工具与真实Office/PDF文件

Status: accepted（本地），2026-11-15；基线8f38c0c；主代理；备份v10。沿用批准R10/AC20/G1，不开放任意宿主exec。

- DocumentService复用owner级ArtifactStore与通用AST，提供create/export/inspect。CLOUD_TOOLS新增三个受限文档工具；输入内容结构化、可引用已取得来源，禁止任意HTML、脚本、URL资源或文件路径。T6策划书也消费同一服务的导出入口。
- 生产依赖固定docx 9.6.1、Playwright 1.65.0（Chromium1254）、pdfjs-dist 4.10.38及JSZip 3.10.1。PDF用可信打印HTML、无网络浏览器上下文、随包Noto中文字体；DOCX用受控OOXML生成器。Letter竖版、黑色标题、11pt正文、清晰层级及跨页表头，长表允许逐行分页。
- 导出缓存是owner所属的不可变artifact（源版本+rendererVersion+格式），内容哈希、源AST哈希、字节哈希分开；重试和并发不覆盖旧版本。单进程并发/超时/大小有上限，跨进程冲突读取已存在版本。缺浏览器或字体则明确受限，不提供伪造PDF。
- API按owner返回可用格式，下载实际二进制；重新解析DOCX ZIP/正文和PDF页数/文字以核对内容。UI只展示实际可用下载格式；大文件不进入聊天正文/模型上下文。
- 本次目标是让CampusMate具备独立可部署能力，生产代码使用仓库声明的依赖，不依赖Codex私人runtime。documents/pdf技能的bundled runtime用于本轮样本与视觉QA；若Windows的标准DOCX渲染器缺少LibreOffice，保留错误并用已安装Word原生另验，说明渲染引擎边界，不将解析替代实际视觉检查。
- 计算工具交付评估/接口与部署条件，不把Node vm、本机终端或Codex工具当云沙箱。尚无真实隔离后端时compute unavailable，不增加有名无实的执行按钮。

GWT：同一AST的MD/DOCX/PDF真实导出并复读，中文、特殊字符、跨页表格、图片/图表/引用匹配；schema/资源/大小越界拒绝；他人不能下载；重复导出返回同字节hash；渲染环境缺失明确限制；真实Agent调用create→inspect→export而非工具名占位。

官方核验2026-11-15：docx https://docx.js.org/ 、PDF打印 https://playwright.dev/docs/api/class-page#page-pdf 、字体资源与OFL https://github.com/notofonts/noto-cjk/tree/main/Sans 。实际版本/字体哈希随运行清单记录。字体安装或系统配置变更不自动执行；只把授权范围内可分发字体保存在产品资源中。

验证：消费者红灯→工具/API/文件定向→真实样本复读与页面图检查→完整串行回归。后端生产运行依赖与本机QA工具分开，远程数据库/部署/真实模型费用仍未授权。

## 结果与限制

- API的DOCX下载400红灯转绿；真实Worker经Manifest调用create→inspect→export，聊天接入实际产物。工具失败会进入独立检查，不能凭模型自称完成成功。
- 同版MD/DOCX/PDF导出、ZIP/PDF文字复读、并发缓存/字节哈希、owner拒绝及环境受限通过。真实网页工具保存受控source artifact，generic文档不能自行填入已核实来源。
- 首个PDF严格检查暴露中文同形字cmap映射问题，未降低内容检查标准。核验https://github.com/papandreou/subset-font 后加入固定subset-font2.9.0，先按实际字符去除无用cmap别名，内容检查转绿，同时减少字体嵌入体积。
- 第一次字体下载503/许可证404，脚本未立即停止而暂写了空哈希清单；已以失败即停方式重新从官方GitHub API下载，最终字节/哈希/许可证实测有效。下载错误记录没有当作通过。
- 文档API回归首次补写前漏登记T10快照；该文件T6原版已在Git中，已撤回本人那两行、补做原版before，再恢复测试并保留红灯证据。未声称首次登记早于修改。
- 最终样本DOCX经Word16.0实际打开并导出5页，产品PDF5页，全部10页逐页检查通过；宽正文列、表头重复、普通表格行保持完整、标题不孤立、图片/图表/引用及特殊字符均可读。标准render_docx.py明确因缺LibreOffice失败，原日志保留，Word结果不算LibreOffice兼容性验证。
- 后端完整255/255、最终相关10/10通过；前端125/125、类型/构建通过。依赖/资源/部署边界见DOCUMENT_RUNTIME.md，计算接口与隔离条件见COMPUTE_ASSESSMENT.md；实际云计算沙箱未部署，也没有假冒可用。
