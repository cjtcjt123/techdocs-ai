# NAS 服务（nas-parse）：文档解析 + 文本嵌入

给 techdocs-ai 提供两件手机端做不好、或做了也慢的事：

| 能力 | 接口 | 为什么放到 NAS |
|---|---|---|
| **文档解析** | `POST /parse` | 手机端自带解析（`src/lib/pdf-lite.ts`、`src/lib/docx-lite.ts`）是纯 JS 自写引擎，离线可用但复杂排版 PDF 会掉字；PyMuPDF 更准 |
| **文本嵌入** | `POST /embed` | 语义检索要算向量。手机端跑嵌入模型要引 Skia/ONNX 之类重依赖，会拖垮出包流水线；NAS 上 CPU 推理即可（bge-small-zh，512 维，几十毫秒一条） |

两个能力都是**可选增强**，都遵循同一个原则：**连得上就用，连不上静默退回手机本地**，不影响 App 离线可用。

## 一、文档解析（降级链）

```
导入 .pdf → 设置里填了解析服务地址？
              ├ 填了 → POST /parse → 成功就用 NAS 结果（source: nas）
              │                      └ 失败/超时/为空 → 退回手机本地解析（source: local）
              └ 没填 → 直接用手机本地解析（source: local）
```

不填地址 = 全程离线自足，只是质量保守一些。手机端设了超时（90s），NAS 不在家或没开机只会静默降级。

> 只有 `.pdf` 走这条链。`.docx` 不绕 NAS —— 手机端解 docx 已经够好（0.99 质量、毫秒级）。
> 服务端仍实现了 `/parse` 的 docx 分支，方便用 curl 单独验。

## 二、文本嵌入（混合检索的语义那一路）

App 侧检索是**混合检索**：关键词（BM25，本地、永远在线）+ 语义（向量，需要嵌入服务）。
两路各排各的名次，最后用 RRF 融合 —— 所以「搜"有效期"而原文写"保质期"」这类字面无重叠的问法也能命中。

```
问答/搜索 → 关键词路（BM25） ─┐
                                ├→ RRF 融合 → 上下文
            语义路（/embed）  ─┘
                 ↑ 没配嵌入服务 / 没建索引 / 服务挂了 → 这一路静默缺席，只走关键词
```

**不填嵌入地址就只用关键词检索**，功能完整、完全离线。填了才启用语义那一路。

> 嵌入向量存在手机本地（sqlite `embeddings` 表）。它是**派生数据** —— 丢了按原文本重算即可，
> 所以既不需要备份，也不参与同步。在「我的 → 语义检索」点「重建语义索引」即可全量重算。
> 换了模型必须重建：不同模型的向量维度和语义都不一样，混用会得到无意义的结果。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 连通性 + 嵌入模型状态：`{"ok":true,"engine":"pymupdf 1.28.2","version":"1.1","embed":{"model":"…","ready":true,"error":null}}` |
| `POST` | `/parse?name=xxx.pdf` | body 是文件原始字节（`application/octet-stream`） |
| `POST` | `/embed` | body 是 JSON：`{"texts":["第一段","第二段"]}` |

`POST /parse` 返回：

```json
{"text": "提取到的正文", "pages": 2, "quality": 0.9, "engine": "pymupdf", "elapsedMs": 92}
```

- `quality` 是 0~1 的自评（按每页字符数算）。低于 0.3 基本就是扫描件。
- 扫描件不会返回垃圾文本，而是 `text: ""` + `note: "…需要 OCR"`，App 侧会显示这个提示。
- 出错时返回 4xx + 中文 `detail`：415（格式不支持，如老式 `.doc`）、413（超过 `MAX_BYTES`）、401（令牌不对）、422（解析失败）。

`POST /embed` 返回：

```json
{"vectors": [[0.12, -0.03, ...]], "model": "BAAI/bge-small-zh-v1.5", "dim": 512, "elapsedMs": 18}
```

