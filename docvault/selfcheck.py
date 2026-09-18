"""docvault 自检：把「用户管理 + 凭据」的每一条安全不变量都跑一遍。

    python selfcheck.py        # 用 8788 起的服务无关，全在内存/临时库里跑

为什么不用 pytest：这里没有 fixture 需求，一个临时库 + 一个 TestClient 就够，
多一个框架多一份要维护的东西。断言失败会明确说是哪一条。
"""
import os
import sys
import tempfile

# 必须在 import db / app 之前 —— db.py 在 import 时读库路径
TMP = tempfile.mkdtemp(prefix="docvault-check-")
os.environ["DOCVAULT_DB"] = os.path.join(TMP, "check.db")
os.environ["DOCVAULT_ADMIN_PASSWORD"] = "admin-pw-123"
os.environ["DOCVAULT_ADMIN_USER"] = "admin"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import auth  # noqa: E402
import db  # noqa: E402
from app import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

PASS, FAIL = 0, []


def check(label, ok, extra=""):
    global PASS
    if ok:
        PASS += 1
        print(f"  ok  {label}")
    else:
        FAIL.append(label)
        print(f"  XX  {label}  {extra}")


def hdr(tok):
    return {"Authorization": "Bearer " + tok}


print("=== 1. 密码哈希 ===")
h = auth.hash_password("s3cret")
check("哈希串自描述算法与参数", h.startswith("scrypt$16384$8$1$"))
check("哈希串不含明文", "s3cret" not in h)
check("正确密码通过", auth.verify_password("s3cret", h))
check("错误密码不通过", not auth.verify_password("s3cret ", h))
check("损坏的哈希串不抛异常、直接不通过", not auth.verify_password("x", "garbage"))
check("同一密码两次哈希不同（每次新盐）", auth.hash_password("a") != auth.hash_password("a"))

print("\n=== 2. 凭据明文 ===")
plain, sh, prefix = auth.new_secret("app")
check("App 令牌带可识别前缀", plain.startswith("dv_app_"))
check("API Key 前缀与令牌不同", auth.new_secret("api")[0].startswith("dv_key_"))
check("前缀只是明文开头、不是秘密", plain.startswith(prefix) and len(prefix) < len(plain) / 2)
check("入库的是哈希不是明文", sh == auth.hash_secret(plain) and sh != plain)

