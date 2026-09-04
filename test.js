// Run: node test.js — extracts the CORE block from index.html and tests it in isolation.
const fs = require('fs'), assert = require('assert'), path = require('path');
// the game lives in index.html so GitHub Pages can serve it directly
const GAME = process.env.WARBLOCK_FILE || 'index.html';
const html = fs.readFileSync(path.join(__dirname, GAME), 'utf8');
const core = html.slice(html.indexOf('/*CORE-START*/'), html.indexOf('/*CORE-END*/'));
const mod = { exports: {} }; new Function('module', 'exports', core)(mod, mod.exports); const C = mod.exports;
let passed = 0;
const eff = b => b.attack.n * (b.attack.dmgFar ? (b.attack.dmg+b.attack.dmgFar)/2 : b.attack.dmg); // hex: mean over range
function test(name, fn){ try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n    ', e.message); process.exitCode = 1; } }

console.log('Economy');
test('four tables: $0.50 / $1 / $5 / $10', () => assert.deepStrictEqual(C.TIERS.map(t=>t.stake), [0.5,1,5,10]));
test('the house keeps 20% of every payout', () => { assert.strictEqual(C.RAKE, 0.20); for (const t of C.TIERS){ const p = C.payout(t.stake, C.PLAYERS, C.RAKE); assert.strictEqual(p.pot, t.stake*20); assert.strictEqual(p.rake, Math.round(p.pot*0.2)); assert.strictEqual(p.winner, p.pot - p.rake); } });
test('rake comes off the winner, not the pot', () => { const p = C.payout(100, 20, 0.05); assert.deepStrictEqual(p, {pot:2000, rake:100, winner:1900}); });
test('tierFor resolves stakes and rejects unknown ones', () => { assert.strictEqual(C.tierFor(10).label, 'SHARK'); assert.strictEqual(C.tierFor(0.5).label, 'STREET'); assert.strictEqual(C.tierFor(7), null); });
test('bot aim quality rises with the table, and every table still misses a lot', () => { for (let i=1;i<C.TIERS.length;i++) assert.ok(C.TIERS[i].acc > C.TIERS[i-1].acc); for (const t of C.TIERS) assert.ok(C.botAimError(t.acc) > 0.05); });

console.log('Modes');
test('three modes: solo 20×1, duo 10×2, trio 10×3', () => {
  const M = C.MODES; assert.deepStrictEqual([M.solo.teams,M.solo.teamSize],[20,1]); assert.deepStrictEqual([M.duo.teams,M.duo.teamSize],[10,2]); assert.deepStrictEqual([M.trio.teams,M.trio.teamSize],[10,3]);
});
test('team pot = players × stake, and the after-rake winnings still split evenly', () => {
  for (const m of Object.values(C.MODES)) for (const t of C.TIERS){ const p = C.teamPayout(t.stake, m, C.RAKE);
    assert.strictEqual(p.pot, t.stake*m.teams*m.teamSize);
    assert.strictEqual(p.rake, Math.round(p.pot*C.RAKE), `${m.id} ${t.stake}`);
    assert.strictEqual(p.split*m.teamSize, p.winner, `${m.id} ${t.stake} leaves a remainder`); }
});
test('solo split equals the whole after-rake pot', () => { const p = C.teamPayout(100, C.MODES.solo, C.RAKE); assert.strictEqual(p.split, p.winner); assert.strictEqual(p.winner, 1600); });
test('respawn delay is short enough to stay in the fight', () => assert.ok(C.RESPAWN>=5 && C.RESPAWN<=15));

console.log('Resurgence');
test('two games: MAXWIN (solo/duo/trio) and RESURGENCE (solo/duo)', () => {
  assert.deepStrictEqual(Object.keys(C.GAMES), ['maxwin','resurgence']);
  assert.deepStrictEqual(C.GAMES.maxwin.modes, ['solo','duo','trio']);
  assert.deepStrictEqual(C.GAMES.resurgence.modes, ['resurgence','resurgenceDuo']);
  assert.strictEqual(C.GAMES.resurgence.theme, 'red'); assert.strictEqual(C.GAMES.maxwin.theme, 'blue');
});
test('both resurgence modes field 50 brawlers, cash-out on, faster pace, more boxes', () => {
  for (const id of C.GAMES.resurgence.modes){ const m = C.MODES[id];
    assert.strictEqual(m.teams*m.teamSize, 50, id); assert.strictEqual(m.cashout, true, id); assert.strictEqual(m.fast, true, id); assert.ok(m.boxes > C.BOXES, id); }
  assert.strictEqual(C.MODES.resurgence.teamSize, 1); assert.strictEqual(C.MODES.resurgenceDuo.teamSize, 2);
  assert.strictEqual(C.MODES.resurgenceDuo.teams, 25);
});
test('no maxwin mode has cash-out, and no resurgence mode is winner-takes-all', () => {
  for (const id of C.GAMES.maxwin.modes) assert.ok(!C.MODES[id].cashout, id);
  for (const id of C.GAMES.resurgence.modes) assert.ok(C.MODES[id].cashout, id);
});
test('gameOf routes every mode to the right game', () => { for (const id of C.GAMES.maxwin.modes) assert.strictEqual(C.gameOf(C.MODES[id]).id, 'maxwin'); assert.strictEqual(C.gameOf(C.MODES.resurgence).id, 'resurgence'); });
test('a kill transfers the victim\'s whole bucket, nothing is lost', () => {
  assert.strictEqual(C.bucketAfterKill(5, 45), 50); assert.strictEqual(C.bucketAfterKill(0, 0), 0);
  const stake = 5, mine = stake, theirs = stake + 120; assert.strictEqual(C.bucketAfterKill(mine, theirs), mine + theirs);
});
test('cash-out unlocks only when the 10s lock has fully run down', () => {
  assert.strictEqual(C.CASHOUT.lock, 10);
  assert.strictEqual(C.cashoutReady(C.CASHOUT.lock), false); assert.strictEqual(C.cashoutReady(0.4), false);
  assert.strictEqual(C.cashoutReady(0), true); assert.strictEqual(C.cashoutReady(-0.1), true);
});
test('resurgence pot is every stake on the table, less the house cut', () => { const p = C.teamPayout(100, C.MODES.resurgence, C.RAKE); assert.strictEqual(p.pot, 100*50); assert.strictEqual(p.winner, 4000); });

console.log('House cut on cash-outs');
test('every cash-out is taxed 20%, kills or not', () => {
  const a = C.cashoutPayout(500), b = C.cashoutPayout(500);
  assert.strictEqual(a.fee, 100); assert.strictEqual(a.net, 400); assert.deepStrictEqual(a, b);
});
test('the cash-out cut matches the pot rake exactly', () => { const b = 1000; assert.strictEqual(C.cashoutPayout(b).fee, Math.round(b*C.RAKE)); });
test('gross always equals fee + net, fee never exceeds the bucket', () => {
  for (const b of [0,1,5,7,50,99,1000,12345]){ const co = C.cashoutPayout(b); assert.strictEqual(co.fee+co.net, co.gross, String(b)); assert.ok(co.fee>=0 && co.fee<=co.gross); assert.ok(co.net>=0); } });
test('banking a single $5 stake returns $4', () => { const co = C.cashoutPayout(5); assert.strictEqual(co.fee, 1); assert.strictEqual(co.net, 4); });

console.log('Simulated population');
test('online count follows a day/night curve peaking in the evening', () => {
  const at = h => C.onlineTotal(new Date(2026,7,26,h,0,0));
  assert.ok(at(21) > at(9)*2, 'evening should dwarf the morning lull');
  assert.ok(at(4) < at(20), 'night quieter than prime time');
  assert.ok(at(9) > 0);
});
test('weekends are busier than weekdays at the same hour', () => {
  assert.ok(C.onlineTotal(new Date(2026,7,29,21,0,0)) > C.onlineTotal(new Date(2026,7,26,21,0,0)));
});
test('the number never collapses to zero or spikes absurdly', () => {
  for (let d=0; d<7; d++) for (let h=0; h<24; h++){ const n = C.onlineTotal(new Date(2026,7,23+d,h,30,0));
    assert.ok(n >= 120, `floor breached at day ${d} hour ${h}: ${n}`);
    assert.ok(n < C.ONLINE.base*3, `spike at day ${d} hour ${h}: ${n}`); }
});
test('same minute gives the same number — no flicker between refreshes', () => {
  const d = new Date(2026,7,26,20,15,0), e = new Date(2026,7,26,20,15,59);
  assert.strictEqual(C.onlineTotal(d), C.onlineTotal(e));
});
test('queues split across games, modes and tables without exceeding the population', () => {
  const total = C.onlineTotal(new Date(2026,7,26,21,0,0));
  let sum = 0;
  for (const id of Object.keys(C.MODES)) for (const t of C.TIERS) sum += C.queueFor(total, id, t.stake);
  assert.ok(sum <= total*1.02, `queues (${sum}) exceed population (${total})`);
  assert.ok(C.queueFor(total,'solo',0.5) > C.queueFor(total,'solo',10), 'cheap tables should be busiest');
});
test('wait estimate shrinks as the queue deepens and is always sane', () => {
  assert.ok(C.waitEstimate(500,50) <= C.waitEstimate(10,50));
  for (const q of [1,5,50,5000]){ const w = C.waitEstimate(q,50); assert.ok(w>=2 && w<=45); }
});

console.log('Lives');
test('everyone gets several lives, and resurgence stays a sprint', () => {
  assert.strictEqual(C.LIVES, 3);
  for (const id of C.GAMES.maxwin.modes) assert.strictEqual(C.livesFor(C.MODES[id]), 3, id);
  for (const id of C.GAMES.resurgence.modes) assert.strictEqual(C.livesFor(C.MODES[id]), 2, id);
});
test('livesFor never returns zero, whatever it is handed', () => {
  for (const v of [undefined, null, {}, {lives:0}]) assert.ok(C.livesFor(v) >= 1, JSON.stringify(v));
});
test('a match now takes several eliminations per player to empty out', () => {
  const solo = C.MODES.solo;
  const deathsNeeded = solo.teams * solo.teamSize * C.livesFor(solo) - C.livesFor(solo);
  assert.strictEqual(deathsNeeded, 57, 'twenty players at three lives is a much longer match');
  assert.ok(deathsNeeded > solo.teams, 'must exceed one death per player, which was the old behaviour');
});
test('coming back grants a shield, but a short one', () => {
  assert.ok(C.RESPAWN_SHIELD >= 1 && C.RESPAWN_SHIELD <= 5);
  assert.ok(C.RESPAWN > 0 && C.RESPAWN <= 10, 'waiting to respawn must not feel like a punishment');
  assert.ok(C.RESPAWN_SHIELD < C.GRACE, 'a respawn shield must be shorter than the opening protection');
});

console.log('Waiting room');
test('the room waits up to 25s and drops 3s after it fills', () => {
  assert.strictEqual(C.LOBBY.wait, 25); assert.ok(C.LOBBY.dropIn > 0 && C.LOBBY.dropIn < C.LOBBY.wait);
});
test('you are always seated first and the room never oversells', () => {
  const seats = 20, rate = C.joinRate(500, seats);
  assert.strictEqual(C.seatsAt(0, seats, rate), 1);
  for (let t=0; t<=60; t+=0.5) { const n = C.seatsAt(t, seats, rate); assert.ok(n >= 1 && n <= seats, `t=${t}: ${n}`); }
  assert.strictEqual(C.seatsAt(999, seats, rate), seats);
});
test('seats only ever fill, never empty', () => {
  const seats = 50, rate = C.joinRate(200, seats); let prev = 0;
  for (let t=0; t<=40; t+=0.25){ const n = C.seatsAt(t, seats, rate); assert.ok(n >= prev); prev = n; }
});
test('a deep queue fills the room faster than a thin one', () => {
  const seats = 20;
  assert.ok(C.fillTime(seats, C.joinRate(5000, seats)) < C.fillTime(seats, C.joinRate(20, seats)));
});
test('fill time always lands between the floor and the 25s cap, on every table', () => {
  for (const total of [200, 6454, 26340]) for (const id of Object.keys(C.MODES)) for (const t of C.TIERS){
    const mo = C.MODES[id], seats = mo.teams*mo.teamSize;
    const ft = C.fillTime(seats, C.joinRate(C.queueFor(total, id, t.stake), seats));
    assert.ok(ft >= C.LOBBY.minFill && ft <= C.LOBBY.wait, `${id} $${t.stake} @${total}: ${ft}`);
  }
});
test('the pot shown in the room tracks the seats actually taken', () => {
  const stake = 100;
  assert.strictEqual(C.payout(stake, 1, C.RAKE).pot, 100);
  assert.strictEqual(C.payout(stake, 20, C.RAKE).pot, 2000);
  assert.ok(C.payout(stake, 20, C.RAKE).winner > C.payout(stake, 10, C.RAKE).winner);
});

console.log('Live wins ticker');
test('every advertised win is an amount the payout maths can actually produce', () => {
  const rng = C.makeRng(3);
  for (let i=0;i<400;i++){ const e = C.makeWinEvent(rng);
    assert.ok(C.MODES[e.modeId], 'unknown mode'); assert.ok(C.tierFor(e.stake), 'unknown table');
    if (e.cashout){ // a banked bucket: own stake + the stakes taken from `kills` victims, less the cut
      assert.strictEqual(e.amount, C.cashoutPayout(e.stake*(1+e.kills)).net, JSON.stringify(e));
    } else {         // a share of the pot for that mode and table
      assert.strictEqual(e.amount, C.teamPayout(e.stake, C.MODES[e.modeId], C.RAKE).split, JSON.stringify(e));
    }
  }
});
test('no advertised win can exceed the whole table', () => {
  const rng = C.makeRng(11);
  for (let i=0;i<400;i++){ const e = C.makeWinEvent(rng); const mode = C.MODES[e.modeId];
    assert.ok(e.amount <= C.teamPayout(e.stake, mode, C.RAKE).pot, `${e.amount} > pot`);
    assert.ok(e.amount > 0 && e.kills >= 1); }
});
test('the mode is always named, and names the game it belongs to', () => {
  assert.strictEqual(C.modeLabel('solo'), 'MAXWIN SOLO');
  assert.strictEqual(C.modeLabel('trio'), 'MAXWIN TRIO');
  assert.strictEqual(C.modeLabel('resurgence'), 'RESURGENCE SOLO');
  assert.strictEqual(C.modeLabel('resurgenceDuo'), 'RESURGENCE DUO');
  for (const id of Object.keys(C.MODES)) assert.ok(/^(MAXWIN|RESURGENCE) /.test(C.modeLabel(id)), id);
});
test('the ticker shows both games and all four tables over time', () => {
  const rng = C.makeRng(5), games = new Set(), tables = new Set();
  for (let i=0;i<300;i++){ const e = C.makeWinEvent(rng); games.add(e.cashout?'res':'max'); tables.add(e.stake); }
  assert.strictEqual(games.size, 2); assert.strictEqual(tables.size, 4);
});
test('cheap tables appear far more often than the $1000 one', () => {
  const rng = C.makeRng(9); let cheap = 0, rich = 0;
  for (let i=0;i<2000;i++){ const e = C.makeWinEvent(rng); if (e.stake===5) cheap++; if (e.stake===1000) rich++; }
  assert.ok(cheap > rich*4, `${cheap} vs ${rich}`);
});
test('pickWeighted respects its weights and always returns a real key', () => {
  const rng = C.makeRng(2), counts = {a:0,b:0};
  for (let i=0;i<5000;i++) counts[C.pickWeighted({a:0.8,b:0.2}, rng)]++;
  assert.ok(counts.a > counts.b*2); assert.strictEqual(counts.a+counts.b, 5000);
});

console.log('Graphics quality');
test('four tiers, ordered, each lighter than the next', () => {
  assert.deepStrictEqual(C.QUALITY.order, ['low','medium','high','ultra']);
  for (let i=1;i<C.QUALITY.order.length;i++){
    const a = C.preset(C.QUALITY.order[i-1]), b = C.preset(C.QUALITY.order[i]);
    assert.ok(b.leaves > a.leaves && b.gas > a.gas && b.dpr >= a.dpr, `${a.name} → ${b.name}`);
  }
});
test('the guess follows the hardware, weakest to strongest', () => {
  const rank = t => C.QUALITY.order.indexOf(t);
  assert.strictEqual(C.guessTier({cores:2, memory:2, dpr:2, touch:true}), 'low');
  assert.ok(rank(C.guessTier({cores:4, memory:4, dpr:2, touch:true})) <= rank('medium'));
  assert.ok(rank(C.guessTier({cores:6, memory:6, dpr:3, touch:true})) >= rank('high'));
  assert.strictEqual(C.guessTier({cores:8, memory:8, dpr:3, touch:true}), 'ultra');
  assert.strictEqual(C.guessTier({cores:8, memory:8, dpr:2, touch:false}), 'ultra');
});
test('a phone that reports nothing still gets a sharp start, not the worst tier', () => {
  // Safari exposes neither deviceMemory nor a meaningful core count
  const t = C.guessTier({cores:4, dpr:3, touch:true});
  assert.ok(C.QUALITY.order.indexOf(t) >= C.QUALITY.order.indexOf('medium'), `got ${t}`);
});
test('even the lowest tier stays sharp: no tier renders below 1.5x', () => {
  for (const t of C.QUALITY.order) assert.ok(C.preset(t).dpr >= 1.5, t);
});
test('a phone is never rated above a desktop with the same specs', () => {
  const rank = t => C.QUALITY.order.indexOf(t);
  let everLower = false;
  for (const cores of [2,4,6,8]) for (const memory of [2,4,6,8]) for (const dpr of [1,2,3]){
    const specs = {cores, memory, dpr};
    const phone = rank(C.guessTier({...specs, touch:true}));
    const desk  = rank(C.guessTier({...specs, touch:false}));
    assert.ok(phone <= desk, `phone outranked desktop at ${JSON.stringify(specs)}`);
    if (phone < desk) everLower = true;
  }
  assert.ok(everLower, 'the touch penalty must actually change the tier somewhere');
});
test('an unknown device gets a usable guess, never the extremes', () => {
  const t = C.guessTier({});
  assert.ok(C.QUALITY.order.includes(t));
  assert.notStrictEqual(t, 'ultra'); assert.notStrictEqual(t, 'low');
});
test('tiers move one step at a time and never past the ends', () => {
  assert.strictEqual(C.nextTier('ultra', 20), 'high');
  assert.strictEqual(C.nextTier('low', 10), 'low');
  assert.strictEqual(C.nextTier('ultra', 60), 'ultra');
  assert.strictEqual(C.nextTier('medium', 60), 'high');
});
test('a healthy frame rate never changes the tier', () => {
  for (const t of C.QUALITY.order) for (const fps of [50, 52, 55])
    assert.strictEqual(C.nextTier(t, fps), t, `${t} @ ${fps}fps should hold`);
});
test('the up and down thresholds cannot overlap into a flip-flop', () => {
  assert.ok(C.QUALITY.up > C.QUALITY.down + 5, 'needs a dead band between stepping down and back up');
});

console.log('Music');
test('tension starts near zero at the drop and peaks at the last duel', () => {
  assert.ok(C.tension(20,20,0,4) < 0.05, 'a full lobby should be calm');
  assert.ok(C.tension(2,20,4,4) > 0.9, 'the final duel should be at full tilt');
});
test('tension only ever rises as players die and the gas closes', () => {
  let prev = -1;
  for (let alive=20; alive>=2; alive--){ const t = C.tension(alive,20,0,4); assert.ok(t >= prev, `alive ${alive}`); prev = t; }
  prev = -1;
  for (let ph=0; ph<=4; ph++){ const t = C.tension(10,20,ph,4); assert.ok(t >= prev, `phase ${ph}`); prev = t; }
});
test('tension stays inside 0..1 for every possible match state', () => {
  for (const total of [1,2,20,30,50]) for (let alive=1; alive<=total; alive++) for (let ph=0; ph<=6; ph++){
    const t = C.tension(alive,total,ph,4);
    assert.ok(t >= 0 && t <= 1, `alive ${alive}/${total} phase ${ph} → ${t}`);
  }
});
test('the beat speeds up with tension and never runs away', () => {
  assert.strictEqual(C.beatTime(0), C.MUSIC.beatSlow);
  assert.strictEqual(C.beatTime(1), C.MUSIC.beatFast);
  assert.ok(C.MUSIC.beatFast < C.MUSIC.beatSlow, 'more tension must mean a faster pulse');
  for (const v of [-5, 0.5, 7, NaN]) { const b = C.beatTime(v); if (!Number.isNaN(v)) assert.ok(b >= C.MUSIC.beatFast && b <= C.MUSIC.beatSlow, String(v)); }
});
test('the extra layers come in late, not straight away', () => {
  assert.ok(C.MUSIC.layer2 > 0.2 && C.MUSIC.layer3 > C.MUSIC.layer2);
  assert.ok(C.tension(20,20,0,4) < C.MUSIC.layer2, 'the drop must be a single bare pulse');
});

console.log('Profile name');
test('a name is trimmed, collapsed and capped', () => {
  assert.strictEqual(C.sanitizeName('  Loic   the   Great  '), 'Loic the Great'.slice(0, C.NAME.max));
  assert.strictEqual(C.sanitizeName('x'.repeat(80)).length, C.NAME.max);
  assert.strictEqual(C.sanitizeName('Néo_99'), 'Néo_99', 'accents and underscores are fine');
  assert.strictEqual(C.sanitizeName('日本語'), '日本語', 'any script is allowed');
});
test('control characters and markup cannot survive a name', () => {
  assert.strictEqual(C.sanitizeName('<b>hax</b>'), 'bhaxb');
  assert.strictEqual(C.sanitizeName('a\u0000\u001f\u007fb'), 'ab');
  assert.ok(!/[<>&"'`]/.test(C.sanitizeName('a<>&"\'`b')));
});
test('non-strings and empties are rejected rather than crashing', () => {
  for (const v of [null, undefined, 42, {}, [], '', '   ']) assert.strictEqual(C.sanitizeName(v), '');
});
test('a name must be long enough to identify anyone', () => {
  assert.ok(!C.validName('a'));
  assert.ok(!C.validName('  '));
  assert.ok(C.validName('ab'));
  assert.strictEqual(C.NAME.min, 2);
});
test('nameOr always yields something displayable', () => {
  assert.strictEqual(C.nameOr('', 'Ghost'), 'Ghost');
  assert.strictEqual(C.nameOr('!!!', 'Ghost'), 'Ghost', 'a name of only stripped characters falls back');
  assert.strictEqual(C.nameOr(null), C.NAME.fallback);
  assert.strictEqual(C.nameOr('Loic'), 'Loic');
});

