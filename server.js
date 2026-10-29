/* 달무티 멀티플레이 서버 — 방 관리 + 게임 진행 (권위 서버)
   실행: npm install && npm start  →  http://<내 IP>:3000 */
const http=require('http'), fs=require('fs'), path=require('path');
const {WebSocketServer}=require('ws');
const {createGame,shuffle,BOT_NAMES}=require('./engine.js');

const PORT=process.env.PORT||3000;
const AI_DELAY=700;                    // AI 한 수 간격(ms)
const TURN_MS=30*1000;                 // 사람 차례 제한시간
const EMPTY_ROOM_TTL=10*60*1000;       // 게임 중 전원 이탈 시 방 보관 시간
const STATIC={'/':'index.html','/index.html':'index.html','/engine.js':'engine.js'};
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};

const server=http.createServer((req,res)=>{
  const f=STATIC[req.url.split('?')[0]];
  if(!f){ res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname,f),(err,buf)=>{
    if(err){ res.writeHead(500); return res.end(); }
    res.writeHead(200,{'Content-Type':TYPES[path.extname(f)],'Cache-Control':'no-cache'}); res.end(buf);
  });
});

/* room = {code, n, pub, hostSid, members:[{sid,name,ws,seat}], game, emptyTimer}
   pub: 공개 방이면 시작 메뉴의 방 목록에 보인다
   member.ws가 null이면 연결 끊김. seat은 게임 시작 후 플레이어 id */
const rooms=new Map();
const watchers=new Set();               // 시작 메뉴에서 방 목록을 보고 있는 연결

function newCode(){
  const A='ABCDEFGHJKLMNPQRSTUVWXYZ'; let c;
  do{ c=Array.from({length:4},()=>A[Math.floor(Math.random()*A.length)]).join(''); }while(rooms.has(c));
  return c;
}
function send(ws,msg){ if(ws&&ws.readyState===ws.OPEN) ws.send(JSON.stringify(msg)); }
// 공개 + 대기 중 + 자리 남음 + 접속자 있음
function openRooms(){
  const list=[];
  for(const r of rooms.values()){
    if(!r.pub||r.game||r.members.length>=r.n||!r.members.some(m=>m.ws)) continue;
    list.push({code:r.code,host:r.members.find(m=>m.sid===r.hostSid)?.name||'',count:r.members.length,n:r.n});
    if(list.length>=20) break;
  }
  return list;
}
function broadcastList(){ const msg={t:'rooms',list:openRooms()}; watchers.forEach(ws=>send(ws,msg)); }
function broadcastRoom(room){
  const members=room.members.map(m=>({name:m.name,host:m.sid===room.hostSid,online:!!m.ws}));
  room.members.forEach(m=>send(m.ws,{t:'room',code:room.code,n:room.n,pub:room.pub,host:m.sid===room.hostSid,started:!!room.game,members}));
  broadcastList();
}
function broadcastState(room){ room.members.forEach(m=>send(m.ws,{t:'state',view:room.game.view(m.seat)})); }
function cleanName(s){ return String(s||'').trim().slice(0,8)||'손님'; }
function uniqueName(room,name){
  let nm=name, k=2;
  while(room.members.some(m=>m.name===nm)) nm=name.slice(0,7)+(k++);
  return nm;
}
const isIds=a=>Array.isArray(a)&&a.length<=80&&a.every(Number.isInteger);

function startRoomGame(room){
  const humans=room.members;
  const bots=shuffle(BOT_NAMES.filter(b=>!humans.some(h=>h.name===b))).slice(0,room.n-humans.length);
  humans.forEach((h,i)=>h.seat=i);
  const game=createGame(humans.map(h=>({name:h.name,human:true})).concat(bots.map(name=>({name}))),{
    // 방이 지워졌거나 게임이 바뀌면 예약된 타이머는 무시
    later:(fn,ms)=>setTimeout(()=>{ if(rooms.get(room.code)===room&&room.game===game) fn(); },ms),
    speed:()=>AI_DELAY,
    turnMs:TURN_MS,
    changed:()=>broadcastState(room),
    toast:(msg,to)=>room.members.forEach(m=>{ if(to==null||m.seat===to) send(m.ws,{t:'toast',msg}); }),
  });
  room.game=game;
  broadcastRoom(room);
  game.start();
}

