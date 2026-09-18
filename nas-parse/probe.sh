#!/bin/sh
# 京美AI助手 · NAS 环境探测（纯只读：不安装、不修改、不下载任何东西）
#
# 用法：把这一整段粘到 NAS 的终端里回车，把输出原样发我。
# 飞牛 fnOS 开终端：系统设置 → 终端与 SSH（或直接用浏览器里的终端）

echo "===== 1 系统 ====="
head -3 /etc/os-release 2>/dev/null
echo "kernel: $(uname -r)  arch: $(uname -m)"

echo "===== 2 CPU ====="
lscpu 2>/dev/null | grep -E "Model name|^CPU\(s\)|Thread|Core|Socket|MHz"
echo -n "指令集: "
grep -o -m1 -E "avx2|avx512f|fma|sse4_2" /proc/cpuinfo 2>/dev/null | sort -u | tr '\n' ' '
echo

echo "===== 3 内存 / 磁盘 ====="
free -g 2>/dev/null | head -2
df -h /vol1 2>/dev/null | tail -1
df -h /var/lib/docker 2>/dev/null | tail -1
df -h / 2>/dev/null | tail -1

echo "===== 4 GPU（关键）====="
nvidia-smi --query-gpu=index,name,memory.total,driver_version,compute_cap --format=csv 2>&1 | head -6 || echo "未装 nvidia-smi（= 驱动还没装）"
nvidia-smi 2>/dev/null | grep -o "CUDA Version: [0-9.]*"
lspci 2>/dev/null | grep -iE "vga|3d controller|nvidia" | head -4 || echo "（没装 lspci，跳过硬件列表）"

echo "===== 5 Docker ====="
docker --version 2>&1 | head -1
docker compose version 2>&1 | head -1
docker info 2>/dev/null | grep -i "Runtimes" | head -1
command -v nvidia-ctk >/dev/null 2>&1 && echo "nvidia-container-toolkit: 已装" || echo "nvidia-container-toolkit: 未装"

echo "===== 6 端口占用（我要用的那几口）====="
(ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | grep -E ":(8787|8788|8789|8790|8000)" || echo "全部空闲"

echo "===== 7 已在跑的容器 ====="
docker ps --format "{{.Names}} | {{.Image}} | {{.Status}}" 2>&1 | head -12

echo "===== 探测结束，把上面全部内容发我 ====="
