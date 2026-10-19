const express=require('express'),multer=require('multer'),puppeteer=require('puppeteer'),{spawn}=require('child_process'),
fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),{once}=require('events'),S=require('./security');
const env=(k,d)=>Number(process.env[k])||d;
const PORT=env('PORT',10000),CONC=env('CONCURRENCY',1),MAX_PIXELS=env('MAX_PIXELS',2073600),MAX_FRAMES=env('MAX_FRAMES',1800),
MAX_FILE=env('MAX_FILE_MB',2)*1048576,MAX_QUEUE=env('MAX_QUEUE',20),MAX_PER_USER=env('MAX_PER_USER',5),
JOB_TIMEOUT=env('JOB_TIMEOUT_SEC',600)*1000,TTL=env('RESULT_TTL_MIN',60)*6e4;
const DATA=process.env.DATA_DIR||path.join(os.tmpdir(),'framewise'),WORK=path.join(DATA,'work'),OUT=path.join(DATA,'out');
for(const d of[WORK,OUT]){fs.rmSync(d,{recursive:true,force:true});fs.mkdirSync(d,{recursive:true,mode:0o700})}
const ORIGIN='http://render.invalid/';
const RATIO={'16:9':[16,9],'9:16':[9,16],'1:1':[1,1],'4:5':[4,5]},CRF={low:30,medium:24,high:19,ultra:14};
const clamp=(v,a,b,d)=>Math.min(b,Math.max(a,Number.isFinite(+v)?+v:d)),even=n=>Math.max(2,Math.round(n/2)*2);
const rm=f=>fs.unlink(f,()=>{});
const jobs=new Map(),queue=[];let running=0;

const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.get('/healthz',(q,r)=>r.json({ok:true,queued:queue.length,running}));
app.use((q,r,n)=>{r.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cache-Control':'no-store',
  'Content-Security-Policy':"base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'"});n()});
app.use(S.basicAuth(process.env.ACCESS_PASSWORD));
app.use(S.limiter(600,6e4));
app.use(express.static(path.join(__dirname,'public')));
const sidMw=(req,res,next)=>{req.sid=String(req.get('x-sid')||'');S.SID_RE.test(req.sid)?next():res.status(401).json({error:'Missing or invalid session id'})};
const upload=multer({storage:multer.diskStorage({destination:WORK,filename:(q,f,cb)=>cb(null,crypto.randomBytes(16).toString('hex')+'.html')}),
  limits:{fileSize:MAX_FILE,files:10,fields:5,parts:20},
  fileFilter:(q,f,cb)=>/\.html?$/i.test(f.originalname)?cb(null,true):cb(new Error('ONLY_HTML'))});

// The uploaded HTML is NEVER executed by Node. It runs only inside a throwaway headless Chromium with a filtered network.
const CLOCK=`(()=>{let t=0,id=0,q=new Map();const b=Date.now();
performance.now=()=>t;Date.now=()=>b+t;
window.requestAnimationFrame=f=>{q.set(++id,f);return id};window.cancelAnimationFrame=i=>q.delete(i);
window.__seek=ms=>{t=ms;document.getAnimations().forEach(a=>{try{a.pause();a.currentTime=ms}catch(e){}});
const c=[...q.values()];q.clear();c.forEach(f=>{try{f(t)}catch(e){}})};
['WebSocket','RTCPeerConnection','webkitRTCPeerConnection'].forEach(k=>{try{Object.defineProperty(window,k,{value:undefined})}catch(e){}})})();`;
function ffArgs(o){
  const a=['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate',String(o.fps),'-i','-'];
  if(o.format==='webm')a.push('-c:v','libvpx-vp9','-crf',String(CRF[o.quality]+6),'-b:v','0','-pix_fmt','yuv420p');
  else if(o.format==='gif')a.push('-vf','split[a][b];[a]palettegen[p];[b][p]paletteuse');
  else a.push('-c:v','libx264','-preset',o.quality==='ultra'?'slow':'fast','-crf',String(CRF[o.quality]),'-pix_fmt','yuv420p','-movflags','+faststart');
  return a}
