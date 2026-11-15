# CampusMate 文档运行清单

本地状态：2026-11-15。文档能力由产品后端自己的依赖提供，Codex、Word和Poppler仅用于本轮额外QA，不是线上工具。

安装后端 `npm ci`，随后运行 `npx playwright install --with-deps chromium`。固定版本为docx9.6.1、Playwright1.65.0（Chromium1254）、pdfjs-dist4.10.38、JSZip3.10.1、subset-font2.9.0及锁文件中的传递依赖。CI已增加后端浏览器安装。Linux运行需相同版本浏览器及系统库，建议使用非root隔离容器、限制CPU/内存和系统网络权限。

随包资源 `backend/assets/fonts/NotoSansCJKsc-Regular.otf`，16,437,364字节，版本2.004，SHA-256 `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`。来源及SIL OFL见同目录manifest/LICENSE。打印前校验哈希并只嵌入当前文档需要的字符子集，避免同形CJK字符被错误复制为兼容部首。不会自动安装系统字体。DOCX阅读器可按自身字体环境替代字体，分页可能与Chromium/PDF不同。

部署时保留backend、同级shared和字体资源，启动API与Worker时共用数据库。PDF不依赖本机Word；`DOCUMENT_PDF_ENABLED=0`可明确关闭PDF，缺浏览器或字体时availableFormats不会声称支持PDF。有图表的DOCX也需该打印环境生成受控图像。实际渲染失败返回错误，不生成空文件。

通用工具为document_create/document_inspect/document_export，前两者接收受限文档结构/本人artifactId；导出支持md/docx/pdf。web_fetch保存真实来源artifact并返回sourceId，文档事实引用只能关联本任务取得的sourceId，不能自填“已核实”URL。用户提供但尚未抓取的材料应标待核实。

下载入口 `GET /v1/artifacts/:id/download?format=md|docx|pdf`需要Bearer认证。X-Artifact-Sha256表示源AST内容，X-File-Sha256表示实际下载字节，X-Document-Revision表示源版本。导出结果独立保存为不可变artifact；相同源版本/格式/rendererVersion复用同字节，跨进程竞争不覆盖已存在文件。

资源边界：AST最多4MB，文件最多32MB，PDF最多150页；每次浏览器打印30秒、每进程最多2个导出/8个排队；云文档工具60秒上限。多进程需外部CPU/内存/并发限制，这些本地上限不是全局租户配额。浏览器只打印可信模板，脚本禁用、网络请求阻断、字体/图片为受限data资源；模型不能传任意HTML、URL资源、终端命令或宿主路径。

复读检查会重新解析DOCX ZIP/正文及PDF页数/文字，结构和内容一致才保存导出。它不能替代每份用户文档的人工排版/事实核对。工具inspect明确报告这种边界。

本轮QA使用合成中文长文、42行跨页表格、图像、图表、特殊字符和引用。输出与逐页图在仓库外 `campusmate-evidence/t10-document-qa-v3/`，DOCX经Microsoft Word16.0实际打开并导出5页，产品PDF5页，10页均已逐页目视检查；没有发现缺字、截断或重叠。第一版出现标题与表格分离/普通行断页，已调整列宽和分页后重验。标准render_docx.py因本机缺LibreOffice失败，原日志保留；不将Word结果表述为LibreOffice兼容性通过。
