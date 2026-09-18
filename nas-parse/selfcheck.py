"""解析服务自检 —— 不需要起服务，直接 python selfcheck.py 就能跑。

覆盖三件容易悄悄坏掉的事：
  1. 兼容码位还原（「用」U+2F64 → U+4E32），坏了用户就搜不到关键字
  2. 表格行重组（同一行的单元格要留在同一行，不能一列碎句）
  3. 令牌鉴权（AUTH_TOKEN 非空时必须拦住无令牌请求）
"""

import sys
import unicodedata

import app as svc

failures = []


def check(name, cond, detail=""):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  → ' + str(detail)}")
    if not cond:
        failures.append(name)


# ---- 1. 兼容码位还原 ----
# 康熙部首区的码位是 PDF 字体子集化的产物，必须还原成正常汉字
kangxi = "\u2f64\u2f2f"          # ⽤⼯
check("兼容码位还原为常用汉字", svc.normalize_cjk_compat(kangxi) == "用工",
      repr(svc.normalize_cjk_compat(kangxi)))
# 全角标点不能被动（与手机端 cjk-compat-table.ts 的取值范围保持一致）
check("全角标点保持不变", svc.normalize_cjk_compat("，（）") == "，（）")
check("普通文本原样返回", svc.normalize_cjk_compat("Araldite CY1578") == "Araldite CY1578")


# ---- 2. 质量分 ----
check("空文本 0 分", svc.score_pdf("", 1) == 0.0)
check("扫描件低分", svc.score_pdf("x" * 30, 1) < 0.5)
check("正文高分", svc.score_pdf("x" * 3000, 2) >= 0.9)


# ---- 3. 表格行重组 ----
class _Page:
    """伪 PyMuPDF page：两行两列的表格，每格是一个独立 span。"""

    def get_text(self, mode):
        assert mode == "dict"
        cells = [
            (10, 10, 60, 22, "性能项目"), (200, 10, 250, 22, "单位"), (400, 10, 450, 22, "数值"),
            (10, 40, 120, 52, "混合粘度"), (200, 40, 260, 52, "mPa·s"), (400, 40, 450, 52, "1200"),
        ]
        lines = [
            {"spans": [{"bbox": (x0, y0, x1, y1), "size": 12.0, "text": t}]}
            for (x0, y0, x1, y1, t) in cells
        ]
        return {"blocks": [{"lines": lines}]}


rows = svc.page_text_rows(_Page()).split("\n")
check("表格行不被拆散", len(rows) == 2, rows)
check("同行单元格用空格分隔", rows and rows[0].split() == ["性能项目", "单位", "数值"], rows)


# ---- 4. 令牌鉴权 ----
from fastapi import HTTPException

svc.AUTH_TOKEN = ""
try:
    svc.check_auth(None)
    check("未设令牌时放行", True)
except HTTPException:
    check("未设令牌时放行", False, "不该抛错")

svc.AUTH_TOKEN = "secret123"
try:
    svc.check_auth(None)
    check("无令牌被拒", False, "应抛 401")
except HTTPException as e:
    check("无令牌被拒", e.status_code == 401, e.status_code)
try:
    svc.check_auth("Bearer wrong")
    check("错令牌被拒", False, "应抛 401")
except HTTPException as e:
    check("错令牌被拒", e.status_code == 401, e.status_code)
try:
    svc.check_auth("Bearer secret123")
    check("正确令牌放行", True)
except HTTPException:
    check("正确令牌放行", False, "不该抛错")
svc.AUTH_TOKEN = ""


# ---- 5. 嵌入服务（只验配置与状态形状，不真去下模型）----
# fastembed 是懒加载的：没被调用过就不该 import，所以这里也不该因为缺依赖而失败
check("嵌入模型默认是中文小模型", svc.EMBED_MODEL == "BAAI/bge-small-zh-v1.5", svc.EMBED_MODEL)
state = svc.embed_state()
check("embed_state 字段完整", set(state) == {"model", "ready", "error"}, state)
check("未预热时 ready=False 且无报错", state["ready"] is False and state["error"] is None, state)
check("向量批量上限为正整数", svc.MAX_EMBED_TEXTS > 0 and svc.EMBED_MAX_CHARS > 0)


# ---- 6. /embed 的接口契约（注入假嵌入器）----
# 这里验的是「入参校验 / 响应形状 / 维度回显」——本次新写的代码。
# 模型精度是 fastembed 的事，不该由自检来背；也正因为注入了假模型，
# 没装 fastembed 的环境一样能跑完这一节。
import asyncio
import json as _json


class _FakeVec(list):
    """模拟 numpy 数组 —— 真实 fastembed 返回的是 np.ndarray，接口里用 .tolist() 取原生列表。"""

    def tolist(self):
        return list(self)


class _FakeEmbedder:
    def embed(self, texts):
        return [_FakeVec([float(i + 1)] * 4) for i, _ in enumerate(texts)]


_real_get_embedder = svc.get_embedder
svc.get_embedder = lambda: _FakeEmbedder()


def _call_embed(payload):
    resp = asyncio.run(svc.embed(payload=payload, authorization=None))
    return resp.status_code, _json.loads(resp.body)


try:
    code, body = _call_embed({"texts": ["甲", "乙"]})
    check("/embed 正常返回向量", code == 200 and len(body.get("vectors", [])) == 2, body)
    check("/embed 回显向量维度", body.get("dim") == 4, body.get("dim"))
    check("/embed 回显模型名", bool(body.get("model")), body.get("model"))

    for bad, want, label in [
        ({"texts": []}, 400, "空 texts"),
        ({"nope": 1}, 400, "缺 texts 字段"),
        ({"texts": ["x"] * (svc.MAX_EMBED_TEXTS + 1)}, 413, "超过批量上限"),
    ]:
        try:
            _call_embed(bad)
            check(f"/embed 拒绝{label}", False, f"应抛 {want}")
        except HTTPException as e:
            check(f"/embed 拒绝{label}", e.status_code == want, e.status_code)
finally:
    svc.get_embedder = _real_get_embedder


print()
if failures:
    print(f"❌ {len(failures)} 项失败：{', '.join(failures)}")
    sys.exit(1)
print("✅ 全部通过")
