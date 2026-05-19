'use strict';

const express  = require('express');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');

const PORT       = 3847;
const POLL_MS    = 10_000;
const DATA_DIR   = path.join(__dirname, 'data');
const SLOTS_FILE = path.join(DATA_DIR, 'slots.json');
const PUB_DIR    = path.join(__dirname, 'public');

// ─── Slot definitions ──────────────────────────────────────────────────────────
const SLOT_DEFS = [
  { id:'C1',   label:'C',    group:'batter',  pos:['C']                 },
  { id:'C2',   label:'C',    group:'batter',  pos:['C']                 },
  { id:'1B',   label:'1B',   group:'batter',  pos:['1B']                },
  { id:'2B',   label:'2B',   group:'batter',  pos:['2B']                },
  { id:'3B',   label:'3B',   group:'batter',  pos:['3B']                },
  { id:'SS',   label:'SS',   group:'batter',  pos:['SS']                },
  { id:'MI',   label:'MI',   group:'batter',  pos:['2B','SS']           },
  { id:'CI',   label:'CI',   group:'batter',  pos:['1B','3B']           },
  { id:'OF1',  label:'OF',   group:'batter',  pos:['OF','LF','CF','RF'] },
  { id:'OF2',  label:'OF',   group:'batter',  pos:['OF','LF','CF','RF'] },
  { id:'OF3',  label:'OF',   group:'batter',  pos:['OF','LF','CF','RF'] },
  { id:'OF4',  label:'OF',   group:'batter',  pos:['OF','LF','CF','RF'] },
  { id:'OF5',  label:'OF',   group:'batter',  pos:['OF','LF','CF','RF'] },
  { id:'UTIL', label:'UTIL', group:'batter',  pos:['*']                 },
  { id:'P1',   label:'P',    group:'pitcher', pos:['SP','RP','P']       },
  { id:'P2',   label:'P',    group:'pitcher', pos:['SP','RP','P']       },
  { id:'P3',   label:'P',    group:'pitcher', pos:['SP','RP','P']       },
  { id:'P4',   label:'P',    group:'pitcher', pos:['SP','RP','P']       },
  { id:'P5',   label:'P',    group:'pitcher', pos:['SP','RP','P']       },
  { id:'P6',   label:'P',    group:'pitcher', pos:['SP','RP','P']       },
  { id:'P7',   label:'P',    group:'pitcher', pos:['SP','RP','P']       },
  { id:'P8',   label:'P',    group:'pitcher', pos:['SP','RP','P']       },
  { id:'P9',   label:'P',    group:'pitcher', pos:['SP','RP','P']       },
  { id:'BN1',  label:'BN',   group:'bench',   pos:['*']                 },
  { id:'BN2',  label:'BN',   group:'bench',   pos:['*']                 },
  { id:'BN3',  label:'BN',   group:'bench',   pos:['*']                 },
  { id:'BN4',  label:'BN',   group:'bench',   pos:['*']                 },
  { id:'BN5',  label:'BN',   group:'bench',   pos:['*']                 },
  { id:'BN6',  label:'BN',   group:'bench',   pos:['*']                 },
  { id:'BN7',  label:'BN',   group:'bench',   pos:['*']                 },
];
const SLOT_MAP = Object.fromEntries(SLOT_DEFS.map(s => [s.id, s]));

// ─── Utilities ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayET() {
  // Tracker day rolls over at 6:00 AM America/New_York time, not midnight.
  //
  // Example:
  // - May 4, 2026 05:59 ET => tracker date is 2026-05-03
  // - May 4, 2026 06:00 ET => tracker date is 2026-05-04
  const RESET_HOUR_ET = 6;

  const etNow = new Date(new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York'
  }));

  etNow.setHours(etNow.getHours() - RESET_HOUR_ET);

  return [
    etNow.getFullYear(),
    String(etNow.getMonth() + 1).padStart(2, '0'),
    String(etNow.getDate()).padStart(2, '0')
  ].join('-');
}

function normalize(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z\s]/gi,' ').toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g,'')
    .replace(/\s+/g,' ').trim();
}

function matchPlayer(norm, apiList) {
  const exact = apiList.find(p => p.norm === norm);
  if (exact) return exact;
  const parts = norm.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  const last   = parts[parts.length - 1];
  const firsts = parts.slice(0, -1); // e.g. ['j','p'] for "j p crawford"

  for (const p of apiList) {
    const ap = p.norm.split(' ').filter(Boolean);
    if (ap.length < 2) continue;
    const aLast   = ap[ap.length - 1];
    const aFirsts = ap.slice(0, -1);
    if (aLast !== last) continue;
    // API name must have at least as many first-name tokens as stored name.
    // Prevents "j p" (2 tokens) matching "Justin" (1 token).
    if (aFirsts.length < firsts.length) continue;
    // Every stored first-part must match the corresponding API first-part by initial.
    if (firsts.every((f, i) => aFirsts[i]?.[0] === f[0])) return p;
  }

  // Partial last-name fallback for hyphenated / truncated names (single first token only).
  if (firsts.length === 1) {
    for (const p of apiList) {
      const ap = p.norm.split(' ').filter(Boolean);
      if (ap.length < 2) continue;
      const aLast = ap[ap.length - 1];
      if (last.length > 4 && ap[0][0] === firsts[0][0] && (aLast.includes(last) || last.includes(aLast))) return p;
    }
  }

  return null;
}

