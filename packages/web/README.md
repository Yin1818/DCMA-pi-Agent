# DCMA 工业数据分析工作台

React 前端和本地 Node HTTP 服务通过同一个地址运行。Pi SDK 只在服务器端读取本机授权信息，浏览器不会获得密钥。默认只监听 `127.0.0.1`。

## 启动

项目根目录：

```bash
npm install --ignore-scripts
npm run web:dev
```

打开 http://127.0.0.1:3000/ 。`DCMA_PORT` 可以覆盖端口。Ctrl+C 同时停止页面服务与正在执行的模型请求。

### 聊天页与展板统一运行

先在仓库根目录执行 `npm --prefix dashboard ci --ignore-scripts` 安装展板锁文件中的依赖。随后只需 `npm run web:dev`，聊天页位于 `/`，展板位于 `/dashboard/`，无需另外启动3001端口的数据库服务。两套页面保留各自目录和样式，共用展板数据库后端、连接池及只读查询规则，统一读取 `dcma` 数据。

聊天页默认使用数据库数据，每3秒检查一次；设备列表对应四个模拟来源和一个历史真实采集来源，名称来自数据库记录。右侧四项指标为电机温度、直流电压、实际电流和实际转速；未提供的类型、位置、投运日期显示“未提供”，不根据原始状态码猜测运行状态。原设备示意图保留。切换来源会清空旧来源显示，失败时明确提示，不用示例值代替；同一来源刷新失败可保留上次成功结果。

“查看更多”在当前标签页进入 `/dashboard/?table=当前来源#realtime`，展板直接选择同一电机及模拟/历史真实来源。浏览器返回恢复聊天页及已保存会话。导入数据仍为显式离线模式，可以“返回数据库数据”；展板始终读取 MySQL，不展示导入文件。

Agent 请求携带当前来源，新增 `read_industrial_dashboard` 工具复用展板近期采样查询；原表目录和筛选工具保留。该工具返回最新记录及以列名、行数组表示的最近最多100个有效时间采样，响应最多64KB，截断会标记；时间按展板暂定北京时间解释，结果不能代替全库统计。

生产预览前需分别执行 `npm run web:build` 和 `npm --prefix dashboard run build`，生成两套静态资源。两套页面在生产模式下仍由同一服务提供；开发验证不代表生产构建已验证。

首次克隆缺少 Pi 模型数据文件时，执行 `npm run hydrate:model-data`。

## 可用功能

- 新建、切换、重命名、删除和导出真实会话；会话、分析图表、配置及导入数据保存在当前浏览器。
- 设备按数据库来源选择；原始状态码尚未解码，显示“状态未确认”。显式导入模式可按设置阈值标记温度超限。
- CSV / JSONL / LOG 文件导入，逐行验证时间和数值；真实 CSV 下载和 Markdown 分析报告下载。
- 数据库侧栏显示电机温度、电压、电流、转速近期趋势；原离线遥测图表和频谱计算模块保留。
- 响应式布局，小屏可通过顶部按钮打开会话与设备面板；弹窗支持 Escape 和键盘焦点。
- 仅提供 Agent 对话，支持 Pi SDK 流式回复、停止生成和错误显示。每次调用带入最近 20 条有效消息；关闭数据库优先查询时，提供当前数据集最新最多200个原始采样点，分析由模型完成。

<<<<<<< Updated upstream
=======
## 工业故障知识库

`knowledge/sources/` 保存四份原始 Word/PDF，`knowledge/scripts/` 负责抽取正文、分块、记录段落或页码、提取故障码并校验来源指纹。生成的 856 条 `knowledge/data/knowledge.jsonl` 是 RAG 语料。配置云端 Embeddings API 并构建完整向量索引后，Agent 工具和 HTTP 查询会共用向量与关键词混合检索；聊天回答继续走 DCMA 现有 Pi 云端模型流程，嵌入模型单独配置。代码匹配、资料过滤和出处信息在两种检索模式下都保留。

Agent 会在工业故障、报警、维护、型号和故障码问题中调用 `search_fault_knowledge`。有故障码时使用精确代码查询，没有代码时使用型号、现象和关键词；回答须引用资料文件名和定位，PDF 资料还要注明页码。知识库内容是检索证据，不是 Agent 指令；未命中时必须说明“知识库未找到匹配证据”，不能补写故障码含义或根因。S120 手册与 G120 设备型号不一致时，回答必须标注适用范围。

内置只读接口：`GET /api/knowledge/health`、`GET /api/knowledge/sources`、`GET /api/knowledge/search?q=电机过载&limit=8`、`GET /api/knowledge/context?code=F0011`。接口与 Agent 使用同一检索实现，返回的记录包含 `source_file`、`locator`、`page`、`title`、`kind`、`codes` 和证据文本。健康接口会报告当前使用混合还是关键词检索，以及向量索引是否与资料和模型匹配。

### 启用云端语义检索

默认推荐硅基流动的 `BAAI/bge-m3` 中文/多语种嵌入模型，使用 OpenAI 兼容的 Embeddings API。复制 `.env.example` 到 `packages/web/.env`，只需在硅基流动控制台创建并本机填写 `EMBEDDING_API_KEY`。嵌入服务密钥与聊天密钥独立；DCMA 的 `DEEPSEEK_API_KEY` 不会自动作为嵌入密钥。

```dotenv
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_API_KEY=your-siliconflow-api-key
EMBEDDING_MODEL=BAAI/bge-m3
```