const wss=new WebSocketServer({server,maxPayload:4096});
wss.on('connection',ws=>{
  let room=null, me=null;
  ws.isAlive=true; ws.on('pong',()=>ws.isAlive=true);

  function hello(m){
    if(room) return;
    const sid=typeof m.sid==='string'?m.sid.slice(0,64):''; if(!sid) return;
    let r;
    if(m.t==='create'){
      const n=Number(m.n);
      if(!Number.isInteger(n)||n<4||n>8) return send(ws,{t:'error',msg:'인원은 4~8명입니다'});
      r={code:newCode(),n,pub:!!m.pub,hostSid:sid,members:[],game:null,emptyTimer:null}; rooms.set(r.code,r);
    } else {
      r=rooms.get(String(m.code||'').trim().toUpperCase());
      if(!r) return send(ws,{t:'error',msg:'방을 찾을 수 없습니다',fatal:true});
    }
    let mem=r.members.find(x=>x.sid===sid);
    if(mem){                                    // 재접속: 이전 연결은 끊는다
      const old=mem.ws; mem.ws=ws;
      if(old&&old!==ws){ send(old,{t:'error',msg:'다른 창에서 이 자리로 접속했습니다',fatal:true}); old.close(); }
    } else {
      if(r.game) return send(ws,{t:'error',msg:'이미 게임이 시작된 방입니다',fatal:true});
      if(r.members.length>=r.n) return send(ws,{t:'error',msg:'방이 가득 찼습니다',fatal:true});
      mem={sid,name:uniqueName(r,cleanName(m.name)),ws,seat:null}; r.members.push(mem);
    }
    room=r; me=mem; clearTimeout(r.emptyTimer); watchers.delete(ws);
    if(!r.members.some(x=>x.sid===r.hostSid&&x.ws)) r.hostSid=sid;   // 방장이 없으면 넘겨받음
    broadcastRoom(r);
    if(r.game){ if(r.game.isAI(mem.seat)) r.game.setAI(mem.seat,false); else send(ws,{t:'state',view:r.game.view(mem.seat)}); }
  }

  // 나가기 / 연결 끊김. 대기실이면 자리를 비우고, 게임 중이면 AI가 대신 둔다
  function drop(){
    const r=room, mem=me; room=null; me=null;
    if(!r) return;
    if(r.game){ mem.ws=null; r.game.setAI(mem.seat,true); }
    else r.members=r.members.filter(x=>x!==mem);
    if(r.hostSid===mem.sid){ const next=r.members.find(x=>x.ws); if(next) r.hostSid=next.sid; }
    if(!r.members.some(x=>x.ws)){
      if(!r.game) rooms.delete(r.code);
      else r.emptyTimer=setTimeout(()=>rooms.delete(r.code),EMPTY_ROOM_TTL);
    }
    broadcastRoom(r);
  }

  ws.on('message',raw=>{
    let m; try{ m=JSON.parse(raw); }catch(_){ return; }
    if(!m||typeof m.t!=='string') return;
    if(m.t==='create'||m.t==='join') return hello(m);
    if(m.t==='list'){ if(!room){ watchers.add(ws); send(ws,{t:'rooms',list:openRooms()}); } return; }
    if(!room) return;
    const g=room.game, isHost=me.sid===room.hostSid;
    switch(m.t){
      case 'start': if(isHost&&!g) startRoomGame(room); break;
      case 'play':  if(g&&isIds(m.ids)) g.play(me.seat,m.ids); break;
      case 'pass':  if(g) g.play(me.seat,null); break;
      case 'tax':   if(g&&isIds(m.ids)) g.taxReturn(me.seat,m.ids); break;
      case 'rev':   if(g) g.revolution(me.seat,!!m.call); break;
      case 'next':  if(g&&isHost) g.nextRound(); break;
      case 'leave': drop(); break;
    }
  });
  ws.on('close',()=>{ watchers.delete(ws); if(me&&me.ws===ws) drop(); });
});

// 응답 없는 연결 정리 (와이파이 끊김 등은 close 이벤트가 늦게 온다)
setInterval(()=>wss.clients.forEach(ws=>{
  if(!ws.isAlive) return ws.terminate();
  ws.isAlive=false; ws.ping();
}),30000);

server.listen(PORT,()=>{
  const ips=Object.values(require('os').networkInterfaces()).flat().filter(i=>i&&i.family==='IPv4'&&!i.internal).map(i=>i.address);
  console.log(`달무티 서버 실행 중 — http://localhost:${PORT}`);
  ips.forEach(ip=>console.log(`  같은 네트워크: http://${ip}:${PORT}`));
});
