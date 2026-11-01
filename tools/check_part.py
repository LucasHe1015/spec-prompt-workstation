# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
sh=[l.strip() for l in open(sys.argv[2],encoding='utf-8') if l.strip()]
miss=[k for k in sh if k not in d]
extra=[k for k in d if k not in sh]
print('entries',len(d),'shard',len(sh),'missing',len(miss),'extra',len(extra))
print('missing sample',miss[:20])
print('extra sample',extra[:20])