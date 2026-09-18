FROM python:3.12-slim

WORKDIR /app

# onnxruntime（fastembed 的推理后端）依赖 libgomp，slim 镜像里没有 —— 缺了会在 import 时报错
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8787

# 嵌入模型缓存：容器重建时不重下（compose 里把这个目录挂到宿主机）
ENV EMBED_CACHE_DIR=/models/fastembed
VOLUME ["/models"]

# 单 worker 够用：解析是 CPU 密集且短促，并发由 uvicorn 的异步 IO 扛。
# 真要并发多个大 PDF，再加 --workers 2（内存翻倍）。
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8787"]
