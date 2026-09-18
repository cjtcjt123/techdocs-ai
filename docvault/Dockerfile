FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py auth.py db.py selfcheck.py ./
COPY web ./web

# 库放在 volume 里，容器重建不丢账号
ENV DOCVAULT_DB=/data/docvault.db
VOLUME ["/data"]

EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8790/health')"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8790"]
