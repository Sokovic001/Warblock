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
test('the house keeps 20% of every payout', () => { assert.strictEqual(C.RAKE, 0.20); for (const t of C.TIERS){ const p = C.payout(t.stake, C.PLAYERS, C.RAKE); assert.strictEqual(p.pot, t.stake*20); assert.strictEqual(p.rake, C.cents(p.pot*0.2)); assert.strictEqual(p.winner, p.pot - p.rake); } });
test('rake comes off the winner, not the pot', () => { const p = C.payout(100, 20, 0.05); assert.deepStrictEqual(p, {pot:2000, rake:100, winner:1900}); });
test('payout still charges the house even when the caller forgets the rake', () => {
  // It used to fall back to 0% on a missing argument and hand over the gross pot. Every call
  // site happened to pass C.RAKE, so nothing showed — the next one to forget would not be so
  // lucky. An explicit 0 is still honoured, that is a caller saying what it means.
  assert.deepStrictEqual(C.payout(10, 20), C.payout(10, 20, C.RAKE));
  assert.strictEqual(C.payout(10, 20).rake, C.cents(200 * C.RAKE));
  assert.strictEqual(C.payout(10, 20, 0).rake, 0);
});
test('cents() keeps sub-dollar precision — rounding to the dollar would erase the rake', () => {
  // Every assertion below is a whole dollar away from what Math.round(v) returns, which is the
  // trap CLAUDE.md warns about: at $0.50 an integer rounding wipes the 20% out entirely.
  assert.strictEqual(C.cents(0.5), 0.5);
  assert.strictEqual(C.cents(0.4), 0.4);
  assert.strictEqual(C.cents(0.1), 0.1);
  assert.strictEqual(C.cents(0.005), 0.01);
  assert.strictEqual(C.cents(7.005), 7.01);
});
test('the house still takes its 20% on a sub-dollar cash out', () => {
  assert.deepStrictEqual(C.cashoutPayout(0.5), {gross:0.5, fee:0.1, net:0.4});
  assert.deepStrictEqual(C.cashoutPayout(1.5), {gross:1.5, fee:0.3, net:1.2});
  for (const g of [0.05, 0.15, 0.5, 1.5, 7.35]){ const p = C.cashoutPayout(g);
    assert.ok(p.fee > 0, `$${g} cashed out without paying any rake`);
    assert.strictEqual(C.cents(p.fee + p.net), C.cents(p.gross), `$${g} loses money in the split`); }
});
test('tierFor resolves stakes and rejects unknown ones', () => { assert.strictEqual(C.tierFor(10).label, 'SHARK'); assert.strictEqual(C.tierFor(0.5).label, 'STREET'); assert.strictEqual(C.tierFor(7), null); });
test('bot aim quality rises with the table, and every table still misses a lot', () => { for (let i=1;i<C.TIERS.length;i++) assert.ok(C.TIERS[i].acc > C.TIERS[i-1].acc); for (const t of C.TIERS) assert.ok(C.botAimError(t.acc) > 0.05); });

test('the prize is what you carry out: a clean sweep pays exactly what the flat pot used to', () => {
  // MAXWIN no longer hands the survivor a fixed pot. You leave with your own stake plus every
  // stake you took, less the house cut — so killing is the only way the number grows, and
  // winning by hiding pays your buy-in back minus the rake. The ceiling is unchanged: collect
  // all of them and you land on the old figure to the cent, which is what keeps the advertised
  // "up to" honest.
  for (const t of C.TIERS){
    const seats = C.MODES.solo.teams * C.MODES.solo.teamSize;
    const sweep = C.cashoutPayout(C.cents(t.stake * seats));
    const flat  = C.teamPayout(t.stake, C.MODES.solo, C.RAKE);
    assert.strictEqual(sweep.net, flat.winner, `$${t.stake}: sweep ${sweep.net} vs old pot ${flat.winner}`);
    const hid = C.cashoutPayout(t.stake);
    assert.strictEqual(hid.net, C.cents(t.stake * (1 - C.RAKE)), `$${t.stake} with no kills`);
    assert.ok(hid.net < sweep.net, 'hiding must never pay as well as hunting');
  }
});

console.log('Cover props');
test('a cell always yields the same prop, whoever generates the map', () => {
  // Derive des coordonnees et non de l'index dans la liste : deux joueurs sur la meme graine
  // doivent voir la meme carte, ce qui comptera le jour ou un serveur fera autorite.
  for (const [x,z] of [[0,0],[37,91],[151,151],[7,3]])
    assert.strictEqual(C.propKind(x,z), C.propKind(x,z), `${x},${z}`);
  assert.notStrictEqual(C.propKind(37,91), undefined);
  for (let x=0;x<40;x++) for (let z=0;z<40;z++){
    const k=C.propKind(x,z);
    assert.ok(Number.isInteger(k) && k>=0 && k<C.PROPS.farm.length, `${x},${z} -> ${k}`);
  }
});
test('all three props show up on a full map, in roughly equal shares', () => {
  const n=[0,0,0];
  for (let x=0;x<C.MAP;x++) for (let z=0;z<C.MAP;z++) n[C.propKind(x,z)]++;
  const total=n.reduce((a,b)=>a+b), tiers=total/3;
  n.forEach((v,i)=>{
    assert.ok(v>0, `${C.PROPS.farm[i].id} n'apparait jamais`);
    assert.ok(Math.abs(v-tiers)/tiers < 0.10, `${C.PROPS.farm[i].id}: ${(100*v/total).toFixed(1)}%`);
  });
});
test('no prop borrows the loot gold: it is reserved for what you pick up', () => {
  // La regle a tenir : l'or ne sert qu'a ce qui se ramasse. Les obstacles prenaient la couleur
  // d'accent du biome, 0xFFD23A pour FARM — exactement celle du sac de butin — et on les
  // confondait avec les caisses. Compare a la constante partagee, donc ce test casse si
  // quelqu'un reintroduit du dore dans un obstacle plus tard, y compris dans un autre biome.
  for (const [biome, trio] of Object.entries(C.PROPS))
    for (const prop of trio)
      for (const [role, teinte] of Object.entries(prop)){
        if (role==='id') continue;
        assert.notStrictEqual(teinte, C.LOOT_GOLD, `${biome}.${prop.id}.${role} reprend l'or du butin`);
      }
});

console.log('Critical hits');
const critSuite = (b, hits, now) => {   // enchaine des tirs et rend la liste des critiques
  const w = C.critWindow(b); let st=null, out=[];
  for (const [cible, t] of hits){ const r = C.critShot(st, cible, t===undefined?(now=(now||0)+0.5):t, w); st=r.state; out.push(r.crit); }
  return out;
};
test('the third consecutive hit on the same target crits, the first two do not', () => {
  const out = critSuite(C.BRAWLERS.bolt, [['a'],['a'],['a']]);
  assert.deepStrictEqual(out, [false,false,true]);
});
test('the counter restarts after a crit: the fourth shot is not one', () => {
  const out = critSuite(C.BRAWLERS.bolt, [['a'],['a'],['a'],['a']]);
  assert.deepStrictEqual(out, [false,false,true,false]);
  // et il faut de nouveau trois tirs pour en obtenir un second
  assert.deepStrictEqual(critSuite(C.BRAWLERS.bolt, [['a'],['a'],['a'],['a'],['a'],['a']]),
    [false,false,true,false,false,true]);
});
test('a missed shot drops the streak', () => {
  // null = le tir n'a touche personne
  assert.deepStrictEqual(critSuite(C.BRAWLERS.bolt, [['a'],['a'],[null],['a'],['a'],['a']]),
    [false,false,false,false,false,true]);
});
test('switching target drops the streak, and each target counts on its own', () => {
  assert.deepStrictEqual(critSuite(C.BRAWLERS.bolt, [['a'],['a'],['b']]), [false,false,false]);
  // deux tirs sur A puis trois sur B : c'est B qui crite, A n'a rien transmis
  assert.deepStrictEqual(critSuite(C.BRAWLERS.bolt, [['a'],['a'],['b'],['b'],['b']]),
    [false,false,false,false,true]);
});
test('letting the window lapse drops the streak', () => {
  const b = C.BRAWLERS.bolt, w = C.critWindow(b);
  assert.deepStrictEqual(critSuite(b, [['a',0],['a',1],['a',1+w+0.01]]), [false,false,false]);
  // pile sur la limite, la serie tient
  assert.deepStrictEqual(critSuite(b, [['a',0],['a',1],['a',1+w]]), [false,false,true]);
});
test('the window is the weapon reload plus two seconds, floored at three', () => {
  for (const b of Object.values(C.BRAWLERS))
    assert.strictEqual(C.critWindow(b), Math.max(C.CRIT.windowMin, b.ammoReload + C.CRIT.windowBase), b.id);
  assert.strictEqual(C.critWindow(C.BRAWLERS.rush), 3.1);
  assert.strictEqual(C.critWindow(C.BRAWLERS.hex), 4.1);
});
test('every brawler can reach a crit while firing dry: window beats its own reload', () => {
  // Sans ca, une arme lente ne pourrait jamais enchainer trois tirs dans la fenetre et le
  // critique lui serait interdit de fait.
  for (const b of Object.values(C.BRAWLERS))
    assert.ok(C.critWindow(b) > b.ammoReload, `${b.id}: fenetre ${C.critWindow(b)} <= recharge ${b.ammoReload}`);
});
test('a crit is never a first shot, so it can never one-shot anyone', () => {
  // Le critique est le TROISIEME tir : contre une cible qui meurt en deux, il est simplement
  // inatteignable. C'est le cas de toutes les cibles fragiles — RUSH critique a 105 depasserait
  // les 85 PV de HEX, mais HEX est deja mort au deuxieme tir, donc ce coup n'existe pas.
  for (const a of Object.values(C.BRAWLERS)) for (const t of Object.values(C.BRAWLERS)){
    if (eff(a)*2 >= t.hp) continue;                    // cible tombee avant le troisieme tir
    assert.ok(eff(a)*C.CRIT.mult < t.hp,
      `${a.id} critique ${Math.round(eff(a)*C.CRIT.mult)} tuerait ${t.id} (${t.hp} PV) d'un coup`);
  }
});

console.log('Pseudos : cle d\'unicite');
test('deux pseudos qui se lisent pareil partagent la meme cle', () => {
  const k = C.nameKey('Loic');
  for (const n of ['Loic','loic','LOIC','LoIc','Lo ic','lo_ic','l.o.i.c','lo-ic','  loic  '])
    assert.strictEqual(C.nameKey(n), k, n);
});
test('les accents sont replies, le nom affiche ne l\'est pas', () => {
  assert.strictEqual(C.nameKey('Loic'), C.nameKey('Lo\u00efc'));
  assert.strictEqual(C.nameKey('Rene'), C.nameKey('Ren\u00e9'));
  assert.strictEqual(C.nameKey('Ana'), C.nameKey('A\u00f1a'));
  // la cle sert d'index, pas d'affichage : sanitizeName rend toujours le nom tel qu'ecrit
  assert.strictEqual(C.sanitizeName('Lo\u00efc'), 'Lo\u00efc');
});
test('deux pseudos reellement differents gardent des cles differentes', () => {
  const noms = ['loic','loica','oic','lo1c','zoe','zoey'];
  const cles = noms.map(C.nameKey);
  assert.strictEqual(new Set(cles).size, noms.length, cles.join(' '));
});
test('la cle ne contient ni espace, ni majuscule, ni separateur', () => {
  for (const n of ['Jean-Pierre Ier','A_B.C D','  Zoe  ', 'Ren\u00e9 92'])
    assert.ok(/^[\p{Ll}\p{N}]*$/u.test(C.nameKey(n)), `${n} -> ${C.nameKey(n)}`);
});
test('replier une cle deja repliee ne la change plus', () => {
  for (const n of ['Lo\u00efc','Jean-Pierre','A B C'])
    assert.strictEqual(C.nameKey(C.nameKey(n)), C.nameKey(n), n);
});
test('une entree qui n\'est pas un pseudo rend une cle vide, jamais une erreur', () => {
  for (const junk of [undefined, null, 42, {}, [], '', '   ', '@@@@'])
    assert.strictEqual(C.nameKey(junk), '', String(junk));
});
test('un pseudo refuse par validName ne doit jamais etre indexe', () => {
  // la cle seule ne suffit pas a autoriser : le serveur valide d'abord, indexe ensuite
  assert.strictEqual(C.validName('a'), false);
  assert.ok(C.nameKey('a').length > 0, 'la cle existe pourtant, d\'ou la regle');
  assert.strictEqual(C.validName('Lo\u00efc'), true);
});

