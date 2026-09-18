"""docvault —— 京美AI助手的后端。

第一优先是【用户调用 + 用户管理】：谁能进来、谁在调、每个凭据用在哪，都在这里。

B → C 不返工的四条，落在哪：
① B（单机只读页）与 C（完整多用户）的差别只允许落在【页面 + 鉴权】——
   本文件的路由里没有一句「如果只有一个用户就……」，页面也是纯静态、拿接口当数据源。
② 接口第一天就写全（含此刻用不到的写操作）：账号、停用、改密、签发、吊销全在，
   否则上 C 那天要一边加功能一边改老接口，老客户端会跟着坏。
③ 页面与接口分离：`web/` 只有静态文件，不 import 本文件任何东西。
④ 不为 C 提前上 Postgres：库里就 2 张表、等值查询，SQLite 完全够；
   换库只换 db.py 的连接与 SQL。
另外每张业务表从第一天就带 `user_id` / `owner_id`，即使现在只有一个人 ——
这就是「加人不返工」的全部秘密，没有别的技巧。
"""
import os

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import auth
import db

VERSION = "1.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="docvault", version=VERSION, description="京美AI助手后端")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# ---------------- 入参 ----------------

class LoginIn(BaseModel):
    username: str
    password: str


class UserIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=6, max_length=256)
    role: str = "user"
    note: str | None = None


class UserPatch(BaseModel):
    password: str | None = Field(default=None, min_length=6, max_length=256)
    role: str | None = None
    disabled: bool | None = None
    note: str | None = None


class PasswordIn(BaseModel):
    old: str
    new: str = Field(min_length=6, max_length=256)


class CredIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    expires_days: int | None = None      # 不填 = 永不过期
    user_id: str | None = None           # 仅管理员可为他人签发


# ---------------- 装配 ----------------

@app.on_event("startup")
def _startup():
    db.init_db()
    created = auth.bootstrap_admin()
    if created and created["password"]:
        print(
            "\n" + "=" * 62
            + f"\n  已创建管理员账号：{created['username']}"
            + f"\n  初始密码（只在这里出现这一次，请立刻改掉）：{created['password']}"
            + "\n  想固定密码就设环境变量 DOCVAULT_ADMIN_PASSWORD 后重建库\n"
            + "=" * 62 + "\n",
            flush=True,
        )


def public_user(u: dict) -> dict:
    return {k: u[k] for k in ("id", "username", "role", "disabled", "note", "created_at")}


def public_cred(c: dict) -> dict:
    """凭据对外永远不含 secret_hash。列表里只给前缀，让人认出是哪一把。"""
    return {k: c[k] for k in ("id", "user_id", "kind", "name", "prefix",
                              "last_used_at", "expires_at", "revoked", "created_at")}


def _expires(days: int | None) -> str | None:
    if not days:
        return None
    import time
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(time.time() + days * 86400))


def _admins_left(exclude_id: str | None = None) -> int:
    return len([
        u for u in db.list_users()
        if u["role"] == "admin" and not u["disabled"] and u["id"] != exclude_id
    ])


# ---------------- 公开端点 ----------------

@app.get("/health")
def health():
    """不需要鉴权 —— 探活。Docker/Caddy/手机端都拿它判断「服务在不在」。"""
    return {
        "ok": True, "service": "docvault", "version": VERSION,
        "users": db.count_users(), "tokens": db.count_creds("app"), "api_keys": db.count_creds("api"),
    }


@app.post("/auth/login")
def login(body: LoginIn):
    """用账号密码换一把 App 令牌。App 只存这把令牌，不存密码。"""
    u = db.get_user_by_name(body.username)
    if not u or not auth.verify_password(body.password, u["password_hash"]):
        raise HTTPException(401, "用户名或密码不对")
    if u["disabled"]:
        raise HTTPException(403, "账号已停用")
    plain, h, prefix = auth.new_secret("app")
    cred = db.create_cred(u["id"], "app", "登录获得", h, prefix)
    return {"token": plain, "credential_id": cred["id"], "user": public_user(u)}


@app.get("/auth/me")
def me(user: dict = Depends(auth.current_user)):
    return public_user(user)


@app.post("/auth/password")
def change_own_password(body: PasswordIn, user: dict = Depends(auth.current_user)):
    if not auth.verify_password(body.old, user["password_hash"]):
        raise HTTPException(400, "原密码不对")
    db.update_user(user["id"], password_hash=auth.hash_password(body.new))
    return {"ok": True}


# ---------------- 用户管理 ----------------

@app.get("/users")
def list_users(_: dict = Depends(auth.require_admin)):
    creds = db.list_creds()
    return [{
        **public_user(u),
        "tokens": len([c for c in creds if c["user_id"] == u["id"] and c["kind"] == "app" and not c["revoked"]]),
        "api_keys": len([c for c in creds if c["user_id"] == u["id"] and c["kind"] == "api" and not c["revoked"]]),
    } for u in db.list_users()]


@app.post("/users")
def create_user(body: UserIn, _: dict = Depends(auth.require_admin)):
    """只从管理页手动开号 —— 没有注册接口。资料在内网，不需要给外人开门。"""
    if body.role not in ("admin", "user"):
        raise HTTPException(400, "角色只能是 admin 或 user")
    if db.get_user_by_name(body.username):
        raise HTTPException(409, "用户名已存在")
    u = db.create_user(body.username, auth.hash_password(body.password), body.role, body.note)
    return public_user(u)