console.log('Avatars');
test('every brawler contributes two faces, twenty picks in all', () => {
  const ids = Object.keys(C.BRAWLERS);
  const list = C.avatarList(ids);
  assert.strictEqual(list.length, ids.length*2);
  assert.strictEqual(list.length, 20);
  for (const id of ids) assert.strictEqual(list.filter(a=>a.brawler===id).length, 2, id);
});
test('avatar ids are unique and every emote is a known one', () => {
  const list = C.avatarList(Object.keys(C.BRAWLERS));
  assert.strictEqual(new Set(list.map(a=>a.id)).size, list.length, 'duplicate ids would break selection');
  for (const a of list) assert.ok(C.EMOTES.includes(a.emote), a.emote);
});
test('each brawler keeps its own straight face plus a second expression', () => {
  for (const a of C.avatarList(Object.keys(C.BRAWLERS))) {
    const mine = C.avatarList(Object.keys(C.BRAWLERS)).filter(x=>x.brawler===a.brawler);
    assert.ok(mine.some(x=>x.emote==='calm'), a.brawler+' has no neutral face');
    assert.ok(mine.some(x=>x.emote!=='calm'), a.brawler+' has no second expression');
  }
});
test('the list follows the roster: add a brawler and it gains two faces', () => {
  assert.strictEqual(C.avatarList(['bolt']).length, 2);
  assert.strictEqual(C.avatarList(['bolt','hex','ghost']).length, 6);
  assert.strictEqual(C.avatarList([]).length, 0);
});
test('an unknown avatar id is rejected so a bad save cannot blank the picture', () => {
  const list = C.avatarList(Object.keys(C.BRAWLERS));
  assert.ok(C.validAvatar(list[0].id, list));
  assert.ok(!C.validAvatar('nope', list));
  assert.ok(!C.validAvatar('', list));
  assert.ok(!C.validAvatar(undefined, list));
});

