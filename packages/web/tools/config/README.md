# 本地设备配置与维护知识

本目录提供配置格式示例，服务不会读取 `.example.json` 文件。示例中的厂商、型号、版本和来源都是占位符，不能直接作为设备资料或故障知识启用。

`createKnowledgeService(directory)` 只读取指定私有运行目录中的 `profiles.json` 和 `knowledge.json`。核实后的资料应放在该目录，不要放入示例目录或版本库。缺少文件时，工具返回 `configured: false`；厂商、单位、代码含义和维修步骤也保持未配置。

## 读取与校验

配置必须是普通 UTF-8 JSON 文件，每个文件最多 1 MiB。读取时使用 `O_NOFOLLOW` 拒绝符号链接，并在读取过程中检查字节数。私有运行目录由服务端管理，工具每次查询都会重新读取文件。更新配置时，建议先写入临时文件，再通过原子重命名替换原文件。

出现以下任一问题，工具都会拒绝配置：未知字段、错误类型、内容超限、设备表重复、知识 ID 重复，或同一条目内的代码类型与代码组合重复。返回的 `ToolInputError` 不包含文件路径或原文。除状态规则 `eq` 接受的原始字符串外，空白字符串均无效；有效字符串按原样保留。

## profiles.json

顶层只允许一个 `profiles` 数组，最多 5 条。每条配置的字段如下，其中可选字段已单独标出：

| 字段 | 类型与限制 |
| --- | --- |
| `table` | `real_data_01`、`real_data_02`、`real_data_03`、`real_data_04`、`real_data`，不能重复 |
| `manufacturer`, `model`, `version` | 非空字符串，每项最多 160 字符；未知时必须为 `null` |
| `source` | 用户配置依据，非空字符串，最多 500 字符 |
| `units` | 对象，可为空；键仅允许下列数值字段，值为最多 32 字符的非空字符串 |
| `stateRules` | 可选状态规则对象；未提供时不推断运行状态，返回 `null` |
| `deviceName` | 可选设备台账名，非空字符串，最多160字符；未提供返回 `null` |
| `location` | 可选位置，非空字符串，最多300字符；未提供返回 `null` |
| `commissionDate` | 可选投运日期，必须为有效的 `YYYY-MM-DD`；未提供返回 `null` |
| `ratedValues` | 可选对象，键为允许的数值字段；每项仅含有限数值 `value`、非空 `unit`（最多32字符）、依据 `source`（最多500字符）；未提供返回 `null` |

额定值需依据铭牌或手册人工录入，不能自动用作告警阈值。额定值和状态规则都应分别注明依据。

允许的单位键：`dc_voltage`, `speed_setpoint`, `speed_actual`, `current_actual`, `torque_setpoint`, `torque_actual`, `air_intake_temp`, `motor_temp`, `inverter_temp`, `actual_power`, `field_current`, `torque_current`, `inverter_radiator_temp`, `inverter_load_rate`, `motor_load_rate`, `pulse_frequency`, `motor_power`, `feedback_power`。

`stateRules` 只允许以下必填字段：`source`（非空，最多 500 字符）、`version`（非空，最多 160 字符）和 `rules`（1 至 20 条）。每条规则包含 `state`（`running`、`stopped`、`fault`）和 `all`（1 至 10 个条件）。

每个条件包含 `field`（数据库 `fieldLabels` 中的实际字段）、`operator`（`eq`、`gt`、`lt`）和 `value`。`gt`/`lt` 只接受有限数值；`eq` 还可接受最多 300 字符的原始字符串，包括空字符串，空白会保留。

状态规则须有真实设备文档依据，所以格式示例未填写这一可选字段。返回的 `stateRules` 是通过校验的规则集，未配置时为 `null`。校验仅检查格式，资料仍由用户提供，未经外部验证。

`getDeviceProfile(table)` 返回设备身份、`source`、全部数据库 `fieldLabels`，以及各数值字段的 `measurements`（`field`, `label`, `unit`, `unitStatus`）。缺少单位时返回 `unit: null`、`unitStatus: "unknown"`；已填写的单位标为 `user_configured`，仍需核实其依据。

