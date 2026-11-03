const fs=require('fs');
const dir=process.argv[2];
const lines=fs.readFileSync(dir+'/raw/perf_events.jsonl','utf8').split(/\r?\n/).filter(Boolean);
const ev=lines.map(l=>JSON.parse(l));
const t0=ev[0].frameTsMs, t1=ev[ev.length-1].frameTsMs, dur=(t1-t0)/1000;
const inf=ev.map(e=>e.inferMs).sort((a,b)=>a-b);
const pct=p=>inf[Math.floor(inf.length*p)];
const rss=ev.map(e=>e.rssKb).filter(x=>x>0);
const temps=ev.map(e=>e.tempC).filter(x=>x>0);
const pcs=ev.reduce((a,e)=>{a[e.posture]=(a[e.posture]||0)+1;return a;},{});
const persons=ev.reduce((a,e)=>{a[e.personCount]=(a[e.personCount]||0)+1;return a;},{});
const fallEvents=ev.filter(e=>e.fall===true).length;
const recovered=ev.filter(e=>e.eventType==='RECOVERED').length;
const errors=ev.filter(e=>e.dataValid!==true).length;
const k=ev.map(e=>e.validKptCount);
const out={events:ev.length,firstFrameTs:t0,lastFrameTs:t1,cameraActiveSec:Math.round(dur*10)/10,
 received:ev.length+(ev[ev.length-1].droppedFrames||0),inferred:ev.length,dropped:ev[ev.length-1].droppedFrames||0,
 captureFps:Math.round((ev.length+(ev[ev.length-1].droppedFrames||0))/dur*100)/100,
 inferFps:Math.round(ev.length/dur*100)/100,
 inferMsP50:inf[Math.floor(inf.length/2)],inferMsP95:pct(0.95),inferMsMin:inf[0],inferMsMax:inf[inf.length-1],
 rssKbMin:Math.min(...rss),rssKbMax:Math.max(...rss),tempCMin:Math.min(...temps),tempCMax:Math.max(...temps),
 errors,fallEvents,recovered,personCounts:persons,postureCounts:pcs,
 validKptAvg:k.reduce((a,b)=>a+b,0)/k.length,
 keypointSample:ev[Math.floor(ev.length/2)].primaryKeypoints};
fs.writeFileSync(dir+'/raw/perf_analysis.json',JSON.stringify(out,null,1));
console.log(JSON.stringify(out,null,1));