console.log('Emotes');
test('eight throwable faces, all real expressions, no neutral one', () => {
  assert.strictEqual(C.EMOTE_WHEEL.length, 8);
  for (const e of C.EMOTE_WHEEL) assert.ok(C.EMOTES.includes(e), e);
  assert.ok(!C.EMOTE_WHEEL.includes('calm'), 'a blank face taunts nobody');
  assert.strictEqual(new Set(C.EMOTE_WHEEL).size, 8, 'no duplicates on the wheel');
});
test('only wheel faces can be sent', () => {
  for (const e of C.EMOTE_WHEEL) assert.ok(C.validEmote(e));
  for (const bad of ['calm', 'nope', '', null, undefined, 42]) assert.ok(!C.validEmote(bad), String(bad));
});
test('a bubble shows long enough to be read, and cannot be spammed', () => {
  assert.ok(C.EMOTE.duration >= 1.5 && C.EMOTE.duration <= 5);
  assert.ok(C.EMOTE.cooldown > 0 && C.EMOTE.cooldown < C.EMOTE.duration, 'the cooldown must be shorter than the bubble, but never zero');
});
test('the wheel fits on the number row', () => {
  assert.ok(C.EMOTE_WHEEL.length <= 9, 'keys 1..9 must cover every slot');
});