const publicErr=e=>/ffmpeg/i.test(e.message)?'Encoding failed':/timeout|navigation/i.test(e.message)?'Page took too long to load or render':'Render failed';

async function render(job){
  const o=job.opts,[w,h]=o.size,n=Math.round(o.duration*o.fps),out=path.join(OUT,`${job.id}.${o.format}`);
  let br,ff,timer;
  try{
    const html=await fs.promises.readFile(job.file);
    ff=spawn('ffmpeg',[...ffArgs(o),out],{stdio:['pipe','ignore','pipe']});
    let err='';ff.stderr.on('data',d=>err=(err+d).slice(-500));ff.stdin.on('error',()=>{});
    const done=new Promise((res,rej)=>{ff.on('error',e=>rej(new Error('ffmpeg: '+e.message)));ff.on('close',c=>c===0?res():rej(new Error('ffmpeg failed: '+err)))});
    done.catch(()=>{});
    timer=setTimeout(()=>{job.timedOut=true;job.cancel=true;try{ff.kill('SIGKILL')}catch(e){}br&&br.close().catch(()=>{})},JOB_TIMEOUT);
    br=await puppeteer.launch({headless:'new',protocolTimeout:60000,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||undefined,
      args:['--no-sandbox','--disable-dev-shm-usage','--disable-extensions','--force-device-scale-factor=1','--hide-scrollbars']});
    const page=await br.newPage();await page.setViewport({width:w,height:h});page.setDefaultTimeout(30000);
    page.on('dialog',d=>d.dismiss().catch(()=>{}));page.on('popup',p=>p.close().catch(()=>{}));
    await page.setRequestInterception(true);
    page.on('request',async req=>{try{const u=req.url();
      if(u===ORIGIN)return await req.respond({status:200,contentType:'text/html; charset=utf-8',body:html});
      (await S.urlAllowed(u))?await req.continue():await req.abort('blockedbyclient')}catch(e){}});
    await page.evaluateOnNewDocument(CLOCK);
    await page.goto(ORIGIN,{waitUntil:'load',timeout:30000});
    await page.evaluate(()=>document.fonts&&document.fonts.ready);
    const type=o.quality==='low'||o.quality==='medium'?'jpeg':'png';
    for(let i=0;i<n;i++){
      if(job.cancel)throw new Error('cancelled');
      await page.evaluate(ms=>window.__seek(ms),i*1000/o.fps);
      const buf=await page.screenshot(type==='jpeg'?{type,quality:92}:{type});
      if(!ff.stdin.write(buf))await Promise.race([once(ff.stdin,'drain'),done]);
      job.progress=Math.round((i+1)/n*95);job.frame=i+1;job.frames=n}
    job.status='encoding';ff.stdin.end();await done;
    job.progress=100;job.size=fs.statSync(out).size;job.output=out;job.status='done';
  }catch(e){
    console.error('job',job.id,e.message);try{ff&&ff.kill('SIGKILL')}catch(_){}rm(out);
    job.status=job.cancel&&!job.timedOut?'cancelled':'error';job.error=job.timedOut?'Render timed out':job.status==='error'?publicErr(e):undefined;
  }finally{clearTimeout(timer);await(br&&br.close().catch(()=>{}));rm(job.file)}
}
function pump(){
  while(running<CONC&&queue.length){const j=queue.shift();if(j.cancel)continue;
    running++;j.status='rendering';render(j).finally(()=>{running--;j.finished=Date.now();pump()})}}
const pub=j=>({id:j.id,name:j.name,status:j.status,progress:j.progress,frame:j.frame,frames:j.frames,error:j.error,size:j.size,opts:j.opts,format:j.opts.format});
const active=sid=>[...jobs.values()].filter(j=>j.sid===sid&&['queued','rendering','encoding'].includes(j.status)).length;