// ─── MLB HTTP helper ───────────────────────────────────────────────────────────
function mlbFetch(apiPath, timeoutMs=10_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname:'statsapi.mlb.com', path:apiPath,
        headers:{ Accept:'application/json', 'User-Agent':'MLBFantasyTracker/4.0' } },
      res => {
        if (res.statusCode!==200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const chunks=[];
        res.on('data',c=>chunks.push(c));
        res.on('end',()=>{ try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){reject(e);} });
        res.on('error',reject);
      }
    );
    req.on('error',reject);
    req.setTimeout(timeoutMs,()=>{ req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Player DB — two seasons for injured/inactive coverage ────────────────────
let playerDB=[], playerDBDate='';

async function ensurePlayerDB() {
  const today = todayET();
  if (playerDBDate===today && playerDB.length) return;
  const year = Number(today.split('-')[0]);
  const byId = new Map();
  for (const season of [year, year-1]) {
    try {
      const data = await mlbFetch(`/api/v1/sports/1/players?season=${season}`, 25_000);
      for (const p of (data?.people??[])) {
        if (!p?.id||!p?.fullName) continue;
        if (!byId.has(p.id)) byId.set(p.id, {
          id: Number(p.id), name: p.fullName, norm: normalize(p.fullName),
          pos: p.primaryPosition?.abbreviation??'UNK',
          teamAbbr: p.currentTeam?.abbreviation??'',
        });
      }
      console.log(`[PlayerDB] season ${season}: ${data?.people?.length??0}`);
    } catch(e) { console.warn(`[PlayerDB] ${season}:`, e.message); }
    await sleep(300);
  }
  playerDB=[ ...byId.values() ]; playerDBDate=today;
  console.log(`[PlayerDB] Total: ${playerDB.length} unique players`);
}

// ─── Slots persistence ─────────────────────────────────────────────────────────
let slots={};

function loadSlots() {
  SLOT_DEFS.forEach(d=>{ slots[d.id]=null; });
  try {
    if (fs.existsSync(SLOTS_FILE)) {
      const raw=JSON.parse(fs.readFileSync(SLOTS_FILE,'utf8'));
      SLOT_DEFS.forEach(d=>{ if(raw[d.id]!==undefined) slots[d.id]=raw[d.id]; });
    }
  } catch(_) {}
}

function saveSlots() {
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots,null,2));
}

loadSlots();

function getTrackedPlayers() {
  const players=[], seen=new Set();
  for (const def of SLOT_DEFS) {
    if (def.group==='bench') continue;
    const p=slots[def.id]; if(!p) continue;
    const norm=normalize(p.name);
    if (seen.has(norm)) continue;
    seen.add(norm);
    players.push({ name:p.name, norm, isPitcher:def.group==='pitcher' });
  }
  return players;
}

// ─── Play helpers ──────────────────────────────────────────────────────────────
function isPA(play) {
  if (!play?.about?.isComplete) return false;
  const t=String(play?.result?.eventType??play?.result?.event??'').toLowerCase();
  return /strikeout|single|double|triple|home_run|walk|intent_walk|hit_by_pitch|field_out|grounded_into|fly_out|line_out|pop_out|force_out|sac_fly|sac_bunt|sacrifice|fielders_choice|catcher_interference|error/.test(t);
}

function isSB(play) {
  if (!play?.about?.isComplete) return false;
  return /stolen_base|steals/.test(String(play?.result?.eventType??'').toLowerCase());
}

