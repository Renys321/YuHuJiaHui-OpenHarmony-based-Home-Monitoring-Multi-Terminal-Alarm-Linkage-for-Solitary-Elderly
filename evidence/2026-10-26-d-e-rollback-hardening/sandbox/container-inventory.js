'use strict';
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
function sha(b){return crypto.createHash('sha256').update(b).digest('hex').toUpperCase();}
function inv(root,exclude){const ex=new Set(exclude||[]);const rows=[];const posix=process.platform!=='win32';
(function walk(cur,pre){for(const e of fs.readdirSync(cur,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
 if(pre===''&&ex.has(e.name))continue;const abs=path.join(cur,e.name);const rel=pre===''?e.name:pre+'/'+e.name;
 const st=fs.lstatSync(abs);const c={path:rel,size:st.size,mode:st.mode&0o777,uid:posix?st.uid:0,gid:posix?st.gid:0};
 if(st.isDirectory()){rows.push(Object.assign({},c,{type:'dir',size:0,sha256:''}));walk(abs,rel);}
 else if(st.isFile()){rows.push(Object.assign({},c,{type:'file',sha256:sha(fs.readFileSync(abs))}));}
 else if(st.isSymbolicLink()){rows.push(Object.assign({},c,{type:'symlink',size:0,sha256:sha(Buffer.from(fs.readlinkSync(abs)))}));}
 else rows.push(Object.assign({},c,{type:'other',sha256:''}));}})(root,'');
 rows.sort((a,b)=>a.path.localeCompare(b.path));
 const treeHash=sha(Buffer.from(rows.map(r=>r.path+'\t'+r.type+'\t'+r.size+'\t'+r.mode+'\t'+r.uid+':'+r.gid+'\t'+r.sha256).join('\n'),'utf8'));
 return {rows,treeHash};}
const root=process.argv[2]||'/data';
const exclude=(process.argv[3]||'').split(',').filter(Boolean);
process.stdout.write(JSON.stringify(inv(root,exclude)));
