# docvault —— 京美AI助手的后端

第一件事是**用户调用 + 用户管理**：谁能进来、谁在调、每把凭据用在哪。

## 跑起来

```bash
cd docvault
DOCVAULT_ADMIN_PASSWORD=你的密码 \
  /Users/chenjingtao/.workbuddy/binaries/python/envs/default/bin/python \
  -m uvicorn app:app --host 0.0.0.0 --port 8790
```

打开 `http://<这台机器的IP>:8790` 就是管理页。

不设 `DOCVAULT_ADMIN_PASSWORD` 也能跑：库里没有用户时会**自动建一个管理员**，
随机密码打在启动日志里（只出现一次）。这一步不做，第一次部署会死锁 ——
管理页要令牌、令牌要用户、用户只能从管理页建。

自检（不需要起服务，全在临时库里跑）：

```bash
python selfcheck.py     # 65 条，覆盖鉴权、越权、自保闸、凭据生命周期
```

NAS 上部署：`docker compose up -d --build`，库落在 `./data/docvault.db`。

## 两个概念，别混

| | App 令牌 | 外部 API Key |
|---|---|---|
| 谁在用 | 装了 App 的那台手机 | 别的程序（脚本、同事的系统） |
| 前缀 | `dv_app_…` | `dv_key_…` |
| 吊销一个 | 那台手机要重新登录 | 那个程序要换 Key |

两组接口（`/tokens`、`/api-keys`）刻意分开写。底层是同一张表、同一个签发函数，
但语义不同 —— 混在一起，出事时「这把东西泄露了该吊销谁」就变成猜谜。

**明文只在生成那一刻返回一次**，库里存的是 SHA-256。丢了就重新签发，找不回来。
（密码用 scrypt 存，因为密码是「人自己选的弱秘密」，需要慢哈希；令牌是 256 位随机串，
对它做慢哈希只会让每次请求都变慢。）

## 接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/health` | 公开 | 探活 + 计数，Docker/手机端用它判断服务在不在 |
| POST | `/auth/login` | 公开 | 账号密码换一把 App 令牌 |
| GET | `/auth/me` | 令牌 | 当前是谁 |
| POST | `/auth/password` | 令牌 | 改自己的密码 |
| GET | `/users` | 管理员 | 用户列表（含各人名下凭据数） |
| POST | `/users` | 管理员 | 开号（**没有注册接口**） |
| PATCH | `/users/{id}` | 管理员 | 改密码 / 停用 / 改角色 |
| DELETE | `/users/{id}` | 管理员 | 删号（名下凭据级联清掉） |
| GET/POST | `/tokens` | 令牌 | 列 / 签 App 令牌 |
| DELETE | `/tokens/{id}` | 本人或管理员 | 吊销 |
| GET/POST | `/api-keys` | 令牌 | 列 / 签 API Key |
| DELETE | `/api-keys/{id}` | 本人或管理员 | 吊销 |
| GET | `/stats` | 令牌 | 计数（C 方案那天在这里长成按人按天的用量） |

调用任何受保护的接口都要带 `Authorization: Bearer <令牌或 Key>`。

## 三条自保闸（都是无法从界面恢复的操作）

- 不能停用自己
- 不能删除自己
- 不能停用 / 降级 / 删除**最后一个可用的管理员**

## B 方案 → C 方案怎么不返工

现在是一个人用、管理页是单机只读风格，但代码已经按多人写好了：

1. **B 与 C 的差别只落在「页面 + 鉴权」** —— 路由里没有一句「如果只有一个用户就……」。
   管理页是纯静态 HTML，拿接口当数据源，上 C 时只换 `web/index.html`。
2. **接口第一天就写全**（含此刻用不到的写操作）。否则上 C 那天要一边加功能一边改老接口，
   老客户端跟着坏。
3. **页面与接口分离**：`web/` 里只有静态文件，不 import `app.py` 的任何东西。
4. **不为 C 提前上 Postgres**：就 2 张表、全是等值查询，SQLite + WAL 够用。
   换库只换 `db.py` 里的连接和 SQL。

再加一条：每张业务表从第一天就带 `user_id` / `owner_id`，即使现在只有一个人。
这就是「加人不返工」的全部秘密，没有别的技巧。

## 文件

```
app.py          路由装配（含 B→C 的四条落地说明）
auth.py         密码哈希、凭据生成、FastAPI 依赖、首次启动建管理员
db.py           SQLite 表结构与存取
web/index.html  管理页（纯静态，无构建）
selfcheck.py    65 条自检
```