app.post('/api/jobs',S.limiter(15,6e4),sidMw,upload.array('files',10),(req,res)=>{
  const files=req.files||[],bad=(c,m)=>{files.forEach(f=>rm(f.path));res.status(c).json({error:m})};
  if(!files.length)return bad(400,'No HTML files uploaded');
  if(queue.length+running+files.length>MAX_QUEUE)return bad(429,'Server queue is full — try again shortly');
  if(active(req.sid)+files.length>MAX_PER_USER)return bad(429,`Max ${MAX_PER_USER} active jobs per user`);
  let s={};try{s=JSON.parse(req.body.settings||'{}')}catch(e){return bad(400,'Invalid settings')}
  const fps=[24,30,60].includes(+s.fps)?+s.fps:30,duration=clamp(s.duration,1,60,5);
  const format=['mp4','webm','gif'].includes(s.format)?s.format:'mp4',quality=CRF[s.quality]?s.quality:'high';
  let w,h;
  if(s.ratio==='custom'){w=clamp(s.width,64,3840,1280);h=clamp(s.height,64,3840,720)}
  else{const[a,b]=RATIO[s.ratio]||RATIO['16:9'],sh=clamp(s.short,360,2160,1080);[w,h]=a>=b?[sh*a/b,sh]:[sh,sh*b/a]}
  if(w*h>MAX_PIXELS){const k=Math.sqrt(MAX_PIXELS/(w*h));w*=k;h*=k}   // auto-downscale to the server's limit
  w=even(w);h=even(h);
  if(Math.round(duration*fps)>MAX_FRAMES)return bad(400,`Too many frames (max ${MAX_FRAMES}) — lower FPS or duration`);
  const out=files.map(f=>{const id=crypto.randomBytes(16).toString('hex');
    const name=path.basename(Buffer.from(f.originalname,'latin1').toString('utf8')).replace(/[\u0000-\u001f<>"\\\/]/g,'').slice(0,80)||'untitled.html';
    const j={id,sid:req.sid,name,file:f.path,status:'queued',progress:0,opts:{fps,duration,format,quality,size:[w,h]}};
    jobs.set(id,j);queue.push(j);return pub(j)});
  pump();res.json(out)});
app.get('/api/jobs',sidMw,(req,res)=>res.json([...jobs.values()].filter(j=>j.sid===req.sid).reverse().map(pub)));
app.delete('/api/jobs/:id',sidMw,(req,res)=>{
  const j=jobs.get(req.params.id);if(!j||j.sid!==req.sid)return res.sendStatus(404);
  j.cancel=true;if(!['rendering','encoding'].includes(j.status)){jobs.delete(j.id);rm(j.file);j.output&&rm(j.output)}
  res.sendStatus(204)});
app.get('/api/download/:id',(req,res)=>{   // capability URL: 128-bit random id
  const j=/^[a-f0-9]{32}$/.test(req.params.id)&&jobs.get(req.params.id);if(!j||j.status!=='done')return res.sendStatus(404);
  res.download(j.output,j.name.replace(/\.[^.]+$/,'')+'.'+j.opts.format)});
app.use((err,req,res,next)=>{
  if(err instanceof multer.MulterError||err.message==='ONLY_HTML'){const big=err.code==='LIMIT_FILE_SIZE';
    return res.status(big?413:400).json({error:big?`File too large (max ${MAX_FILE/1048576} MB)`:err.message==='ONLY_HTML'?'Only .html / .htm files are allowed':'Upload error: '+err.code})}
  console.error(err);res.status(500).json({error:'Internal server error'})});
setInterval(()=>{for(const j of jobs.values())if(j.finished&&Date.now()-j.finished>TTL){j.output&&rm(j.output);jobs.delete(j.id)}},6e4).unref();
process.on('unhandledRejection',e=>console.error('unhandledRejection',e));
process.on('SIGTERM',()=>process.exit(0));
app.listen(PORT,'0.0.0.0',()=>console.log('Framewise listening on :'+PORT));