function classify(play) {
  const t=String(play?.result?.eventType??play?.result?.event??'').toLowerCase();
  if (/home_run/.test(t))               return {type:'HR',  label:'Home Run',  isHit:true,  ab:true };
  if (/triple(?!_play)/.test(t))         return {type:'3B',  label:'Triple',    isHit:true,  ab:true };
  if (/double(?!_play)/.test(t))         return {type:'2B',  label:'Double',    isHit:true,  ab:true };
  if (/single/.test(t))                 return {type:'1B',  label:'Single',    isHit:true,  ab:true };
  if (/intent_walk|walk/.test(t))       return {type:'BB',  label:'Walk',      isHit:false, ab:false};
  if (/hit_by_pitch/.test(t))           return {type:'HBP', label:'HBP',       isHit:false, ab:false};
  if (/strikeout/.test(t))              return {type:'K',   label:'Strikeout', isHit:false, ab:true };
  if (/sac_fly|sacrifice_fly/.test(t))  return {type:'SF',  label:'Sac Fly',   isHit:false, ab:false};
  if (/sac_bunt|sacrifice_bunt/.test(t))return {type:'SH',  label:'Sac Bunt',  isHit:false, ab:false};
  return                                       {type:'OUT', label:'Out',        isHit:false, ab:true };
}

function innStr(play) {
  return `${play?.about?.halfInning==='top'?'Top':'Bot'} ${play?.about?.inning??''}`.trim();
}

// ─── Tracker ───────────────────────────────────────────────────────────────────
class Tracker {
  constructor() {
    this.playerGameMap      = new Map();
    this.gameRosters        = new Map();
    this.playerPlayIdx      = new Map();
    this.finalGames         = new Set();
    this.finalDecisionGames = new Set();   // games whose boxscore decisions we've fetched
    this.playerCheckedGames = new Map();
    this.events             = [];  // kept sorted newest-first by ts
    this.seenIds            = new Set();
    this.liveStatus         = {};
    this.gameScores         = {};
    this.activeGamePlayers  = new Set();
    this.lastPollMs         = null;
    this.lastError          = null;
    this.dateKey            = '';
  }

  _resetIfNewDay() {
    const today=todayET();
    if (this.dateKey===today) return;
    this.dateKey=today;
    this.playerGameMap.clear(); this.gameRosters.clear();
    this.playerPlayIdx.clear(); this.finalGames.clear();
    this.finalDecisionGames.clear();
    this.playerCheckedGames.clear(); this.events=[];
    this.seenIds=new Set(); this.liveStatus={}; this.gameScores={};
    this.activeGamePlayers.clear();
    console.log('[Tracker] New day:',today);
  }

  _addEvent(evt) {
    if (this.seenIds.has(evt.id)) return false;
    this.seenIds.add(evt.id);
    // Insert sorted by ts descending (newest at index 0)
    const ts=new Date(evt.ts).getTime();
    let i=0;
    while (i<this.events.length && new Date(this.events[i].ts).getTime()>ts) i++;
    this.events.splice(i,0,evt);
    if (this.events.length>500) this.events.pop();
    return true;
  }

  computeStats() {
    const stats={};
    for (const e of this.events) {
      if (!stats[e.playerName]) stats[e.playerName]={
        role:e.role, h:0,ab:0,hr:0,r:0,rbi:0,sb:0,
        bf:0,outs:0,k:0,bb:0,ha:0,hra:0,er:0,
      };
      const s=stats[e.playerName];
      if (e.type==='SB') { if (e.role==='hitter') s.sb++; continue; }
      if (e.role==='hitter') {
        if (e.countsAsAb) s.ab++;
        if (e.isHit) s.h++;
        if (e.type==='HR') s.hr++;
        s.r+=e.runs??0; s.rbi+=e.rbi??0;
      } else {
        if (e.type==='W')  { s.w=(s.w??0)+1; continue; }
        if (e.type==='SV') { s.sv=(s.sv??0)+1; continue; }
        s.bf++;
        s.outs+=e.outsRecorded??0;
        if (e.type==='K') s.k++;
        if (e.type==='BB'||e.type==='HBP') s.bb++;
        if (e.type==='HR') s.hra++;
        if (e.isHit) s.ha++;
        s.er+=e.runsAllowed??0;
      }
    }
    for (const s of Object.values(stats)) {
      if (s.role==='pitcher') {
        const ip=s.outs/3;
        s.era  = ip>0 ? (s.er*9)/ip : 0;
        s.whip = ip>0 ? (s.bb+s.ha)/ip : 0;
      } else {
        s.avg=s.ab>0?s.h/s.ab:0;
      }
    }
    return stats;
  }

