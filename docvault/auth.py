"""密码与凭据。

两条不退让的线：
1. 密码用 scrypt（Python 标准库，无编译依赖，抗 GPU 暴力）。哈希串自描述参数
   （`scrypt$n$r$p$salt$hash`），以后调参数不会让老密码失效。
2. 凭据【明文只在生成那一刻返回一次】，库里只有 SHA-256。丢了就重新签发，找不回来。

为什么令牌用 SHA-256 而不用 scrypt：慢哈希是用来抵抗「用户自己选的弱密码」的，
而这里明文是 256 位随机串，穷举不可行 —— 对高熵秘密做慢哈希只会让每次请求都变慢。
"""
import hashlib
import hmac
import os
import secrets

import db

SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}
PREFIXES = {"app": "dv_app", "api": "dv_key"}


def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, **SCRYPT, dklen=32)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, want = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(
            pw.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=len(want) // 2
        )
        return hmac.compare_digest(dk.hex(), want)
    except (ValueError, TypeError):
        return False


def hash_secret(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def new_secret(kind: str):
    """→ (明文, 哈希, 前缀)。前缀写进库只为了在列表里认出是哪一把，它本身不是秘密。"""
    prefix = f"{PREFIXES[kind]}_{secrets.token_hex(2)}"
    plain = f"{prefix}_{secrets.token_urlsafe(32)}"
    return plain, hash_secret(plain), prefix


# ---------------- FastAPI 依赖 ----------------

from fastapi import Depends, Header, HTTPException  # noqa: E402  （依赖放这里，读的时候紧挨着用它的函数）


def current_user(authorization: str | None = Header(default=None)) -> dict:
    """解析 `Authorization: Bearer <secret>` → 用户。

    返回的是【User 对象】而不是 True/False：C 方案那天只需要在查询里加
    `WHERE owner_id = user['id']`，鉴权这一层一行都不用改。
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "缺少 Bearer 令牌")
    plain = authorization.split(" ", 1)[1].strip()
    cred = db.find_cred_by_hash(hash_secret(plain))
    if not cred:
        raise HTTPException(401, "令牌无效")
    if cred["revoked"]:
        raise HTTPException(401, "令牌已被吊销")
    if cred["expires_at"] and cred["expires_at"] < db.now():
        raise HTTPException(401, "令牌已过期")
    user = db.get_user(cred["user_id"])
    if not user or user["disabled"]:
        raise HTTPException(401, "账号已停用")
    db.touch_cred(cred["id"])
    return user


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "需要管理员权限")
    return user


def bootstrap_admin() -> dict | None:
    """库里一个用户都没有时自动建管理员。

    不做这一步，第一次部署会死锁：管理页要令牌，令牌要用户，用户只能从管理页建。
    密码取 `DOCVAULT_ADMIN_PASSWORD`；没设就随机生成并打到日志里（只在启动日志里出现，
    不落盘 —— 落盘等于把明文密码存到磁盘上，宁可让人去看一眼日志）。建完返回它，好让启动流程打印。
    """
    if db.count_users() > 0:
        return None
    username = os.environ.get("DOCVAULT_ADMIN_USER", "admin")
    pw = os.environ.get("DOCVAULT_ADMIN_PASSWORD")
    generated = pw is None
    if generated:
        pw = secrets.token_urlsafe(12)
    db.create_user(username, hash_password(pw), role="admin", note="首次启动自动创建")
    return {"username": username, "password": pw if generated else None}
