const fs = require('fs');
const root = process.argv[2];
const dir = root + '/raw';
const sizes = [640, 416, 320];
const data = {};
for (const s of sizes) {
  const lines = fs.readFileSync(`${dir}/bench_${s}_events.jsonl`, 'utf8').split(/\r?\n/).filter(Boolean);
  data[s] = lines.map(l => JSON.parse(l));
}
const images = ['no_person_camera_check.jpeg', 'no_person_living_room.jpeg', 'person_camera_preview.jpeg'];
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
function bboxIoU(a, b) {
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3], bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih, uni = a[2] * a[3] + b[2] * b[3] - inter;
  return uni > 0 ? inter / uni : 0;
}
const out = { sizes: {} };
for (const s of sizes) {
  const ev = data[s];
  const byImg = {};
  images.forEach((img, idx) => { byImg[img] = ev.filter((_, i) => i % 3 === idx); });
  const statsLines = fs.readFileSync(`${dir}/bench_${s}_stats.jsonl`, 'utf8').trim().split(/\r?\n/);
  const stats = JSON.parse(statsLines[statsLines.length - 1]);
  const res = {
    stats: {
      inferMsP50: stats.inferMsP50, inferMsP95: stats.inferMsP95, inferMsAvg: stats.inferMsAvg,
      inferMsMin: stats.inferMsMin, inferMsMax: stats.inferMsMax, inferFps: stats.inferFps,
      elapsedSec: stats.elapsedSec, rssKb: stats.rssKb, tempC: stats.tempC, errors: stats.errors
    }, images: {}
  };
  for (const img of images) {
    const es = byImg[img];
    const persons = es.map(e => e.personCount);
    const kp = es.map(e => e.validKptCount);
    const avgc = es.map(e => e.kptConfAvg);
    const minc = es.map(e => e.kptConfMin);
    const bboxes = es.filter(e => e.personCount > 0).map(e => e.primaryBBox);
    res.images[img] = {
      frames: es.length,
      personCounts: [...new Set(persons)],
      validKptsAvg: avg(kp),
      kptConfAvg: avg(avgc),
      kptConfMin: avg(minc),
      bboxSample: bboxes[0] || null,
      inferMsAvg: avg(es.map(e => e.inferMs))
    };
  }
  out.sizes[s] = res;
}
for (const s of [416, 320]) {
  out.sizes[s].consistency = {};
  for (const img of images) {
    const idx = images.indexOf(img);
    const a = data[640].filter((_, i) => i % 3 === idx);
    const b = data[s].filter((_, i) => i % 3 === idx);
    const ious = [], kdist = [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i].personCount > 0 && b[i].personCount > 0) {
        ious.push(bboxIoU(a[i].primaryBBox, b[i].primaryBBox));
        const ka = a[i].primaryKeypoints, kb = b[i].primaryKeypoints;
        const ds = [];
        for (let k = 0; k < 17; k++) {
          if (ka[k][2] >= 0.3 && kb[k][2] >= 0.3) {
            ds.push(Math.hypot(ka[k][0] - kb[k][0], ka[k][1] - kb[k][1]));
          }
        }
        if (ds.length) kdist.push(avg(ds));
      }
    }
    out.sizes[s].consistency[img] = {
      bboxIoUAvg: avg(ious), bboxIoUMin: ious.length ? Math.min(...ious) : null,
      kptMeanDistAvg: avg(kdist), kptMeanDistMax: kdist.length ? Math.max(...kdist) : null,
      matchedFrames: ious.length
    };
  }
}
fs.writeFileSync(`${dir}/benchmark_summary.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
