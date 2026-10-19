from pathlib import Path
import base64
import json

root = Path(__file__).parent
template = (root / 'src/template.html').read_text(encoding='utf-8')
css = (root / 'src/styles.css').read_text(encoding='utf-8')
core = (root / 'src/core.js').read_text(encoding='utf-8')
app = (root / 'src/app.js').read_text(encoding='utf-8')
network = json.loads((root / 'src/network.json').read_text(encoding='utf-8'))
network_js = json.dumps(network, ensure_ascii=False, separators=(',', ':'))
logo_bytes = (root / 'assets/xian-metro-mark.png').read_bytes()
logo_data = 'data:image/png;base64,' + base64.b64encode(logo_bytes).decode('ascii')

out = template
out = out.replace('__LOGO_DATA__', logo_data)
out = out.replace('/*__STYLES__*/', css)
out = out.replace('/*__NETWORK__*/', network_js)
out = out.replace('/*__CORE__*/', core)
out = out.replace('/*__APP__*/', app)
(root / 'index.html').write_text(out, encoding='utf-8')

sync_payload = {
    'version': network.get('meta', {}).get('updated', ''),
    'data': network,
}
(root / 'network-sync.json').write_text(
    json.dumps(sync_payload, ensure_ascii=False, separators=(',', ':')),
    encoding='utf-8',
)
print('wrote index.html', len(out.encode('utf-8')), 'bytes')
print('wrote network-sync.json')