首次配置或更新资料后，在仓库根目录执行 `npm --prefix packages/web run knowledge:build`。这条命令会按“解析原始资料 → 校验分块和来源哈希 → 批量调用云端 Embeddings → 原子写入完整向量索引”的顺序运行；向量分 32 条一批发送，费用由嵌入服务商决定。仅想重切分和校验资料时运行 `npm --prefix packages/web run knowledge:ingest`；切分不会自动更新向量，完成后仍须运行 `knowledge:build`。`knowledge:reindex` 只按当前 JSONL 重建向量。生成的 `knowledge/data/vectors.json` 是本机运行文件，按资料哈希、嵌入服务地址、模型和向量覆盖情况验证是否可用，密钥不会写入索引。索引过期或服务异常时系统保留关键词检索，并在健康接口报告状态；相同查询向量会在进程内缓存最多 128 条。

>>>>>>> Stashed changes
## 数据导入

CSV 示例（时间必须包含日期，推荐 ISO 8601 并带时区）：

```csv
timestamp,temperature,vibration,current,speed
2026-10-08T00:00:00Z,46.8,0.32,312,1498
2026-10-08T00:00:01Z,50.2,0.34,313,1497
```

时间为必填列，至少提供一个指标。单位分别是 ℃、mm/s、A、rpm。支持中文列名“时间”“温度”“振动”“电流”“转速”。LOG / JSONL 每行一个对应字段的 JSON 对象。上限 2 MB、10000 行；重复时间、非法数值与不匹配列数会拒绝导入。

空通道显示“—”。设备看板和图表使用原始时间间隔；温度警戒阈值用于看板预警。Agent 接收到的有限数据窗口不能用于推断全量数据的统计或设备健康分数。

## 使用真实模型

DeepSeek 官方接口已配置在 `models.json`：`https://api.deepseek.com`，模型 `deepseek-flash`（DeepSeek V4.1 Flash）。复制 `.env.example` 为本目录的 `.env` 并填写 `DEEPSEEK_API_KEY`，然后重启服务。`.env` 已被 Git 忽略，勿将密钥写入前端或提交到仓库。服务器只读取本项目的模型配置；Pi 的现有授权仍可使用。

网页设置选择“DeepSeek V4.1 Flash”，保存后回复由真实模型生成。本工作台每次回复最多输出 4096 token；费用估算使用官方高峰价格，实际扣费以提供商账单为准。

在项目根目录运行 `./pi-test.sh`，通过 `/login` 完成 Pi 模型授权，或者在启动服务的终端配置对应提供商的环境变量。授权后在网页设置中刷新模型列表，选择实际模型，保存并应用。

模型调用使用所选提供商，可能消耗其额度。现有功能默认启用，无需选择工具；数据库优先查询设置仅决定默认数据来源，不撤销数据库工具的调用权限。网页模型会话没有执行终端命令或修改文件的工具。

`GET /api/health` 返回后端状态与已授权模型元数据。`POST /api/chat` 返回 NDJSON 流，事件为 `delta`、`done` 或 `error`；需要同源请求、JSON 内容类型及 `X-DCMA-Client: web` 请求头。

## 工业 MySQL 数据库

在本目录的 `.env` 配置 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`；默认端口为3306，可用 `MYSQL_DATABASE` 限制到指定库。凭据只由 Node 后端读取，不进入浏览器或 Git。需要本机能访问学校内网数据库；在家可能需要学校 VPN。

网页设置中的“工业 MySQL 数据库”，点击“检查连接与表结构”读取实际目录，再点击表名预览20行。`GET /api/database/catalog` 返回连接状态、实际列名和类型；`GET /api/database/rows?schema=...&table=...&limit=20` 读取表数据。共用展板接口的已知表白名单；展板及 Agent 当前设备工具固定读取 `dcma`。

Agent 默认优先 MySQL；显式导入模式下可以在设置中关闭数据库优先，以分析离线文件。配置数据库后默认获得 `list_industrial_tables`、`read_industrial_dashboard` 与 `read_industrial_rows` 工具，当前设备读数优先使用同源展板工具，需要额外筛选时查询实际字段。所有查询运行在只读事务中，不能执行任意 SQL、写入或删除。每轮最多8次工具调用，原始记录最多200行/64KB，当前设备工具最多100个有效时间采样/64KB；单次 SQL 超时5秒。返回记录只代表该窗口，不代表全库统计。

- `real_data_01`、`real_data_02`、`real_data_03`、`real_data_04`：实时模拟数据。
- `real_data`：短暂真实采集的数据。

MySQL 未连通时，网页和 Agent 明确报告未取得数据。侧栏已经与展板的字段和数据来源对应，不用示例代替查询结果；导入文件属于独立离线数据。单位与时间解释沿用展板现有口径，设备位置、类型、投运日期及状态码定义仍需外部台账或手册确认。数据库接口和页面读取可验证，不等于模型诊断效果已完成验收。

## 验证与发布

```bash
npm run check
node --test packages/web/test/telemetry.test.ts
npm run web:build
npm run web:preview
```

`web:build` 生成静态资源；`web:preview` / `npm --prefix packages/web start` 同时提供静态页面和 Pi API。需要部署到远程或多人访问时，应增加独立身份认证与访问控制后再对外开放。

## 当前边界

原示例台账和采样生成模块保留，但不再驱动当前设备侧栏，也不用于数据库失败回退；设备图片仍为示意图。导入文件属于离线数据，当前没有直接传感器采集或厂家故障码数据库。故障代码需厂商和型号确认，通用建议不会被标成已确认根因。

浏览器最多保留 50 个会话、每个会话 200 条消息。存储不足会提示导出；清除浏览器站点数据会清除本地记录。Agent 对话需要有效模型授权；模型不可用时明确提示，不生成本地模板回复。