  async poll(players) {
    this._resetIfNewDay();
    const t0=Date.now(); const newEvents=[];
    this.liveStatus={}; this.activeGamePlayers.clear();
    if (!players.length) { this.lastPollMs=0; return {newEvents}; }

    // Schedule
    let games=[];
    try {
      const sched=await mlbFetch(`/api/v1/schedule?sportId=1&date=${this.dateKey}`);
      games=sched?.dates?.[0]?.games??[];
    } catch(e) { this.lastError=e.message; return {newEvents}; }

    // Discovery
    const unmapped=players.filter(p=>!this.playerGameMap.has(p.norm));
    if (unmapped.length) {
      for (const game of games) {
        const needsCheck=unmapped.filter(p=>
          !this.playerGameMap.has(p.norm) &&
          !this.playerCheckedGames.get(p.norm)?.has(game.gamePk)
        );
        if (!needsCheck.length) continue;
        try {
          let apiPlayers=this.gameRosters.get(game.gamePk);
          if (!apiPlayers) {
            const bs=await mlbFetch(`/api/v1/game/${game.gamePk}/boxscore`);
            apiPlayers=[];
            for (const side of ['away','home']) {
              for (const p of Object.values(bs?.teams?.[side]?.players??{})) {
                if (p?.person?.fullName) apiPlayers.push({
                  id:Number(p.person.id), name:p.person.fullName, norm:normalize(p.person.fullName),
                });
              }
            }
            this.gameRosters.set(game.gamePk,apiPlayers);
          }
          for (const p of needsCheck) {
            if (!this.playerCheckedGames.has(p.norm)) this.playerCheckedGames.set(p.norm,new Set());
            this.playerCheckedGames.get(p.norm).add(game.gamePk);
            if (this.playerGameMap.has(p.norm)) continue;
            const slotEntry=Object.values(slots).find(s=>s&&normalize(s.name)===p.norm);
            const mlbId=slotEntry?.mlbId?Number(slotEntry.mlbId):null;
            const match=mlbId?(apiPlayers.find(a=>a.id===mlbId)??null):matchPlayer(p.norm,apiPlayers);
            if (match) {
              this.playerGameMap.set(p.norm,{gameId:game.gamePk,apiId:Number(match.id),apiName:match.name});
              console.log(`[Map] "${p.name}" (id=${match.id}) → game ${game.gamePk}`);
            }
          }
        } catch(e) { console.warn(`[Discovery] game ${game.gamePk}:`,e.message); }
        await sleep(60);
      }
        for (const p of unmapped) {
          if (!this.playerGameMap.has(p.norm)) {
            console.warn(`[Unresolved] "${p.name}" — not in today's games`);
            // Mark all games as checked for this player to stop infinite rescanning
            if (!this.playerCheckedGames.has(p.norm)) this.playerCheckedGames.set(p.norm, new Set());
            for (const g of games) this.playerCheckedGames.get(p.norm).add(g.gamePk);
          }
}
    }

    // Active / completed games for the current tracker day
    const active=new Map();

    for (const p of players) {
      const map=this.playerGameMap.get(p.norm);
      if (!map) continue;

      const g=games.find(g=>g.gamePk===map.gameId);
      if (!g) continue;

      const st=g.status?.abstractGameState;

      // Preview games have no completed plays yet, so skip them for event processing.
      // Live and Final games should both be processed so the frontend works as
      // a full-day recap.
      if (st==='Preview') continue;

      if (!active.has(map.gameId)) {
        active.set(map.gameId,{
          label:`${g.teams?.away?.team?.name} @ ${g.teams?.home?.team?.name}`,
          status:st,
          isLive:st==='Live',
          isFinal:st==='Final',
          players:[],
        });
      }
      this.gameScores[map.gameId]={
        away:g.teams?.away?.score??0,
        awayAbbr:g.teams?.away?.team?.abbreviation??'',
        home:g.teams?.home?.score??0,
        homeAbbr:g.teams?.home?.team?.abbreviation??'',
        status:st,
      };

      active.get(map.gameId).players.push(p);
    }

    // Play-by-play + linescore
    for (const [gameId,{label,isLive,isFinal,status,players:gp}] of active) {
      if (isLive) gp.forEach(p=>this.activeGamePlayers.add(p.norm));
      try {
        const pbp=await mlbFetch(`/api/v1/game/${gameId}/playByPlay`);
          const allPlays=pbp?.allPlays??[];

          // Build per-player start indexes first.
          //
          // Important:
          // - Newly mapped / newly tracked players must start at 0 so they can process
          //   the full allPlays[] history on their first poll.
          // - Existing indexed players can use the small rewind optimization.
          const playerStarts = new Map();

          for (const player of gp) {
            const hasIdx = this.playerPlayIdx.has(player.norm);

            const startIdx = hasIdx
              ? Math.max(0, this.playerPlayIdx.get(player.norm) - 2)
              : 0;

            playerStarts.set(player.norm, startIdx);
          }

          // Optimization: only start the outer play loop at the earliest start index
          // needed by any player in this game.
          const minStart = playerStarts.size
            ? Math.min(...playerStarts.values())
            : allPlays.length;

          for (let i=minStart;i<allPlays.length;i++) {
            const play=allPlays[i];
            if (!play?.about?.isComplete) continue;

            for (const player of gp) {
              const pStart = playerStarts.get(player.norm) ?? 0;

              // Existing players skip plays before their own cursor.
              // Newly added players have pStart === 0, so they process full history.
              if (i < pStart) continue;

              for (const evt of this._processPlay(play,gameId,label,player)) {
                if (this._addEvent(evt)) newEvents.push(evt);
              }
            }
          }

          // Only after processing do we advance each player's cursor to the end.
          for (const player of gp) {
            this.playerPlayIdx.set(player.norm, allPlays.length);
          }
        const cur=pbp?.currentPlay;
        if (cur&&!cur.about?.isComplete) this._updateLive(cur,gp,label,gameId);

        // ── Fetch boxscore once per Final game to get W/SV decisions ──────────
        if (isFinal && !this.finalDecisionGames.has(gameId)) {
          try {
            const box=await mlbFetch(`/api/v1/game/${gameId}/boxscore`);
            const allPlayers={
              ...box?.teams?.away?.players??{},
              ...box?.teams?.home?.players??{},
            };
            for (const player of gp) {
              if (!player.isPitcher) continue;
              const map=this.playerGameMap.get(player.norm);
              if (!map) continue;
              const key=`ID${map.apiId}`;
              const ps=allPlayers[key]?.stats?.pitching;
              if (!ps) continue;
              const ts=new Date().toISOString();
              if (ps.wins>0) {
                const evId=`${gameId}:W:${map.apiId}`;
                this._addEvent({
                  id:evId,ts,playerName:player.name,role:'pitcher',
                  type:'W',label:'Win',desc:`${player.name} earns the Win.`,
                  inning:'Final',gameLabel:label,vs:'',
                  isHit:false,countsAsAb:false,rbi:0,runs:0,
                  outsRecorded:0,runsAllowed:0,
                });
              }
              if (ps.saves>0) {
                const evId=`${gameId}:SV:${map.apiId}`;
                this._addEvent({
                  id:evId,ts,playerName:player.name,role:'pitcher',
                  type:'SV',label:'Save',desc:`${player.name} records the Save.`,
                  inning:'Final',gameLabel:label,vs:'',
                  isHit:false,countsAsAb:false,rbi:0,runs:0,
                  outsRecorded:0,runsAllowed:0,
                });
              }
            }
            this.finalDecisionGames.add(gameId);
            console.log(`[Decisions] Fetched boxscore for game ${gameId}`);
          } catch(e) {
            console.warn(`[Decisions] Boxscore fetch failed for ${gameId}:`,e.message);
          }
        }

        // Linescore for onDeck/inHole + batting order
        if (isLive) {
          try {
            const ls=await mlbFetch(`/api/v1/game/${gameId}/linescore`,5_000);
            const onDeckName=ls?.offense?.onDeck?.fullName??null;
            const inHoleName=ls?.offense?.inHole?.fullName??null;
            const battingOrder=ls?.offense?.battingOrder??[]; // Array of player IDs in order
            
            for (const player of gp) {
              if (this.liveStatus[player.name]?.type==='batting') continue;
              
              // Check batting order position
              const map=this.playerGameMap.get(player.norm);
              if(map && battingOrder.length){
                const orderPos=battingOrder.indexOf(map.apiId)+1;
                if(orderPos>0){
                  this.liveStatus[player.name]={
                    ...(this.liveStatus[player.name]??{}),
                    battingOrderPos:orderPos,
                  };
                }
              }
              
              // On-base detection: check all three bases
              const offenseRunners=[ls?.offense?.first,ls?.offense?.second,ls?.offense?.third].filter(Boolean);
              const isOnBase=offenseRunners.some(r=>normalize(r?.fullName??'')===player.norm);

              if (onDeckName&&normalize(onDeckName)===player.norm)
                this.liveStatus[player.name]={...(this.liveStatus[player.name]??{}),type:'onDeck',inning:'',count:'',vs:'',gameLabel:label,gamePk:gameId};
              else if (inHoleName&&normalize(inHoleName)===player.norm)
                this.liveStatus[player.name]={...(this.liveStatus[player.name]??{}),type:'inHole',inning:'',count:'',vs:'',gameLabel:label,gamePk:gameId};
              else if (isOnBase&&this.liveStatus[player.name]?.type!=='batting')
                this.liveStatus[player.name]={...(this.liveStatus[player.name]??{}),type:'onBase',inning:'',count:'',vs:'',gameLabel:label,gamePk:gameId};
            }
          } catch(_) {}
          await sleep(60);
        }
      } catch(e) { console.warn(`[Poll] Game ${gameId}:`,e.message); }
      await sleep(60);
    }

    this.lastPollMs=Date.now()-t0; this.lastError=null;
    const mapped=players.filter(p=>this.playerGameMap.has(p.norm)).length;
    const liveCount = [...active.values()].filter(g => g.isLive).length;
    const finalCount = [...active.values()].filter(g => g.isFinal).length;
    console.log(`[Poll] ${this.lastPollMs}ms | ${active.size} game(s) active/complete | live=${liveCount} final=${finalCount} | ${mapped}/${players.length} mapped | ${newEvents.length} new`);
    return {newEvents};
  }

