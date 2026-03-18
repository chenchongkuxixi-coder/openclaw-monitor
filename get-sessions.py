#!/usr/bin/env python3
import re, json, sys
from pathlib import Path
from datetime import date

today = date.today()
log_path = Path(f'/tmp/openclaw/openclaw-{today}.log')

# Fallback: try yesterday
if not log_path.exists():
    yesterday = date.today()
    import datetime
    yesterday = today - datetime.timedelta(days=1)
    log_path = Path(f'/tmp/openclaw/openclaw-{yesterday}.log')

if not log_path.exists():
    print("0")
    sys.exit()

total_actives = []
with open(log_path) as f:
    for line in f:
        try:
            obj = json.loads(line.strip())
            msg = obj.get('1', '')
            if 'totalActive=' in msg:
                m = re.search(r'totalActive=(\d+)', msg)
                if m:
                    total_actives.append(int(m.group(1)))
        except:
            pass

for v in reversed(total_actives):
    if v > 0:
        print(v)
        break
else:
    print("0")
