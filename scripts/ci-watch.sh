#!/bin/bash
# 轮询 GitHub Actions run，直到完成。用于 techdocs-ai iOS 构建。
PROXY="http://127.0.0.1:50599"
REPO="cjtcjt123/techdocs-ai"
RUN_ID="${1:?usage: ci-watch.sh <run_id>}"

api() { curl -s -x "$PROXY" --max-time 30 -H "Accept: application/vnd.github+json" "$1"; }

for i in $(seq 1 100); do
  R=$(api "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID")
  ST=$(printf '%s' "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status'),d.get('conclusion') or '-')" 2>/dev/null)
  echo "[$(date +%H:%M:%S)] $ST"
  case "$ST" in
    "completed "*) break ;;
  esac
  sleep 45
done

echo "===== RUN SUMMARY ====="
api "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('conclusion:', d.get('conclusion'))
print('head_sha:', d.get('head_sha'))
print('url:', d.get('html_url'))
"
echo "===== STEPS ====="
api "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID/jobs" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for j in d.get('jobs',[]):
    print('JOB', j['name'], j['status'], j['conclusion'])
    for s in j.get('steps',[]):
        print('  %2s %-55s %s %s' % (s['number'], s['name'], s['status'], s['conclusion']))
    print('JOB_ID', j['id'])
"
echo "===== ARTIFACTS ====="
api "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID/artifacts" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d.get('artifacts',[]):
    print(a['name'], a['size_in_bytes'], a['expired'])
"
echo "===== RELEASES ====="
api "https://api.github.com/repos/$REPO/releases?per_page=5" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for r in d:
    print('TAG', r['tag_name'], '|', r['name'])
    for a in r.get('assets',[]):
        print('   ASSET', a['name'], a['size'], a['browser_download_url'])
"
echo "===== DONE ====="