console.log('Chat');
test('a message is trimmed, collapsed and capped so it cannot break the layout', () => {
  assert.strictEqual(C.sanitizeChat('  hello   world  '), 'hello world');
  assert.strictEqual(C.sanitizeChat('a'.repeat(500)).length, C.CHAT.maxLen);
  assert.strictEqual(C.sanitizeChat('line1\nline2\tend'), 'line1 line2 end');
  assert.strictEqual(C.sanitizeChat('\u0007bell'), 'bell');
});
test('anything that is not usable text comes back empty', () => {
  for (const v of [null, undefined, 42, {}, [], '', '   ', '\n\t ']) assert.strictEqual(C.sanitizeChat(v), '');
});
test('control characters are stripped, so no message can inject markup breaks', () => {
  const out = C.sanitizeChat('ok\u0000\u001f\u007fdone');
  assert.ok(!/[\u0000-\u001f\u007f]/.test(out), out);
});
test('every canned category returns a real line', () => {
  const rng = C.makeRng(5);
  for (const kind of Object.keys(C.CHAT.lines))
    for (let i=0;i<40;i++){ const l = C.botLine(kind, rng); assert.ok(typeof l === 'string' && l.length > 0 && l.length <= C.CHAT.maxLen, `${kind}: ${l}`); }
});
test('an unknown category falls back instead of returning nothing', () => {
  const l = C.botLine('does-not-exist', C.makeRng(1));
  assert.ok(C.CHAT.lines.idle.includes(l));
});
test('a chat line never throws, whatever it is handed for randomness', () => {
  // a call site once passed rng() instead of rng and killed the match loop mid-game
  for (const bad of [0.42, 0, 1, null, undefined, 'x', {}]){
    const l = C.botLine('kill', bad);
    assert.ok(C.CHAT.lines.kill.includes(l), `bad rng ${JSON.stringify(bad)} → ${l}`);
  }
});
test('quick phrases all fit the length cap', () => {
  assert.ok(C.CHAT.quick.length >= 6);
  for (const q of C.CHAT.quick) assert.strictEqual(C.sanitizeChat(q), q, q);
});
test('the log is bounded and bots have a speaking cooldown', () => {
  assert.ok(C.CHAT.maxLines >= 3 && C.CHAT.maxLines <= 10);
  assert.ok(C.CHAT.botCooldown > 0, 'without a cooldown, a fight would spam the log');
});
test('the chat window keeps a deeper backlog than the floating bubbles', () => {
  assert.strictEqual(C.CHAT.history, 20);
  assert.ok(C.CHAT.history > C.CHAT.maxLines, 'opening the window must reveal more than what floats on screen');
});