  _processPlay(play, gameId, label, player) {
    const map=this.playerGameMap.get(player.norm); if(!map) return [];
    const entries=[];
    const runners=play.runners??[];
    const ts=play.about?.endTime??new Date().toISOString();
    const inn=innStr(play);
    const idx=play.about?.atBatIndex??play.atBatIndex??0;

    if (isPA(play)) {
      const cls=classify(play);
      const desc=String(play.result?.description??'').trim();
      const batterId=Number(play.matchup?.batter?.id);
      const pitcherId=Number(play.matchup?.pitcher?.id);

      // Pre-AB situation
      const preFirst =runners.some(r=>r?.movement?.start==='1B');
      const preSecond=runners.some(r=>r?.movement?.start==='2B');
      const preThird =runners.some(r=>r?.movement?.start==='3B');
      const preOuts  =play.count?.outs??0;
      const lastPitch=play.playEvents?.filter(ev=>ev.isPitch)?.slice(-1)[0];
      const finalCount=lastPitch?`${lastPitch.count?.balls??0}-${lastPitch.count?.strikes??0}`:null;
      const hitEvt=play.playEvents?.find(ev=>ev.hitData?.launchSpeed);
      const exitVelo   =hitEvt?.hitData?.launchSpeed??null;
      const launchAngle=hitEvt?.hitData?.launchAngle??null;
      const hitDistance=hitEvt?.hitData?.totalDistance??null;
      const trajectory =hitEvt?.hitData?.trajectory??null;

      if (!player.isPitcher&&map.apiId===batterId) {
        const runs=runners.filter(r=>r?.movement?.end==='score'&&Number(r?.details?.runner?.id)===map.apiId).length;
        entries.push({
          id:`${gameId}:bat:${map.apiId}:${idx}`,ts,
          playerName:player.name,role:'hitter',
          type:cls.type,label:cls.label,desc,inning:inn,gameLabel:label,
          vs:play.matchup?.pitcher?.fullName??'',
          isHit:cls.isHit,countsAsAb:cls.ab,
          rbi:play.result?.rbi??0,runs,outsRecorded:0,runsAllowed:0,
          preFirst,preSecond,preThird,preOuts,finalCount,
          exitVelo,launchAngle,hitDistance,trajectory,
        });
      }
      if (player.isPitcher&&map.apiId===pitcherId) {
        const bOut=cls.ab&&!cls.isHit&&cls.type!=='BB'&&cls.type!=='HBP';
        const rOut=runners.filter(r=>r?.details?.isOut).length;
        entries.push({
          id:`${gameId}:pit:${map.apiId}:${idx}`,ts,
          playerName:player.name,role:'pitcher',
          type:cls.type,label:cls.label,desc,inning:inn,gameLabel:label,
          vs:play.matchup?.batter?.fullName??'',
          isHit:cls.isHit,countsAsAb:cls.ab,
          outsRecorded:rOut+(bOut?1:0),
          runsAllowed:runners.filter(r=>r?.movement?.end==='score').length,
          rbi:0,runs:0,
          preFirst,preSecond,preThird,preOuts,finalCount,
          exitVelo,launchAngle,hitDistance,trajectory,
        });
      }
    }

    if (isSB(play)&&!player.isPitcher) {
      for (const runner of runners) {
        if (Number(runner?.details?.runner?.id)===map.apiId&&runner?.movement?.end!=='out') {
          entries.push({
            id:`${gameId}:sb:${map.apiId}:${idx}`,ts,
            playerName:player.name,role:'hitter',
            type:'SB',label:'Stolen Base',
            desc:String(play.result?.description??'').trim(),
            inning:inn,gameLabel:label,vs:'',
            isHit:false,countsAsAb:false,rbi:0,runs:0,outsRecorded:0,runsAllowed:0,
          });
          break;
        }
      }
    }

    // Run scored as a baserunner on someone else's at-bat.
    // The batter block already captures runs from the player's OWN PA,
    // so only emit this when the tracked player is not the current batter.
    const batterIdRun=Number(play.matchup?.batter?.id);
    if (!player.isPitcher && map.apiId !== batterIdRun) {
      const scoredAsRunner=runners.some(r=>
        r?.movement?.end==='score' &&
        Number(r?.details?.runner?.id)===map.apiId
      );
      if (scoredAsRunner) {
        entries.push({
          id:`${gameId}:run:${map.apiId}:${idx}`,ts,
          playerName:player.name,role:'hitter',
          type:'R',label:'Run Scored',
          desc:String(play.result?.description??'').trim(),
          inning:inn,gameLabel:label,
          vs:play.matchup?.pitcher?.fullName??'',
          isHit:false,countsAsAb:false,rbi:0,runs:1,outsRecorded:0,runsAllowed:0,
        });
      }
    }

    return entries.filter((e,i,a)=>a.findIndex(x=>x.id===e.id)===i);
  }