with TestClient(app) as cli:
    print("\n=== 3. 首次启动不死锁 ===")
    check("库空时自动建管理员", db.count_users() == 1)
    check("管理员角色正确", db.list_users()[0]["role"] == "admin")

    print("\n=== 4. 登录 / 鉴权 ===")
    r = cli.post("/auth/login", json={"username": "admin", "password": "admin-pw-123"})
    check("登录 200", r.status_code == 200, r.text)
    a_tok = r.json()["token"]
    check("登录返回的是 App 令牌", a_tok.startswith("dv_app_"))
    check("登录响应里没有密码哈希", "password_hash" not in r.text)

    check("密码错 → 401", cli.post("/auth/login", json={"username": "admin", "password": "nope"}).status_code == 401)
    check("用户不存在 → 401（不透露是否存在）",
          cli.post("/auth/login", json={"username": "ghost", "password": "x"}).status_code == 401)
    check("不带 Authorization → 401", cli.get("/auth/me").status_code == 401)
    check("令牌是假的 → 401", cli.get("/auth/me", headers=hdr("dv_app_deadbeef")).status_code == 401)
    check("Bearer 前缀错 → 401", cli.get("/auth/me", headers={"Authorization": "Token " + a_tok}).status_code == 401)
    check("正确令牌 → 200", cli.get("/auth/me", headers=hdr(a_tok)).status_code == 200)
    check("/health 免鉴权", cli.get("/health").status_code == 200)
    check("/health 报出计数", cli.get("/health").json()["users"] == 1)

    print("\n=== 5. 开号（只手动，无注册接口）===")
    r = cli.post("/users", headers=hdr(a_tok), json={"username": "chen", "password": "chen-pw-123", "role": "user"})
    check("管理员能开号", r.status_code == 200, r.text)
    chen_id = r.json()["id"]
    check("重名 → 409", cli.post("/users", headers=hdr(a_tok),
          json={"username": "chen", "password": "x" * 8}).status_code == 409)
    check("没有 /auth/register 这个口子", cli.post("/auth/register", json={}).status_code in (404, 405))
    check("用户名过长 → 422", cli.post("/users", headers=hdr(a_tok),
          json={"username": "x" * 65, "password": "y" * 8}).status_code == 422)
    check("密码过短 → 422", cli.post("/users", headers=hdr(a_tok),
          json={"username": "z", "password": "123"}).status_code == 422)

    print("\n=== 6. 越权 ===")
    c_tok = cli.post("/auth/login", json={"username": "chen", "password": "chen-pw-123"}).json()["token"]
    check("普通用户列用户 → 403", cli.get("/users", headers=hdr(c_tok)).status_code == 403)
    check("普通用户能看自己", cli.get("/auth/me", headers=hdr(c_tok)).json()["username"] == "chen")
    check("普通用户能签自己的令牌", cli.post("/tokens", headers=hdr(c_tok), json={"name": "我的 iPhone"}).status_code == 200)
    check("普通用户不能替别人签", cli.post("/tokens", headers=hdr(c_tok),
          json={"name": "偷偷的", "user_id": "u_someone"}).status_code == 403)

    print("\n=== 7. 停用 / 删除 的自保闸 ===")
    check("不能停用自己", cli.patch(f"/users/{db.list_users()[0]['id']}", headers=hdr(a_tok),
          json={"disabled": True}).status_code == 400)
    check("不能删除自己", cli.delete(f"/users/{db.list_users()[0]['id']}", headers=hdr(a_tok)).status_code == 400)
    admin_id = db.list_users()[0]["id"]
    check("不能把最后一个管理员降级", cli.patch(f"/users/{admin_id}", headers=hdr(a_tok),
          json={"role": "user"}).status_code == 400)
    check("停用普通用户 → 200", cli.patch(f"/users/{chen_id}", headers=hdr(a_tok),
          json={"disabled": True}).status_code == 200)
    check("停用后他的令牌立刻失效（401）", cli.get("/auth/me", headers=hdr(c_tok)).status_code == 401)
    check("停用后他也登不进来（403）", cli.post("/auth/login",
          json={"username": "chen", "password": "chen-pw-123"}).status_code == 403)
    cli.patch(f"/users/{chen_id}", headers=hdr(a_tok), json={"disabled": False})
    check("重新启用后可登录", cli.post("/auth/login",
          json={"username": "chen", "password": "chen-pw-123"}).status_code == 200)

    print("\n=== 8. 凭据签发 / 吊销 / 过期 ===")
    r = cli.post("/api-keys", headers=hdr(a_tok), json={"name": "报价脚本"})
    check("能签发 API Key", r.status_code == 200, r.text)
    key = r.json()["secret"]
    check("Key 前缀与其他 Key 可区分", key.startswith("dv_key_"))
    krow = db.find_cred_by_hash(auth.hash_secret(key))
    check("库里查得到（按哈希）", krow is not None)
    check("库里没有明文", "secret" not in krow and krow["secret_hash"] != key)

    lst = cli.get("/api-keys", headers=hdr(a_tok)).json()
    check("列表里不含明文 secret", all("secret" not in x for x in lst))
    check("列表里能认出是哪一把（有前缀）", any(x["prefix"] == krow["prefix"] for x in lst))

    kl = cli.post("/api-keys", headers=hdr(a_tok), json={"name": "短期", "expires_days": -1}).json()
    check("过期 Key 立刻不可用（401）", cli.get("/auth/me", headers=hdr(kl["secret"])).status_code == 401)

    check("Key 也能当令牌用（同一套鉴权）", cli.get("/auth/me", headers=hdr(key)).status_code == 200)
    check("管理员吊销 Key → 200", cli.delete("/api-keys/" + krow["id"], headers=hdr(a_tok)).status_code == 200)
    check("吊销后 401", cli.get("/auth/me", headers=hdr(key)).status_code == 401)
    check("再吊销一次 → 200（幂等）", cli.delete("/api-keys/" + krow["id"], headers=hdr(a_tok)).status_code == 200)
    check("拿 App 令牌的 id 去吊销 Key → 404（两组路由不串味）",
          cli.delete("/api-keys/" + db.list_creds("app")[0]["id"], headers=hdr(a_tok)).status_code == 404)
    check("普通用户吊销管理员的令牌 → 403", cli.delete(
        "/tokens/" + [c for c in db.list_creds("app") if c["user_id"] == admin_id][0]["id"],
        headers=hdr(c_tok)).status_code == 403)

    print("\n=== 9. 改密码 ===")
    check("原密码错 → 400", cli.post("/auth/password", headers=hdr(a_tok),
          json={"old": "wrong", "new": "newpw123"}).status_code == 400)
    check("改密码 200", cli.post("/auth/password", headers=hdr(a_tok),
          json={"old": "admin-pw-123", "new": "newpw123"}).status_code == 200)
    check("旧密码登不进", cli.post("/auth/login",
          json={"username": "admin", "password": "admin-pw-123"}).status_code == 401)
    check("新密码能登进", cli.post("/auth/login",
          json={"username": "admin", "password": "newpw123"}).status_code == 200)

    print("\n=== 10. 删除用户级联清凭据 ===")
    k2 = cli.post("/tokens", headers=hdr(c_tok), json={"name": "临时"}).json()
    chen_creds = [c for c in db.list_creds() if c["user_id"] == chen_id]
    before = db.count_creds()
    check("他名下确实有凭据（否则下面的算术没意义）", len(chen_creds) >= 3, f"实际 {len(chen_creds)}")
    check("删掉 chen → 200", cli.delete("/users/" + chen_id, headers=hdr(a_tok)).status_code == 200)
    left = [c for c in db.list_creds() if c["user_id"] == chen_id]
    # 判据要精确到「他名下还剩几把」：拿总数跟删除前比是错的 ——
    # 删除前那个数里本来就含他自己的凭据（第一版就是这么写错的）。
    check("他名下凭据全部清掉", not left, f"残留 {len(left)}")
    check("总数正好少了他那些", db.count_creds() == before - len(chen_creds),
          f"{db.count_creds()} vs {before - len(chen_creds)}")
    check("他那把令牌立刻 401", cli.get("/auth/me", headers=hdr(k2["secret"])).status_code == 401)
    check("删不存在的人 → 404", cli.delete("/users/u_ghost", headers=hdr(a_tok)).status_code == 404)

    print("\n=== 11. 管理页 ===")
    r = cli.get("/")
    check("根路径返回管理页 HTML", r.status_code == 200 and "京美AI助手" in r.text)
    check("管理页是纯静态（不依赖接口渲染才能打开）", "<script>" in r.text and r.headers["content-type"].startswith("text/html"))
    check("接口路由没有被静态挂载吞掉", cli.get("/health").json()["service"] == "docvault")

print(f"\ndocvault 自检：{PASS}/{PASS + len(FAIL)}")
if FAIL:
    print("失败项：\n" + "\n".join("  - " + f for f in FAIL))
    sys.exit(1)
print("全部通过 ✅")