`configured` 表示找到了对应表的配置，`configurationPresent` 表示配置文件存在且通过校验。没有对应表配置时，设备身份和来源返回 `null`。`sourceStatus` 为 `user_provided` 或 `unknown`，`verified` 始终为 `false`。

## knowledge.json

顶层只允许一个 `entries` 数组，最多 500 条。每个条目包含以下字段：

| 字段 | 类型与限制 |
| --- | --- |
| `id` | 唯一非空字符串，最多 128 字符 |
| `manufacturer`, `model`, `version` | 必填非空字符串，每项最多 160 字符；必须按实际资料明确填写 |
| `kind` | `manual` 或 `case` |
| `text` | 非空正文，最多 20000 字符 |
| `source` | 必填对象，仅含 `title`（最多 300 字符）、`locator`（最多 1000 字符）、`revision`（最多 160 字符），均为非空字符串 |
| `codes` | 可选数组，每条知识最多 100 项，全文件最多 5000 项 |

每个 `codes` 项都必须填写 `kind`（`fault`, `alarm`, `status`, `control`）、`code`（非空，最多 128 字符）、`meaning`（非空，最多 2000 字符）和 `steps`（最多 30 条非空字符串，每条最多 1000 字符，也可填空数组），不接受其他字段。

来源定位信息按用户填写的文本保存。服务不会打开原文档、抓取 URL 或调用模型，也不会验证资料真实性。

`lookupFaultCode({manufacturer, model, version, code, kind})` 按厂家、型号、版本、代码和代码类型同时精确匹配，区分大小写，不做模糊匹配或版本回退。返回 `configured`、`found`、匹配总数 `total`、是否还有结果的 `hasMore`、`matches` 和 `verified: false`。

每项匹配包含知识 `id`、设备身份、代码 `kind`/`code`/`meaning`/`steps`、知识类型 `entryKind`、`source`、`sourceStatus: "user_provided"` 和 `verified: false`。一次最多返回前 10 项，合计 JSON 不超过 48000 个 UTF-8 字节；每个返回项保留完整说明和步骤。单条超限时也不会截取一部分步骤返回。

有匹配但无法放入结果预算时，可能返回空数组和 `hasMore: true`；确实无匹配时同样返回空数组，需结合其他字段区分。多个来源的结果会分别保留。调用者应提示资料冲突和结果截断，不应自行选定一个含义。

`searchMaintenanceKnowledge({query, manufacturer?, model?, version?, limit?})` 接受最多 500 字符的查询，可选身份条件采用精确匹配；`limit` 是 1 至 10 的整数，默认 5。工具在正文、来源标题、代码和步骤中查找字面子串及词项，忽略大小写，并对中文增加相邻双字匹配。完整查询命中得 10 分，每个匹配词项得 1 分，结果按分数降序、ID 升序排列。

返回值包含 `configured`、匹配总数 `total`、`verified: false` 和 `matches`。每项含 1 至 10 的 `rank`、`score`、`id`、知识 `kind`、设备身份、最多 600 字符的 `excerpt`，以及 `excerptLocation`、`excerptOffset`、`source`、`sourceStatus: "user_provided"` 和 `verified: false`。

摘录优先取自完整查询命中的正文、标题或代码材料；没有完整命中时，取词项命中的材料。截取位置从首次命中前最多 100 字符处开始。`excerptLocation` 指出材料位置，取值为 `text`、`source.title` 或 `codes[索引] (类型:代码)`。代码材料包含代码、含义和步骤；`excerptOffset` 表示摘录在该材料中的字符起点。排序分数只衡量文字相关性，不能用作故障概率、置信度或资料正确性的判断。

知识文件缺失时返回 `configured: false`；文件合法但没有条目时，返回 `configured: true` 和空结果。维修步骤和资料均由用户提供，未经外部验证。检索结果不会成为自动控制指令。