  _updateLive(play,players,gameLabel,gameId) {
    const batterId=Number(play.matchup?.batter?.id);
    const pitcherId=Number(play.matchup?.pitcher?.id);
    const inn=innStr(play);
    const count=play.count?`${play.count.balls}-${play.count.strikes}`:'';
    for (const player of players) {
      const map=this.playerGameMap.get(player.norm); if(!map) continue;
      if (!player.isPitcher&&map.apiId===batterId)
        this.liveStatus[player.name]={type:'batting',inning:inn,count,vs:play.matchup?.pitcher?.fullName??'',gameLabel,gamePk:gameId};
      if (player.isPitcher&&map.apiId===pitcherId)
        this.liveStatus[player.name]={type:'pitching',inning:inn,count,vs:play.matchup?.batter?.fullName??'',gameLabel,gamePk:gameId};
    }
  }
}

// ─── App ───────────────────────────────────────────────────────────────────────
const app=express(), tracker=new Tracker(), clients=new Set();
app.use(express.json());
app.use(express.static(PUB_DIR));

app.get('/events',(req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  try{res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);}catch(_){}
  clients.add(res); req.on('close',()=>clients.delete(res));
});

function broadcast(event,data){
  const msg=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients){try{res.write(msg);}catch(_){clients.delete(res);}}
}