console.log('Brawlers');
test('ten brawlers, every role / colour / hat / super kind is distinct', () => { const bs = Object.values(C.BRAWLERS); assert.strictEqual(bs.length, 10); for (const k of ['role','color','hat']) assert.strictEqual(new Set(bs.map(b=>b[k])).size, 10, k); assert.ok(new Set(bs.map(b=>b.super.kind)).size >= 7, 'super kinds'); });
test('super kinds are all ones the engine implements', () => { const known = ['burst','slam','zone','heal','lob','stealth','dash','turret']; for (const b of Object.values(C.BRAWLERS)) assert.ok(known.includes(b.super.kind), b.id); });
test('special supers carry the parameters their kind needs', () => { const B = C.BRAWLERS; assert.ok(B.pyro.super.radius>0 && B.pyro.super.dps>0 && B.pyro.super.life>0); assert.ok(B.medic.super.amount>0 && B.medic.super.amount<=1); assert.ok(B.volt.super.aoe>0 && B.volt.attack.aoe>0 && B.volt.attack.kind==='lob'); assert.ok(B.ghost.super.duration>0); assert.ok(B.rush.super.dist>0 && B.rush.super.dmg>0); assert.ok(B.ward.super.hp>0 && B.ward.super.life>0 && B.ward.super.shot.dmg>0); });
test('every brawler has attack, super with a cost, ammo reload and speed', () => { for (const b of Object.values(C.BRAWLERS)){ assert.ok(b.attack.n>=1 && b.attack.dmg>0 && b.attack.range>0 && b.attack.speed>0); assert.ok(b.super.cost>0 && b.super.kind); assert.ok(b.ammoReload>0 && b.speed>0 && b.hp>0); } });
test('tank has the most hp, sniper the least; sniper the longest reach, melee the shortest; assassin the fastest', () => {
  const bs = Object.values(C.BRAWLERS); const byHp = [...bs].sort((a,b)=>b.hp-a.hp); const byRange = [...bs].sort((a,b)=>b.attack.range-a.attack.range); const bySpeed = [...bs].sort((a,b)=>b.speed-a.speed);
  assert.strictEqual(byHp[0].id, 'brick'); assert.strictEqual(byHp[byHp.length-1].id, 'hex'); assert.strictEqual(byRange[0].id, 'hex'); assert.strictEqual(byRange[byRange.length-1].id, 'rush'); assert.strictEqual(bySpeed[0].id, 'ghost');
});
test('full-hit attack damage is in a fair band (55–80) for every brawler at base', () => { for (const b of Object.values(C.BRAWLERS)){ const d = eff(b); assert.ok(d>=55 && d<=80, `${b.id}: ${d}`); } });
test('no brawler can be one-shot by a base attack, sniper max shot excluded', () => { for (const a of Object.values(C.BRAWLERS)) for (const t of Object.values(C.BRAWLERS)) assert.ok(a.attack.n*a.attack.dmg < t.hp, `${a.id} vs ${t.id}`); });
test('super charges from 3–4 full attacks', () => { for (const b of Object.values(C.BRAWLERS)){ const hits = b.super.cost/eff(b); assert.ok(hits>=2.5 && hits<=4.5, `${b.id}: ${hits.toFixed(1)}`); } });
test('hex damage ramps from close to far and caps at range', () => { const a = C.BRAWLERS.hex.attack; assert.strictEqual(C.hexDamage(a,0), a.dmg); assert.strictEqual(C.hexDamage(a,a.range), a.dmgFar); assert.strictEqual(C.hexDamage(a,a.range*3), a.dmgFar); assert.ok(C.hexDamage(a,a.range/2) > a.dmg && C.hexDamage(a,a.range/2) < a.dmgFar); });