- 单次最多 512 条（`MAX_EMBED_TEXTS`），单条超过 1000 字会被截断（`EMBED_MAX_CHARS`）。
- **首次调用会下载模型**（bge-small-zh 约 100MB），所以容器启动时会在后台预热（`EMBED_WARMUP=1`）。
  预热失败不影响 `/parse`，`/health` 里会如实报告。
- 形状与 OpenAI `/embeddings` 不同（这个是 `{"texts":[...]}` → `{"vectors":[...]}`），
  App 侧两种形状都认，填哪个地址都能用。

## 部署到 fnOS（飞牛 NAS）

```bash
# 放到 NAS 上任意目录，例如 /vol1/1000/techdocs/nas-parse
docker compose up -d --build
docker compose logs -f          # 看到 "Application startup complete" 即成功
                                # 稍后再出现 "[embed] 模型就绪" 表示嵌入也准备好了
```

可选：在同目录建 `.env` 加一层令牌保护（内网也可以不设）

```
AUTH_TOKEN=随便一串你记得住的
```

完了在 NAS 上验一下：

```bash
curl http://127.0.0.1:8787/health
# 解析
curl -X POST "http://127.0.0.1:8787/parse?name=t.pdf" --data-binary @t.pdf
# 嵌入
curl -X POST http://127.0.0.1:8787/embed -H 'Content-Type: application/json' \
     -d '{"texts":["适用期是多久"]}'
```

> **模型下载需要联网**。NAS 不能出网的话，两种办法：
> ① 把 `models/` 目录（compose 里已挂载到宿主机）用能上网的机器预先生成好再拷进去；
> ② 干脆不用这个 /embed —— App 里可以把嵌入地址填成任意 OpenAI 兼容服务
> （例如 NAS 上另起的 Ollama `http://<ip>:11434/v1`，模型 `bge-m3`），效果一样。

## 手机端怎么接

App 里两处，都是填地址 + 测试连接：

| 能力 | 位置 | 填什么 |
|---|---|---|
| 文档解析 | **我的 → 文档解析服务** | `http://<NAS的局域网IP>:8787` |
| 语义检索 | **我的 → 语义检索（嵌入服务）** | 同上（NAS 服务自带 `/embed`）；模型名留空即可 |

语义检索那边填完记得点 **保存**，再点 **重建语义索引**（要先把资料库的文档建好向量，语义路才有东西可比）。

> 网页预览（`localhost:8081`）里测这两个按钮可能因为浏览器 CORS 报失败，属正常现象，
> 以真机为准 —— 手机走原生 fetch，不受 CORS 限制。服务端已放开 CORS 以便浏览器直连。

## 本地开发 / 自检

```bash
pip install -r requirements.txt
python selfcheck.py                                   # 不需要起服务，16 项断言
uvicorn app:app --host 127.0.0.1 --port 8787 --reload
```

`selfcheck.py` 盯的是容易悄悄坏掉的事：兼容码位还原（「用」U+2F64 不还原，用户就搜不到关键字）、
表格行重组（同行单元格不能被拆成一列碎句）、令牌鉴权、嵌入状态形状。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | 空 | 非空则要求 `Authorization: Bearer <token>`；`/health` 始终放行以便测试 |
| `MAX_BYTES` | 64MB | 单文件上限，超了返回 413 |
| `EMBED_MODEL` | `BAAI/bge-small-zh-v1.5` | 嵌入模型。中文 / 512 维 / CPU 够快。**换模型后手机端必须重建语义索引** |
| `EMBED_CACHE_DIR` | 空 | 模型缓存目录（Dockerfile 里设为 `/models/fastembed`，compose 挂到宿主机） |
| `EMBED_WARMUP` | `1` | 启动时后台预热嵌入模型；失败只记录，不影响 `/parse` |
| `MAX_EMBED_TEXTS` | `512` | 单次 `/embed` 最多几条文本 |
| `EMBED_MAX_CHARS` | `1000` | 单条文本截断长度 |