function buildState(){
  // Map playerName → game abstractGameState ('Preview'|'Live'|'Final')
  const playerGameStates={};
  for (const def of SLOT_DEFS) {
    if (def.group==='bench') continue;
    const p=slots[def.id]; if(!p) continue;
    const map=tracker.playerGameMap.get(normalize(p.name));
    if(!map) continue;
    const score=tracker.gameScores[map.gameId];
    if(score) playerGameStates[p.name]=score.status;
  }
  return{
    slots,slotDefs:SLOT_DEFS,
    events:tracker.events.slice(0,120),
    stats:tracker.computeStats(),
    liveStatus:tracker.liveStatus,
    activeGamePlayers:[...tracker.activeGamePlayers],
    gameScores:tracker.gameScores??{},
    playerGameStates,
    pollMs:tracker.lastPollMs,error:tracker.lastError,ts:Date.now(),
  };
}

app.get('/api/players/search',async(req,res)=>{
  await ensurePlayerDB();
  const q=normalize(req.query.q??'');
  if(q.length<2) return res.json([]);
  res.json(playerDB.filter(p=>p.norm.includes(q)).slice(0,12));
});

app.put('/api/roster/slot/:slotId',(req,res)=>{
  const def=SLOT_MAP[req.params.slotId];
  if(!def) return res.status(400).json({error:'Invalid slot'});
  const p=req.body?.player??null;
  const prevNorm=slots[def.id]?.norm;
  if(p){
    slots[def.id]={name:p.name.trim(),norm:normalize(p.name),position:p.pos??'UNK',
      teamAbbr:p.teamAbbr??'',mlbId:p.mlbId?Number(p.mlbId):null};
  }else{slots[def.id]=null;}
  if (prevNorm && prevNorm !== slots[def.id]?.norm) {
    tracker.playerGameMap.delete(prevNorm);
    tracker.playerPlayIdx.delete(prevNorm);
    tracker.playerCheckedGames.delete(prevNorm);
    tracker.activeGamePlayers.delete(prevNorm);
  }
  saveSlots();broadcast('state',buildState());res.json({ok:true});
});

app.post('/api/roster/swap',(req,res)=>{
  const{from,to}=req.body??{};
  if(!SLOT_MAP[from]||!SLOT_MAP[to]) return res.status(400).json({error:'Invalid slots'});
  [slots[from],slots[to]]=[slots[to],slots[from]];
  saveSlots();broadcast('state',buildState());res.json({ok:true});
});

app.get('/api/state',(_req,res)=>res.json(buildState()));

