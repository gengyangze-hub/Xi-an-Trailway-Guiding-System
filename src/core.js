/* Xi'an Metro navigation core: graph, routing, fare and simulated arrivals. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetroCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EARTH_KM = 6371;
  var TRANSFER_WALK_SEC = 240;
  var SERVICE_START = 6 * 3600;
  var SERVICE_END = 23 * 3600 + 30 * 60;

  function rad(d) { return d * Math.PI / 180; }

  function distanceKm(a, b) {
    var dLat = rad(b.lat - a.lat);
    var dLon = rad(b.lon - a.lon);
    var la1 = rad(a.lat), la2 = rad(b.lat);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function rideMinutes(km) {
    return Math.max(1.5, 0.45 + km / 0.82);
  }

  function fareFor(km) {
    if (km <= 6) return 2;
    if (km <= 10) return 3;
    if (km <= 14) return 4;
    if (km <= 20) return 5;
    if (km <= 26) return 6;
    return 6 + Math.ceil((km - 26) / 8);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function formatClock(totalSeconds) {
    var s = ((Math.round(totalSeconds) % 86400) + 86400) % 86400;
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60));
  }

  function formatClockSeconds(totalSeconds) {
    var s = ((Math.round(totalSeconds) % 86400) + 86400) % 86400;
    return formatClock(s) + ':' + pad(s % 60);
  }

  function formatDuration(seconds) {
    var m = Math.max(1, Math.round(seconds / 60));
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }

  function build(data) {
    var lines = data.lines.map(function (line) {
      var copy = {
        id: line.id,
        name: line.name,
        short: line.short,
        color: line.color,
        headway: line.headway,
        loop: !!line.loop,
        stations: line.stations.map(function (s, idx) {
          return { name: s.name, lon: s.lon, lat: s.lat, idx: idx };
        }),
        path: line.path
      };
      copy.cumDist = [];
      copy.cumTime = [];
      var d = 0, t = 0;
      for (var i = 0; i < copy.stations.length; i++) {
        if (i > 0) {
          var km = distanceKm(copy.stations[i - 1], copy.stations[i]);
          d += km;
          t += rideMinutes(km) * 60;
        }
        copy.cumDist.push(d);
        copy.cumTime.push(t);
      }
      if (copy.loop) {
        var closeKm = distanceKm(copy.stations[copy.stations.length - 1], copy.stations[0]);
        copy.cumDist.push(d + closeKm);
        copy.cumTime.push(t + rideMinutes(closeKm) * 60);
      }
      copy.totalDist = d + (copy.loop ? distanceKm(copy.stations[copy.stations.length - 1], copy.stations[0]) : 0);
      copy.totalTime = t + (copy.loop ? rideMinutes(distanceKm(copy.stations[copy.stations.length - 1], copy.stations[0])) * 60 : 0);
      return copy;
    });

    var lineMap = {};
    lines.forEach(function (line) { lineMap[line.id] = line; });

    var stationMap = new Map();
    var nodes = new Map();
    var adjacency = new Map();

    lines.forEach(function (line) {
      line.stations.forEach(function (station, idx) {
        var key = line.id + '|' + idx;
        var node = {
          key: key,
          lineId: line.id,
          lineName: line.name,
          color: line.color,
          idx: idx,
          name: station.name,
          lon: station.lon,
          lat: station.lat
        };
        nodes.set(key, node);
        adjacency.set(key, []);
        var entry = stationMap.get(station.name);
        if (!entry) {
          entry = { name: station.name, lon: station.lon, lat: station.lat, lines: [] };
          stationMap.set(station.name, entry);
        }
        entry.lines.push({ line: line, idx: idx, node: node });
      });
    });

    function addRide(line, i, j) {
      var a = nodes.get(line.id + '|' + i);
      var b = nodes.get(line.id + '|' + j);
      var km = distanceKm(a, b);
      var seconds = rideMinutes(km) * 60;
      var edge = {
        type: 'ride',
        from: a.key,
        to: b.key,
        lineId: line.id,
        lineName: line.name,
        color: line.color,
        fromName: a.name,
        toName: b.name,
        fromIdx: i,
        toIdx: j,
        dir: j > i ? 1 : -1,
        seconds: seconds,
        km: km
      };
      adjacency.get(a.key).push(edge);
    }

    lines.forEach(function (line) {
      for (var i = 0; i < line.stations.length - 1; i++) {
        addRide(line, i, i + 1);
        addRide(line, i + 1, i);
      }
      if (line.loop) {
        var last = line.stations.length - 1;
        addRide(line, last, 0);
        addRide(line, 0, last);
      }
    });

    stationMap.forEach(function (entry) {
      if (entry.lines.length < 2) return;
      var ordered = entry.lines.slice().sort(function (a, b) {
        return parseInt(a.line.id, 10) - parseInt(b.line.id, 10);
      });
      ordered.forEach(function (a) {
        ordered.forEach(function (b) {
          if (a === b) return;
          var wait = b.line.headway * 30;
          adjacency.get(a.node.key).push({
            type: 'transfer',
            from: a.node.key,
            to: b.node.key,
            fromLineId: a.line.id,
            toLineId: b.line.id,
            station: entry.name,
            walkSeconds: TRANSFER_WALK_SEC,
            waitSeconds: wait,
            seconds: TRANSFER_WALK_SEC + wait
          });
        });
      });
    });

    return {
      meta: data.meta,
      lines: lines,
      lineMap: lineMap,
      stationMap: stationMap,
      nodes: nodes,
      adjacency: adjacency,
      transfers: data.transfers || {}
    };
  }

  function MinHeap() {
    this.items = [];
  }
  MinHeap.prototype.push = function (item, priority) {
    var node = { item: item, priority: priority };
    this.items.push(node);
    var i = this.items.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (this.items[p].priority <= this.items[i].priority) break;
      var tmp = this.items[p];
      this.items[p] = this.items[i];
      this.items[i] = tmp;
      i = p;
    }
  };
  MinHeap.prototype.pop = function () {
    if (!this.items.length) return null;
    var top = this.items[0];
    var last = this.items.pop();
    if (this.items.length) {
      this.items[0] = last;
      var i = 0;
      while (true) {
        var l = i * 2 + 1, r = l + 1, smallest = i;
        if (l < this.items.length && this.items[l].priority < this.items[smallest].priority) smallest = l;
        if (r < this.items.length && this.items[r].priority < this.items[smallest].priority) smallest = r;
        if (smallest === i) break;
        var tmp = this.items[i];
        this.items[i] = this.items[smallest];
        this.items[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  };

  function plan(model, fromName, toName, options) {
    options = options || {};
    var from = model.stationMap.get(fromName);
    var to = model.stationMap.get(toName);
    if (!from || !to) return { error: '未找到车站' };
    if (fromName === toName) return { error: '起点与终点相同' };

    var transferPenalty = (options.transferPenaltyMin || 0) * 60;
    var dist = new Map();
    var prev = new Map();
    var startWait = new Map();
    var heap = new MinHeap();

    from.lines.forEach(function (entry) {
      var key = entry.node.key;
      var wait = entry.line.headway * 30;
      dist.set(key, wait);
      startWait.set(key, wait);
      heap.push(key, wait);
    });

    while (true) {
      var item = heap.pop();
      if (!item) break;
      var key = item.item;
      var cost = item.priority;
      if (cost > (dist.get(key) || Infinity) + 0.0001) continue;
      var edges = model.adjacency.get(key) || [];
      for (var i = 0; i < edges.length; i++) {
        var edge = edges[i];
        var extra = edge.seconds + (edge.type === 'transfer' ? transferPenalty : 0);
        var nextCost = cost + extra;
        var old = dist.has(edge.to) ? dist.get(edge.to) : Infinity;
        if (nextCost < old - 0.0001) {
          dist.set(edge.to, nextCost);
          prev.set(edge.to, { from: key, edge: edge });
          heap.push(edge.to, nextCost);
        }
      }
    }

    var bestKey = null;
    var bestCost = Infinity;
    to.lines.forEach(function (entry) {
      var key = entry.node.key;
      if (dist.has(key) && dist.get(key) < bestCost) {
        bestCost = dist.get(key);
        bestKey = key;
      }
    });
    if (!bestKey) return { error: '未能找到可行路线' };

    var path = [];
    var cursor = bestKey;
    while (prev.has(cursor)) {
      var p = prev.get(cursor);
      path.push(p.edge);
      cursor = p.from;
    }
    path.reverse();

    var segments = [];
    var transfers = [];
    var seg = null;
    var rideSec = 0, walkSec = 0, waitSec = startWait.get(cursor) || 0, kmTotal = 0;
    var stopCount = 0;

    path.forEach(function (edge) {
      if (edge.type === 'ride') {
        if (!seg) {
          seg = {
            lineId: edge.lineId,
            lineName: edge.lineName,
            color: edge.color,
            board: edge.fromName,
            boardIdx: edge.fromIdx,
            alight: edge.toName,
            alightIdx: edge.toIdx,
            dir: edge.dir,
            stations: [edge.fromName],
            rideSec: 0,
            km: 0
          };
        }
        seg.stations.push(edge.toName);
        seg.alight = edge.toName;
        seg.alightIdx = edge.toIdx;
        seg.rideSec += edge.seconds;
        seg.km += edge.km;
        rideSec += edge.seconds;
        kmTotal += edge.km;
        stopCount++;
      } else {
        if (seg) {
          segments.push(seg);
          seg = null;
        }
        transfers.push({
          station: edge.station,
          fromLineId: edge.fromLineId,
          toLineId: edge.toLineId,
          walkSeconds: edge.walkSeconds,
          waitSeconds: edge.waitSeconds
        });
        walkSec += edge.walkSeconds;
        waitSec += edge.waitSeconds;
      }
    });
    if (seg) segments.push(seg);

    segments.forEach(function (segment) {
      var line = model.lineMap[segment.lineId];
      if (line.loop) {
        segment.terminus = '环线';
        segment.loop = true;
      } else {
        segment.terminus = segment.dir > 0
          ? line.stations[line.stations.length - 1].name
          : line.stations[0].name;
        segment.loop = false;
      }
    });

    var totalSec = rideSec + walkSec + waitSec;
    var signature = segments.map(function (s) {
      return s.lineId + ':' + s.board + '>' + s.alight;
    }).join('|');

    return {
      ok: true,
      from: fromName,
      to: toName,
      segments: segments,
      transfers: transfers,
      rideSec: rideSec,
      walkSec: walkSec,
      waitSec: waitSec,
      totalSec: totalSec,
      durationMin: Math.max(1, Math.round(totalSec / 60)),
      distanceKm: kmTotal,
      fare: fareFor(kmTotal),
      stopCount: stopCount,
      transferCount: Math.max(0, segments.length - 1),
      signature: signature,
      lineIds: segments.map(function (s) { return s.lineId; })
    };
  }

  function directionInfo(model, line, station, idx, dir) {
    var n = line.stations.length;
    var loop = line.loop;
    var towardIdx = loop ? (idx + dir + n) % n : (dir > 0 ? n - 1 : 0);
    var nextIdx = loop ? (idx + dir + n) % n : idx + dir;
    var offset;
    if (loop) {
      offset = dir > 0 ? line.cumTime[idx] : line.totalTime - line.cumTime[idx];
    } else if (dir < 0) {
      offset = line.cumTime[idx];
    } else {
      offset = line.totalTime - line.cumTime[idx];
    }
    var label;
    if (loop) {
      label = '经 ' + line.stations[nextIdx].name + ' 方向';
    } else {
      label = '开往 ' + line.stations[towardIdx].name;
    }
    var headway = line.headway * 60;
    var first = SERVICE_START + offset;
    var last = SERVICE_START + offset + Math.floor((SERVICE_END - SERVICE_START) / headway) * headway;
    return {
      dir: dir,
      label: label,
      nextStation: line.stations[nextIdx].name,
      terminus: loop ? '环线' : line.stations[towardIdx].name,
      first: first,
      last: last,
      headway: line.headway
    };
  }

  function boardFor(model, stationName, lineId, nowSeconds, count) {
    var entry = model.stationMap.get(stationName);
    if (!entry) return null;
    var line = model.lineMap[lineId];
    if (!line) return null;
    var match = entry.lines.filter(function (x) { return x.line.id === lineId; })[0];
    if (!match) return null;
    var idx = match.idx;
    var n = line.stations.length;
    var dirs = [];
    if (line.loop || idx < n - 1) dirs.push(1);
    if (line.loop || idx > 0) dirs.push(-1);
    count = count || 3;
    var now = nowSeconds == null ? 0 : nowSeconds;

    var directions = dirs.map(function (dir) {
      var info = directionInfo(model, line, entry.name, idx, dir);
      var step = line.headway * 60;
      var next = info.first;
      if (now > next) {
        next = info.first + Math.ceil((now - info.first) / step) * step;
      }
      var arrivals = [];
      for (var k = 0; k < count; k++) {
        var at = next + k * step;
        if (at > info.last + 3600) break;
        arrivals.push({
          at: at,
          inSeconds: at - now,
          clock: formatClockSeconds(at)
        });
      }
      var firstFuture = arrivals.length ? arrivals[0] : null;
      var serviceState = now < info.first ? 'before' : (now > info.last + 3600 ? 'after' : 'running');
      return {
        dir: dir,
        label: info.label,
        nextStation: info.nextStation,
        terminus: info.terminus,
        first: formatClock(info.first),
        last: formatClock(info.last),
        headway: info.headway,
        arrivals: arrivals,
        nextIn: firstFuture ? firstFuture.inSeconds : null,
        serviceState: serviceState
      };
    });

    return {
      station: entry.name,
      lineId: line.id,
      lineName: line.name,
      color: line.color,
      idx: idx,
      directions: directions,
      first: formatClock(SERVICE_START),
      last: formatClock(SERVICE_END),
      simulated: true
    };
  }

  return {
    build: build,
    plan: plan,
    boardFor: boardFor,
    fareFor: fareFor,
    distanceKm: distanceKm,
    formatClock: formatClock,
    formatClockSeconds: formatClockSeconds,
    formatDuration: formatDuration,
    SERVICE_START: SERVICE_START,
    SERVICE_END: SERVICE_END,
    TRANSFER_WALK_SEC: TRANSFER_WALK_SEC
  };
});
