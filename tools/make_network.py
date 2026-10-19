import json, glob, os, math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

HEADWAY = {
    '1号线': 3.5,
    '2号线': 2.5,
    '3号线': 3.0,
    '4号线': 3.5,
    '5号线': 4.0,
    '6号线': 4.0,
    '8号(环)线': 3.5,
    '9号线': 5.0,
    '10号线': 6.0,
    '14号线': 6.5,
    '15号线': 5.5,
    '16号线': 7.0,
}
SHORT = {name: name.replace('号(环)线', '号环线').replace('号线', '号线') for name in HEADWAY}

files = sorted((ROOT / 'data/raw').glob('line_*.json'), key=lambda x: int(x.stem[5:]))
raw = []
for f in files:
    d = json.load(open(f, encoding='utf-8-sig'))['data']
    raw.append(d)

# Transfer groups by exact display name.
station_lines = defaultdict(list)
for d in raw:
    for s in d['stations']:
        station_lines[s['display_name']].append(d['line']['line_name'])
transfers = {name: sorted(set(lines)) for name, lines in station_lines.items() if len(set(lines)) > 1}

lines = []
for d in raw:
    meta = d['line']
    name = meta['line_name']
    stations = []
    for s in d['stations']:
        lon, lat = s['location']['coordinates']
        stations.append({
            'name': s['display_name'],
            'lon': round(lon, 6),
            'lat': round(lat, 6),
            'transfer': len(transfers.get(s['display_name'], [])) > 1,
        })
    path = [[round(c[0], 6), round(c[1], 6)] for c in d['geometry']['coordinates'][0]]
    loop = name == '8号(环)线'
    if loop and path[0] != path[-1]:
        path.append(path[0])
    lines.append({
        'id': meta['line_name'].replace('号(环)线', '').replace('号线', ''),
        'name': name,
        'short': SHORT[name],
        'color': meta['line_color'],
        'headway': HEADWAY[name],
        'loop': loop,
        'stations': stations,
        'path': path,
    })

lines.sort(key=lambda l: int(l['id']))

# Unique station count
unique = len(station_lines)
network = {
    'meta': {
        'city': '西安',
        'updated': '2026-06-28',
        'lineCount': len(lines),
        'stationCount': unique,
        'transferCount': len(transfers),
    },
    'lines': lines,
    'transfers': transfers,
}

out_dir = ROOT / 'src'
out_dir.mkdir(exist_ok=True)
out_path = out_dir / 'network.json'
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(network, f, ensure_ascii=False, separators=(',', ':'))
print('lines', len(lines), 'stations', unique, 'transfers', len(transfers))
print('bytes', os.path.getsize(out_path))
for l in lines:
    print(l['id'], l['name'], len(l['stations']), len(l['path']))