console.log('Speed');
test('speed is derived from health and reach, never hand-written', () => {
  for (const b of Object.values(C.BRAWLERS)) assert.strictEqual(b.speed, C.derivedSpeed(b.hp, b.attack.range, b.agility), b.id);
});
test('bulkier brawlers are slower: speed correlates negatively with health', () => {
  const bs = Object.values(C.BRAWLERS);
  const mx = a => a.reduce((s,v)=>s+v,0)/a.length;
  const hp = bs.map(b=>b.hp), sp = bs.map(b=>b.speed), mh = mx(hp), ms = mx(sp);
  const cov = hp.reduce((s,h,i)=>s+(h-mh)*(sp[i]-ms),0);
  assert.ok(cov < 0, 'health and speed should move in opposite directions');
});
test('longer reach trends faster once health is accounted for', () => {
  // same health, more range → strictly faster
  assert.ok(C.derivedSpeed(110, 12, 0) > C.derivedSpeed(110, 5, 0));
  // same range, more health → strictly slower
  assert.ok(C.derivedSpeed(200, 8, 0) < C.derivedSpeed(90, 8, 0));
});
test('the heavy short-range brawlers are the two slowest', () => {
  const order = Object.values(C.BRAWLERS).sort((a,b)=>a.speed-b.speed).map(b=>b.id);
  assert.deepStrictEqual(order.slice(0,2), ['brick','rush']);
  assert.strictEqual(order[order.length-1], 'ghost');
});
test('no brawler dominates another on health, reach and speed at once', () => {
  // Every pick must give something up. Ghost may out-run Hex while being slightly tougher,
  // because Hex buys that back with nine extra blocks of reach — that is a trade, not dominance.
  for (const a of Object.values(C.BRAWLERS)) for (const b of Object.values(C.BRAWLERS)){
    if (a===b) continue;
    const dominates = a.hp >= b.hp && a.attack.range >= b.attack.range && a.speed >= b.speed
      && (a.hp > b.hp || a.attack.range > b.attack.range || a.speed > b.speed);
    assert.ok(!dominates, `${a.id} strictly dominates ${b.id}`);
  }
});
test('among equally fragile brawlers, the short-ranged one must be the faster', () => {
  const g = C.BRAWLERS.ghost, h = C.BRAWLERS.hex;
  assert.ok(g.attack.range < h.attack.range && g.speed > h.speed, 'the assassin has to close the gap');
});
test('the spread is wide enough to feel (over 2 units) and stays in bounds', () => {
  const sp = Object.values(C.BRAWLERS).map(b=>b.speed);
  assert.ok(Math.max(...sp)-Math.min(...sp) > 2, 'speeds too bunched to notice');
  for (const v of sp) assert.ok(v >= C.SPEED.min && v <= C.SPEED.max);
});

