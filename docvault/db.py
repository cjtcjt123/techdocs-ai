"""docvault 的存储层：只做「存取」，不做任何业务判断。

为什么没有 ORM：一共 2 张表、查询全是等值查找。ORM 换来的是一份必须手工同步的
模型层，而这里要防的错是「谁是谁的凭据」——SQL 看得更清楚。以后真上 Postgres（C 方案）
也只换这一个文件的连接和 SQL，上层 `current_user()` 的签名不变。
"""
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager

DB_PATH = os.environ.get(
    "DOCVAULT_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "docvault.db")
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',   -- admin | user
  disabled      INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TEXT NOT NULL
);

-- 两类凭据共用一张表：App 令牌 与 外部 API Key。
-- 它们的形状完全一样（哈希 + 前缀 + 归属 + 有效期 + 吊销），只差一个 kind。
-- 拆成两张表 = 同一套 CRUD 抄两遍，将来改一处必漏一处。
-- 「接口分开」是路由层的事（/tokens 与 /api-keys 各有各的语义），不是存储层的事。
CREATE TABLE IF NOT EXISTS credentials (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,          -- app | api
  name         TEXT,
  secret_hash  TEXT NOT NULL,          -- 明文【永不入库】
  prefix       TEXT NOT NULL,          -- 明文前 12 位，只为在列表里认出「是哪一把」
  last_used_at TEXT,
  expires_at   TEXT,                   -- NULL = 永不过期
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cred_hash ON credentials(secret_hash);
CREATE INDEX IF NOT EXISTS idx_cred_user ON credentials(user_id, kind);
"""


@contextmanager
def conn():
    """每次调用开一条连接。sqlite 的连接建立是微秒级，
    比维护一个带锁的全局连接更省心（FastAPI 的同步端点跑在线程池里）。"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init_db():
    with conn() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def uid(prefix="u"):
    return prefix + uuid.uuid4().hex[:12]


# ---------------- users ----------------

def create_user(username, password_hash, role="user", note=None, uid_=None):
    with conn() as c:
        row = {
            "id": uid_ or uid("u"), "username": username, "password_hash": password_hash,
            "role": role, "note": note, "created_at": now(),
        }
        c.execute(
            "INSERT INTO users (id, username, password_hash, role, note, created_at)"
            " VALUES (:id, :username, :password_hash, :role, :note, :created_at)", row
        )
        # 必须用【同一条连接】读回来：此时事务还没提交（commit 在 with 出口），
        # 另开一条连接去看是看不到这笔未提交数据的 —— 会拿到 None。
        r = c.execute("SELECT * FROM users WHERE id=?", (row["id"],)).fetchone()
        return dict(r)


def get_user(id_):
    with conn() as c:
        r = c.execute("SELECT * FROM users WHERE id=?", (id_,)).fetchone()
        return dict(r) if r else None


def get_user_by_name(username):
    with conn() as c:
        r = c.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        return dict(r) if r else None


def list_users():
    with conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM users ORDER BY created_at")]


def update_user(id_, **fields):
    allowed = {k: v for k, v in fields.items() if k in ("password_hash", "role", "disabled", "note")}
    if not allowed:
        return get_user(id_)
    sets = ", ".join(f"{k}=:{k}" for k in allowed)
    with conn() as c:
        c.execute(f"UPDATE users SET {sets} WHERE id=:id", {**allowed, "id": id_})
    return get_user(id_)


def delete_user(id_):
    with conn() as c:
        cur = c.execute("DELETE FROM users WHERE id=?", (id_,))
        return cur.rowcount > 0


def count_users():
    with conn() as c:
        return c.execute("SELECT COUNT(*) FROM users").fetchone()[0]


# ---------------- credentials ----------------

def create_cred(user_id, kind, name, secret_hash, prefix, expires_at=None):
    with conn() as c:
        rid = uid("c")
        c.execute(
            "INSERT INTO credentials (id, user_id, kind, name, secret_hash, prefix, expires_at, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (rid, user_id, kind, name, secret_hash, prefix, expires_at, now()),
        )
        r = c.execute("SELECT * FROM credentials WHERE id=?", (rid,)).fetchone()
        return dict(r)


def list_creds(kind=None, user_id=None):
    q, p = "SELECT * FROM credentials WHERE 1=1", []
    if kind:
        q += " AND kind=?"; p.append(kind)
    if user_id:
        q += " AND user_id=?"; p.append(user_id)
    q += " ORDER BY created_at DESC"
    with conn() as c:
        return [dict(r) for r in c.execute(q, p)]


def find_cred_by_hash(h):
    with conn() as c:
        r = c.execute("SELECT * FROM credentials WHERE secret_hash=?", (h,)).fetchone()
        return dict(r) if r else None


def touch_cred(id_):
    """记「最后一次使用」。写失败不影响鉴权结果 —— 使用痕迹比能不能用次要。"""
    try:
        with conn() as c:
            c.execute("UPDATE credentials SET last_used_at=? WHERE id=?", (now(), id_))
    except sqlite3.Error:
        pass


def revoke_cred(id_):
    with conn() as c:
        cur = c.execute("UPDATE credentials SET revoked=1 WHERE id=?", (id_,))
        return cur.rowcount > 0


def get_cred(id_):
    with conn() as c:
        r = c.execute("SELECT * FROM credentials WHERE id=?", (id_,)).fetchone()
        return dict(r) if r else None


def count_creds(kind=None):
    with conn() as c:
        if kind:
            return c.execute("SELECT COUNT(*) FROM credentials WHERE kind=?", (kind,)).fetchone()[0]
        return c.execute("SELECT COUNT(*) FROM credentials").fetchone()[0]