app.get('/api/live-atbat/:gamePk',async(req,res)=>{
  try{
    const feed=await mlbFetch(`/api/v1.1/game/${req.params.gamePk}/feed/live`,8_000);
    const cur=feed?.liveData?.plays?.currentPlay,ls=feed?.liveData?.linescore;
    if(!cur) return res.json({error:'No active play'});
    const pitches=(cur.playEvents??[]).filter(e=>e.isPitch).map((e,i)=>({
      num:i+1,type:e.details?.type?.code??'UN',typeName:e.details?.type?.description??'',
      speed:e.pitchData?.startSpeed??null,pX:e.pitchData?.coordinates?.pX??null,
      pZ:e.pitchData?.coordinates?.pZ??null,szTop:e.pitchData?.strikeZoneTop??3.5,
      szBot:e.pitchData?.strikeZoneBottom??1.5,desc:e.details?.description??'',
      isStrike:e.details?.isStrike??false,isBall:e.details?.isBall??false,inPlay:e.details?.isInPlay??false,
    }));
    res.json({
      batter:cur.matchup?.batter?.fullName??'',pitcher:cur.matchup?.pitcher?.fullName??'',
      batSide:cur.matchup?.batSide?.code??'R',pitSide:cur.matchup?.pitchHand?.code??'R',
      inning:`${ls?.inningHalf??'Top'} ${ls?.currentInning??''}`,
      outs:cur.count?.outs??0,count:{balls:cur.count?.balls??0,strikes:cur.count?.strikes??0},
      runners:{first:!!(ls?.offense?.first),second:!!(ls?.offense?.second),third:!!(ls?.offense?.third)},
      pitches,isComplete:cur.about?.isComplete??false,result:cur.result?.description??'',
    });
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── Scoreboard ────────────────────────────────────────────────────────────────
let scoreboardCache={ts:0,data:[]};

app.get('/api/scoreboard',async(req,res)=>{
  if(Date.now()-scoreboardCache.ts<14_000&&scoreboardCache.data.length)
    return res.json(scoreboardCache.data);
  try{
    const today=todayET();
    const sched=await mlbFetch(`/api/v1/schedule?sportId=1&date=${today}&hydrate=linescore`,15_000);
    const games=sched?.dates?.[0]?.games??[];
    const data=games.map(g=>{
      const ls=g.linescore??{};
      return{
        gamePk:g.gamePk,
        status:g.status?.abstractGameState,
        detailedState:g.status?.detailedState,
        startTime:g.gameDate,
        awayAbbr:g.teams?.away?.team?.abbreviation??'',
        awayScore:g.teams?.away?.score??0,
        homeAbbr:g.teams?.home?.team?.abbreviation??'',
        homeScore:g.teams?.home?.score??0,
        inning:ls.currentInning??null,
        inningHalf:ls.inningHalf??'',
        outs:ls.outs??0,
        balls:ls.balls??0,
        strikes:ls.strikes??0,
        runners:{
          first:!!(ls.offense?.first),
          second:!!(ls.offense?.second),
          third:!!(ls.offense?.third),
        },
      };
    });
    scoreboardCache={ts:Date.now(),data};
    res.json(data);
  }catch(e){
    if(scoreboardCache.data.length) return res.json(scoreboardCache.data);
    res.status(500).json({error:e.message});
  }
});

app.get('/api/debug/:gamePk',async(req,res)=>{
  try{
    const pbp=await mlbFetch(`/api/v1/game/${req.params.gamePk}/playByPlay`);
    const plays=(pbp?.allPlays??[]).slice(-5);
    res.json({
      mapped:Object.fromEntries(tracker.playerGameMap),
      lastFivePlays:plays.map(p=>({
        atBatIndex:p.about?.atBatIndex,isComplete:p.about?.isComplete,
        eventType:p.result?.eventType,batterId:p.matchup?.batter?.id,
        batterName:p.matchup?.batter?.fullName,pitcherId:p.matchup?.pitcher?.id,
        pitcherName:p.matchup?.pitcher?.fullName,
      })),
    });
  }catch(e){res.status(500).json({error:e.message});}
});

let polling=false;
async function runPoll(){
  if(polling){setTimeout(runPoll,POLL_MS);return;}
  polling=true;
  try{
    const players=getTrackedPlayers();
    const{newEvents}=await tracker.poll(players);
    broadcast('state',buildState());
    for(const evt of newEvents)
      broadcast('toast',{playerName:evt.playerName,label:evt.label,type:evt.type,
        inning:evt.inning,gameLabel:evt.gameLabel,role:evt.role,desc:evt.desc});
  }catch(e){console.error('[Poll]',e);}
  finally{polling=false;setTimeout(runPoll,POLL_MS);}
}

app.listen(PORT,'127.0.0.1',()=>{
  console.log('\n  ⚾  MLB Fantasy Tracker v4\n  →  http://localhost:'+PORT+'\n');
  const url=`http://localhost:${PORT}`;
  const cmd=process.platform==='win32'?`start "" "${url}"`:process.platform==='darwin'?`open "${url}"`:` xdg-open "${url}"`;
  exec(cmd,err=>{if(err)console.log('  Open:',url);});
  ensurePlayerDB().then(()=>setTimeout(runPoll,1500));
});