console.log('Modes');
test('three modes: solo 20×1, duo 10×2, trio 10×3', () => {
  const M = C.MODES; assert.deepStrictEqual([M.solo.teams,M.solo.teamSize],[20,1]); assert.deepStrictEqual([M.duo.teams,M.duo.teamSize],[10,2]); assert.deepStrictEqual([M.trio.teams,M.trio.teamSize],[10,3]);
});
test('team pot = players × stake, and the after-rake winnings still split evenly', () => {
  for (const m of Object.values(C.MODES)) for (const t of C.TIERS){ const p = C.teamPayout(t.stake, m, C.RAKE);
    assert.strictEqual(p.pot, t.stake*m.teams*m.teamSize);
    assert.strictEqual(p.rake, C.cents(p.pot*C.RAKE), `${m.id} ${t.stake}`);
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

console.log('Monnaie en centimes entiers');
test('toCents est le seul passage des dollars aux centimes, et refuse ce qui n\'est pas un montant', () => {
  assert.strictEqual(C.toCents(0.5), 50);
  assert.strictEqual(C.toCents(0.1), 10);
  assert.strictEqual(C.toCents(10), 1000);
  assert.strictEqual(C.toCents(0), 0);
  // Rendre zéro sur une saisie absurde reviendrait à payer zéro sans rien dire. On rend null.
  for (const v of [NaN, Infinity, -Infinity, '5', '', undefined, null, {}, [], true])
    assert.strictEqual(C.toCents(v), null, `${JSON.stringify(v)} n'est pas un montant`);
  for (const d of [0.005, 0.014, 1/3, 7.355, 1234.567])
    assert.ok(Number.isInteger(C.toCents(d)), `${d} doit rendre un entier, jamais un dollar déguisé`);
});
test('fromCents fait le retour, et la conversion tient dans les deux sens', () => {
  assert.strictEqual(C.fromCents(50), 0.5);
  assert.strictEqual(C.fromCents(1), 0.01);
  assert.strictEqual(C.fromCents(123456), 1234.56);
  for (const c of [0, 1, 7, 50, 99, 1000, 123456]) assert.strictEqual(C.toCents(C.fromCents(c)), c, String(c));
  assert.strictEqual(C.fromCents('50'), null);
});
test('sur 0..1 000 000 centimes : commission + net = brut, et les trois sont entiers', () => {
  // Un suffixe Cents sur un nom de variable n'attrape pas une fuite d'un centime. Une boucle si.
  for (let g = 0; g <= 1000000; g++){
    const co = C.cashoutCents(g);
    if (co.feeCents + co.netCents !== co.grossCents) assert.fail(`${g} : ${co.feeCents} + ${co.netCents} ≠ ${co.grossCents}`);
    if (!Number.isInteger(co.grossCents) || !Number.isInteger(co.feeCents) || !Number.isInteger(co.netCents)) assert.fail(`${g} rend un flottant`);
    if (g > 0 && co.feeCents <= 0) assert.fail(`${g} centimes encaissés sans commission`);
    if (co.feeCents > co.grossCents || co.netCents < 0) assert.fail(`${g} : la commission dépasse le brut`);
  }
});
test('la commission est strictement positive dès que le brut l\'est — 1, 2, 3 et 4 centimes', () => {
  // L'historique le dit : un arrondi a déjà effacé la commission sur la table à 0,50 $. En
  // dollars, cashoutPayout(0.01) rend encore {gross:0.01, fee:0, net:0.01} — 20 % de tout
  // paiement, sauf celui-là. L'arrondi vers le haut ferme la porte pour de bon.
  for (const g of [1, 2, 3, 4]){
    const co = C.cashoutCents(g);
    assert.strictEqual(co.feeCents, 1, `${g} centime(s) doivent laisser au moins un centime à la maison`);
    assert.strictEqual(co.netCents, g - 1, `${g} centime(s)`);
  }
  assert.strictEqual(C.cashoutCents(5).feeCents, 1);
  assert.strictEqual(C.cashoutCents(6).feeCents, 2);
  // Zéro reste zéro : la commission naît du paiement, pas du geste.
  assert.deepStrictEqual(C.cashoutCents(0), { grossCents: 0, feeCents: 0, netCents: 0 });
  assert.strictEqual(C.RAKE_NUM / C.RAKE_DEN, C.RAKE, 'le taux entier doit être le même taux');
});
test('couture : centimes entiers et dollars donnent le même centime, table par table', () => {
  // Toute sacoche atteignable est un multiple de la mise, de zéro à tous les sièges de la table.
  // Tant que ce test passe, les deux mondes ne peuvent pas diverger en silence pendant la phase.
  for (const m of Object.values(C.MODES)) for (const t of C.TIERS){
    const stakeCents = C.toCents(t.stake);
    for (let k = 0; k <= C.seatsOf(m); k++){
      const ent = C.cashoutCents(stakeCents * k), dol = C.cashoutPayout(C.cents(t.stake * k));
      const oú = `${m.id} $${t.stake} × ${k}`;
      assert.strictEqual(ent.grossCents, C.toCents(dol.gross), `${oú} : brut`);
      assert.strictEqual(ent.feeCents, C.toCents(dol.fee), `${oú} : commission`);
      assert.strictEqual(ent.netCents, C.toCents(dol.net), `${oú} : net`);
    }
  }
});
test('seatsOf nomme le calcul que teamPayout faisait à la volée', () => {
  for (const m of Object.values(C.MODES)) assert.strictEqual(C.seatsOf(m), C.teamPayout(1, m, C.RAKE).players, m.id);
  assert.strictEqual(C.seatsOf(C.MODES.solo), 20);
  assert.strictEqual(C.seatsOf(C.MODES.resurgence), 50);
});
test('payoutCents est d\'accord avec teamPayout, et le pot se partage sans reste', () => {
  for (const m of Object.values(C.MODES)) for (const t of C.TIERS){
    const p = C.payoutCents(C.toCents(t.stake), m), d = C.teamPayout(t.stake, m, C.RAKE);
    const oú = `${m.id} $${t.stake}`;
    assert.strictEqual(p.seats, d.players, `${oú} : sièges`);
    assert.strictEqual(p.potCents, C.toCents(d.pot), `${oú} : pot`);
    assert.strictEqual(p.feeCents, C.toCents(d.rake), `${oú} : commission`);
    assert.strictEqual(p.winnerCents, C.toCents(d.winner), `${oú} : gain`);
    assert.strictEqual(p.splitCents, C.toCents(d.split), `${oú} : part`);
    assert.strictEqual(p.splitCents * m.teamSize, p.winnerCents, `${oú} : le partage laisse un reste`);
    for (const v of [p.potCents, p.feeCents, p.winnerCents, p.splitCents]) assert.ok(Number.isInteger(v), `${oú} : ${v} n'est pas entier`);
  }
});
test('l\'argent se conserve à chaque transfert, et c\'est cela qui prouve purseBound', () => {
  // Modèle pur des quatre transferts du jeu, rejoués sans rien refactorer dedans : la sacoche naît
  // à la mise, passe entière au tueur, tombe au sol quand il n'y a personne à créditer, et
  // l'encaissement la remet à zéro. Si la somme tient à chaque étape, alors aucune sacoche ne peut
  // dépasser tout l'argent de la table — ce que purseBound se contente d'écrire.
  const mode = C.MODES.resurgence, seats = C.seatsOf(mode), stakeCents = C.toCents(0.5);
  const totalCents = stakeCents * seats, borne = C.purseBound(stakeCents, seats);
  assert.deepStrictEqual(borne, { minCents: 0, maxCents: totalCents });
  const ents = Array.from({ length: seats }, () => ({ pouchCents: stakeCents, alive: true }));
  let solCents = 0, encaisseCents = 0, maxVue = stakeCents;
  const verifie = quoi => {
    const vivantes = ents.reduce((a, e) => a + (e.alive ? e.pouchCents : 0), 0);
    assert.strictEqual(vivantes + solCents + encaisseCents, totalCents, `${quoi} : de l'argent apparaît ou disparaît`);
    for (const e of ents){
      assert.ok(e.pouchCents >= borne.minCents && e.pouchCents <= borne.maxCents, `${quoi} : sacoche hors borne (${e.pouchCents})`);
      if (e.pouchCents > maxVue) maxVue = e.pouchCents;
    }
  };
  verifie('mise');
  const rng = C.makeRng(7);
  for (let tour = 0; tour < 500; tour++){
    const vivants = ents.filter(e => e.alive);
    if (vivants.length < 2) break;
    const geste = rng(), i = Math.floor(rng() * vivants.length), victime = vivants[i];
    if (geste < 0.55){
      const tueur = vivants[(i + 1) % vivants.length];
      tueur.pouchCents += victime.pouchCents;          // bucketAfterKill : la sacoche passe entière
      victime.pouchCents = 0; victime.alive = false;
      verifie('kill');
    } else if (geste < 0.72){
      solCents += victime.pouchCents;                  // mort par le gaz : personne à créditer
      victime.pouchCents = 0; victime.alive = false;
      verifie('gaz');
    } else if (geste < 0.88){
      victime.pouchCents += solCents; solCents = 0;    // ramassage : zéro kill, et pourtant riche
      verifie('ramassage');
    } else {
      encaisseCents += victime.pouchCents;             // encaissement : brut, la commission comprise
      victime.pouchCents = 0; victime.alive = false;
      verifie('encaissement');
    }
  }
  // Sans cela le test passerait sur une partie où personne ne prend jamais rien à personne.
  assert.ok(maxVue > stakeCents, 'la simulation n\'a jamais fait grossir une sacoche');
});
test('garde textuelle : dans le bloc CORE, seuls toCents et fromCents changent d\'unité', () => {
  const suspectes = core.split('\n').map(l => l.trim()).filter(l => /[*\/]\s*100\b|\b100\s*[*\/]/.test(l));
  const autorisees = [
    'return Math.round(dollars * 100);',                  // toCents
    'return Math.round(cts) / 100;',                      // fromCents
    'const cents = v => Math.round(v*100)/100;',          // arrondit des dollars, ne change pas d'unité
    'const v = SPEED.base - (hp-SPEED.hpRef)/100',        // ce n'est pas de l'argent : c'est la vitesse
  ];
  for (const l of suspectes)
    assert.ok(autorisees.some(a => l.startsWith(a)), `conversion hors de toCents/fromCents : ${l}`);
  assert.ok(/best: fromCents\(entier\(s\.best\)\)/.test(core), 'applyAccount doit passer par fromCents, pas diviser par 100 à la main');
});

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
    // Both games pay the same way: own stake plus the stakes taken from `kills` victims, less
    // the house cut. MAXWIN used to advertise the flat pot whatever the kills, which meant the
    // ticker showed the same figure for a nineteen-kill run and for a win by hiding.
    assert.strictEqual(e.amount, C.cashoutPayout(e.stake*(1+e.kills)).net, JSON.stringify(e));
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
test('the ticker leans on the cheap tables, in the order the tables are priced', () => {
  // The old version counted e.stake===1000 — a table that does not exist, so `rich` was always
  // zero and the assertion collapsed to `cheap > 0`. Inverting TIER_SHARE left it green.
  const rng = C.makeRng(9), n = {};
  for (const t of C.TIERS) n[t.stake] = 0;
  for (let i=0;i<2000;i++) n[C.makeWinEvent(rng).stake]++;
  const stakes = C.TIERS.map(t=>t.stake);
  for (let i=1;i<stakes.length;i++)
    assert.ok(n[stakes[i-1]] > n[stakes[i]], `$${stakes[i-1]} (${n[stakes[i-1]]}) should out-appear $${stakes[i]} (${n[stakes[i]]})`);
  assert.ok(n[0.5] > n[10]*4, `$0.50 ${n[0.5]} vs $10 ${n[10]}`);
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
    assert.ok(b.leaves > a.leaves && b.gas > a.gas && b.smoke > a.smoke && b.dpr >= a.dpr, `${a.name} → ${b.name}`);
  }
});
test('even the lightest tier draws a smoke cloud you can read', () => {
  for (const t of C.QUALITY.order) assert.ok(C.preset(t).smoke >= 5, t);
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
  // Comparing b.speed back to derivedSpeed(...) can never fail: the loop in the CORE block has
  // already written exactly that value onto every brawler, so the assertion only restates it.
  // Re-run the core with that loop removed and inspect the literal itself, which is the one
  // place a hand-written speed can survive.
  const LOOP = 'for(const b of Object.values(BRAWLERS)) b.speed = derivedSpeed(b.hp, b.attack.range, b.agility);';
  assert.ok(core.includes(LOOP), 'the speed-derivation loop moved — update this test');
  const bare = { exports: {} }; new Function('module', 'exports', core.replace(LOOP, ''))(bare, bare.exports);
  for (const b of Object.values(bare.exports.BRAWLERS)) assert.strictEqual(b.speed, undefined, `${b.id} ships a hand-written speed`);
});
test('the derived speed table is pinned, so retuning SPEED cannot pass unnoticed', () => {
  // Without this, changing a SPEED constant silently moves every brawler and rewrites the
  // table published in docs/GAME-DESIGN.md while the suite stays green.
  const expected = { bolt:7.3, shell:6.7, brick:5.65, hex:7.5, pyro:6.45, medic:7, volt:7.35, ghost:8.1, rush:6.25, ward:6.8 };
  assert.deepStrictEqual(Object.keys(C.BRAWLERS).sort(), Object.keys(expected).sort());
  for (const [id, s] of Object.entries(expected)) assert.strictEqual(C.BRAWLERS[id].speed, s, id);
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
test('every fired spec declares a numeric stagger, so a bot cooldown can never be NaN', () => {
  // A bot arms its own cooldown with atk.stagger*atk.n. VOLT shipped with no stagger at all, so
  // that came out NaN — and NaN<=0 is false for ever. A VOLT bot fired once at first contact
  // then stood there facing you, never pulling the trigger again. The call sites that build
  // projectiles all wrote (stagger||0); the one in the bot loop did not.
  const specs=[];
  for (const b of Object.values(C.BRAWLERS)){
    specs.push([b.id+' attack', b.attack]);
    if (b.super && b.super.n !== undefined) specs.push([b.id+' super', b.super]);
  }
  for (const [what, sp] of specs){
    assert.strictEqual(typeof sp.stagger, 'number', `${what} declares no stagger`);
    assert.ok(Number.isFinite(sp.stagger*sp.n), `${what}: stagger*n is not a finite number`);
  }
});
test('a turret dies to one full ammo bar, whoever is shooting it', () => {
  // Not a balance nicety: a turret nobody can clear inside a reload owns the ground it sees for
  // its whole 15 seconds, and WARD wins the fight by placing it. Three ammo is the whole bar.
  const t = C.BRAWLERS.ward.super;
  assert.strictEqual(t.kind, 'turret');
  for (const b of Object.values(C.BRAWLERS))
    assert.ok(Math.ceil(t.hp/eff(b)) <= 3, `${b.id} needs ${Math.ceil(t.hp/eff(b))} full attacks for ${t.hp} hp`);
});
test('a box breaks in at most two full attacks for every brawler', () => { for (const b of Object.values(C.BRAWLERS)) assert.ok(eff(b)*2 >= C.BOX_HP, b.id); });
test('bots drop their cubes on death (loot is transferable, like stakes)', () => assert.strictEqual(C.BOT.dropCubesOnKill, true));

console.log('Map');
// Counts walkable cells the player can never stand on because nothing links them to the centre.
// Zero is the only acceptable answer: a percentage bar tolerated a sealed room and hid the bug.
const unreachable = seed => {
  const m = C.generateMap(seed), N = C.MAP, seen = new Uint8Array(N*N), start = (N>>1)*N+(N>>1);
  const q = [start]; seen[start] = 1;
  for (let qi=0; qi<q.length; qi++){ const cur=q[qi], x=(cur/N)|0, z=cur%N;
    for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){ const nx=x+dx, nz=z+dz;
      if (nx<0||nz<0||nx>=N||nz>=N) continue;
      const i=nx*N+nz; if (seen[i]||C.BLOCKING(m[i])) continue; seen[i]=1; q.push(i); } }
  let lost = 0; for (let i=0;i<m.length;i++) if (!C.BLOCKING(m[i]) && !seen[i]) lost++;
  return lost;
};
test('map is MAP×MAP with only floor / wall / bush / prop cells, deterministic per seed', () => { const a = C.generateMap(11), b = C.generateMap(11); assert.strictEqual(a.length, C.MAP*C.MAP); assert.deepStrictEqual(Array.from(a), Array.from(b)); for (const c of a) assert.ok(c===0||c===1||c===2||c===3); });
test('walls and props block, bushes never do', () => { assert.ok(C.BLOCKING(1)); assert.ok(C.BLOCKING(3)); assert.ok(!C.BLOCKING(0)); assert.ok(!C.BLOCKING(2)); });
test('props are sparse cover, never a maze', () => { for (const seed of [3,9,44]){ const m = C.generateMap(seed); let p=0; for (const c of m) if (c===3) p++; assert.ok(p/m.length > 0.002 && p/m.length < 0.04, `seed ${seed}: ${(p/m.length*100).toFixed(1)}%`); } });
test('no two props touch: every prop keeps open floor on all four sides', () => {
  // The old version read a single seed and counted a neighbour as blocking when it was a wall
  // or a bush — but bushes do not block and props (type 3) do, so it tested the wrong set and
  // could not see two props meeting. Careful: this restates the placement guard, it does NOT
  // prove a prop cannot seal a corridor. Four props on the diagonals of one cell still cage
  // it, and a single prop can still plug a one-cell gap; both happen on real seeds.
  for (const seed of [3, 9, 21, 44, 57, 186, 267]){
    const m = C.generateMap(seed), N = C.MAP;
    for (let x=1;x<N-1;x++) for (let z=1;z<N-1;z++){ if (m[x*N+z]!==3) continue;
      for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])
        assert.strictEqual(m[(x+dx)*N+(z+dz)], 0, `prop at ${x},${z} on seed ${seed} sits against cover`); }
  }
});
test('border is walled', () => { const m = C.generateMap(3), N = C.MAP; for (let i=0;i<N;i++){ assert.strictEqual(m[i], 1); assert.strictEqual(m[i*N], 1); assert.strictEqual(m[(N-1)*N+i], 1); assert.strictEqual(m[i*N+N-1], 1); } });
test('spawn ring and centre are walkable', () => { const m = C.generateMap(5), N = C.MAP, cx=N/2, cz=N/2; for (let i=0;i<20;i++){ const a=i/20*Math.PI*2; const x=Math.floor(cx+Math.cos(a)*N*0.42), z=Math.floor(cz+Math.sin(a)*N*0.42); assert.notStrictEqual(m[x*N+z], 1, `spawn ${i}`); } assert.strictEqual(m[Math.floor(cx)*N+Math.floor(cz)], 0); });
test('map mixes cover: 8–30% walls, 5–30% bushes', () => { for (const seed of [1,2,3,4,5]){ const m = C.generateMap(seed); let w=0,b=0; for (const c of m){ if(c===1) w++; if(c===2) b++; } const n=m.length; assert.ok(w/n>0.08 && w/n<0.30, `walls ${(w/n).toFixed(2)} seed ${seed}`); assert.ok(b/n>0.05 && b/n<0.30, `bushes ${(b/n).toFixed(2)} seed ${seed}`); } });
test('no cell is ever walled off, swept across seeds', () => {
  // The old version read seed 9 alone — 99.97%, comfortably over its 97% bar — while the real
  // seed is drawn at random every match. These four failed that bar outright: 186 at 96.72%,
  // 267 at 95.26% with a single sealed pocket of 877 cells, 1316 at 95.38%, 1354 at 96.87%.
  for (const seed of [186, 267, 1316, 1354]) assert.strictEqual(unreachable(seed), 0, `seed ${seed}`);
  for (let seed=0; seed<120; seed++) assert.strictEqual(unreachable(seed), 0, `seed ${seed}`);
});
test('a prop adds cover but never seals a cell off', () => {
  // Both were legal under the placement guard on its own: seed 2 caged (115,24) behind four
  // props sitting on its diagonals, seed 57 plugged a one-cell corridor at (87,26).
  for (const seed of [2, 57]) assert.strictEqual(unreachable(seed), 0, `seed ${seed}`);
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
  for (const seed of [9, 42, 777, 2024]) assert.strictEqual(unreachable(seed), 0, `seed ${seed}`);
});

console.log('Smoke grenade');
const cloud = (x, z, age) => ({ x, z, age: age === undefined ? C.SMOKE.bloom : age });
test('the gadget is switched on and every piece of it is exported', () => {
  assert.strictEqual(C.SMOKE_READY, true);
  for (const fn of ['smokeStart','smokeTick','canThrowSmoke','smokeThrown','smokeLanding','smokeRadius','segmentHitsDisc','smokeSightBlocked'])
    assert.strictEqual(typeof C[fn], 'function', fn);
});
test('a disc sitting on the line of fire is hit', () => {
  assert.strictEqual(C.segmentHitsDisc(0,0, 10,0, 5,0, 1), true);
  assert.strictEqual(C.segmentHitsDisc(0,0, 10,0, 5,0.9, 1), true);
  assert.strictEqual(C.segmentHitsDisc(0,0, 0,10, 0.5,5, 1), true);
});
test('a disc beside the line is not', () => {
  assert.strictEqual(C.segmentHitsDisc(0,0, 10,0, 5,1.1, 1), false);
  assert.strictEqual(C.segmentHitsDisc(0,0, 10,0, 5,-4, 1), false);
});
test('the segment ends where the shot ends: a disc behind you or past the target never blocks', () => {
  assert.strictEqual(C.segmentHitsDisc(0,0, 10,0, -4,0, 1), false, 'behind the shooter');
  assert.strictEqual(C.segmentHitsDisc(0,0, 10,0, 14,0, 1), false, 'past the target');
  // the same discs would both be hit if the maths used the infinite line instead
  assert.strictEqual(C.segmentHitsDisc(0,0, 10,0, -0.5,0, 1), true, 'just behind, still touching');
});
test('a disc that only grazes the line does not block it', () => {
  assert.strictEqual(C.segmentHitsDisc(0,0, 10,0, 5,1, 1), false, 'exactly tangent');
  assert.strictEqual(C.segmentHitsDisc(0,0, 10,0, 5,0.999, 1), true);
});
test('a cloud with no radius left blocks nothing', () => {
  for (const r of [0, -1, NaN, undefined]) assert.strictEqual(C.segmentHitsDisc(0,0, 10,0, 5,0, r), false, String(r));
});
test('sight is blocked the same way in both directions', () => {
  const cs = [cloud(5, 0.4)];
  assert.strictEqual(C.smokeSightBlocked(cs, 0,0, 10,0), C.smokeSightBlocked(cs, 10,0, 0,0));
  assert.strictEqual(C.smokeSightBlocked(cs, 0,0, 10,0), true);
});
test('a brawler standing on top of you is never hidden by smoke', () => {
  const cs = [cloud(0.5, 0)];
  assert.strictEqual(C.smokeSightBlocked(cs, 0,0, C.SMOKE.near*0.9,0), false);
  assert.strictEqual(C.smokeSightBlocked(cs, 0,0, C.SMOKE.near+0.5,0), true);
});
test('an expired cloud, an empty list and no list at all all leave sight clear', () => {
  assert.strictEqual(C.smokeSightBlocked([cloud(5,0,C.SMOKE.life)], 0,0, 10,0), false);
  assert.strictEqual(C.smokeSightBlocked([cloud(5,0,C.SMOKE.life+3)], 0,0, 10,0), false);
  assert.strictEqual(C.smokeSightBlocked([], 0,0, 10,0), false);
  assert.strictEqual(C.smokeSightBlocked(null, 0,0, 10,0), false);
});
test('any one cloud on the line is enough', () => {
  const cs = [cloud(30,30), cloud(5,0), cloud(-9,-9)];
  assert.strictEqual(C.smokeSightBlocked(cs, 0,0, 10,0), true);
  assert.strictEqual(C.smokeSightBlocked([cs[0], cs[2]], 0,0, 10,0), false);
});
test('the cloud blooms, stands at full size, then thins to nothing', () => {
  const S = C.SMOKE;
  assert.strictEqual(C.smokeRadius(0), 0);
  assert.strictEqual(C.smokeRadius(-1), 0);
  assert.strictEqual(C.smokeRadius(S.bloom), S.radius);
  assert.strictEqual(C.smokeRadius(S.life - S.fade), S.radius);
  assert.ok(C.smokeRadius(S.bloom/2) > 0 && C.smokeRadius(S.bloom/2) < S.radius, 'still growing');
  assert.ok(C.smokeRadius(S.life - S.fade/2) < S.radius, 'already thinning');
  assert.strictEqual(C.smokeRadius(S.life), 0);
  assert.strictEqual(C.smokeRadius(S.life + 10), 0);
});
test('the cloud never grows past its stated radius, and only ever grows then shrinks', () => {
  let peak = 0, falling = false;
  for (let t = 0; t <= C.SMOKE.life + 1; t += 0.05){
    const r = C.smokeRadius(t);
    assert.ok(r <= C.SMOKE.radius + 1e-9, `radius ${r} at ${t}s`);
    if (r + 1e-9 < peak) falling = true;
    else if (falling) assert.ok(r <= 1e-9, `grew again at ${t}s`);
    peak = Math.max(peak, r);
  }
  assert.strictEqual(peak, C.SMOKE.radius);
});
test('you start every life empty-handed: grenades are found, never issued', () => {
  const g = C.smokeStart();
  assert.deepStrictEqual(g, { charges: 0, cd: 0 });
  assert.strictEqual(C.canThrowSmoke(g), false, 'nothing to throw at the drop');
});
test('nothing about the pouch refills on its own', () => {
  let g = C.smokeStart();
  for (let i = 0; i < 6000; i++) g = C.smokeTick(g, 0.05);   // five minutes, a whole match
  assert.strictEqual(g.charges, 0, 'waiting must never hand you a grenade');
  assert.strictEqual(C.canThrowSmoke(g), false);
});
test('picking one up fills the pouch one grenade at a time, up to the cap', () => {
  let g = C.smokeStart();
  for (let i = 1; i <= C.SMOKE.charges; i++){
    assert.strictEqual(C.smokeRoom(g), true, `room for number ${i}`);
    g = C.smokePicked(g);
    assert.strictEqual(g.charges, i);
  }
  assert.strictEqual(C.smokeRoom(g), false, 'a full pouch takes no more');
  assert.strictEqual(C.smokePicked(g).charges, C.SMOKE.charges, 'and cannot be overfilled');
});
test('a pickup never clears the throw lock you are already serving', () => {
  const g = C.smokePicked({ charges: 0, cd: 2.5 });
  assert.strictEqual(g.charges, 1);
  assert.strictEqual(g.cd, 2.5);
  assert.strictEqual(C.canThrowSmoke(g), false);
});
test('throwing spends one charge and locks the button', () => {
  const g = C.smokeThrown(C.smokePicked(C.smokeStart()));
  assert.strictEqual(g.charges, 0);
  assert.strictEqual(g.cd, C.SMOKE.cooldown);
  assert.strictEqual(C.canThrowSmoke(g), false, 'still locked');
});
test('an empty pouch and a locked button both refuse the throw', () => {
  assert.strictEqual(C.canThrowSmoke({ charges: 0, cd: 0 }), false);
  assert.strictEqual(C.canThrowSmoke({ charges: 2, cd: 0.1 }), false);
  assert.strictEqual(C.canThrowSmoke(null), false);
  assert.strictEqual(C.canThrowSmoke(undefined), false);
});
test('the lock runs down to exactly zero and stops there', () => {
  let g = C.smokeThrown({ charges: 2, cd: 0 });
  for (let i = 0; i < 200; i++) g = C.smokeTick(g, 0.05);
  assert.strictEqual(g.cd, 0);
  assert.strictEqual(C.canThrowSmoke(g), true, 'usable again once the lock clears');
});
test('a pouch can never be talked into holding more than the cap', () => {
  for (const n of [3, 99, 2.7, -4, NaN, undefined])
    assert.ok(C.smokeTick({ charges: n, cd: 0 }, 0).charges <= C.SMOKE.charges, String(n));
  assert.strictEqual(C.smokeTick({ charges: -4, cd: 0 }, 0).charges, 0, 'nor less than nothing');
});
test('two crates, two throws, then you are out until you find another', () => {
  const S = C.SMOKE;
  let g = C.smokePicked(C.smokePicked(C.smokeStart()));      // two lucky crates
  g = C.smokeThrown(g);
  g = C.smokeTick(g, S.cooldown);
  assert.strictEqual(C.canThrowSmoke(g), true, 'the second one is ready');
  g = C.smokeThrown(g);
  assert.strictEqual(g.charges, 0);
  g = C.smokeTick(g, 600);
  assert.strictEqual(C.canThrowSmoke(g), false, 'and no amount of waiting brings one back');
});
test('the grenade lands where you aim, clamped to how far an arm can throw', () => {
  const S = C.SMOKE;
  assert.strictEqual(C.smokeLanding(0,0, 1,0, 5).x, 5);
  assert.strictEqual(C.smokeLanding(0,0, 1,0, 99).dist, S.range, 'clamped long');
  assert.strictEqual(C.smokeLanding(0,0, 1,0, undefined).dist, S.range, 'no distance given: full throw');
  assert.strictEqual(C.smokeLanding(0,0, 1,0, NaN).dist, S.range);
  assert.strictEqual(C.smokeLanding(0,0, 1,0, -3).dist, 0, 'a negative throw is a drop at your feet');
});
test('a throw of zero drops the grenade on your own feet', () => {
  const at = C.smokeLanding(11,7, 1,0, 0);
  assert.strictEqual(at.dist, 0);
  assert.deepStrictEqual([at.x, at.z], [11, 7], 'exactly where you stand, whichever way you face');
  assert.deepStrictEqual([C.smokeLanding(11,7, 0,-1, 0).x, C.smokeLanding(11,7, 0,-1, 0).z], [11, 7]);
});
test('the getaway works: a cloud dropped on you hides you from everyone at range', () => {
  const me = { x: 20, z: 20 };
  const at = C.smokeLanding(me.x, me.z, 1, 0, 0);
  const cloud = [{ x: at.x, z: at.z, age: C.SMOKE.bloom }];
  // whichever way an enemy stands off, the line into you crosses the cloud you are sitting in
  for (const a of [0, 0.7, 1.9, 3.0, 4.4, 5.8]) for (const d of [3, 6, 10, 14]) {
    const ex = me.x + Math.cos(a)*d, ez = me.z + Math.sin(a)*d;
    assert.strictEqual(C.smokeSightBlocked(cloud, ex, ez, me.x, me.z), true, `enemy at ${d} blocks, angle ${a}`);
  }
});
test('the getaway holds while you walk out, and ends once you are clear of the cloud', () => {
  const cloud = [{ x: 0, z: 0, age: C.SMOKE.bloom }];
  const enemy = { x: 0, z: -12 };                          // watching from the north
  // you leave due east. Inside the cloud, and for a while past its edge, the line still crosses it
  assert.strictEqual(C.smokeSightBlocked(cloud, enemy.x, enemy.z, 1, 0), true, 'one step out');
  assert.strictEqual(C.smokeSightBlocked(cloud, enemy.x, enemy.z, C.SMOKE.radius-0.2, 0), true, 'at the edge');
  assert.strictEqual(C.smokeSightBlocked(cloud, enemy.x, enemy.z, C.SMOKE.radius+2, 0), false, 'well clear: they see you again');
});
test('a self-drop covers you, a full throw does not — that is the whole choice', () => {
  assert.strictEqual(C.smokeCoversThrower(0), true);
  assert.strictEqual(C.smokeCoversThrower(C.SMOKE.radius - 0.01), true);
  assert.strictEqual(C.smokeCoversThrower(C.SMOKE.radius), false, 'standing exactly on the edge is not cover');
  assert.strictEqual(C.smokeCoversThrower(C.SMOKE.range), false, 'a full throw is a screen, not a getaway');
  assert.strictEqual(C.smokeCoversThrower(undefined), false, 'no distance means a throw at full range');
  assert.strictEqual(C.smokeCoversThrower(-5), true, 'a negative throw is still a drop on yourself');
});
test('landing and cover read the throw distance the same way', () => {
  for (const d of [0, -4, 1, C.SMOKE.radius, 5, 99, NaN, undefined, null, 'far'])
    assert.strictEqual(C.smokeLanding(0,0, 1,0, d).dist, C.smokeThrowDist(d), String(d));
  assert.strictEqual(C.smokeThrowDist('far'), C.SMOKE.range, 'anything that is not a number is a full throw');
  assert.strictEqual(C.smokeThrowDist(Infinity), C.SMOKE.range);
});
test('your own fresh cloud is one-way: you see them, they have lost you', () => {
  const mine = [{ x: 0, z: 0, age: C.SMOKE.bloom, team: 3 }];
  const me = [0, 0], them = [10, 0];
  assert.strictEqual(C.smokeSightBlocked(mine, me[0],me[1], them[0],them[1], 3), false, 'you look out');
  assert.strictEqual(C.smokeSightBlocked(mine, them[0],them[1], me[0],me[1], 7), true, 'they look in');
});
test('the window belongs to the team, not the thrower alone', () => {
  const cloud = [{ x: 0, z: 0, age: C.SMOKE.bloom, team: 3 }];
  assert.strictEqual(C.smokeSightBlocked(cloud, 0,0, 10,0, 3), false, 'a team-mate shares it');
  for (const other of [0, 2, 4, 19]) assert.strictEqual(C.smokeSightBlocked(cloud, 0,0, 10,0, other), true, `team ${other}`);
});
test('the window is counted from full size, and lasts exactly as long as it says', () => {
  const S = C.SMOKE, at = age => ({ x:0, z:0, age, team:1 });
  assert.strictEqual(C.smokeSeeThrough(at(0), 1), true, 'yours from the moment it lands');
  assert.strictEqual(C.smokeSeeThrough(at(S.bloom + S.oneWay - 0.01), 1), true, 'the last instant of it');
  assert.strictEqual(C.smokeSeeThrough(at(S.bloom + S.oneWay), 1), false, 'and then it is over');
  assert.strictEqual(C.smokeWindowLeft(at(S.bloom)), S.oneWay, 'a full window once it is up');
  assert.strictEqual(C.smokeWindowLeft(at(S.life)), 0);
  assert.strictEqual(C.smokeWindowLeft(null), 0);
});
test('once the window shuts, your own cloud blinds you like everyone else', () => {
  const S = C.SMOKE, old = [{ x: 0, z: 0, age: S.bloom + S.oneWay + 0.1, team: 3 }];
  assert.strictEqual(C.smokeSightBlocked(old, 0,0, 10,0, 3), true, 'no more free look');
  assert.strictEqual(C.smokeSightBlocked(old, 10,0, 0,0, 7), true, 'still hides you, both ways now');
});
test('the one-way advantage always ends well before the cloud does', () => {
  const S = C.SMOKE;
  assert.ok(S.oneWay > 0, 'without it the gadget is a blindfold you throw at yourself');
  assert.ok(S.bloom + S.oneWay < S.life - S.fade, 'every cloud must spend real time blinding both sides');
  assert.ok(S.charges * (S.bloom + S.oneWay) < 12, 'a full pouch must not add up to a lasting one-way wall');
});
test('no viewer given means the old symmetric rule, unchanged', () => {
  const cloud = [{ x: 5, z: 0, age: C.SMOKE.bloom, team: 3 }];
  for (const v of [undefined, null]) assert.strictEqual(C.smokeSightBlocked(cloud, 0,0, 10,0, v), true, String(v));
  assert.strictEqual(C.smokeSeeThrough(cloud[0], undefined), false);
  assert.strictEqual(C.smokeSeeThrough(null, 3), false);
});
test('team 0 is a real team, not a missing one', () => {
  const cloud = [{ x: 0, z: 0, age: C.SMOKE.bloom, team: 0 }];
  assert.strictEqual(C.smokeSightBlocked(cloud, 0,0, 10,0, 0), false, 'team 0 sees through its own smoke');
  assert.strictEqual(C.smokeSightBlocked(cloud, 0,0, 10,0, 1), true);
});
test('standing in your own cloud reads as hidden, with the window counting down', () => {
  const S = C.SMOKE, clouds = [{ x: 0, z: 0, age: S.bloom, team: 2 }];
  const inside = C.smokeCover(clouds, 1, 1, 2);
  assert.strictEqual(inside.hidden, true);
  assert.strictEqual(inside.window, S.oneWay);
  assert.strictEqual(inside.exposed, false);
  const outside = C.smokeCover(clouds, S.radius + 1, 0, 2);
  assert.deepStrictEqual(outside, { hidden: false, window: 0, exposed: false });
});
test('an expired cloud covers nobody, and a stale one covers without a window', () => {
  const S = C.SMOKE;
  assert.strictEqual(C.smokeCover([{ x:0, z:0, age:S.life, team:2 }], 0, 0, 2).hidden, false);
  const stale = C.smokeCover([{ x:0, z:0, age:S.bloom + S.oneWay + 0.5, team:2 }], 0, 0, 2);
  assert.strictEqual(stale.hidden, true);
  assert.strictEqual(stale.window, 0);
});
test('standing in an enemy fresh cloud is a trap, and says so', () => {
  const S = C.SMOKE, theirs = [{ x: 0, z: 0, age: S.bloom, team: 5 }];
  const cv = C.smokeCover(theirs, 0.5, 0, 2);
  assert.strictEqual(cv.exposed, true, 'they are watching you through it');
  assert.strictEqual(cv.window, 0, 'and you get no window of your own');
  // once their window shuts it is just smoke again, and it hides you like any other
  const after = C.smokeCover([{ x:0, z:0, age:S.bloom + S.oneWay + 0.5, team:5 }], 0.5, 0, 2);
  assert.strictEqual(after.exposed, false);
  assert.strictEqual(after.hidden, true);
});
test('the cover check tolerates an empty map and a missing list', () => {
  for (const c of [[], null, undefined]) assert.deepStrictEqual(C.smokeCover(c, 0, 0, 1), { hidden:false, window:0, exposed:false });
});
test('a self-drop still does not blind the brawler already on top of you', () => {
  const cloud = [{ x: 0, z: 0, age: C.SMOKE.bloom }];
  assert.strictEqual(C.smokeSightBlocked(cloud, C.SMOKE.near*0.5, 0, 0, 0), false, 'point blank sees through it');
  assert.strictEqual(C.smokeSightBlocked(cloud, C.SMOKE.near+0.3, 0, 0, 0), true, 'a step further and you are gone');
});
test('the aim vector does not have to be normalised', () => {
  const a = C.smokeLanding(3,4, 0,7, 5), b = C.smokeLanding(3,4, 0,1, 5);
  assert.ok(Math.abs(a.x-b.x) < 1e-9 && Math.abs(a.z-b.z) < 1e-9);
  assert.strictEqual(Math.round(Math.hypot(a.x-3, a.z-4)*1e9)/1e9, 5);
});
test('a tap drops it on you, a held key throws it where you aim', () => {
  const S = C.SMOKE;
  assert.strictEqual(C.smokeHoldAim(0), false, 'un appui instantane reste un lacher');
  assert.strictEqual(C.smokeHoldAim(S.tapMax - 0.001), false, 'juste sous le seuil');
  assert.strictEqual(C.smokeHoldAim(S.tapMax), true, 'pile au seuil, on vise');
  assert.strictEqual(C.smokeHoldAim(3), true);
  // un appui bref ignore la visee : la grenade tombe a ses pieds, quoi que pointe le curseur
  assert.strictEqual(C.smokeHoldDist(0.05, S.range), 0);
  assert.strictEqual(C.smokeHoldDist(0.05, 7), 0);
  // maintenu, elle part a la distance visee, bornee comme n'importe quel jet
  assert.strictEqual(C.smokeHoldDist(1, 6), 6);
  assert.strictEqual(C.smokeHoldDist(1, 99), S.range);
  assert.strictEqual(C.smokeHoldDist(1, -4), 0);
});
test('an unusable hold duration is read as a tap, never as a wild throw', () => {
  for (const junk of [undefined, null, NaN, Infinity, 'x'])
    assert.strictEqual(C.smokeHoldAim(junk), false, String(junk));
  assert.strictEqual(C.smokeHoldDist(undefined, C.SMOKE.range), 0);
});
test('the tap window is short enough to feel instant, long enough to be reachable', () => {
  assert.ok(C.SMOKE.tapMax >= 0.12 && C.SMOKE.tapMax <= 0.35, `${C.SMOKE.tapMax}s`);
  // et elle doit rester bien en dessous du vol, sinon viser couterait plus que le trajet
  assert.ok(C.SMOKE.tapMax < C.SMOKE.flight, 'viser ne doit pas couter plus que le vol lui-meme');
});
test('the throw out-ranges the cloud, so you can smoke a spot without standing in it', () => {
  assert.ok(C.SMOKE.range > C.SMOKE.radius * 1.5, 'a grenade you can only drop at your feet is not a gadget');
});
test('a crate leaves exactly one of three things, and the odds add up', () => {
  const D = C.BOX_DROP;
  assert.ok(D.smoke > 0 && D.heart > 0 && D.cube > 0, 'every drop must stay possible');
  // la part du cube est ecrite dans la table, pas deduite : si elle derive du reste, ce test casse
  assert.strictEqual(C.cents(D.smoke + D.heart + D.cube), 1, 'les trois tirages doivent faire 1');
  const seen = { smoke: 0, heart: 0, cube: 0 };
  for (let i = 0; i < 100000; i++){ const k = C.boxDrop(i / 100000); assert.ok(k in seen, k); seen[k]++; }
  assert.ok(Math.abs(seen.smoke/100000 - D.smoke) < 0.002, `smoke ${seen.smoke/1000}%`);
  assert.ok(Math.abs(seen.heart/100000 - D.heart) < 0.002, `heart ${seen.heart/1000}%`);
  assert.strictEqual(seen.smoke + seen.heart + seen.cube, 100000, 'every crate leaves something');
});
test('the drop table reads the edges of the roll the same way every time', () => {
  const D = C.BOX_DROP;
  assert.strictEqual(C.boxDrop(0), 'smoke');
  assert.strictEqual(C.boxDrop(D.smoke - 1e-9), 'smoke');
  assert.strictEqual(C.boxDrop(D.smoke), 'heart', 'the boundary belongs to the next slice');
  assert.strictEqual(C.boxDrop(D.smoke + D.heart), 'cube');
  assert.strictEqual(C.boxDrop(0.999999), 'cube');
  assert.strictEqual(C.boxDrop(() => 0.05), 'smoke', 'a generator works as well as a number');
  for (const junk of [undefined, null, NaN, 'x']) assert.strictEqual(C.boxDrop(junk), 'smoke', String(junk));
});
test('cubes stay the common drop, so breaking crates still means getting stronger', () => {
  const D = C.BOX_DROP, cube = D.cube;
  assert.ok(cube > D.heart && cube > D.smoke, `cube ${cube}, heart ${D.heart}, smoke ${D.smoke}`);
});
test('a grenade is roughly one crate in five: rare enough to be worth crossing the map for', () => {
  const per = 1 / C.BOX_DROP.smoke;
  assert.ok(per >= 3 && per <= 8, `one crate in ${per.toFixed(1)}`);
});
test('the map never holds enough grenades for everyone at once', () => {
  for (const m of Object.values(C.MODES)){
    const crates = m.boxes || C.BOXES, players = m.teams * m.teamSize;
    const perPlayer = crates * C.BOX_DROP.smoke / players;
    assert.ok(perPlayer < 1, `${m.id}: ${perPlayer.toFixed(2)} grenades per player is not scarce`);
  }
});
test('nobody can keep a corner smoked forever', () => {
  assert.ok(C.SMOKE.charges <= 3, 'a pouch you can stockpile in is a smoke wall waiting to happen');
  // nothing refills, so a full pouch is the whole budget until you find another crate
  const uptime = C.SMOKE.charges * C.SMOKE.life;
  assert.ok(uptime < 20, `${uptime}s of cloud from one full pouch is too much standing smoke`);
});
test('two grenades can still overlap into one wall', () => {
  assert.ok(C.SMOKE.cooldown < C.SMOKE.life - C.SMOKE.fade, 'the second lands before the first thins out');
});
test('the cloud spends most of its life at full strength', () => {
  const S = C.SMOKE;
  assert.ok(S.bloom + S.fade < S.life * 0.5, 'a cloud that is always growing or dying blinds nobody');
  assert.ok(S.flight >= 0.3 && S.flight <= 1, `${S.flight}s in the air is either instant or a joke`);
});
test('the cloud is wider than the point-blank window and narrower than a brawler\'s awareness', () => {
  assert.ok(C.SMOKE.radius > C.SMOKE.near * 2, 'a cloud you can see straight across hides nothing');
  assert.ok(C.SMOKE.radius * 2 < C.BOT.sight, 'wider than anyone can see makes it a wall, not a gadget');
});
test('the point-blank window is tighter than the cloud, so smoke always has an effect', () => {
  assert.ok(C.SMOKE.near < C.SMOKE.radius);
  assert.ok(C.SMOKE.near > 0, 'without it you could blind someone punching you');
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
  assert.ok(C.BOX_DROP.heart > 0.15 && C.BOX_DROP.heart < 0.5, `${C.BOX_DROP.heart}`);
  assert.ok(C.BOX_DROP.cube > C.BOX_DROP.heart);
});
test('bots hesitate before their first shot and fire slower than a human', () => { assert.ok(C.BOT.reaction>=0.4); assert.ok(C.BOT.fireMult>1); });

console.log('Signing in');
test('the environment of the key decides which Crossmint answers', () => {
  assert.strictEqual(C.crossmintApi('ck_production_abc'), 'https://www.crossmint.com');
  assert.strictEqual(C.crossmintApi('ck_staging_abc'), 'https://staging.crossmint.com');
  assert.strictEqual(C.crossmintEnv('sk_staging_abc'), 'staging', 'the server key parses the same way');
  // Une clé absente ne doit pas produire une URL à moitié formée qu'on appellerait quand même.
  for (const junk of [undefined, null, '', 'nope', 'ck_prod_abc', 42])
    assert.strictEqual(C.crossmintApi(junk), null, String(junk));
  assert.strictEqual(C.authUrl(undefined, 'otps/send'), null);
});
test('the sign-in routes are built from the key, never hand-written', () => {
  assert.strictEqual(C.authUrl('ck_production_abc', 'otps/send'),
    'https://www.crossmint.com/api/2024-09-26/session/sdk/auth/otps/send');
  assert.ok(C.authUrl('ck_production_abc', 'authenticate').startsWith('https://'));
});
test('an address is accepted or refused on what it is, not on how it looks', () => {
  for (const bon of ['a@b.co', 'loic.jnepro@gmail.com', 'LOIC@EXAMPLE.COM', 'a+tag@sub.domain.fr'])
    assert.ok(C.validEmail(bon), bon);
  for (const mauvais of ['', 'loic', 'loic@', '@gmail.com', 'a@b', 'a b@c.com', 'a@@b.co', 'a@b..co',
                         'a@b.c', undefined, null, 42, 'a@-b.co', 'x'.repeat(250) + '@b.co'])
    assert.ok(!C.validEmail(mauvais), String(mauvais));
});
test('an address is stored folded, so the same person is the same person', () => {
  assert.strictEqual(C.cleanEmail('  LoIc@Gmail.COM  '), 'loic@gmail.com');
  assert.strictEqual(C.cleanEmail(undefined), '');
});
test('a code copied out of an email still works', () => {
  // Espaces, tirets, collage trop long : le champ ne se plaint jamais, il garde les chiffres.
  for (const brut of ['123456', '123 456', '12-34-56', ' 123456 ', '123456789'])
    assert.strictEqual(C.otpDigits(brut), '123456', brut);
  assert.ok(C.otpReady('123 456'));
  assert.ok(!C.otpReady('1234'));
  assert.ok(!C.otpReady('abcdef'));
  for (const junk of [undefined, null, {}, []]) assert.strictEqual(C.otpDigits(junk), '');
});
test('the sign-in screens never go backwards on their own', () => {
  assert.strictEqual(C.authNext('out', 'sent'), 'code');
  assert.strictEqual(C.authNext('code', 'ok'), 'in');
  assert.strictEqual(C.authNext('code', 'back'), 'out');
  assert.strictEqual(C.authNext('in', 'signout'), 'out');
  // Un double clic, un événement en retard, un état inventé : l'écran reste où il est.
  assert.strictEqual(C.authNext('code', 'sent'), 'code');
  assert.strictEqual(C.authNext('in', 'ok'), 'in');
  assert.strictEqual(C.authNext('out', 'ok'), 'out');
  assert.strictEqual(C.authNext('nimporte', 'ok'), 'out');
});
test('a token says when it expires, and a broken one says nothing', () => {
  const jeton = exp => 'x.' + Buffer.from(JSON.stringify({ sub: 'u', exp })).toString('base64url') + '.y';
  assert.strictEqual(C.jwtExpiry(jeton(1800000000)), 1800000000);
  for (const junk of [undefined, null, '', 'abc', 'a.b', 'a.!!.c', jeton('bientôt'), jeton(0), jeton(-5)])
    assert.strictEqual(C.jwtExpiry(junk), 0, String(junk));
});
test('a session is live until it is not, and the clock is the judge', () => {
  const jeton = exp => 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.y';
  assert.ok(C.sessionLive(jeton(2000), 1999 * 1000));
  assert.ok(!C.sessionLive(jeton(2000), 2001 * 1000));
  assert.ok(!C.sessionLive('cassé', 0), 'un jeton illisible n\'est jamais une session');
});
test('a token is refreshed before it dies, never after', () => {
  const jeton = exp => 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.y';
  const marge = C.AUTH.refreshMargin;
  assert.ok(marge >= 30, 'une marge trop courte ne laisse pas le temps au réseau');
  // Une heure devant soi : on rafraîchit une heure moins la marge plus tard.
  assert.strictEqual(C.refreshDelay(jeton(3600), 0), (3600 - marge) * 1000);
  // Déjà dans la marge, ou déjà expiré : tout de suite, et jamais un délai négatif.
  assert.strictEqual(C.refreshDelay(jeton(3600), 3590 * 1000), 0);
  assert.strictEqual(C.refreshDelay(jeton(100), 900 * 1000), 0);
  assert.strictEqual(C.refreshDelay('cassé', 0), 0);
});
test('a token that comes back already dead never turns into a refresh loop', () => {
  // Le piège que le test navigateur a trouvé : rafraîchir rendait un jeton périmé, le délai suivant
  // valait zéro, et le jeu martelait Crossmint aussi vite que le réseau le permettait.
  const jeton = exp => 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.y';
  const plancher = C.AUTH.minRefresh * 1000;
  assert.ok(plancher > 0, 'sans plancher, la boucle revient');
  assert.strictEqual(C.nextRefresh(jeton(10), 900 * 1000), plancher, 'jeton déjà mort');
  assert.strictEqual(C.nextRefresh('cassé', 0), plancher, 'jeton illisible');
  assert.strictEqual(C.nextRefresh(jeton(3600), 3599 * 1000), plancher, 'jeton qui expire dans une seconde');
  // Un jeton normal garde son vrai délai : le plancher ne doit pas rafraîchir plus que nécessaire.
  assert.strictEqual(C.nextRefresh(jeton(3600), 0), (3600 - C.AUTH.refreshMargin) * 1000);
  assert.ok(C.AUTH.minRefresh < C.AUTH.refreshMargin, 'le plancher ne doit jamais dépasser la marge');
});
test('a failure tells the player what to do, never why it really failed', () => {
  for (const code of [0, 400, 401, 403, 429, 500, 503, 418]) {
    const m = C.authMessage(code);
    assert.ok(m.length > 10 && /[.!]$/.test(m), `${code}: ${m}`);
    assert.ok(!/\d/.test(m), `${code}: le joueur n'a que faire du code HTTP`);
  }
  assert.notStrictEqual(C.authMessage(429), C.authMessage(401), 'ces deux-là appellent des gestes différents');
});
test('the account the server sends replaces the local draft', () => {
  const avatars = C.avatarList(Object.keys(C.BRAWLERS));
  const local = { name: 'Brouillon', avatar: avatars[3].id, stats: { matches: 99, wins: 99, kills: 99, best: 99 } };
  const p = C.applyAccount(local, { name: 'Loïc', avatar: avatars[1].id,
    stats: { matches: 4, wins: 1, kills: 7, best: 250 } }, avatars);
  assert.strictEqual(p.name, 'Loïc');
  assert.strictEqual(p.avatar, avatars[1].id);
  assert.deepStrictEqual(p.stats, { matches: 4, wins: 1, kills: 7, best: 2.5 });
});
test('the server counts in cents and the game in dollars, and the seam is exact', () => {
  const avatars = C.avatarList(Object.keys(C.BRAWLERS));
  const local = { name: 'x', avatar: avatars[0].id, stats: {} };
  // 50 centimes, la plus petite table : un arrondi à l'entier l'effacerait.
  assert.strictEqual(C.applyAccount(local, { stats: { best: 50 } }, avatars).stats.best, 0.5);
  assert.strictEqual(C.applyAccount(local, { stats: { best: 1 } }, avatars).stats.best, 0.01);
  assert.strictEqual(C.applyAccount(local, { stats: { best: 123456 } }, avatars).stats.best, 1234.56);
});
test('a half-written account never wipes what the player already had', () => {
  const avatars = C.avatarList(Object.keys(C.BRAWLERS));
  const local = { name: 'Loic', avatar: avatars[2].id, stats: { matches: 3, wins: 1, kills: 2, best: 5 } };
  for (const cassé of [undefined, null, {}, { name: '' }, { avatar: 'bolt:pirate' }, { stats: null }]) {
    const p = C.applyAccount(local, cassé, avatars);
    assert.strictEqual(p.name, 'Loic', String(JSON.stringify(cassé)));
    assert.strictEqual(p.avatar, avatars[2].id, 'un avatar inconnu ne doit pas vider la case');
    assert.deepStrictEqual(p.stats, { matches: 0, wins: 0, kills: 0, best: 0 });
  }
});
test('statistics coming back negative or absurd are clamped, not trusted', () => {
  const avatars = C.avatarList(Object.keys(C.BRAWLERS));
  const p = C.applyAccount({ name: 'x', avatar: avatars[0].id, stats: {} },
    { stats: { matches: -5, wins: 'beaucoup', kills: 2.7, best: -100 } }, avatars);
  assert.deepStrictEqual(p.stats, { matches: 0, wins: 0, kills: 2, best: 0 });
});

console.log('Le contrat du client : billet, partie, rapport');
// Les quatre cas hors ligne d'abord, un par un et nommés. Ils ne testent pas une exception : ils
// testent le cas normal du fichier unique, celui où il n'y a ni serveur ni compte. Sans eux,
// l'invariant le plus important de la phase ne serait vérifié par rien.
//
// `sas` est ce que l'appelant écrira : choisir l'événement d'entrée selon ce qu'on a sous la
// main, encaisser ce que le réseau rend, et s'arrêter là. Le billet vaut null dans les quatre.
const GRAINE_LOCALE = 3735928559;                 // celle que le navigateur tire aujourd'hui
function sas({ api, session, reponse }){
  let etat = C.matchFlow('hors-ligne', (api && session) ? 'sas-en-ligne' : 'sas-hors-ligne');
  let billet = null;
  if (etat === 'demande') {
    if (reponse === 'muet') etat = C.matchFlow(etat, 'delai');
    else if (typeof reponse !== 'object' || reponse === null) etat = C.matchFlow(etat, 'illisible');
    else { billet = reponse; etat = C.matchFlow(etat, 'billet'); }
  }
  return { etat, billet };
}
function coupDenvoi(etat){
  // Le coup d'envoi se réapplique jusqu'à ce que l'état ne bouge plus : depuis `demande` il lâche
  // d'abord la demande, puis il lance la partie.
  const apres = C.matchFlow(etat, 'coup-denvoi');
  return apres === etat ? apres : coupDenvoi(apres);
}
test('hors ligne 1/4 — ACCOUNT.api vide : graine locale, aucun billet demandé', () => {
  const { etat, billet } = sas({ api: '', session: 'jeton-valide', reponse: 'muet' });
  assert.strictEqual(etat, 'hors-ligne', 'sans adresse de serveur, on ne demande rien');
  assert.strictEqual(billet, null);
  assert.strictEqual(C.seedFor(billet, GRAINE_LOCALE), GRAINE_LOCALE);
  assert.strictEqual(coupDenvoi(etat), 'partie', 'la partie part quand même');
});
test('hors ligne 2/4 — pas de session : graine locale, aucun billet demandé', () => {
  const { etat, billet } = sas({ api: 'https://api.warblock', session: null, reponse: 'muet' });
  assert.strictEqual(etat, 'hors-ligne', 'un serveur sans compte connecté n\'émet pas de billet');
  assert.strictEqual(C.seedFor(billet, GRAINE_LOCALE), GRAINE_LOCALE);
  assert.strictEqual(coupDenvoi(etat), 'partie');
});
test('hors ligne 3/4 — serveur muet : graine locale, on n\'attend personne', () => {
  const { etat, billet } = sas({ api: 'https://api.warblock', session: 'jeton-valide', reponse: 'muet' });
  assert.strictEqual(etat, 'hors-ligne');
  assert.strictEqual(C.seedFor(billet, GRAINE_LOCALE), GRAINE_LOCALE);
  assert.strictEqual(coupDenvoi(etat), 'partie');
});
test('hors ligne 4/4 — réponse illisible : graine locale, la partie part pareil', () => {
  // Une page d'erreur du répartiteur de charge, du HTML là où on attendait du JSON.
  const { etat, billet } = sas({ api: 'https://api.warblock', session: 'jeton-valide', reponse: '<html>502</html>' });
  assert.strictEqual(etat, 'hors-ligne');
  assert.strictEqual(C.seedFor(billet, GRAINE_LOCALE), GRAINE_LOCALE);
  assert.strictEqual(coupDenvoi(etat), 'partie');
});
test('un billet qui tarde ou qui échoue ne bloque jamais le coup d\'envoi', () => {
  // Cas normal, pas cas limite : le chronomètre du sas ne s'arrête pas pour attendre le réseau.
  const enAttente = sas({ api: 'https://api.warblock', session: 'jeton', reponse: { seed: 7 } });
  assert.strictEqual(enAttente.etat, 'billet');
  // La demande est encore en vol quand le compte à rebours tombe à zéro.
  assert.strictEqual(coupDenvoi('demande'), 'partie', 'la demande est lâchée, la partie part');
  assert.strictEqual(C.matchFlow('demande', 'coup-denvoi'), 'hors-ligne', 'le premier temps lâche la demande');
  assert.strictEqual(C.seedFor(null, GRAINE_LOCALE), GRAINE_LOCALE, 'et sans billet, la graine est locale');
  // Un refus du serveur mène au même endroit qu'un silence : la partie se joue.
  for (const raté of ['echec', 'delai', 'illisible'])
    assert.strictEqual(coupDenvoi(C.matchFlow('demande', raté)), 'partie', raté);
});
test('un billet utilisable donne SA graine, et elle seule', () => {
  assert.strictEqual(C.seedFor({ seed: 0 }, GRAINE_LOCALE), 0, 'zéro est une graine, pas une absence');
  assert.strictEqual(C.seedFor({ seed: 4294967295 }, GRAINE_LOCALE), 4294967295);
  assert.strictEqual(C.seedFor({ seed: 12345, id: 'm_1', stakeCents: 50 }, GRAINE_LOCALE), 12345);
});
test('seedFor ne lance sur aucune entrée, et retombe sur la graine locale', () => {
  // Le serveur peut rendre n'importe quoi : une exception ici serait une partie qui ne démarre
  // pas, ce qui coûte plus cher que n'importe quelle graine.
  const dégénérées = [null, undefined, {}, [], 0, '', 'billet', true, NaN,
                      { seed: undefined }, { seed: null }, { seed: 1.5 }, { seed: -1 },
                      { seed: '12345' }, { seed: NaN }, { seed: Infinity },
                      { seed: 4294967296 }, { seed: {} }, Object.create(null)];
  for (const mauvais of dégénérées) {
    let vu;
    assert.doesNotThrow(() => { vu = C.seedFor(mauvais, GRAINE_LOCALE); }, `seedFor a lancé sur ${JSON.stringify(mauvais)}`);
    assert.strictEqual(vu, GRAINE_LOCALE, `${JSON.stringify(mauvais)} aurait dû rendre la graine locale`);
  }
});
test('matchFlow suit sa table, transition par transition', () => {
  const table = [
    ['hors-ligne', 'sas-en-ligne', 'demande'],
    ['fini', 'sas-en-ligne', 'demande'],
    ['hors-ligne', 'sas-hors-ligne', 'hors-ligne'],
    ['fini', 'sas-hors-ligne', 'hors-ligne'],
    ['demande', 'billet', 'billet'],
    ['demande', 'echec', 'hors-ligne'],
    ['demande', 'delai', 'hors-ligne'],
    ['demande', 'illisible', 'hors-ligne'],
    ['demande', 'coup-denvoi', 'hors-ligne'],
    ['hors-ligne', 'coup-denvoi', 'partie'],
    ['billet', 'coup-denvoi', 'partie'],
    ['partie', 'fin-en-ligne', 'rapport'],
    ['partie', 'fin-hors-ligne', 'fini'],
    ['rapport', 'reglement', 'fini'],
    ['rapport', 'echec', 'fini'],
  ];
  for (const [de, ev, vers] of table) assert.strictEqual(C.matchFlow(de, ev), vers, `${de} + ${ev}`);
  for (const [, , vers] of table) assert.ok(C.MATCH_STEPS.includes(vers), `${vers} n'est pas un état`);
});
test('tout événement inconnu laisse l\'état où il est, et un double clic ne renvoie personne au début', () => {
  for (const etat of C.MATCH_STEPS)
    for (const ev of ['', undefined, null, 'ok', 'sent', 'coupDenvoi', 'FIN', 42, {}])
      assert.strictEqual(C.matchFlow(etat, ev), etat, `${etat} + ${String(ev)}`);
  // Deux clics sur JOUER pendant que la demande est en vol : ni seconde demande, ni retour au début.
  assert.strictEqual(C.matchFlow('demande', 'sas-en-ligne'), 'demande');
  assert.strictEqual(C.matchFlow('billet', 'sas-en-ligne'), 'billet', 'un billet reçu ne se jette pas sur un clic');
  assert.strictEqual(C.matchFlow('partie', 'sas-en-ligne'), 'partie');
  assert.strictEqual(C.matchFlow('rapport', 'fin-en-ligne'), 'rapport', 'une fin envoyée deux fois ne rend pas deux rapports');
  assert.strictEqual(C.matchFlow('fini', 'reglement'), 'fini');
  // Un état inventé — sauvegarde d'une version précédente, console du navigateur — repart de zéro.
  for (const faux of ['nimporte', '', undefined, null, 42]) assert.strictEqual(C.matchFlow(faux, 'coup-denvoi'), 'partie', String(faux));
});
test('une partie entière, du sas au règlement, puis la suivante', () => {
  let e = C.matchFlow('hors-ligne', 'sas-en-ligne');   assert.strictEqual(e, 'demande');
  e = C.matchFlow(e, 'billet');                        assert.strictEqual(e, 'billet');
  e = C.matchFlow(e, 'coup-denvoi');                   assert.strictEqual(e, 'partie');
  e = C.matchFlow(e, 'fin-en-ligne');                  assert.strictEqual(e, 'rapport');
  e = C.matchFlow(e, 'reglement');                     assert.strictEqual(e, 'fini');
  e = C.matchFlow(e, 'sas-en-ligne');                  assert.strictEqual(e, 'demande', 'la partie suivante repart d\'ici');
  // Et la même partie jouée hors ligne ne passe jamais par le rapport.
  let h = coupDenvoi(C.matchFlow('hors-ligne', 'sas-hors-ligne'));
  assert.strictEqual(h, 'partie');
  assert.strictEqual(C.matchFlow(h, 'fin-hors-ligne'), 'fini', 'sans billet, personne n\'attend de rapport');
});
test('reportFrom ne retient que des faits : aucun montant ne passe hors des deux nommés', () => {
  // L'état de fin de partie du jeu porte la mise, le pot, le portefeuille, le gain recalculé…
  // Aucun n'a de raison de traverser le réseau : le serveur les refait depuis le billet.
  const etat = { seconds: 214, kills: 3, deaths: 1, rank: 2, cubes: 4, damage: 5120, cashedOut: false,
                 purseCents: 200, declaredNetCents: 160,
                 stakeCents: 50, potCents: 1000, winnerCents: 800, walletCents: 12345,
                 payoutCents: 800, feeCents: 200, amount: 8, wallet: 123.45, best: 4, seed: 9 };
  const r = C.reportFrom(etat);
  assert.deepStrictEqual(Object.keys(r).sort(), Object.keys(C.REPORT_FIELDS).sort());
  const montants = Object.keys(r).filter(k => /Cents$/.test(k));
  assert.deepStrictEqual(montants.sort(), ['declaredNetCents', 'purseCents'], 'un montant de plus est passé');
  for (const interdit of ['stakeCents', 'potCents', 'winnerCents', 'walletCents', 'payoutCents', 'feeCents', 'amount', 'wallet', 'best', 'seed'])
    assert.ok(!(interdit in r), `${interdit} n'a rien à faire dans un rapport`);
  assert.strictEqual(r.purseCents, 200);
  assert.strictEqual(r.declaredNetCents, 160);
});
test('reportFrom rend des faits propres, et un montant absent ne devient pas zéro', () => {
  const r = C.reportFrom({ seconds: 214.7, kills: '3', deaths: -2, rank: 0, cubes: 4.4, damage: 5120.6,
                           cashedOut: 1, purseCents: 200.9, declaredNetCents: 0 });
  assert.deepStrictEqual(r, { seconds: 215, kills: 3, deaths: 0, rank: 1, cubes: 4, damage: 5121,
                              cashedOut: true, purseCents: 200, declaredNetCents: 0 });
  // Un compte absent vaut zéro : le fait n'a pas eu lieu. Un montant absent vaut null, comme
  // `toCents` rend null — un zéro silencieux se paie, une valeur absente se repère.
  for (const vide of [undefined, null, {}, 'rapport', 42, []]) {
    const v = C.reportFrom(vide);
    assert.strictEqual(v.kills, 0, String(vide));
    assert.strictEqual(v.rank, 1, String(vide));
    assert.strictEqual(v.cashedOut, false, String(vide));
    assert.strictEqual(v.purseCents, null, `${String(vide)} : une sacoche absente n'est pas une sacoche vide`);
    assert.strictEqual(v.declaredNetCents, null, String(vide));
  }
  assert.strictEqual(C.reportFrom({ purseCents: '200' }).purseCents, null, 'une chaîne n\'est pas un montant');
  assert.strictEqual(C.reportFrom({ purseCents: -5 }).purseCents, 0);
});
test('checkReport refuse un champ inconnu, avec un code, au lieu de l\'ignorer', () => {
  const bon = C.reportFrom({ seconds: 90, kills: 2, deaths: 0, rank: 1, cubes: 3, damage: 900,
                             cashedOut: true, purseCents: 300, declaredNetCents: 240 });
  const { rapport, erreurs } = C.checkReport({ ...bon, payoutCents: 999999 });
  assert.strictEqual(rapport, null, 'un rapport douteux ne ressort pas propre');
  assert.strictEqual(erreurs.length, 1);
  assert.strictEqual(erreurs[0].code, 'inconnu');
  assert.strictEqual(erreurs[0].field, 'payoutCents');
  assert.ok(erreurs[0].message.includes('payoutCents'), erreurs[0].message);
  // Le contraste avec PATCH /api/me est la décision : là-bas on ignore, ici on refuse.
  assert.strictEqual(C.checkReport({ ...bon, id: 1, status: 'settled' }).erreurs.length, 2);
});
test('checkReport vérifie les types, les bornes et les absences, et dit quoi corriger', () => {
  const bon = C.reportFrom({ seconds: 90, kills: 2, deaths: 0, rank: 1, cubes: 3, damage: 900,
                             cashedOut: true, purseCents: 300, declaredNetCents: 240 });
  const cas = [
    [{ kills: 1.5 }, 'kills', 'type'],
    [{ kills: '2' }, 'kills', 'type'],
    [{ purseCents: 12.5 }, 'purseCents', 'type'],
    [{ purseCents: Number.MAX_SAFE_INTEGER + 2 }, 'purseCents', 'type'],
    [{ declaredNetCents: -1 }, 'declaredNetCents', 'borne'],
    [{ rank: 0 }, 'rank', 'borne'],
    [{ cashedOut: 'oui' }, 'cashedOut', 'type'],
    [{ cubes: undefined }, 'cubes', 'manquant'],
    [{ purseCents: null }, 'purseCents', 'manquant'],
  ];
  for (const [patch, champ, code] of cas) {
    const { rapport, erreurs } = C.checkReport({ ...bon, ...patch });
    assert.strictEqual(rapport, null, JSON.stringify(patch));
    assert.strictEqual(erreurs.length, 1, JSON.stringify(patch) + ' : ' + JSON.stringify(erreurs));
    assert.strictEqual(erreurs[0].field, champ, JSON.stringify(patch));
    assert.strictEqual(erreurs[0].code, code, JSON.stringify(patch));
    assert.ok(erreurs[0].message.includes(champ) && /[.]$/.test(erreurs[0].message), erreurs[0].message);
  }
  // Un corps qui n'est pas un objet ne rend pas neuf erreurs, il en rend une, claire.
  for (const pas of [null, undefined, 'rapport', 42, []]) {
    const { rapport, erreurs } = C.checkReport(pas);
    assert.strictEqual(rapport, null, String(pas));
    assert.strictEqual(erreurs.length, 1, String(pas));
    assert.strictEqual(erreurs[0].code, 'corps', String(pas));
  }
  // Rien de rempli du tout : chaque champ manquant est signalé, pas seulement le premier.
  assert.strictEqual(C.checkReport({}).erreurs.length, Object.keys(C.REPORT_FIELDS).length);
});
test('aller-retour : ce que reportFrom produit, checkReport l\'accepte sans une erreur', () => {
  const fins = [
    { seconds: 0, kills: 0, deaths: 0, rank: 20, cubes: 0, damage: 0, cashedOut: false, purseCents: 0, declaredNetCents: 0 },
    { seconds: 312.4, kills: 7, deaths: 2, rank: 1, cubes: 10, damage: 9876.5, cashedOut: true,
      purseCents: C.toCents(12.5), declaredNetCents: C.cashoutCents(C.toCents(12.5)).netCents },
    // Une victoire MAXWIN sur la plus petite table : le rapport ne porte que la sacoche, et le
    // serveur recalculera le reste depuis le billet.
    { seconds: 240, kills: 19, deaths: 0, rank: 1, cubes: 6, damage: 15000, cashedOut: false,
      purseCents: C.purseBound(C.toCents(0.5), C.seatsOf(C.MODES.solo)).maxCents, declaredNetCents: 800 },
  ];
  for (const fin of fins) {
    const { rapport, erreurs } = C.checkReport(C.reportFrom(fin));
    assert.deepStrictEqual(erreurs, [], JSON.stringify(fin));
    assert.deepStrictEqual(rapport, C.reportFrom(fin), 'le rapport propre doit être celui qu\'on a rendu');
    for (const v of [rapport.purseCents, rapport.declaredNetCents])
      assert.ok(Number.isSafeInteger(v) && v >= 0, `${v} n'est pas un montant en centimes entiers`);
  }
});
test('le contrat du client ne touche ni à l\'horloge, ni au hasard, ni au navigateur', () => {
  // WBCore doit rester pur : l'heure et la graine de secours sont des arguments, jamais des
  // appels. Une seule de ces fonctions qui lirait Date.now() rendrait un rapport intestable.
  const bloc = core.slice(core.indexOf('// ---- Le contrat du client'), core.indexOf('  return { MAP, PLAYERS,'));
  assert.ok(bloc.length > 1000, 'le bloc du contrat n\'a pas été retrouvé dans CORE');
  for (const interdit of ['Date.now', 'Math.random', 'document', 'window', 'THREE', 'performance', 'fetch', 'localStorage'])
    assert.ok(!bloc.split('\n').some(l => l.includes(interdit) && !l.trim().startsWith('//')),
      `${interdit} n'a rien à faire dans le contrat du client`);
});

console.log('Le plan de zone, tiré de la seule graine');
const MODES_LENTS = [C.MODES.solo, C.MODES.duo, C.MODES.trio];
const MODES_RAPIDES = [C.MODES.resurgence, C.MODES.resurgenceDuo];
const TOUS_MODES = MODES_LENTS.concat(MODES_RAPIDES);
test('même graine, même plan : deux fois de suite, et dans deux processus distincts', () => {
  for (const mode of TOUS_MODES)
    for (const graine of [0, 1, 7, 12345, 0xdeadbeef, 4294967295])
      assert.deepStrictEqual(C.zonePlan(graine, mode), C.zonePlan(graine, mode), `graine ${graine} en ${mode.id}`);
  // Deux processus, parce qu'un plan qui dépendrait d'un état accumulé dans le module passerait
  // les égalités ci-dessus sans broncher. C'est le seul moyen de le voir sans relire le code.
  const dehors = require('child_process').execFileSync(process.execPath, ['-e', `
    const fs = require('fs');
    const html = fs.readFileSync(process.env.WB_FICHIER, 'utf8');
    const bloc = html.slice(html.indexOf('/*CORE-' + 'START*/'), html.indexOf('/*CORE-' + 'END*/'));
    const m = { exports: {} }; new Function('module', 'exports', bloc)(m, m.exports);
    process.stdout.write(JSON.stringify(m.exports.zonePlan(12345, m.exports.MODES.solo)));
  `], { encoding: 'utf8', env: Object.assign({}, process.env, { WB_FICHIER: path.join(__dirname, GAME) }) });
  assert.strictEqual(dehors, JSON.stringify(C.zonePlan(12345, C.MODES.solo)),
    'le même plan doit sortir d\'un processus neuf');
});
test('zonePlan tourne avec Math.random remplacé par une fonction qui lance', () => {
  // La preuve mécanique qu'aucun hasard non semé ne subsiste dans le plan. Un test qui compare
  // deux appels peut passer par chance ; celui-ci ne le peut pas.
  const vrai = Math.random;
  Math.random = () => { throw new Error('le plan de zone a tiré sur Math.random'); };
  try {
    for (const mode of TOUS_MODES)
      for (let graine = 0; graine < 40; graine++) {
        const plan = C.zonePlan(graine, mode);
        C.zoneTotalS(plan);
        for (let t = 0; t <= 200; t += 7) C.zoneAt(plan, t);
      }
  } finally { Math.random = vrai; }
  // Déterministe n'est pas constant : deux graines doivent donner deux gaz.
  assert.notDeepStrictEqual(C.zonePlan(1, C.MODES.solo).phases, C.zonePlan(2, C.MODES.solo).phases);
});
test('chaque cercle reste dans la carte, et les rayons décroissent strictement', () => {
  assert.strictEqual(C.MAP, 152);
  for (const mode of TOUS_MODES)
    for (let graine = 0; graine < 300; graine++) {
      const plan = C.zonePlan(graine, mode);
      let precedent = plan.startR;
      for (const p of plan.phases) {
        assert.ok(p.r < precedent, `graine ${graine} ${mode.id} phase ${p.index} : rayon ${p.r} ≥ ${precedent}`);
        precedent = p.r;
        assert.ok(p.cx - p.r >= 0 && p.cx + p.r <= C.MAP, `graine ${graine} ${mode.id} phase ${p.index} déborde en x`);
        assert.ok(p.cz - p.r >= 0 && p.cz + p.r <= C.MAP, `graine ${graine} ${mode.id} phase ${p.index} déborde en z`);
      }
    }
});
test('chaque cercle est entièrement contenu dans le précédent', () => {
  // Sans ça, le gaz enferme un joueur hors du cercle suivant sans qu'il ait jamais eu l'occasion
  // de le rejoindre : il meurt d'une décision prise avant qu'il ne bouge.
  for (const mode of TOUS_MODES)
    for (let graine = 0; graine < 300; graine++) {
      const plan = C.zonePlan(graine, mode);
      let cx = plan.startCx, cz = plan.startCz, r = plan.startR;
      for (const p of plan.phases) {
        // Le plan doit aussi se raconter correctement : `from` est bien le cercle en place.
        assert.strictEqual(p.fromCx, cx); assert.strictEqual(p.fromCz, cz); assert.strictEqual(p.fromR, r);
        const d = Math.hypot(p.cx - cx, p.cz - cz);
        assert.ok(d + p.r <= r,
          `graine ${graine} ${mode.id} phase ${p.index} : ${d.toFixed(3)} + ${p.r} dépasse ${r}`);
        cx = p.cx; cz = p.cz; r = p.r;
      }
    }
});
test('le gaz normal met toujours 154 s à se refermer, la variante rapide moins', () => {
  // 154 s est la durée mesurée qui a fait passer le jeu à trois vies (docs/HISTORIQUE.md) : avec
  // une seule vie le dernier survivant était désigné vers 54 s, bien avant la fin du gaz.
  assert.strictEqual(25 + 34 + 18 + 26 + 12 + 18 + 8 + 13, 154);
  for (let graine = 0; graine < 60; graine++) {
    for (const mode of MODES_LENTS) {
      const plan = C.zonePlan(graine, mode);
      assert.strictEqual(C.zoneTotalS(plan), 154, `graine ${graine} en ${mode.id}`);
      assert.strictEqual(plan.phases.reduce((s, p) => s + p.waitS + p.shrinkS, 0), 154);
      assert.strictEqual(plan.phases[plan.phases.length - 1].endS, 154);
      assert.strictEqual(plan.phases[0].startS, 0);
    }
    for (const mode of MODES_RAPIDES) {
      const plan = C.zonePlan(graine, mode);
      assert.strictEqual(C.zoneTotalS(plan), 12 + 20 + 8 + 16 + 6 + 12 + 4 + 9);
      assert.ok(C.zoneTotalS(plan) < 154, `${mode.id} devrait être plus court que 154 s`);
    }
  }
});
test('zoneAt rend le cercle de départ à t=0 et le cercle final au-delà du total', () => {
  for (const mode of [C.MODES.solo, C.MODES.resurgence]) {
    const plan = C.zonePlan(2026, mode);
    const debut = C.zoneAt(plan, 0);
    assert.strictEqual(debut.r, C.ZONE_START_R);
    assert.strictEqual(debut.cx, C.MAP / 2); assert.strictEqual(debut.cz, C.MAP / 2);
    assert.strictEqual(debut.shrinking, false);
    assert.strictEqual(debut.timer, plan.phases[0].waitS);
    const dernier = plan.phases[plan.phases.length - 1];
    for (const t of [plan.totalS, plan.totalS + 1, 10000]) {
      const z = C.zoneAt(plan, t);
      assert.strictEqual(z.phase, plan.phases.length, `à t=${t} la partie est finie de se resserrer`);
      assert.strictEqual(z.shrinking, false);
      assert.strictEqual(z.r, dernier.r); assert.strictEqual(z.cx, dernier.cx); assert.strictEqual(z.cz, dernier.cz);
      assert.strictEqual(z.timer, Infinity);
    }
    // Le gaz ne recule jamais, et il arrive pile sur le cercle que le plan annonce.
    let precedent = Infinity;
    for (let t = 0; t <= plan.totalS; t += 0.25) {
      const z = C.zoneAt(plan, t);
      assert.ok(z.r <= precedent + 1e-9, `le gaz recule à t=${t} en ${mode.id}`);
      precedent = z.r;
    }
    for (const p of plan.phases) {
      assert.strictEqual(C.zoneAt(plan, p.startS).r, p.fromR, `phase ${p.index} devrait démarrer sur le cercle en place`);
      const arrive = C.zoneAt(plan, p.endS - 1e-6);
      assert.ok(Math.abs(arrive.r - p.r) < 1e-4, `phase ${p.index} n'arrive pas sur son rayon`);
      assert.ok(Math.abs(arrive.cx - p.cx) < 1e-4 && Math.abs(arrive.cz - p.cz) < 1e-4,
        `phase ${p.index} n'arrive pas sur son centre`);
    }
  }
});
test('les dégâts du gaz montent à chaque phase', () => {
  for (const mode of TOUS_MODES) {
    const plan = C.zonePlan(5, mode);
    for (let i = 1; i < plan.phases.length; i++)
      assert.ok(plan.phases[i].dps > plan.phases[i - 1].dps,
        `${mode.id} : la phase ${i} ne fait pas plus mal que la précédente`);
    // zoneAt sert le dps de la phase en cours pendant l'attente comme pendant le resserrement,
    // et celui de la dernière une fois le cercle final en place — c'est la règle du jeu.
    for (const p of plan.phases) {
      assert.strictEqual(C.zoneAt(plan, p.startS).dps, p.dps);
      assert.strictEqual(C.zoneAt(plan, p.shrinkStartS).dps, p.dps);
    }
    assert.strictEqual(C.zoneAt(plan, plan.totalS + 60).dps, plan.phases[plan.phases.length - 1].dps);
  }
});
test('le cercle final n\'atterrit pas toujours au même endroit', () => {
  // Un gaz déterministe qui poserait le dernier cercle au même endroit à chaque partie serait
  // reproductible ET ennuyeux. Aucun test ne regarde le jeu tourner : celui-ci est le seul
  // garde-fou automatique contre une dérive du tirage vers un point fixe.
  const vus = new Set();
  for (let graine = 0; graine < 200; graine++) {
    const p = C.zonePlan(graine, C.MODES.solo).phases[3];
    vus.add(Math.round(p.cx / 4) + ':' + Math.round(p.cz / 4));
  }
  assert.ok(vus.size >= 60, `seulement ${vus.size} emplacements finals distincts sur 200 graines`);
});
test('bac à sable : CORE se charge sans document, window, THREE, Math.random, Date.now ni performance', () => {
  // Garde permanente. Le mode de défaillance que docs/HISTORIQUE.md documente cinq fois est une
  // édition automatisée qui réintroduit dans le bloc testé quelque chose qui dépend de
  // l'environnement. Ici le bloc s'exécute sans aucun de ces noms : une réintroduction d'entropie
  // ou d'horloge au chargement tombe tout de suite, avant d'atteindre le navigateur.
  const sansRandom = new Proxy(Math, { get: (t, p) => p === 'random' ? undefined : Reflect.get(t, p) });
  const sansNow = new Proxy(Date, { get: (t, p) => p === 'now' ? undefined : Reflect.get(t, p) });
  const bac = new Function('module', 'exports', 'document', 'window', 'THREE', 'performance',
                           'localStorage', 'fetch', 'Math', 'Date', core);
  const m = { exports: {} };
  bac(m, m.exports, undefined, undefined, undefined, undefined, undefined, undefined, sansRandom, sansNow);
  const S = m.exports;
  assert.strictEqual(typeof S.zonePlan, 'function', 'le bloc ne s\'est pas chargé dans le bac à sable');
  // Et les fonctions pures tournent bel et bien là-dedans, pas seulement le chargement.
  const plan = S.zonePlan(4242, S.MODES.solo);
  assert.strictEqual(S.zoneTotalS(plan), 154);
  assert.strictEqual(S.zoneAt(plan, 0).r, S.ZONE_START_R);
  assert.deepStrictEqual(plan, C.zonePlan(4242, C.MODES.solo), 'le plan ne doit pas dépendre de l\'environnement');
  assert.strictEqual(S.payoutCents(50, S.MODES.solo).feeCents, C.payoutCents(50, C.MODES.solo).feeCents);
  assert.deepStrictEqual(S.checkReport(S.reportFrom({})).erreurs, C.checkReport(C.reportFrom({})).erreurs);
  assert.strictEqual(S.seedFor(null, 7), 7);
  assert.deepStrictEqual(Array.from(S.generateMap(3)), Array.from(C.generateMap(3)));
});
test('le plan de zone ne connaît ni horloge, ni hasard non semé, ni navigateur', () => {
  const bloc = core.slice(core.indexOf('// ---- Le plan de zone'), core.indexOf('// ---- Le contrat du client'));
  assert.ok(bloc.length > 1000, 'le bloc du plan de zone n\'a pas été retrouvé dans CORE');
  for (const interdit of ['Date.now', 'Math.random', 'document', 'window', 'THREE', 'performance', 'fetch', 'localStorage'])
    assert.ok(!bloc.split('\n').some(l => l.includes(interdit) && !l.trim().startsWith('//')),
      `${interdit} n'a rien à faire dans le plan de zone`);
  // Et le bloc Game ne redéclare plus les tables : deux sources de vérité, c'est une qui ment.
  const jeu = html.slice(html.indexOf('/*CORE-END*/'));
  for (const nom of ['const ZONE_PHASES', 'const ZONE_PHASES_FAST', 'const ZONE_START_R'])
    assert.ok(!jeu.includes(nom), `${nom} est redéclaré hors de WBCore`);
  assert.ok(!/Math\.random\(\)\*Math\.PI\*2, d=Math\.random\(\)/.test(jeu),
    'zoneUpdate retire de nouveau le centre du cercle suivant sur Math.random');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
