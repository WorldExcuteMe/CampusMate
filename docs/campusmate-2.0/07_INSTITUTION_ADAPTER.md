# 07 · Institution Adapter（Stage 5）

> 基于真实代码。声明式映射，禁止模型任意代码直接生产执行。

## 核心接口（core/institution-adapter.ts）

```
InstitutionConnector: discoverSources / inspectSource / fetchData / normalize / validate
```
- SourceDescriptor/SourceSchema/RawData/NormalizedData/ValidationResult。
- 环境发现 `discoverSources`：从机构已知 URL 枚举源 + 格式识别（ics/csv/xlsx/pdf/html）。

## 声明式映射（安全核心）

- `DeclarativeConfig.fieldMap`：target → {source, transform, default}。
- transform 固定白名单：trim/lower/upper/number/int/weekday/date/time。**无 eval，不执行任意代码**。
- `applyMapping` 纯数据转换；`validateMapping` 必填字段校验。
- 模型生成的候选规则只能是声明式配置，须 fixture 测试 + 用户确认才激活。

## Adapter Lifecycle

`Draft → Candidate → Validated → Active → Degraded → Retired`（TRANSITIONS 强制）。
- `validateCandidate`：fixtures 全通过 → validated；失败保持 candidate + errorHistory。
- `activate`：**须 validated + userConfirmed**，禁止未验证激活（测试验证抛错）。
- `checkSchema`：fingerprint 变更 → active 转 degraded。

## AdapterMeta

version/status/config/schemaFingerprint/supportedDataTypes/permissions/fixtures/health/lastSuccess/errorHistory/userConfirmed。
`schemaFingerprint`：字段排序 sha256 前 16 位。

## 具体适配器（core/institution-adapters.ts）

- GenericAdapter（配置驱动，任意结构化源）。
- csvConnector（复用 parseCsv）；ICS/XLSX 复用 schedule-import。
- HTML：`extractHtml` 声明式正则模式提取（无 eval）。
- PDF：`extractPdfText` 对已提取文本声明式提取（PDF→text 由 pdfjs/Companion 上游完成）。
- fetchData 仅公开 URL（safeFetch SSRF 守卫）或授权 Companion；**不绕过认证/验证码/MFA，不接受密码**。

## 测试证据（AC12/AC13）

- AC12 高校信息源统一适配：**VERIFIED**（Generic/CSV/HTML/PDF 适配器 + 声明式映射 + 生命周期）。
- AC13 未知环境请求补充：**VERIFIED**（discoverSources + 候选验证门控；未验证不激活）。
- institution-adapter.test.ts 11 用例：映射/生命周期/候选门控/激活门控/fingerprint degraded/环境发现/HTML/PDF 提取/GenericAdapter。
- 后端 159 测试（158 过/1 skip），tsc 0。

## 安全边界

- 严禁模型生成任意代码作为生产 Connector；仅声明式映射 + 已审核解析器。
- 候选适配器须 fixture 测试通过 + 用户确认才 Active。
- 不绕过高校认证/验证码/MFA/访问控制；不向 LLM 提供教务密码；登录由用户在可信界面完成；本地访问经授权 Companion。

## 后续
- Institution-specific 适配器沉淀（三开发者真实样本→回归 fixture）。
- PDF 二进制→text（pdfjs/Companion）；OCR（按需，不引入大型服务）。
- Adapter 持久化（migration 待审核）。