console.log('Power cubes');
test('each cube adds +10% hp and +10% damage, capped at 10', () => { const b = C.BRAWLERS.bolt; assert.strictEqual(C.maxHp(b,0), b.hp); assert.strictEqual(C.maxHp(b,5), Math.round(b.hp*1.5)); assert.strictEqual(C.maxHp(b,25), C.maxHp(b,10)); assert.ok(Math.abs(C.dmgMult(3)-1.3)<1e-9); assert.strictEqual(C.dmgMult(99), C.dmgMult(10)); });
test('a box breaks in at most two full attacks for every brawler', () => { for (const b of Object.values(C.BRAWLERS)) assert.ok(eff(b)*2 >= C.BOX_HP, b.id); });
test('bots drop their cubes on death (loot is transferable, like stakes)', () => assert.strictEqual(C.BOT.dropCubesOnKill, true));

console.log('Map');
test('map is MAP×MAP with only floor / wall / bush / prop cells, deterministic per seed', () => { const a = C.generateMap(11), b = C.generateMap(11); assert.strictEqual(a.length, C.MAP*C.MAP); assert.deepStrictEqual(Array.from(a), Array.from(b)); for (const c of a) assert.ok(c===0||c===1||c===2||c===3); });
test('walls and props block, bushes never do', () => { assert.ok(C.BLOCKING(1)); assert.ok(C.BLOCKING(3)); assert.ok(!C.BLOCKING(0)); assert.ok(!C.BLOCKING(2)); });
test('props are sparse cover, never a maze', () => { for (const seed of [3,9,44]){ const m = C.generateMap(seed); let p=0; for (const c of m) if (c===3) p++; assert.ok(p/m.length > 0.002 && p/m.length < 0.04, `seed ${seed}: ${(p/m.length*100).toFixed(1)}%`); } });
test('every prop is dropped in the open, so none can seal a corridor', () => {
  const m = C.generateMap(21), N = C.MAP;
  for (let x=1;x<N-1;x++) for (let z=1;z<N-1;z++){ if (m[x*N+z]!==3) continue;
    // the four orthogonal neighbours were all open ground before the prop was placed
    let blocked = 0; for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) if (m[(x+dx)*N+(z+dz)]===1||m[(x+dx)*N+(z+dz)]===2) blocked++;
    assert.strictEqual(blocked, 0, `prop at ${x},${z} was placed against cover`); }
});
test('border is walled', () => { const m = C.generateMap(3), N = C.MAP; for (let i=0;i<N;i++){ assert.strictEqual(m[i], 1); assert.strictEqual(m[i*N], 1); assert.strictEqual(m[(N-1)*N+i], 1); assert.strictEqual(m[i*N+N-1], 1); } });
test('spawn ring and centre are walkable', () => { const m = C.generateMap(5), N = C.MAP, cx=N/2, cz=N/2; for (let i=0;i<20;i++){ const a=i/20*Math.PI*2; const x=Math.floor(cx+Math.cos(a)*N*0.42), z=Math.floor(cz+Math.sin(a)*N*0.42); assert.notStrictEqual(m[x*N+z], 1, `spawn ${i}`); } assert.strictEqual(m[Math.floor(cx)*N+Math.floor(cz)], 0); });
test('map mixes cover: 8–30% walls, 5–30% bushes', () => { for (const seed of [1,2,3,4,5]){ const m = C.generateMap(seed); let w=0,b=0; for (const c of m){ if(c===1) w++; if(c===2) b++; } const n=m.length; assert.ok(w/n>0.08 && w/n<0.30, `walls ${(w/n).toFixed(2)} seed ${seed}`); assert.ok(b/n>0.05 && b/n<0.30, `bushes ${(b/n).toFixed(2)} seed ${seed}`); } });
test('every floor cell is reachable from the centre (no sealed pockets larger than noise)', () => {
  const m = C.generateMap(9), N = C.MAP; const seen = new Uint8Array(N*N); const q=[[N/2|0,N/2|0]]; seen[q[0][0]*N+q[0][1]]=1; let reach=0, floor=0;
  while(q.length){ const [x,z]=q.pop(); reach++; for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){ const nx=x+dx,nz=z+dz; if(nx<0||nz<0||nx>=N||nz>=N) continue; const i=nx*N+nz; if(!seen[i]&&m[i]!==1){ seen[i]=1; q.push([nx,nz]); } } }
  for (const c of m) if (c!==1) floor++; assert.ok(reach/floor > 0.97, `${(reach/floor*100).toFixed(1)}% reachable`);
});

