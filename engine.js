/* 달무티 게임 엔진 — 브라우저(싱글)와 server.js(멀티)가 같이 쓰는 상태 머신.
   UI·네트워크는 모르고, 호스트가 넘겨준 io 콜백으로만 바깥과 통신한다.
   io = { later(fn,ms), speed(), changed(), toast(msg, toId?) }  toId가 없으면 전체 알림 */
(function(root){
'use strict';
const BOT_NAMES=['엘리너','바르톨로','그리젤다','오스윈','마틸다','테오도르','베아트릭스','고드윈'];

function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function newDeck(){const d=[];let id=0;for(let v=1;v<=12;v++)for(let k=0;k<v;k++)d.push({id:id++,v});d.push({id:id++,v:13});d.push({id:id++,v:13});return d;}
function sortHand(h){h.sort((a,b)=>a.v-b.v||a.id-b.id);}
function titleFor(pos,n){if(pos===0)return'대달무티';if(pos===1)return'소달무티';if(pos===n-1)return'대노예';if(pos===n-2)return'소노예';return'평민';}
function vLabel(v){return v===13?'광대':String(v);}
function cardsStr(cs){return cs.map(c=>vLabel(c.v)).join('·');}
function effValue(cs){const n=cs.find(c=>c.v!==13);return n?n.v:13;}
function isValid(cards,pile){
  if(!cards.length) return false;
  const vals=new Set(cards.filter(c=>c.v!==13).map(c=>c.v));
  if(vals.size>1) return false;
  if(!pile) return true;
  return cards.length===pile.count && effValue(cards)<pile.value;
}

/* ---------- AI ---------- */
function aiChoose(h,pile){
  const J=h.filter(c=>c.v===13), byV={};
  h.forEach(c=>{if(c.v!==13)(byV[c.v]=byV[c.v]||[]).push(c);});
  const vals=Object.keys(byV).map(Number).sort((a,b)=>b-a); // 약한 숫자부터
  if(!pile){
    if(vals.length<=1) return h.slice();                       // 한 종류+광대뿐이면 전부 털기
    if(vals.length===2 && J.length && byV[vals[1]].length<=2) return byV[vals[0]].slice();
    // 약한 숫자 중 장수가 많은 묶음을 먼저 정리
    const weakHalf=vals.slice(0,Math.max(1,Math.ceil(vals.length/2)));
    let pick=weakHalf[0];
    weakHalf.forEach(v=>{ if(byV[v].length>byV[pick].length+1) pick=v; });
    return byV[pick].slice();
  }
  const c=pile.count, pv=pile.value;
  let best=null,bs=-1e9;
  for(const v of vals){
    if(v>=pv) continue;
    const k=byV[v].length, need=Math.max(0,c-k);
    if(need>J.length) continue;
    const cards=byV[v].slice(0,c-need).concat(J.slice(0,need));
    let s=v*10 - (k>c?(k-c)*7:0) - need*30;
    if(cards.length===h.length) s+=1000;
    if(s>bs){bs=s;best=cards;}
  }
  if(!best) return null;
  if(best.length<h.length){
    const v=effValue(best);
    if(v<=2 && h.length>6 && Math.random()<0.65) return null;        // 강한 카드 아껴두기
    if(v<=4 && pv>=10 && h.length>10 && Math.random()<0.35) return null;
  }
  return best;
}
// 세금 반환: 받은 카드를 제외한 가장 약한 숫자부터 (광대는 안 줌)
function aiTaxBack(hand,give,k){
  const normals=hand.filter(c=>c.v!==13&&!give.some(g=>g.id===c.id));
  const pool=(normals.length>=k?normals:hand.filter(c=>c.v!==13)).slice().sort((a,b)=>b.v-a.v);
  return pool.slice(0,k);
}

/* ---------- 게임 ---------- */
// seats: [{name, human}] — 배열 index가 플레이어 id
function createGame(seats,io){
  const n=seats.length;
  const G={n,round:0,step:0,log:[],finished:[],lastAction:{},fresh:new Set(),phase:'deal',pile:null,turn:null,
    clearing:false,taxCtx:null,revBy:null,lastPlayer:null,passStreak:0,
    players:seats.map((s,i)=>({id:i,name:s.name,human:!!s.human,ai:!s.human,hand:[],score:0}))};
  G.order=shuffle(G.players.map(p=>p.id));
  const sp=()=>io.speed(), changed=()=>io.changed();
  const turnMs=io.turnMs||0;   // 사람 차례 제한시간(ms). 0이면 없음 (싱글)
  const posOf=id=>G.order.indexOf(id);
  // who: 관련된 플레이어. 이들에겐 secret 문구(카드 내용 포함)가 보이고 강조된다. msg가 null이면 who에게만 보임
  function log(msg,kind='',who=[],secret=null){G.log.unshift({msg,kind,who,secret}); if(G.log.length>80)G.log.pop();}
  function nextActive(id){const o=G.order;const i=o.indexOf(id);for(let k=1;k<=n;k++){const c=o[(i+k)%n];if(!G.finished.includes(c))return c;}return id;}
  function moveCards(from,to,cards){const ids=new Set(cards.map(c=>c.id));from.hand=from.hand.filter(c=>!ids.has(c.id));to.hand.push(...cards);sortHand(to.hand);}
  const autoRevolution=id=>{const pos=posOf(id);return pos===n-1||pos>=n/2;};

  function start(){
    log('자리 추첨: '+G.order.map((id,i)=>`${titleFor(i,n)} ${G.players[id].name}`).join(', '),'big');
    startRound();
  }
  function startRound(){
    G.round++; G.pile=null; G.lastPlayer=null; G.passStreak=0; G.finished=[]; G.lastAction={}; G.turn=null; G.clearing=false;
    G.fresh=new Set(); G.taxCtx=null; G.revBy=null; G.phase='deal';
    const deck=shuffle(newDeck()); G.players.forEach(p=>p.hand=[]);
    deck.forEach((c,i)=>G.players[G.order[i%n]].hand.push(c));
    G.players.forEach(p=>sortHand(p.hand));
    log(`${G.round}라운드 — 카드 80장을 나눴습니다`,'round');
    changed(); io.later(checkRevolution,sp());
  }
  function checkRevolution(){
    const holder=G.players.find(p=>p.hand.filter(c=>c.v===13).length===2);
    if(!holder) return doTax();
    if(!holder.ai){G.phase='revolution';G.revBy=holder.id;changed();return;}
    resolveRevolution(holder.id,autoRevolution(holder.id));
  }
  function resolveRevolution(id,call){
    const p=G.players[id]; G.revBy=null;
    if(!call){ if(p.human) log(null,'',[id],`${p.name}: 혁명을 일으키지 않았습니다`); return doTax(); }
    if(posOf(id)===n-1){
      G.order.reverse();
      log(`${p.name}: 광대 두 장으로 대혁명! 신분이 통째로 뒤집혔습니다`,'big'); io.toast(`대혁명! ${p.name}이(가) 대달무티가 됐습니다`);
    } else {
      log(`${p.name}: 광대 두 장으로 혁명! 이번 라운드는 세금이 없습니다`,'big'); io.toast(`${p.name}의 혁명 — 세금 면제`);
    }
    G.phase='revolution'; changed(); io.later(startPlay,sp());
  }
  function doTax(){
    const o=G.order; G.phase='tax';
    G.taxQueue=[[o[n-1],o[0],2],[o[n-2],o[1],1]];
    changed(); io.later(nextTax,sp()*0.6);
  }
  function nextTax(){
    const t=G.taxQueue.shift();
    if(!t) return startPlay();
    const [pid,did,k]=t, peon=G.players[pid], dal=G.players[did];
    const give=peon.hand.slice(0,k);           // 가장 좋은(낮은) 카드 k장
    moveCards(peon,dal,give); give.forEach(c=>G.fresh.add(c.id));
    log(`${peon.name} → ${dal.name}: 세금 ${k}장`,'',[pid,did],`${peon.name} → ${dal.name}: 세금 ${cardsStr(give)}`);
    G.taxCtx={by:did,to:pid,k,give};
    if(!dal.ai){G.phase='taxReturn';changed();return;}
    giveBack(aiTaxBack(dal.hand,give,k));
    changed(); io.later(nextTax,sp());
  }
  function giveBack(back){
    const ctx=G.taxCtx, dal=G.players[ctx.by], peon=G.players[ctx.to];
    moveCards(dal,peon,back); back.forEach(c=>G.fresh.add(c.id));
    io.toast(`세금: ${cardsStr(ctx.give)} 바치고 ${cardsStr(back)} 받음`,peon.id);
    log(`${dal.name} → ${peon.name}: ${ctx.k}장 돌려줌`,'',[dal.id,peon.id],`${dal.name} → ${peon.name}: ${cardsStr(back)} 돌려줌`);
    G.taxCtx=null;
  }
  function finishTaxReturn(back){ giveBack(back); G.phase='tax'; changed(); io.later(nextTax,sp()*0.6); }
  function startPlay(){
    G.phase='play'; G.pile=null; G.passStreak=0; G.lastPlayer=null; G.lastAction={};
    G.turn=G.order[0]; G.step++;
    log(`${G.players[G.turn].name}이(가) 첫 선을 잡습니다`);
    schedule(); changed();
  }
  // step: 차례가 바뀔 때마다 증가. 예약된 AI 타이머가 지난 차례에 대해 두 번 두는 것을 막는다
  function schedule(){
    G.deadline=null;
    if(G.phase!=='play'||G.clearing||G.turn==null) return;
    const p=G.players[G.turn], step=G.step;
    if(p.ai) return io.later(()=>{ if(G.step===step&&p.ai) act(p.id,aiChoose(p.hand,G.pile)); }, sp());
    if(!turnMs) return;
    // 시간 초과: 바닥에 카드가 있으면 패스, 선이면 AI가 골라서 낸다
    const dl=G.deadline=Date.now()+turnMs;
    io.later(()=>{
      if(G.step!==step||G.deadline!==dl||p.ai||G.turn!==p.id) return;   // 재접속으로 다시 잡힌 타이머가 있으면 그쪽이 처리
      log(`${p.name} 시간 초과 — ${G.pile?'자동 패스':'자동으로 냅니다'}`);
      io.toast('시간 초과!',p.id);
      act(p.id,G.pile?null:aiChoose(p.hand,null));
    }, turnMs);
  }
  function act(id,cards){
    const p=G.players[id]; G.step++;
    if(!cards){ G.passStreak++; G.lastAction[id]={pass:true}; }
    else{
      const ids=new Set(cards.map(c=>c.id)); p.hand=p.hand.filter(c=>!ids.has(c.id));
      G.pile={cards,count:cards.length,value:effValue(cards),by:id};
      G.lastPlayer=id; G.passStreak=0; G.lastAction[id]={cards};
      log(`${p.name}: ${cardsStr(cards)}`,'',[id]);
      if(p.hand.length===0){
        G.finished.push(id);
        log(`${p.name} ${G.finished.length}등으로 손을 털었습니다`,'big');
        if(G.finished.length===1) io.toast(`${p.name} 1등! 다음 라운드 대달무티`);
      }
    }
    p.hand.forEach(c=>G.fresh.delete(c.id));
    const active=G.order.filter(x=>!G.finished.includes(x));
    if(active.length<=1){ if(active.length===1) G.finished.push(active[0]); G.turn=null; changed(); return io.later(endRound,sp()); }
    const others=active.filter(x=>x!==G.lastPlayer);
    if(G.lastPlayer!==null && G.passStreak>=others.length){
      const lp=G.lastPlayer, leader=active.includes(lp)?lp:nextActive(lp);
      G.clearing=true; G.turn=null; changed();
      io.later(()=>{
        G.clearing=false; G.pile=null; G.passStreak=0; G.lastPlayer=null; G.lastAction={}; G.turn=leader; G.step++;
        log(`모두 패스 — ${G.players[leader].name}이(가) 새로 선`);
        schedule(); changed();
      }, sp()*1.3);
      return;
    }
    G.turn=nextActive(id); schedule(); changed();
  }
  function endRound(){
    G.phase='roundEnd'; G.turn=null;
    G.finished.forEach((id,i)=>{G.players[id].score+=n-1-i;});
    G.order=G.finished.slice();
    log(`${G.round}라운드 종료 — 대달무티 ${G.players[G.order[0]].name}`,'big');
    changed();
  }

  /* ---------- 사람 입력 (서버에선 클라이언트 메시지가 그대로 들어오므로 전부 검증) ---------- */
  function play(id,ids){
    const p=G.players[id];
    if(!p||p.ai||G.phase!=='play'||G.clearing||G.turn!==id) return false;
    if(ids==null){ if(!G.pile) return false; act(id,null); return true; }
    const cards=p.hand.filter(c=>ids.includes(c.id));
    if(cards.length!==ids.length||!isValid(cards,G.pile)) return false;
    act(id,cards); return true;
  }
  function taxReturn(id,ids){
    const p=G.players[id];
    if(!p||p.ai||G.phase!=='taxReturn'||G.taxCtx.by!==id) return false;
    const back=p.hand.filter(c=>ids.includes(c.id));
    if(back.length!==G.taxCtx.k||ids.length!==G.taxCtx.k) return false;
    finishTaxReturn(back); return true;
  }
  function revolution(id,call){
    const p=G.players[id];
    if(!p||p.ai||G.phase!=='revolution'||G.revBy!==id) return false;
    resolveRevolution(id,!!call); return true;
  }
  function nextRound(){ if(G.phase==='roundEnd') startRound(); }
  // 멀티: 연결이 끊긴 사람 자리를 AI가 대신 두고, 돌아오면 돌려준다
  function setAI(id,on){
    const p=G.players[id]; if(p.ai===on) return;
    p.ai=on;
    log(on?`${p.name}의 연결이 끊겨 AI가 대신 둡니다`:`${p.name}이(가) 돌아왔습니다`);
    if(on&&G.phase==='revolution'&&G.revBy===id) return resolveRevolution(id,autoRevolution(id));
    if(on&&G.phase==='taxReturn'&&G.taxCtx.by===id) return finishTaxReturn(aiTaxBack(p.hand,G.taxCtx.give,G.taxCtx.k));
    if(G.turn===id) schedule(); changed();
  }

  // viewer 한 명에게 보여줄 상태. 남의 손패는 장수만, 비공개 기록은 관련자에게만
  function view(me){
    const ctx=G.taxCtx;
    return {
      me, n, round:G.round, phase:G.phase, order:G.order, pile:G.pile, turn:G.turn, finished:G.finished,
      lastAction:G.lastAction, clearing:G.clearing, revBy:G.revBy,
      turnMs, turnLeft:G.deadline&&G.turn!=null?Math.max(0,G.deadline-Date.now()):null,
      taxCtx:ctx&&{by:ctx.by,to:ctx.to,k:ctx.k,give:ctx.by===me?ctx.give:null},
      players:G.players.map(q=>({id:q.id,name:q.name,human:q.human,ai:q.ai,score:q.score,count:q.hand.length})),
      hand:G.players[me].hand,
      fresh:G.players[me].hand.filter(c=>G.fresh.has(c.id)).map(c=>c.id),
      log:G.log.filter(e=>e.msg!=null||e.who.includes(me)).slice(0,60).map(e=>{
        const mine=e.who.includes(me);
        return {msg:mine&&e.secret?e.secret:e.msg, kind:e.kind||(mine&&G.players[me].human?'me':'')};
      }),
    };
  }

  return {start,play,taxReturn,revolution,nextRound,setAI,view,isAI:id=>G.players[id].ai};
}

const api={createGame,isValid,shuffle,titleFor,vLabel,cardsStr,BOT_NAMES};
if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.Dalmuti=api;
})(this);
