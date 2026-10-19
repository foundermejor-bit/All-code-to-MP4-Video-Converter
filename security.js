const net=require('net'),dns=require('dns').promises,crypto=require('crypto');
const SID_RE=/^[\w-]{16,64}$/;
function isPrivate(ip){
  if(net.isIPv4(ip)){const[a,b]=ip.split('.').map(Number);
    return a===0||a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||a>=224}
  if(net.isIPv6(ip)){const x=ip.toLowerCase();if(x.startsWith('::ffff:'))return isPrivate(x.slice(7));
    return x==='::1'||x==='::'||/^f[cd]/.test(x)||/^fe[89ab]/.test(x)}
  return true}
// Egress filter for the headless browser: public http(s) only, never loopback/private/link-local.
async function urlAllowed(url){
  let u;try{u=new URL(url)}catch{return false}
  if(['data:','blob:','about:'].includes(u.protocol))return true;
  if(!['http:','https:'].includes(u.protocol))return false;
  const h=u.hostname.replace(/^\[|\]$/g,'');
  if(net.isIP(h))return !isPrivate(h);
  try{const r=await dns.lookup(h,{all:true});return r.length>0&&r.every(x=>!isPrivate(x.address))}catch{return false}}
function limiter(max,windowMs){const hits=new Map();
  setInterval(()=>{const n=Date.now();for(const[k,v]of hits)if(v.reset<n)hits.delete(k)},windowMs).unref();
  return(req,res,next)=>{const n=Date.now();let v=hits.get(req.ip);if(!v||v.reset<n){v={c:0,reset:n+windowMs};hits.set(req.ip,v)}
    if(++v.c>max){res.set('Retry-After',String(Math.ceil((v.reset-n)/1000)));return res.status(429).json({error:'Too many requests — slow down'})}next()}}
// Optional site-wide password (env ACCESS_PASSWORD). /healthz stays open for the platform health check.
function basicAuth(pass){if(!pass)return(q,r,n)=>n();const want=Buffer.from(pass);
  return(req,res,next)=>{if(req.path==='/healthz')return next();
    const[t,b]=(req.headers.authorization||'').split(' ');
    if(t==='Basic'&&b){const got=Buffer.from(Buffer.from(b,'base64').toString().split(':').slice(1).join(':'));
      if(got.length===want.length&&crypto.timingSafeEqual(got,want))return next()}
    res.set('WWW-Authenticate','Basic realm="Framewise"').sendStatus(401)}}
module.exports={isPrivate,urlAllowed,limiter,basicAuth,SID_RE};