console.log('Biomes');
test('one scene is live, the others stay defined and ready', () => {
  assert.strictEqual(C.BIOME_COUNT, 1);
  assert.strictEqual(C.BIOMES.length, 3);
  assert.strictEqual(C.BIOMES[0].name, 'FARM');
  assert.strictEqual(new Set(C.BIOMES.map(b=>b.wall)).size, 3, 'the spare scenes must stay distinct');
});
test('with one scene live, every cell belongs to it', () => {
  for (const seed of [1,42,777]){ const b = C.generateBiomes(seed);
    assert.strictEqual(b.length, C.MAP*C.MAP);
    for (const v of b) assert.strictEqual(v, 0, `seed ${seed} produced a second biome`); }
});
test('biome map is deterministic and covers every cell', () => {
  const a = C.generateBiomes(31), b = C.generateBiomes(31);
  assert.strictEqual(a.length, C.MAP*C.MAP); assert.deepStrictEqual(Array.from(a), Array.from(b));
  for (const v of a) assert.ok(v===0||v===1||v===2);
});
test('the single scene keeps a sane mix of cover and open ground', () => {
  for (const seed of [1,42,777,2024]){ const m = C.generateMap(seed);
    let wall=0, bush=0, prop=0, floor=0;
    for (const c of m){ if(c===1) wall++; else if(c===2) bush++; else if(c===3) prop++; else floor++; }
    const n = m.length;
    assert.ok(wall/n > 0.12 && wall/n < 0.30, `walls ${(wall/n*100).toFixed(0)}%`);
    assert.ok(bush/n > 0.05 && bush/n < 0.20, `bushes ${(bush/n*100).toFixed(0)}%`);
    assert.ok(floor/n > 0.55, `only ${(floor/n*100).toFixed(0)}% open ground`); }
});
test('biomes form large contiguous regions, not noise speckle', () => {
  const b = C.generateBiomes(7), N = C.MAP; let same = 0, total = 0;
  for (let x=1;x<N;x++) for (let z=1;z<N;z++){ total++; if (b[x*N+z]===b[(x-1)*N+z]) same++; }
  assert.ok(same/total > 0.97, `only ${(same/total*100).toFixed(1)}% of neighbours share a biome`);
});
test('the map is twice the old size and still fully connected', () => {
  assert.strictEqual(C.MAP, 152);
  const m = C.generateMap(9), N = C.MAP, seen = new Uint8Array(N*N), q = [[N>>1,N>>1]];
  seen[(N>>1)*N+(N>>1)] = 1; let reach = 0, floor = 0;
  while(q.length){ const [x,z]=q.pop(); reach++; for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){ const nx=x+dx,nz=z+dz; if(nx<0||nz<0||nx>=N||nz>=N) continue; const i=nx*N+nz; if(!seen[i]&&!C.BLOCKING(m[i])){ seen[i]=1; q.push([nx,nz]); } } }
  for (const c of m) if (!C.BLOCKING(c)) floor++;
  assert.ok(reach/floor > 0.97, `${(reach/floor*100).toFixed(1)}% reachable`);
});

console.log('Pacing');
test('spawn protection is short (Showdown-style)', () => assert.ok(C.GRACE>=5 && C.GRACE<=12));
test('out-of-combat healing is a real option: full hp in 15–20 s, and it starts quickly', () => {
  const full = C.HEAL.delay + 1/C.HEAL.rate;
  assert.ok(full>=15 && full<=20, `${full.toFixed(1)}s to full`);
  assert.ok(C.HEAL.delay <= 3.5, 'waiting too long to start makes retreating pointless');
});
test('a heart is worth several seconds of regeneration, not a whole bar', () => {
  const secondsSaved = C.HEART.heal / C.HEAL.rate;
  assert.ok(secondsSaved >= 3 && secondsSaved <= 8, `${secondsSaved.toFixed(1)}s saved`);
  assert.ok(C.HEART.heal < 1, 'a single heart must never fully heal you');
});
test('boxes give cubes more often than hearts', () => {
  assert.ok(C.HEART.boxChance > 0.15 && C.HEART.boxChance < 0.5, `${C.HEART.boxChance}`);
});
test('bots hesitate before their first shot and fire slower than a human', () => { assert.ok(C.BOT.reaction>=0.4); assert.ok(C.BOT.fireMult>1); });

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
