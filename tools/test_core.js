const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const core = require(path.join(root, 'src/core.js'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'src/network.json'), 'utf8'));
const model = core.build(data);
console.log('meta', model.meta, 'stations', model.stationMap.size);
const routes = [
  ['北大街', '大雁塔'],
  ['纺织城', '西安北站'],
  ['钟楼', '秦陵西'],
  ['咸阳西站', '航天新城'],
  ['创新港', '昭慧广场'],
  ['常宁宫', '机场西（T1、T2、T3）'],
  ['北大街', '北大街'],
];
for (const [a, b] of routes) {
  const t0 = Date.now();
  const r = core.plan(model, a, b);
  if (!r.ok) { console.log(a, b, r); continue; }
  console.log('\n', a, '→', b, r.durationMin, 'min', r.transferCount, 'transfers', r.stopCount, 'stops', r.distanceKm.toFixed(1), 'km', r.fare, 'yuan', 'sig', r.signature, 'in', Date.now() - t0, 'ms');
  r.segments.forEach(s => console.log('  ', s.lineName, s.board, '→', s.alight, 'toward', s.terminus, s.stations.length - 1, 'stops', (s.rideSec / 60).toFixed(1), 'min'));
  r.transfers.forEach(t => console.log('   transfer at', t.station));
}
const board = core.boardFor(model, '北大街', '2', 15 * 3600 + 30 * 60, 3);
console.log('\nboard', board.station, board.lineName);
board.directions.forEach(d => console.log(d.label, d.first, d.last, d.headway, d.arrivals.map(a => a.clock + ' / ' + a.inSeconds + 's').join(', ')));