@app.patch("/users/{user_id}")
def patch_user(user_id: str, body: UserPatch, admin: dict = Depends(auth.require_admin)):
    target = db.get_user(user_id)
    if not target:
        raise HTTPException(404, "用户不存在")
    fields = {}
    if body.password is not None:
        fields["password_hash"] = auth.hash_password(body.password)
    if body.role is not None:
        if body.role not in ("admin", "user"):
            raise HTTPException(400, "角色只能是 admin 或 user")
        fields["role"] = body.role
    if body.note is not None:
        fields["note"] = body.note
    if body.disabled is not None:
        # 两条自保闸：把自己锁在外面 / 把最后一个管理员停掉，都是无法从界面恢复的操作
        if body.disabled and user_id == admin["id"]:
            raise HTTPException(400, "不能停用自己")
        if body.disabled and target["role"] == "admin" and _admins_left(exclude_id=user_id) == 0:
            raise HTTPException(400, "至少要留一个可用的管理员")
        fields["disabled"] = 1 if body.disabled else 0
    if body.role == "user" and target["role"] == "admin" and _admins_left(exclude_id=user_id) == 0:
        raise HTTPException(400, "至少要留一个可用的管理员")
    return public_user(db.update_user(user_id, **fields))


@app.delete("/users/{user_id}")
def delete_user(user_id: str, admin: dict = Depends(auth.require_admin)):
    target = db.get_user(user_id)
    if not target:
        raise HTTPException(404, "用户不存在")
    if user_id == admin["id"]:
        raise HTTPException(400, "不能删除自己")
    if target["role"] == "admin" and _admins_left(exclude_id=user_id) == 0:
        raise HTTPException(400, "至少要留一个可用的管理员")
    db.delete_user(user_id)   # credentials 靠外键 ON DELETE CASCADE 一起清掉
    return {"ok": True}


# ---------------- 凭据：App 令牌 与 外部 API Key ----------------
#
# 两组路由刻意分开写。它们底层是同一张表、同一个签发函数，但语义不同：
# App 令牌代表「某个装了 App 的人」，API Key 代表「某个在调你接口的程序」。
# 混在一起会让「这把 Key 泄露了该吊销谁」变成猜谜。

def _issue(kind: str, body: CredIn, user: dict):
    owner = body.user_id or user["id"]
    if body.user_id and body.user_id != user["id"] and user["role"] != "admin":
        raise HTTPException(403, "只有管理员能为他人签发")
    if not db.get_user(owner):
        raise HTTPException(404, "目标用户不存在")
    plain, h, prefix = auth.new_secret(kind)
    cred = db.create_cred(owner, kind, body.name, h, prefix, _expires(body.expires_days))
    # 明文只此一次。前端必须当场让用户复制走。
    return {**public_cred(cred), "secret": plain}


def _list(kind: str, user: dict):
    rows = db.list_creds(kind=kind)
    if user["role"] != "admin":
        rows = [c for c in rows if c["user_id"] == user["id"]]
    names = {u["id"]: u["username"] for u in db.list_users()}
    return [{**public_cred(c), "username": names.get(c["user_id"], "?")} for c in rows]


def _revoke(kind: str, cred_id: str, user: dict):
    c = db.get_cred(cred_id)
    if not c or c["kind"] != kind:
        raise HTTPException(404, "凭据不存在")
    if user["role"] != "admin" and c["user_id"] != user["id"]:
        raise HTTPException(403, "无权吊销他人的凭据")
    db.revoke_cred(cred_id)
    return {"ok": True}


@app.get("/tokens")
def list_tokens(user: dict = Depends(auth.current_user)):
    return _list("app", user)


@app.post("/tokens")
def create_token(body: CredIn, user: dict = Depends(auth.current_user)):
    return _issue("app", body, user)


@app.delete("/tokens/{cred_id}")
def revoke_token(cred_id: str, user: dict = Depends(auth.current_user)):
    return _revoke("app", cred_id, user)


@app.get("/api-keys")
def list_api_keys(user: dict = Depends(auth.current_user)):
    return _list("api", user)


@app.post("/api-keys")
def create_api_key(body: CredIn, user: dict = Depends(auth.current_user)):
    return _issue("api", body, user)


@app.delete("/api-keys/{cred_id}")
def revoke_api_key(cred_id: str, user: dict = Depends(auth.current_user)):
    return _revoke("api", cred_id, user)


@app.get("/stats")
def stats(user: dict = Depends(auth.current_user)):
    """现在只是计数；C 方案那天在这里长成按人/按天的用量。"""
    return {
        "users": db.count_users(),
        "tokens": db.count_creds("app"),
        "api_keys": db.count_creds("api"),
        "you": public_user(user),
    }


# ---------------- 管理页 ----------------
# 挂载必须在所有 API 路由【之后】：StaticFiles 挂在 "/" 会吞掉后面注册的路由。
_web = os.path.join(HERE, "web")
if os.path.isdir(_web):
    app.mount("/", StaticFiles(directory=_web, html=True), name="web")
