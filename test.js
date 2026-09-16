// Run: node test.js — extracts the CORE block from index.html and tests it in isolation.
const fs = require('fs'), assert = require('assert'), path = require('path'), vm = require('vm');
// the game lives in index.html so GitHub Pages can serve it directly
const GAME = process.env.WARBLOCK_FILE || 'index.html';
const html = fs.readFileSync(path.join(__dirname, GAME), 'utf8');
const core = html.slice(html.indexOf('/*CORE-START*/'), html.indexOf('/*CORE-END*/'));
const mod = { exports: {} }; new Function('module', 'exports', core)(mod, mod.exports); const C = mod.exports;
// Le bloc SIM se charge comme CORE : il reçoit `WBCore` en paramètre, exactement comme le
// navigateur le lui donne en variable globale. C'est le même texte, chargé deux fois — c'est ce
// qui rend l'invariant « une seule copie de chaque règle » vérifiable.
const sim = html.slice(html.indexOf('/*SIM-START*/'), html.indexOf('/*SIM-END*/'));
const chargerSim = (WBCore, MathUtil) => {
  const m = { exports: {} };
  new Function('module', 'exports', 'WBCore', 'Math', sim)(m, m.exports, WBCore, MathUtil || Math);
  return m.exports;
};
const SIMU = chargerSim(C);
let passed = 0;
const eff = b => b.attack.n * (b.attack.dmgFar ? (b.attack.dmg+b.attack.dmgFar)/2 : b.attack.dmg); // hex: mean over range
function test(name, fn){ try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n    ', e.message); process.exitCode = 1; } }
// Une poignée de tests font tourner du VRAI code asynchrone — le module `Match`, extrait
// d'index.html et exécuté. Ils s'enregistrent ici et le décompte final les attend ; tout le reste
// du fichier reste synchrone, comme il l'a toujours été.
const enVol = [];
function testAsync(name, fn){
  enVol.push(Promise.resolve().then(fn).then(
    () => { passed++; console.log('  ✓', name); },
    e => { console.log('  ✗', name, '\n    ', e && e.message || e); process.exitCode = 1; }));
}

console.log('Le fichier unique');
test('chaque bloc <script> du fichier est du JavaScript valide', () => {
  // L'INVARIANT DU FICHIER UNIQUE SE TESTE ICI ET NULLE PART AILLEURS. docs/HISTORIQUE.md recense
  // cinq bugs dont la cause unique est une édition par remplacement de texte dans le bloc `Game` —
  // un écran noir, une erreur de syntaxe — et rien n'exécutait ni ne parsait jamais ce bloc : ni
  // `node test.js`, qui ne charge que CORE, ni `node api/test.js`, ni l'intégration continue. La
  // discipline « extraire les blocs puis node --check après chaque édition » n'était tenue que par
  // un humain. `new vm.Script` parse sans exécuter — ni DOM, ni Three.js, ni sous-processus, ni
  // dépendance — donc la faute tombe ici, et du même coup dans `npm test` et dans le workflow qui
  // PUBLIE le fichier.
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) { new vm.Script(m[1], { filename: `bloc${n}.js` }); n++; }
  // Le compte vaut d'être gardé : il attrape aussi une balise `</script>` cassée, qui ferait
  // disparaître un bloc entier de la recherche et passer pour « rien à vérifier ».
  assert.strictEqual(n, 3, 'index.html doit contenir exactement trois blocs <script> internes : WBCore, SIM et Game');
  // Et le fichier reste UNIQUE : le bloc SIM est un bloc interne, pas un fichier à côté. Un
  // `src=` qui pointerait vers un .js local casserait la promesse du projet — on ouvre le fichier
  // et on joue — sans qu'aucun test ne s'en aperçoive, puisque le jeu marcherait encore en local.
  for (const m2 of html.matchAll(/<script[^>]*\bsrc="([^"]*)"/g))
    assert.ok(/^https?:\/\//.test(m2[1]), `un script local est chargé à côté du fichier : ${m2[1]}`);
});

test('tout script distant est vérifié avant d\'être exécuté', () => {
  // VENU DE LA PR #2 DE BEN, ET LE CONSTAT ÉTAIT JUSTE : la balise chargeait tout le moteur de
  // rendu depuis un CDN sans contrôle d'intégrité, sur une page destinée à manipuler des mises. Le
  // navigateur exécutait ce qu'on lui servait, quel qu'il soit.
  //
  // La garde porte sur TOUT script distant, pas sur celui de Three.js : c'est la règle qu'on veut
  // tenir, et un second CDN ajouté un jour sans empreinte doit faire tomber ce test. `crossorigin`
  // est exigé avec, faute de quoi le navigateur ne peut pas lire la réponse pour la vérifier et
  // bloque le script — une balise avec `integrity` seul est pire que rien, elle casse la page.
  const balises = [...html.matchAll(/<script\b[^>]*\bsrc="(https?:[^"]*)"[^>]*>/g)];
  assert.ok(balises.length >= 1, 'plus aucun script distant : la garde ne vérifie plus rien');
  for (const [balise, url] of balises) {
    assert.match(balise, /\bintegrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/,
      `script distant sans empreinte d'intégrité : ${url}`);
    assert.match(balise, /\bcrossorigin=/,
      `integrity sans crossorigin sur ${url} : le navigateur bloquerait le script`);
    // L'empreinte n'a de sens que sur une URL FIGÉE. `.../three.js/latest/` ou une branche
    // changeraient de contenu sous une empreinte qui ne bougerait pas, et la page cesserait de
    // charger un jour sans que personne n'ait rien touché.
    assert.ok(!/\b(latest|master|main)\b/.test(url), `URL non figée sous une empreinte : ${url}`);
  }
});

test('le chat n\'exécute pas ce que le joueur écrit', () => {
  // VENU DE LA PR #2 DE BEN. `addBubble` interpolait DEUX champs sous contrôle du joueur — le
  // pseudo autant que le message — dans `innerHTML`, alors que `sanitizeChat` ne retire que les
  // caractères de contrôle. `<img src=x onerror=...>` s'exécutait, et `renderChatHistory` le
  // rejouait à chaque ouverture de la fenêtre. Le défaut a traversé quatre phases de relecture :
  // il vit dans le bloc `Game`, que ni `WBCore` ni `WBSim` ne couvrent.
  const brut = html.slice(html.indexOf('function addBubble('), html.indexOf('function renderChatHistory('));
  assert.ok(brut.length > 100 && brut.length < 2500, 'addBubble n\'a pas été retrouvée');
  // Les commentaires sont retirés AVANT de chercher `innerHTML` : celui qui explique la correction
  // porte le mot, et une garde qui se déclenche sur sa propre explication serait intenable.
  const bulle = brut.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/innerHTML/.test(bulle),
    'addBubble est repassée par innerHTML : le chat exécute ce que le joueur écrit');
  assert.ok(/createTextNode|textContent/.test(bulle),
    'addBubble n\'écrit plus le texte du joueur par un nœud de texte');
  // ET `sanitizeChat` N'ÉCHAPPE DÉLIBÉRÉMENT PAS LE HTML : contre un nœud de texte cela
  // double-rendrait, et « <3 » s'afficherait « &lt;3 ». Le contrat est épinglé ici pour que la
  // prochaine lecture sache où échapper si un message repassait un jour par `innerHTML`.
  assert.strictEqual(C.sanitizeChat('<3 gg'), '<3 gg');
  assert.strictEqual(C.sanitizeChat('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});

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
    // Une partie finie est une partie finie, que son rapport ait reçu sa réponse ou non. Sans
    // cette sortie, un règlement qui ne revenait jamais — serveur muet, wifi basculé, téléphone
    // endormi — confisquait TOUTES les parties suivantes : plus aucun billet demandé, et la vieille
    // graine rejouée carte pour carte.
    ['rapport', 'sas-en-ligne', 'demande'],
    ['hors-ligne', 'sas-hors-ligne', 'hors-ligne'],
    ['fini', 'sas-hors-ligne', 'hors-ligne'],
    ['rapport', 'sas-hors-ligne', 'hors-ligne'],
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
  // `rapport` ne réagit pas à une seconde fin — mais que le rapport ne parte pas deux fois n'est
  // PAS l'affaire de cette table : c'est l'appelant qui le tient, en vidant `enJeu` dès la
  // première. L'écrire autrement laissait croire à une protection qui n'existait pas.
  assert.strictEqual(C.matchFlow('rapport', 'fin-en-ligne'), 'rapport');
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
                              cashedOut: true, purseCents: 200, declaredNetCents: 0, digests: '' });
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
    // LES TROIS CHAMPS QUI N'AVAIENT AUCUNE BORNE HAUTE. Ils traversaient toute la validation
    // jusqu'à des colonnes `integer` de Postgres, qui s'arrêtent à 2 147 483 647 : l'`update`
    // levait `22003`, la route rendait 500, et la ligne restait `open` — le joueur enfermé dans un
    // billet mort jusqu'à l'expiration, puisqu'il n'en a qu'un à la fois. Aucun test ne pouvait le
    // voir : la doublure d'api/test.js est un tableau JS, elle n'a pas de largeur de colonne.
    [{ deaths: 2147483648 }, 'deaths', 'borne'],
    [{ damage: 2147483648 }, 'damage', 'borne'],
    [{ declaredNetCents: 2147483648 }, 'declaredNetCents', 'borne'],
    [{ purseCents: 2147483648 }, 'purseCents', 'borne'],
    [{ seconds: 2147483648 }, 'seconds', 'borne'],
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
  // La borne elle-même passe : on refuse ce que la colonne ne peut pas écrire, pas un de moins.
  for (const nom of ['deaths', 'damage', 'declaredNetCents', 'purseCents', 'seconds', 'kills', 'cubes', 'rank'])
    assert.deepStrictEqual(C.checkReport({ ...bon, [nom]: C.PG_INT4_MAX }).erreurs, [], nom);
  // Et la garde qui compte pour la suite : tout champ entier du rapport a une borne haute, parce
  // que tout champ entier du rapport finit dans une colonne `integer` de `matches`. Le prochain
  // champ ajouté sans `max` tombe ici, pas devant un joueur.
  for (const [nom, regle] of Object.entries(C.REPORT_FIELDS))
    if (regle.kind === 'entier')
      assert.strictEqual(regle.max, C.PG_INT4_MAX, `« ${nom} » n'a pas de borne haute`);
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
  // La recherche porte sur l'IDENTIFIANT ENTIER, pas sur la sous-chaîne. `windowSeconds`, le champ
  // que le serveur renvoie avec `renonce_recent`, contient les six lettres de `window` sans être le
  // moindre accès au navigateur : une garde qui le refuserait obligerait à renommer un champ du
  // protocole pour lui plaire, et c'est le genre de contorsion qui finit par la faire désarmer.
  const mot = t => new RegExp('(^|[^A-Za-z0-9_$.])' + t.replace(/\./g, '\\.') + '(?![A-Za-z0-9_$])');
  for (const interdit of ['Date.now', 'Math.random', 'document', 'window', 'THREE', 'performance', 'fetch', 'localStorage'])
    assert.ok(!bloc.split('\n').some(l => mot(interdit).test(l) && !l.trim().startsWith('//')),
      `${interdit} n'a rien à faire dans le contrat du client`);
  // Et la garde attrape toujours ce pour quoi elle existe : le prouver ici évite de la croire.
  for (const faux of ['const t = Date.now();', 'if (window.x) return;', 'return Math.random();'])
    assert.ok(['Date.now', 'window', 'Math.random'].some(i => mot(i).test(faux)), faux);
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
  // Le pas fixe est une règle comme une autre : il ne connaît ni horloge ni navigateur, sans quoi
  // le serveur ne pourrait pas compter les pas d'une partie qu'il n'a pas vue tourner.
  assert.deepStrictEqual(S.SIM, C.SIM);
  assert.deepStrictEqual(S.simSteps(0.004, 0.031), C.simSteps(0.004, 0.031));
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

console.log('Le pas fixe');
// `simSteps` est le seul convertisseur entre le temps du navigateur et le temps de la simulation.
// Tout ce qui est en dessous s'appuie dessus : la durée d'une partie se compte en pas, donc une
// dérive ici serait une dérive sur le nombre que le serveur jugera.
test('le pas est fixe, et le rattrapage d\'une image est borné', () => {
  assert.strictEqual(C.SIM.stepS, 1 / 60);
  assert.ok(Number.isInteger(C.SIM.maxRattrapage) && C.SIM.maxRattrapage >= 1,
    'maxRattrapage est un nombre entier de pas');
});
test('simSteps conserve le temps sur dix mille images, sans dérive cumulée', () => {
  // Le mode de défaillance qu'on empêche : un accumulateur qui perd un morceau de milliseconde à
  // chaque image. Sur une partie de 154 secondes, dix mille images, cela déplacerait la fin du
  // gaz de plusieurs secondes — et deux rejeux de la même trace ne tomberaient pas d'accord.
  // Le `dt` reste sous le plafond de rattrapage : ce test-là parle de conservation, celui d'après
  // parle de la borne, et les mélanger cacherait l'un des deux.
  let graine = 20260912, alea = () => (graine = (graine * 1664525 + 1013904223) >>> 0) / 4294967296;
  let reste = 0, pas = 0, reel = 0;
  for (let i = 0; i < 10000; i++) {
    const dt = 0.002 + alea() * 0.048;           // de 500 à 20 images par seconde, bruité
    reel += dt;
    const s = C.simSteps(reste, dt);
    assert.ok(Number.isInteger(s.pas) && s.pas >= 0, `pas invalide à l'image ${i}: ${s.pas}`);
    assert.ok(s.reste >= 0 && s.reste < C.SIM.stepS, `reste hors bornes à l'image ${i}: ${s.reste}`);
    pas += s.pas; reste = s.reste;
  }
  const simule = pas * C.SIM.stepS + reste;
  assert.ok(Math.abs(simule - reel) < 1e-9,
    `dérive de ${(simule - reel)} s sur ${reel} s de temps réel`);
  // Et la conservation ne doit pas être obtenue en ne faisant jamais rien : il faut que des pas
  // soient réellement sortis, sinon le test passerait sur une fonction qui rend toujours zéro.
  assert.ok(pas > 9000, `seulement ${pas} pas rendus pour ${reel} s`);
});
test('une seule image ne peut jamais demander plus de maxRattrapage pas', () => {
  // Un onglet réveillé après quarante secondes réclamerait deux mille quatre cents pas d'un coup :
  // la page gèlerait, et l'image suivante serait à son tour trop longue — la spirale de la mort.
  // Le temps excédentaire est ABANDONNÉ, pas reporté : c'est ce que dit `reste` à zéro.
  for (const dt of [40, 1, 0.5, C.SIM.stepS * (C.SIM.maxRattrapage + 1), 1e9]) {
    const s = C.simSteps(0, dt);
    assert.ok(s.pas <= C.SIM.maxRattrapage, `${dt} s a rendu ${s.pas} pas`);
  }
  const long = C.simSteps(0, 40);
  assert.strictEqual(long.pas, C.SIM.maxRattrapage);
  assert.strictEqual(long.reste, 0, 'le surplus est abandonné, jamais reporté sur l\'image suivante');
  // Un reste déjà gros — invraisemblable, donc exactement ce qu'il faut tester — ne contourne pas
  // la borne non plus.
  assert.ok(C.simSteps(1000, 0).pas <= C.SIM.maxRattrapage);
});
test('un dt nul, négatif, NaN ou infini ne rend jamais un pas négatif ni NaN', () => {
  // `now - last` rend tout ça : zéro sur deux appels dans la même milliseconde, du négatif quand
  // l'horloge du système recule, du NaN au premier appel d'une boucle dont le repère n'est pas
  // encore posé. Un NaN qui entre dans l'accumulateur y reste pour toute la partie.
  const tordus = [0, -0, -1, -1e9, NaN, Infinity, -Infinity, undefined, null, '0.016', {}, []];
  for (const dt of tordus) {
    const s = C.simSteps(0, dt);
    assert.ok(Number.isInteger(s.pas) && s.pas >= 0, `dt=${String(dt)} rend pas=${s.pas}`);
    assert.ok(Number.isFinite(s.reste) && s.reste >= 0, `dt=${String(dt)} rend reste=${s.reste}`);
  }
  // Et un accumulateur déjà corrompu se répare au lieu de contaminer la suite.
  for (const reste of tordus) {
    const s = C.simSteps(reste, 0.02);
    assert.ok(Number.isInteger(s.pas) && s.pas >= 0, `reste=${String(reste)} rend pas=${s.pas}`);
    assert.ok(Number.isFinite(s.reste) && s.reste >= 0, `reste=${String(reste)} rend reste=${s.reste}`);
  }
  assert.deepStrictEqual(C.simSteps(0, 0), { pas: 0, reste: 0 });
  assert.deepStrictEqual(C.simSteps(0, -1), { pas: 0, reste: 0 }, 'une horloge qui recule ne fait pas reculer la partie');
});
test('simSteps est pure : elle ne garde rien entre deux appels', () => {
  // Tout l'état est dans les arguments. C'est ce qui permettra au serveur de rejouer la même
  // suite de pas sans avoir à rejouer la boucle d'images du navigateur.
  const a = C.simSteps(0.004, 0.031), b = C.simSteps(0.004, 0.031);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(C.simSteps(0.004, 0.031), a, 'et mille appels plus tard, toujours pareil');
});

console.log('Le verdict : une enveloppe de plausibilité, pas de l\'anti-triche');
// L'heure d'ouverture d'un billet, et l'heure à laquelle un rapport HONNÊTE arrive : le sas, la
// partie, et trois secondes de réseau. Tout ce qui est plus tôt que ça est de la triche d'horloge,
// tout ce qui est plus tard est une déconnexion — et une déconnexion n'annule rien.
const V_T0 = Date.parse('2026-03-01T18:00:00Z');
const V_BILLET = (extra = {}) => ({
  mode: 'solo', stakeCents: 50, seats: C.seatsOf(C.MODES.solo), seed: 12345,
  openedAt: V_T0, expiresAt: V_T0 + 3600_000, ...extra,
});
const V_RAPPORT = (extra = {}) => C.reportFrom({
  seconds: 60, kills: 0, deaths: 1, rank: 5, cubes: 0, damage: 0,
  cashedOut: false, purseCents: 0, declaredNetCents: 0, ...extra,
});
const V_RENDU = (rapport, billet, retardS = 3) =>
  V_T0 + (C.LOBBY.wait + rapport.seconds + retardS) * 1000;
// Chaque refus prononcé par les tests est retenu ici : à la fin, la liste doit coïncider avec
// ENVELOPPE.controles, ni un motif de trop, ni une ligne morte.
const V_MOTIFS = new Set();
function verdict(billet, rapport, maintenantMs){
  const v = C.matchVerdict(billet, rapport, maintenantMs);
  if (!v.ok) V_MOTIFS.add(v.controle);
  return v;
}
const V_MAXWIN = [C.MODES.solo, C.MODES.duo, C.MODES.trio];

test('le règlement ne lit jamais un montant du rapport : une sacoche énorme est ramenée à la borne', () => {
  // Le mensonge est refusé, ET le montant qui ressort du verdict est celui de la borne, pas celui
  // du rapport. Les deux comptent : le refus est le contrôle, la borne est la ceinture qui tient
  // encore le jour où quelqu'un desserre le contrôle.
  const b = V_BILLET({ mode: 'resurgence', seats: C.seatsOf(C.MODES.resurgence) });
  const max = C.purseBound(b.stakeCents, b.seats).maxCents;
  const r = V_RAPPORT({ seconds: 40, cashedOut: true, purseCents: 99_999_999, declaredNetCents: 79_999_999 });
  const v = verdict(b, r, V_RENDU(r));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.controle, 'sacoche');
  assert.strictEqual(v.sacocheCents, max, 'la sacoche doit être ramenée à mise × sièges');
  assert.strictEqual(v.netCents, 0);
  assert.ok(v.netCents <= C.cashoutCents(max).netCents, 'aucun chemin ne doit payer plus que la table');
});
test('un rapport sans aucun montant se règle quand même, et ne paie rien : le prix est la sacoche', () => {
  // Sacoche à zéro, net annoncé à zéro : la partie se règle sans broncher — c'est ce qui fait
  // qu'un client qui n'annonce rien n'est jamais bloqué. Mais elle ne paie rien, parce que le
  // prix MAXWIN est la sacoche emportée et qu'il n'y en a pas. Le pot forfaitaire, lui, n'est
  // qu'un plafond d'affichage : il ne sort plus de la caisse.
  const b = V_BILLET();
  const r = V_RAPPORT({ seconds: 154, rank: 1, kills: 0, purseCents: 0, declaredNetCents: 0 });
  const v = verdict(b, r, V_RENDU(r));
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.issue, 'victoire');
  assert.strictEqual(v.netCents, 0, 'une victoire les poches vides ne se paie pas le pot entier');
  assert.strictEqual(v.ecartCents, 0, 'et elle ne produit aucun écart : le jeu a versé zéro aussi');
});
test('mensonge refusé : plus de kills que adversaires × vies', () => {
  for (const mode of Object.values(C.MODES)) {
    const seats = C.seatsOf(mode), max = (seats - mode.teamSize) * C.livesFor(mode);
    const b = V_BILLET({ mode: mode.id, seats });
    const juste = V_RAPPORT({ seconds: 60, kills: max, rank: 2 });
    assert.strictEqual(verdict(b, juste, V_RENDU(juste)).ok, true,
      `${mode.id} : ${max} kills sont atteignables avec ${C.livesFor(mode)} vies`);
    const trop = V_RAPPORT({ seconds: 60, kills: max + 1, rank: 2 });
    const v = verdict(b, trop, V_RENDU(trop));
    assert.strictEqual(v.controle, 'kills', mode.id);
    assert.strictEqual(v.netCents, 0);
  }
});
test('mensonge refusé : une partie plus longue que le plan de zone', () => {
  const b = V_BILLET();
  const max = C.zoneTotalS(C.zonePlan(b.seed, C.MODES.solo)) + C.GRACE + C.ENVELOPPE.margeDureeS;
  const bord = V_RAPPORT({ seconds: max, rank: 2 });
  assert.strictEqual(verdict(b, bord, V_RENDU(bord)).ok, true, 'la borne elle-même est acceptée');
  const trop = V_RAPPORT({ seconds: max + 1, rank: 2 });
  const v = verdict(b, trop, V_RENDU(trop));
  assert.strictEqual(v.controle, 'duree');
  assert.strictEqual(v.limites.dureeMaxS, max);
});
test('mensonge refusé : une durée que l\'horloge du serveur n\'a pas eu le temps de contenir', () => {
  // Une partie de deux minutes trente, annoncée cinq secondes après avoir pris son billet. La
  // durée tient dans le plan de zone — c'est le chronomètre du serveur qui la refuse, sas compris.
  const b = V_BILLET();
  const r = V_RAPPORT({ seconds: 154, rank: 2 });
  const v = verdict(b, r, V_T0 + 5000);
  assert.strictEqual(v.controle, 'chronometre', JSON.stringify(v));
  assert.strictEqual(v.netCents, 0);
  // La même partie, rendue à l'heure, passe.
  assert.strictEqual(verdict(b, r, V_RENDU(r)).ok, true);
});
test('mensonge refusé : une victoire annoncée avant que l\'horloge du serveur ne l\'autorise', () => {
  // Le rapport passe le contrôle de chronomètre — la tolérance générale est large — et tombe
  // quand même, parce qu'une victoire est une revendication sur le pot et se juge plus serré.
  const b = V_BILLET();
  const r = V_RAPPORT({ seconds: 100, rank: 1 });
  const tot = V_T0 + 30_000;
  const v = verdict(b, r, tot);
  assert.strictEqual(v.controle, 'victoire', JSON.stringify(v));
  assert.strictEqual(v.netCents, 0);
  // La même partie, la même horloge, mais annoncée perdue : elle passe. C'est bien la victoire que
  // le serveur refuse, pas la durée.
  const perdue = V_RAPPORT({ seconds: 100, rank: 4 });
  assert.strictEqual(verdict(b, perdue, tot).ok, true);
  // Et une victoire instantanée est impossible même si l'horloge du serveur a tourné : il faut
  // (vies − 1) réapparitions pour épuiser le dernier adversaire.
  const eclair = V_RAPPORT({ seconds: 1, rank: 1 });
  assert.strictEqual(verdict(b, eclair, V_T0 + 3600_000 - 1).controle, 'victoire');
});
test('mensonge refusé : un encaissement avant la fin du verrou CASHOUT.lock', () => {
  const b = V_BILLET({ mode: 'resurgence', seats: C.seatsOf(C.MODES.resurgence) });
  const r = V_RAPPORT({ seconds: C.CASHOUT.lock - 1, kills: 3, cashedOut: true, purseCents: 200 });
  const v = verdict(b, r, V_RENDU(r));
  assert.strictEqual(v.controle, 'encaissement');
  const juste = V_RAPPORT({ seconds: C.CASHOUT.lock, kills: 3, cashedOut: true, purseCents: 200 });
  assert.strictEqual(verdict(b, juste, V_RENDU(juste)).ok, true, 'le verrou expiré, l\'encaissement passe');
  // Et le joueur qui encaisse sa PROPRE mise au coup d'envoi n'est pas un tricheur : le verrou
  // n'est armé que par un coup reçu ou un kill mis en banque, donc il n'a jamais couru pour lui.
  // Il perd 20 % pour rien, c'est une bêtise, pas une impossibilité.
  const presse = V_RAPPORT({ seconds: 1, cashedOut: true, purseCents: b.stakeCents });
  assert.strictEqual(verdict(b, presse, V_RENDU(presse)).ok, true);
});
test('mensonge refusé : plus de cubes que CUBE.max', () => {
  const b = V_BILLET();
  const bord = V_RAPPORT({ seconds: 60, rank: 2, cubes: C.CUBE.max });
  assert.strictEqual(verdict(b, bord, V_RENDU(bord)).ok, true);
  const trop = V_RAPPORT({ seconds: 60, rank: 2, cubes: C.CUBE.max + 1 });
  assert.strictEqual(verdict(b, trop, V_RENDU(trop)).controle, 'cubes');
});
test('mensonge refusé : une sacoche au-delà de mise × sièges', () => {
  for (const mode of Object.values(C.MODES)) {
    const seats = C.seatsOf(mode), b = V_BILLET({ mode: mode.id, seats, stakeCents: 1000 });
    const max = C.purseBound(1000, seats).maxCents;
    const bord = V_RAPPORT({ seconds: 60, rank: 2, purseCents: max });
    assert.strictEqual(verdict(b, bord, V_RENDU(bord)).ok, true, `${mode.id} : toute la table dans la sacoche est possible`);
    const trop = V_RAPPORT({ seconds: 60, rank: 2, purseCents: max + 1 });
    assert.strictEqual(verdict(b, trop, V_RENDU(trop)).controle, 'sacoche', mode.id);
  }
});
test('mensonge refusé : un rang au-delà du nombre d\'équipes de la table', () => {
  for (const mode of Object.values(C.MODES)) {
    const seats = C.seatsOf(mode), b = V_BILLET({ mode: mode.id, seats });
    const bord = V_RAPPORT({ seconds: 60, rank: mode.teams });
    assert.strictEqual(verdict(b, bord, V_RENDU(bord)).ok, true, mode.id);
    // Le dernier rang possible est le nombre d'équipes PLUS UNE : le test nommé ci-dessous dit
    // pourquoi, et c'est le branchement du jeu qui l'a prouvé, pas une lecture du code.
    const trop = V_RAPPORT({ seconds: 60, rank: mode.teams + 2 });
    assert.strictEqual(verdict(b, trop, V_RENDU(trop)).controle, 'rang', mode.id);
  }
});
test('joueur honnête accepté : éliminé en Duo pendant que son équipe se bat encore', () => {
  // Le rang que le jeu rend est celui du JOUEUR, pas celui de son équipe : `endMatch` reçoit
  // `aliveTeams().size + 1`, et `aliveTeams()` compte une équipe dès qu'un seul de ses membres
  // est encore en lice. Un joueur de Duo ou de Trio qui perd sa dernière vie alors que son
  // coéquipier tient encore, et qu'aucune équipe n'a encore été éliminée, annonce donc le nombre
  // d'équipes plus un. Borner au nombre d'équipes refusait ce joueur-là — exactement ce que la
  // phase interdit de faire.
  for (const mode of [C.MODES.duo, C.MODES.trio, C.MODES.resurgenceDuo]) {
    const seats = C.seatsOf(mode), b = V_BILLET({ mode: mode.id, seats });
    const r = V_RAPPORT({ seconds: 60, rank: mode.teams + 1, deaths: C.livesFor(mode) });
    const v = verdict(b, r, V_RENDU(r));
    assert.strictEqual(v.ok, true, `${mode.id} : ${v.controle} — ${v.motif}`);
    assert.strictEqual(v.issue, 'defaite', mode.id);
    assert.strictEqual(v.netCents, 0, 'une élimination ne paie rien');
  }
  // Et un rang de plus encore n'a plus d'explication honnête : il est refusé.
  const b = V_BILLET({ mode: 'duo', seats: C.seatsOf(C.MODES.duo) });
  const trop = V_RAPPORT({ seconds: 60, rank: C.MODES.duo.teams + 2 });
  assert.strictEqual(verdict(b, trop, V_RENDU(trop)).controle, 'rang');
});
test('le net d\'un carton plein retombe au centime sur teamPayout(...).winner', () => {
  // Le carton plein, c'est toute la table dans les poches d'un seul joueur. Dans les deux jeux le
  // prix est la sacoche, donc le même chemin les traite tous les cinq — et il retombe au centime
  // sur la fonction de paiement en dollars que le lobby affiche depuis toujours. C'est ce qui
  // garde le « WIN UP TO » honnête : le pot forfaitaire reste exactement le PLAFOND atteignable,
  // jamais un versement.
  for (const t of C.TIERS) {
    const stakeCents = C.toCents(t.stake);
    for (const mode of Object.values(C.MODES)) {
      const seats = C.seatsOf(mode), tp = C.teamPayout(t.stake, mode, C.RAKE);
      const max = C.purseBound(stakeCents, seats).maxCents;
      const b = V_BILLET({ mode: mode.id, seats, teamSize: mode.teamSize, stakeCents });
      const r = V_RAPPORT({
        seconds: 80, rank: 1, kills: (seats - mode.teamSize) * C.livesFor(mode),
        cashedOut: !!mode.cashout, purseCents: max,
      });
      const v = verdict(b, r, V_RENDU(r));
      assert.strictEqual(v.ok, true, `${mode.id} à ${t.stake} : ${v.motif}`);
      assert.strictEqual(v.netCents, C.toCents(tp.winner), `${mode.id} à ${t.stake}`);
      // Le plafond de la table — ce que `payoutCents` annonce au lobby — est atteint exactement,
      // jamais dépassé : c'est là toute la valeur qui reste à ce forfait.
      assert.strictEqual(v.netCents, C.payoutCents(stakeCents, mode).winnerCents, `${mode.id} à ${t.stake}`);
      assert.strictEqual(v.feeCents + v.netCents, v.grossCents, `${mode.id} à ${t.stake}`);
      assert.strictEqual(v.grossCents, max, 'le brut est la sacoche, dans les cinq modes');
    }
  }
});
test('la commission ne tombe jamais à zéro sur une table à 0,50 $', () => {
  const b = V_BILLET();
  // La sacoche est le brut, donc une victoire les poches vides n'a rien à taxer : le gagnant de
  // cette table repart au minimum avec sa propre mise, et c'est sur elle que la commission tombe.
  const gagne = V_RAPPORT({ seconds: 154, rank: 1, purseCents: b.stakeCents });
  const v = verdict(b, gagne, V_RENDU(gagne));
  assert.ok(v.feeCents > 0, 'une victoire à 0,50 $ sans commission');
  assert.strictEqual(v.feeCents + v.netCents, v.grossCents);
  // Et sur toutes les sacoches atteignables d'une table à 0,50 $ en Resurgence, au centime près.
  const res = V_BILLET({ mode: 'resurgence', seats: C.seatsOf(C.MODES.resurgence) });
  const max = C.purseBound(res.stakeCents, res.seats).maxCents;
  for (let sacoche = 1; sacoche <= max; sacoche++) {
    const r = V_RAPPORT({ seconds: 40, kills: 1, cashedOut: true, purseCents: sacoche });
    const w = verdict(res, r, V_RENDU(r));
    assert.strictEqual(w.ok, true, String(sacoche));
    assert.ok(w.feeCents > 0, `${sacoche} centimes encaissés sans commission`);
    assert.strictEqual(w.feeCents + w.netCents, w.grossCents, String(sacoche));
  }
});
test('un rapport honnête au bord de la tolérance est accepté', () => {
  // Refuser à tort coûte plus cher qu'accepter à tort tant qu'aucun argent n'est en jeu. Quatre
  // bords, tous atteints par un joueur honnête dont l'onglet a dormi ou dont l'horloge ment.
  const b = V_BILLET();
  const max = C.zoneTotalS(C.zonePlan(b.seed, C.MODES.solo)) + C.GRACE + C.ENVELOPPE.margeDureeS;
  const bords = [
    // la partie la plus longue que le plan de zone autorise
    [V_RAPPORT({ seconds: max, rank: 2 }), 3],
    // un rapport qui arrive une demi-heure après, mais avant l'expiration du billet : une
    // déconnexion n'annule rien, sinon couper le wifi serait la meilleure stratégie du jeu
    [V_RAPPORT({ seconds: 154, rank: 2 }), 1800],
    // un joueur dont le chronomètre avance plus vite que celui du serveur, au bord de la marge
    [V_RAPPORT({ seconds: 154, rank: 2 }), 3 - C.ENVELOPPE.margeHorlogeS],
    // une victoire annoncée au plus tôt que l'horloge du serveur autorise
    [V_RAPPORT({ seconds: 154, rank: 1 }), -C.ENVELOPPE.margeVictoireS],
  ];
  for (const [r, retard] of bords) {
    const v = verdict(b, r, V_RENDU(r, b, retard));
    assert.strictEqual(v.ok, true, `retard ${retard} : ${v.controle} — ${v.motif}`);
  }
  // La marge de victoire doit couvrir TOUT le sas : un billet demandé à la fin du sas donne un
  // coup d'envoi plus tôt que `openedAt + LOBBY.wait`, et ce joueur-là est honnête.
  assert.ok(C.ENVELOPPE.margeVictoireS > C.LOBBY.wait,
    'une marge de victoire plus courte que le sas refuserait des victoires honnêtes');
});
test('dans les DEUX jeux le montant est encadré, pas recalculé', () => {
  // L'invariant « aucun montant ne vient du client » ne vaut nulle part, et le test le dit au lieu
  // de le laisser croire : le net suit la sacoche déclarée, sur tout l'intervalle de la borne, en
  // Resurgence comme en MAXWIN. C'est faible, c'est honnête, et c'est une raison de plus pour
  // qu'aucun euro n'entre avant la phase 02b.
  const b = V_BILLET({ mode: 'resurgence', seats: C.seatsOf(C.MODES.resurgence) });
  const max = C.purseBound(b.stakeCents, b.seats).maxCents;
  assert.strictEqual(max, b.stakeCents * 50, 'l\'intervalle va de 0 à 50 mises en Resurgence');
  const nets = [0, 1, 50, 500, max].map(sacoche => {
    const r = V_RAPPORT({ seconds: 40, kills: 1, cashedOut: true, purseCents: sacoche });
    return verdict(b, r, V_RENDU(r)).netCents;
  });
  assert.deepStrictEqual(nets, [0, 1, 50, 500, max].map(s => C.cashoutCents(s).netCents));
  assert.ok(nets[4] > nets[0], 'le montant déclaré décide bel et bien du net');
  // En MAXWIN, la même mécanique, sur un intervalle de 0 à 20 mises. Le serveur recalculait ici un
  // pot forfaitaire que le jeu ne versait pas : quatre fois le montant affiché au joueur sur une
  // table STREET, et un `ecart_cents` qui mesurait ce désaccord au lieu d'un mensonge.
  const m = V_BILLET();
  const plafond = C.purseBound(m.stakeCents, m.seats).maxCents;
  assert.strictEqual(plafond, m.stakeCents * 20, 'l\'intervalle va de 0 à 20 mises en MAXWIN');
  const maxwin = [0, 42, plafond].map(sacoche => {
    const r = V_RAPPORT({ seconds: 154, rank: 1, purseCents: sacoche });
    return verdict(m, r, V_RENDU(r)).netCents;
  });
  assert.deepStrictEqual(maxwin, [0, 42, plafond].map(s => C.cashoutCents(s).netCents));
  // Et le forfait n'est plus qu'un plafond : il borne le net, il ne le fixe plus.
  assert.strictEqual(maxwin[2], C.payoutCents(m.stakeCents, C.MODES.solo).winnerCents);
  for (const n of maxwin) assert.ok(n <= C.payoutCents(m.stakeCents, C.MODES.solo).winnerCents);
});
test('en MAXWIN, `cashedOut` n\'ouvre aucune caisse : c\'est le mode qui décide du paiement', () => {
  // Il n'y a pas de bouton d'encaissement en MAXWIN. Un rapport qui le prétend ne doit surtout pas
  // basculer le règlement sur la sacoche déclarée : ce serait le seul chemin par lequel un client
  // MAXWIN choisirait son montant, et l'invariant « aucun montant ne vient du client » tomberait.
  const b = V_BILLET();
  const max = C.purseBound(b.stakeCents, b.seats).maxCents;
  const gagnee = V_RAPPORT({ seconds: 154, rank: 1, cashedOut: true, purseCents: max });
  const v = verdict(b, gagnee, V_RENDU(gagnee));
  assert.strictEqual(v.issue, 'victoire', 'un MAXWIN ne s\'encaisse pas, il se gagne');
  assert.strictEqual(v.netCents, C.cashoutCents(max).netCents);
  // Et surtout : une DÉFAITE reste une défaite. C'est le seul chemin par lequel un client MAXWIN
  // pourrait se payer sa sacoche sans gagner, et il est fermé.
  const perdue = V_RAPPORT({ seconds: 154, rank: 6, cashedOut: true, purseCents: max });
  const w = verdict(b, perdue, V_RENDU(perdue));
  assert.strictEqual(w.issue, 'defaite');
  assert.strictEqual(w.netCents, 0, 'une défaite MAXWIN ne s\'encaisse pas');
});
test('l\'écart entre le net annoncé et le net compté est mesuré, jamais payé', () => {
  const b = V_BILLET();
  const sacoche = 350;
  const attendu = C.cashoutCents(sacoche).netCents;
  for (const annonce of [0, 1, attendu, attendu + 1, 9_999_999]) {
    const r = V_RAPPORT({ seconds: 154, rank: 1, purseCents: sacoche, declaredNetCents: annonce });
    const v = verdict(b, r, V_RENDU(r));
    assert.strictEqual(v.netCents, attendu, 'le net annoncé n\'est jamais payé');
    assert.strictEqual(v.declaredNetCents, annonce);
    assert.strictEqual(v.ecartCents, annonce - attendu, 'l\'écart doit être rendu pour être stocké');
  }
  // Un refus mesure aussi : la partie ne comptera pour rien, la mesure reste.
  const menteur = V_RAPPORT({ seconds: 60, rank: 2, cubes: 99, declaredNetCents: 4242 });
  const v = verdict(b, menteur, V_RENDU(menteur));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.ecartCents, 4242);
});
test('une défaite ne paie rien, dans les cinq modes', () => {
  for (const mode of Object.values(C.MODES)) {
    const seats = C.seatsOf(mode);
    const b = V_BILLET({ mode: mode.id, seats });
    const r = V_RAPPORT({ seconds: 60, rank: Math.min(4, mode.teams), deaths: C.livesFor(mode),
                          purseCents: C.purseBound(b.stakeCents, seats).maxCents });
    const v = verdict(b, r, V_RENDU(r));
    assert.strictEqual(v.ok, true, mode.id);
    assert.strictEqual(v.issue, 'defaite', mode.id);
    assert.deepStrictEqual([v.grossCents, v.feeCents, v.netCents], [0, 0, 0], mode.id);
    // Et la sacoche déclarée, elle, est retenue quand même : une défaite ne la paie pas, elle la
    // mesure. C'est ce qui permettra de comparer plus tard ce qui a été porté et ce qui a été dit.
    assert.strictEqual(v.sacocheCents, C.purseBound(b.stakeCents, seats).maxCents, mode.id);
  }
});
test('un billet expiré ne se règle plus, et le dit avec son propre statut', () => {
  const b = V_BILLET();
  const r = V_RAPPORT({ seconds: 60, rank: 1 });
  assert.strictEqual(verdict(b, r, b.expiresAt).ok, true, 'la seconde d\'expiration elle-même passe encore');
  const v = verdict(b, r, b.expiresAt + 1);
  assert.strictEqual(v.controle, 'expire');
  assert.strictEqual(v.statut, 'expired', 'un billet périmé n\'est pas un rapport refusé');
  assert.strictEqual(v.netCents, 0);
});
test('un billet ou un rapport illisible est refusé, jamais réglé, et ne lance sur rien', () => {
  const bon = V_RAPPORT({ seconds: 60, rank: 2 });
  for (const billet of [null, undefined, {}, [], 42, 'billet', { mode: 'lune', stakeCents: 50, seats: 20 },
                        V_BILLET({ mode: 'constructor' }), V_BILLET({ stakeCents: 0 }),
                        V_BILLET({ openedAt: 'jamais' })]) {
    const v = verdict(billet, bon, V_T0 + 100_000);
    assert.strictEqual(v.ok, false, JSON.stringify(billet));
    assert.strictEqual(v.controle, 'billet', JSON.stringify(billet));
  }
  for (const rapport of [null, undefined, {}, [], 42, 'rapport', { ...bon, triche: 1 },
                         { ...bon, kills: 1.5 }, { ...bon, purseCents: null }]) {
    const v = verdict(V_BILLET(), rapport, V_T0 + 100_000);
    assert.strictEqual(v.ok, false, JSON.stringify(rapport));
    assert.strictEqual(v.controle, 'rapport', JSON.stringify(rapport));
    assert.strictEqual(v.netCents, 0);
  }
  // Une horloge absente ou folle ne doit pas non plus régler quoi que ce soit.
  for (const t of [undefined, null, NaN, Infinity, 'maintenant'])
    assert.strictEqual(verdict(V_BILLET(), bon, t).controle, 'billet', String(t));
});
test('mensonge refusé : plus de morts que de vies', () => {
  // Démontrable depuis les règles, exactement comme le plafond de kills : `endMatch` rend
  // `livesFor(mode) - lives`, et les vies ne descendent pas sous zéro. C'est le seul des trois
  // champs sans borne — deaths, damage, declaredNetCents — qui en admette une venue du jeu ;
  // les deux autres n'ont que la capacité de leur colonne, et le prétendre serait inventer.
  for (const mode of Object.values(C.MODES)) {
    const vies = C.livesFor(mode);
    const b = V_BILLET({ mode: mode.id, seats: C.seatsOf(mode), teamSize: mode.teamSize });
    const bord = V_RAPPORT({ seconds: 60, rank: 2, deaths: vies });
    assert.strictEqual(verdict(b, bord, V_RENDU(bord)).ok, true, `${mode.id} : mourir ${vies} fois est possible`);
    const trop = V_RAPPORT({ seconds: 60, rank: 2, deaths: vies + 1 });
    const v = verdict(b, trop, V_RENDU(trop));
    assert.strictEqual(v.controle, 'morts', mode.id);
    assert.strictEqual(v.limites.mortsMax, vies, mode.id);
  }
});
test('une victoire MAXWIN honnête ne produit JAMAIS d\'écart', () => {
  // LE TEST QUI MANQUAIT, ET QUI EST TOUT LE SUJET. Le jeu paie `cashoutPayout(pouch).net` et le
  // serveur réglait `payoutCents(mise, mode).splitCents` : deux règles pour le même gain, que rien
  // ne confrontait parce que les tests n'exerçaient que la rafle complète — le seul point où les
  // deux formules coïncident. Résultat : sur une table à 0,50 $, une victoire parfaitement honnête
  // écrivait `ecart_cents = -600`, et `GET /api/me` annonçait un BEST quatre fois supérieur à ce
  // que le portefeuille venait d'encaisser.
  //
  // Le rapport est construit ICI comme `endMatch` le construit : sacoche portée, et net annoncé
  // par la fonction que le jeu appelle pour créditer le portefeuille. Rien d'autre.
  for (const t of C.TIERS)
    for (const mode of V_MAXWIN)
      for (const kills of [0, 1, 4, 9, 19]) {
        const seats = C.seatsOf(mode), stakeCents = C.toCents(t.stake);
        if (kills > (seats - mode.teamSize) * C.livesFor(mode)) continue;
        // La sacoche naît à la mise et absorbe celle de chaque victime : le cas le plus simple, et
        // celui qu'un joueur atteint vraiment.
        const pouch = t.stake * (1 + kills);
        const rapport = C.reportFrom({
          seconds: 154, kills, deaths: 0, rank: 1, cubes: 0, damage: 1000, cashedOut: false,
          purseCents: C.toCents(pouch),
          declaredNetCents: C.toCents(C.cashoutPayout(pouch).net),
        });
        const b = V_BILLET({ mode: mode.id, seats, teamSize: mode.teamSize, stakeCents });
        const v = verdict(b, rapport, V_RENDU(rapport));
        const quoi = `${mode.id} à ${t.stake} avec ${kills} kills`;
        assert.strictEqual(v.ok, true, `${quoi} : ${v.controle} — ${v.motif}`);
        assert.strictEqual(v.issue, 'victoire', quoi);
        assert.strictEqual(v.netCents, rapport.declaredNetCents, `${quoi} : le serveur paie autre chose que l'écran`);
        assert.strictEqual(v.ecartCents, 0, `${quoi} : une partie honnête ne doit produire aucun écart`);
        assert.strictEqual(v.feeCents + v.netCents, v.grossCents, quoi);
      }
});
test('survivre jusqu\'au bout en Resurgence paie comme un encaissement, sans avoir appuyé sur le bouton', () => {
  // Ce chemin-là n'était atteint par aucun test des deux suites, alors que le jeu l'emprunte à
  // chaque partie de Resurgence qui va à son terme : `endMatch(true, {})` rend `rank: 1` et
  // `cashedOut: false` quand la dernière équipe debout est celle du joueur. C'est le SEUL cas où
  // un mode cashout se règle sans encaissement, et remplacer `victoire` par `defaite` dans cette
  // branche laissait toute la suite verte pendant que chaque survivant était payé zéro.
  for (const mode of [C.MODES.resurgence, C.MODES.resurgenceDuo]) {
    const seats = C.seatsOf(mode), b = V_BILLET({ mode: mode.id, seats, teamSize: mode.teamSize });
    const sacoche = 700;
    const r = V_RAPPORT({ seconds: 120, kills: 3, rank: 1, cashedOut: false, purseCents: sacoche });
    const v = verdict(b, r, V_RENDU(r));
    assert.strictEqual(v.ok, true, `${mode.id} : ${v.controle} — ${v.motif}`);
    assert.strictEqual(v.issue, 'victoire', `${mode.id} : ni encaissement, ni défaite`);
    assert.strictEqual(v.netCents, C.cashoutCents(sacoche).netCents, mode.id);
    assert.strictEqual(v.feeCents + v.netCents, v.grossCents, mode.id);
    // Et le survivant à sacoche vide reste une VICTOIRE payée zéro. C'est ce qui distingue une
    // défaite réelle d'une victoire sans butin, et `wins` compte la seconde.
    const nu = V_RAPPORT({ seconds: 120, kills: 0, rank: 1, cashedOut: false, purseCents: 0 });
    const w = verdict(b, nu, V_RENDU(nu));
    assert.strictEqual(w.issue, 'victoire', mode.id);
    assert.strictEqual(w.netCents, 0, mode.id);
  }
});
test('aucun montant rendu par le verdict ne sort du domaine d\'un integer Postgres', () => {
  // `declared_net_cents` et `ecart_cents` sont des `integer`, donc 2 147 483 647 au plus. Un
  // rapport qui dépasse est refusé par `checkReport` en amont — mais le verdict clampe quand même,
  // parce que le jour où ce contrôle sautera, l'écriture doit échouer sur une règle et non sur un
  // `22003` qui rend 500 et laisse le billet ouvert : le joueur est alors enfermé dans un billet
  // mort jusqu'à l'expiration, puisqu'il n'en a qu'un à la fois.
  const b = V_BILLET();
  for (const annonce of [0, 1, C.PG_INT4_MAX, C.PG_INT4_MAX + 1, Number.MAX_SAFE_INTEGER]) {
    // Le rapport est forgé à la main : `checkReport` refuserait les deux derniers, et c'est bien
    // le chemin d'après qu'on éprouve ici.
    const r = { ...V_RAPPORT({ seconds: 154, rank: 1, purseCents: 500 }), declaredNetCents: annonce };
    const v = C.matchVerdict(b, r, V_RENDU(r));
    for (const [nom, x] of [['declaredNetCents', v.declaredNetCents], ['ecartCents', v.ecartCents],
                            ['grossCents', v.grossCents], ['feeCents', v.feeCents], ['netCents', v.netCents]])
      assert.ok(Number.isSafeInteger(x) && x >= -2147483648 && x <= C.PG_INT4_MAX,
        `${nom} vaut ${x} pour un net annoncé de ${annonce}`);
  }
});
test('les bornes du verdict viennent du billet, pas du mode d\'aujourd\'hui', () => {
  // `seats` et `teamSize` sont recopiés dans la ligne pour une raison précise : un résultat est
  // accepté jusqu'à l'expiration du billet, soit une bonne dizaine de minutes, et un serveur qui
  // redémarre entre-temps avec un `teams` corrigé jugerait la partie contre une table que
  // personne n'a achetée. Le billet ci-dessous décrit un Trio à 30 sièges ; `MODES.trio` en
  // annonce 30 aujourd'hui, mais le verdict ne doit pas avoir besoin de le savoir.
  const b = V_BILLET({ mode: 'trio', stakeCents: 100, seats: 24, teamSize: 4 });
  const r = V_RAPPORT({ seconds: 60, rank: 2 });
  const v = verdict(b, r, V_RENDU(r));
  assert.strictEqual(v.limites.killsMax, (24 - 4) * C.livesFor(C.MODES.trio), 'killsMax lit le billet');
  assert.strictEqual(v.limites.rangMax, 24 / 4 + 1, 'rangMax lit le billet');
  assert.strictEqual(v.limites.sacocheMaxCents, 100 * 24, 'la borne de sacoche lit le billet');
  // Et un billet sans `teamSize` — une ligne écrite avant que la colonne n'existe — retombe sur le
  // mode plutôt que de refuser une partie honnête.
  const vieux = V_BILLET({ mode: 'trio', stakeCents: 100, seats: 30 });
  const w = verdict(vieux, r, V_RENDU(r));
  assert.strictEqual(w.limites.killsMax, (30 - C.MODES.trio.teamSize) * C.livesFor(C.MODES.trio));
  // Enfin, le chemin de l'ARGENT ne lit plus le mode du tout : il ne connaît que la sacoche et la
  // borne du billet. C'est ce qui ferme définitivement ce trou-là.
  const paye = V_RAPPORT({ seconds: 154, rank: 1, purseCents: 1200 });
  assert.strictEqual(verdict(b, paye, V_RENDU(paye)).netCents, C.cashoutCents(1200).netCents);
});
// ---- LE PLANCHER D'HORLOGE (phase 04a, module 2).
//
// Le billet de la table la plus chère du dossier : Resurgence à 10 $, cinquante sièges. C'est elle
// qui porte le pire cas d'exposition, donc c'est sur elle que le plancher se juge.
const V_RESURGENCE = () => V_BILLET({
  mode: 'resurgence', seats: C.seatsOf(C.MODES.resurgence),
  teamSize: C.MODES.resurgence.teamSize, stakeCents: C.toCents(10),
});
// L'encaissement maximal de cette table : toute la table dans une seule sacoche, sortie à 30 s.
const V_ENCAISSEMENT_MAX = b => V_RAPPORT({
  seconds: 30, kills: 20, deaths: 0, rank: 4, cashedOut: true,
  purseCents: C.purseBound(b.stakeCents, b.seats).maxCents,
});

test('LE TROU EST MONTRÉ AVANT D\'ÊTRE FERMÉ : un encaissement Resurgence à 30 s, zéro seconde après le billet', () => {
  // CE QUE CE TEST PROUVE, ET IL LUI FAUT LES DEUX MOITIÉS. La première montre le trou tel qu'il
  // existait : aucune des bornes de la 02a ne touche ce rapport, contrôle par contrôle, y compris
  // le chronomètre — `margeHorlogeS` vaut 120 pour un sas de 25, donc l'inéquation est satisfaite
  // dès l'instant zéro. La ligne se réglait, et l'attente réelle exigée était NULLE.
  //
  // C'est ce qui dimensionne la phase : la partie est une fonction pure de `seed_public`, que le
  // client reçoit avec son billet, et elle se rejoue en quelques centaines de millisecondes.
  // Chercher hors ligne la trace qui maximise l'argent emporté ne demande aucun talent. Le plancher
  // ne ferme pas cette porte — il la ramène au rythme d'un joueur.
  const b = V_RESURGENCE();
  const r = V_ENCAISSEMENT_MAX(b);
  const ecouleS = 0;
  const vies = C.livesFor(C.MODES.resurgence);
  assert.ok(r.kills <= (b.seats - b.teamSize) * vies, 'kills : la 02a laissait passer');
  assert.ok(r.deaths <= vies, 'morts : la 02a laissait passer');
  assert.ok(r.cubes <= C.CUBE.max, 'cubes : la 02a laissait passer');
  assert.ok(r.purseCents <= C.purseBound(b.stakeCents, b.seats).maxCents, 'sacoche : la 02a laissait passer');
  assert.ok(r.seconds <= C.zoneTotalS(C.zonePlan(b.seed, C.MODES.resurgence)) + C.GRACE + C.ENVELOPPE.margeDureeS,
    'durée : la 02a laissait passer');
  assert.ok(r.seconds >= C.CASHOUT.lock, 'le verrou d\'encaissement est purgé : la 02a laissait passer');
  assert.ok(r.seconds <= ecouleS - C.LOBBY.wait + C.ENVELOPPE.margeHorlogeS,
    'le chronomètre de la 02a laissait passer ce rapport à l\'instant zéro : sans cela, il n\'y aurait pas de trou');
  // Et voilà ce que ce règlement sortait de la caisse. Le pire cas du domaine, celui dont
  // `api/ledger.js` dérive son plafond par joueur.
  assert.strictEqual(C.cashoutCents(r.purseCents).netCents - b.stakeCents, 39000,
    'la table la plus chère expose la maison de 39 000 centimes par billet');

  // La seconde moitié : le plancher, et lui seul, refuse.
  const v = verdict(b, r, V_T0 + ecouleS * 1000);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.controle, 'plancher', JSON.stringify(v));
  assert.ok(v.motif && v.motif.length > 10, 'un refus doit dire pourquoi');
  assert.strictEqual(v.netCents, 0, 'un refus ne paie rien');
  assert.strictEqual(v.grossCents, 0);
  // La mesure survit au refus, comme sur tous les autres : la sacoche bornée sort quand même.
  assert.strictEqual(v.sacocheCents, C.purseBound(b.stakeCents, b.seats).maxCents);
});
test('le même encaissement, après une attente réelle honnête, est ACCEPTÉ et payé', () => {
  // Le plancher renchérit, il n'interdit pas : le joueur qui a réellement attendu le sas puis joué
  // sa partie touche exactement ce que la table promet.
  const b = V_RESURGENCE();
  const r = V_ENCAISSEMENT_MAX(b);
  const v = verdict(b, r, V_RENDU(r));
  assert.strictEqual(v.ok, true, `${v.controle} — ${v.motif}`);
  assert.strictEqual(v.issue, 'encaissement');
  assert.strictEqual(v.netCents, C.cashoutCents(r.purseCents).netCents);
  assert.strictEqual(v.feeCents + v.netCents, v.grossCents);
  // LE BORD EXACT, DES DEUX CÔTÉS. Le plancher est `LOBBY.wait + secondes − margePlancherS`, et il
  // est atteint à la milliseconde : une de moins refuse, la borne elle-même passe. Sans ces deux
  // assertions, un décalage d'une seconde dans la marge ne ferait tomber aucun test.
  const bord = V_T0 + (C.LOBBY.wait + r.seconds - C.ENVELOPPE.margePlancherS) * 1000;
  assert.strictEqual(verdict(b, r, bord).ok, true, 'la borne elle-même est acceptée');
  assert.strictEqual(verdict(b, r, bord - 1).controle, 'plancher', 'une milliseconde plus tôt est refusée');
  // Et la fonction pure rend la même chose que le verdict, puisque c'est elle qu'il appelle.
  assert.strictEqual(C.horlogePlancher(b, r, bord), true);
  assert.strictEqual(C.horlogePlancher(b, r, bord - 1), false);
});
test('un règlement qui ne paie RIEN n\'est jamais refusé par le plancher : la marge large le couvre', () => {
  // L'ARBITRAGE EST ÉCRIT ICI, et il n'a pas changé depuis la 02a : un onglet en arrière-plan, un
  // téléphone endormi et une horloge locale fausse sont beaucoup plus fréquents qu'un tricheur, et
  // refuser une partie honnête coûte un joueur. Le plancher ne s'arme donc que là où de l'argent
  // sort réellement de la caisse ; partout ailleurs, `margeHorlogeS` et ses 120 secondes couvrent
  // toujours.
  const b = V_RESURGENCE();
  // (1) Une défaite, au bord même de la tolérance large, plus de deux minutes AVANT ce que le
  //     plancher exigerait d'un règlement qui paie.
  const perdue = V_RAPPORT({ seconds: 154, rank: 4, deaths: C.livesFor(C.MODES.resurgence) });
  const tard = V_RENDU(perdue, b, 3 - C.ENVELOPPE.margeHorlogeS);
  assert.strictEqual(C.horlogePlancher(b, perdue, tard), false, 'le plancher n\'aurait pas été franchi');
  const d = verdict(b, perdue, tard);
  assert.strictEqual(d.ok, true, `une défaite refusée pour une horloge : ${d.controle} — ${d.motif}`);
  assert.strictEqual(d.issue, 'defaite');
  // (2) Un encaissement dont la commission absorbe tout : un centime de sacoche, zéro de net. Il ne
  //     sort rien de la caisse, donc il n'a rien à protéger.
  const miette = V_RAPPORT({ seconds: 30, rank: 4, cashedOut: true, purseCents: 1 });
  const nul = verdict(b, miette, V_T0);
  assert.strictEqual(nul.ok, true, `${nul.controle} — ${nul.motif}`);
  assert.strictEqual(nul.issue, 'encaissement');
  assert.strictEqual(nul.netCents, 0, 'un centime de sacoche ne paie rien après commission');
  // (3) LE FIL DU RASOIR : deux centimes de sacoche paient UN centime, et ce centime-là suffit à
  //     armer le plancher. C'est la preuve que la condition d'armement est bien « ça paie », et pas
  //     un seuil choisi au jugé.
  const sou = V_RAPPORT({ seconds: 30, rank: 4, cashedOut: true, purseCents: 2 });
  assert.strictEqual(C.cashoutCents(2).netCents, 1);
  assert.strictEqual(verdict(b, sou, V_T0).controle, 'plancher');
});
test('la branche victoire garde ses DEUX planchers, et le nouveau ne les double pas', () => {
  // Le plancher d'horloge s'arme sur tout chemin qui paie, victoire comprise — mais il est écrit
  // UNE fois, après le calcul du montant, et la branche `victoire` garde ses contrôles à elle, qui
  // mordent plus tôt et sous leur propre motif. Deux inéquations de même sens dans la même fonction
  // seraient deux règles à corriger le jour où l'une bouge.
  const b = V_BILLET();
  // (1) Le plancher démontrable depuis les règles : (vies − 1) réapparitions pour épuiser le
  //     dernier adversaire. L'horloge du serveur a tout le temps du monde, et il mord quand même.
  const eclair = V_RAPPORT({ seconds: 1, rank: 1, purseCents: 500 });
  assert.strictEqual(verdict(b, eclair, V_T0 + 3600_000 - 1).controle, 'victoire',
    'le plancher des réapparitions a disparu');
  // (2) Le plancher d'horloge propre à la victoire, `margeVictoireS`. Il tombe AVANT le nouveau, et
  //     c'est son motif qui sort : la branche n'a pas changé de comportement.
  const tot = V_RAPPORT({ seconds: 100, rank: 1, purseCents: 500 });
  assert.strictEqual(verdict(b, tot, V_T0 + 30_000).controle, 'victoire',
    'le refus d\'une victoire trop précoce doit rester nommé `victoire`, pas `plancher`');
  // (3) Et la victoire au bord exact de `margeVictoireS` passe toujours : les deux marges valent 30
  //     pour la même raison — elles doivent couvrir tout le sas — donc le nouveau contrôle ne
  //     resserre rien sur ce chemin-là.
  assert.strictEqual(C.ENVELOPPE.margePlancherS, C.ENVELOPPE.margeVictoireS,
    'les deux marges répondent à la même question : le sas peut avoir été plus court qu\'il n\'y paraît');
  assert.ok(C.ENVELOPPE.margePlancherS > C.LOBBY.wait,
    'une marge de plancher plus courte que le sas refuserait des règlements honnêtes');
  const juste = V_RAPPORT({ seconds: 154, rank: 1, purseCents: 500 });
  assert.strictEqual(verdict(b, juste, V_RENDU(juste, b, -C.ENVELOPPE.margeVictoireS)).ok, true);
  // Et la garde textuelle : un seul appel, et pas dans la branche victoire.
  const corps = core.slice(core.indexOf('function matchVerdict('), core.indexOf('  return { MAP, PLAYERS,'));
  assert.ok(corps.length > 2000, 'le corps de matchVerdict n\'a pas été retrouvé');
  assert.strictEqual((corps.match(/horlogePlancher\(/g) || []).length, 1,
    'le plancher doit être armé une seule fois, sur le chemin qui paie');
  const branche = corps.slice(corps.indexOf('if (victoire) {'), corps.indexOf('// Le verrou d\'encaissement'));
  assert.ok(branche.includes('margeVictoireS') && branche.includes('RESPAWN'),
    'la branche victoire a perdu l\'un de ses deux planchers, ou la découpe a glissé');
  assert.ok(!branche.includes('horlogePlancher'),
    'le plancher est dupliqué dans la branche victoire : deux inéquations de même sens, une seule à corriger le jour où l\'une bouge');
});
test('horlogePlancher ne lit AUCUNE horloge : elle la reçoit, comme renonciationOuverte', () => {
  // La jumelle du contrôle `chronometre`, et la même discipline que la fenêtre de renoncement : une
  // horloge lue à l'intérieur rendrait la fonction intestable et donnerait deux réponses
  // différentes des deux côtés du réseau.
  const d = core.indexOf('function horlogePlancher(');
  assert.ok(d >= 0, 'horlogePlancher n\'a pas été retrouvée dans WBCore');
  const texte = core.slice(d, core.indexOf('\n  }', d))
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  for (const interdit of ['Date.now', 'new Date', 'performance', 'Math.random', 'document', 'THREE'])
    assert.ok(!texte.includes(interdit), `le plancher lit ${interdit}`);
  // Mêmes arguments, même réponse, mille fois de suite.
  const b = V_BILLET(), r = V_RAPPORT({ seconds: 60 });
  const a = C.horlogePlancher(b, r, V_T0 + 50_000);
  for (let i = 0; i < 1000; i++) assert.strictEqual(C.horlogePlancher(b, r, V_T0 + 50_000), a);
  // Elle accepte les trois écritures d'un instant, comme le reste du verdict : le pilote Postgres
  // rend une `timestamptz` en objet Date, une réponse JSON la rend en chaîne ISO, un test la donne
  // en nombre. Les trois doivent répondre pareil, sinon le plancher dépendrait de la plomberie.
  const t = V_T0 + (C.LOBBY.wait + 60 - C.ENVELOPPE.margePlancherS) * 1000;
  for (const ouvert of [V_T0, new Date(V_T0), new Date(V_T0).toISOString()])
    for (const maintenant of [t, new Date(t), new Date(t).toISOString()])
      assert.strictEqual(C.horlogePlancher({ openedAt: ouvert }, r, maintenant), true);
  // Un plancher qu'on ne sait pas mesurer ne se franchit pas : billet illisible, rapport illisible,
  // horloge absente rendent tous `false`. C'est le sens prudent — sur un chemin qui paie.
  for (const cas of [[null, r, t], [{}, r, t], [b, null, t], [b, { seconds: 'x' }, t], [b, r, null], [b, r, 'demain']])
    assert.strictEqual(C.horlogePlancher(cas[0], cas[1], cas[2]), false, JSON.stringify(cas));
});
test('le verdict ne rend aucun motif absent d\'ENVELOPPE, et aucune ligne d\'ENVELOPPE n\'est morte', () => {
  // Ce test est le seul qui relie la liste écrite au code qui l'applique. Ajouter un contrôle sans
  // l'inscrire dans ENVELOPPE, ou laisser une ligne qui ne refuse plus rien, le fait tomber.
  const declares = Object.keys(C.ENVELOPPE.controles).sort();
  assert.deepStrictEqual([...V_MOTIFS].sort(), declares,
    'les motifs réellement prononcés par les tests doivent être exactement ceux qu\'ENVELOPPE annonce');
  for (const m of declares) assert.ok(C.ENVELOPPE.controles[m].length > 10, m);
});
test('le verdict est nommé pour ce qu\'il est : une enveloppe de plausibilité, pas de l\'anti-triche', () => {
  // Écrite seulement dans le README, cette limite serait oubliée exactement le jour où elle
  // protégerait de l'argent. Elle doit donc être lisible dans le code, dans le nom de la constante
  // qui liste les contrôles, et dans le nom de ces tests.
  const bloc = core.slice(core.indexOf('// ---- Le verdict d\'une partie'), core.indexOf('  return { MAP, PLAYERS,'));
  assert.ok(bloc.length > 2000, 'le bloc du verdict n\'a pas été retrouvé dans CORE');
  const entete = bloc.slice(0, bloc.indexOf('const ENVELOPPE'));
  assert.match(entete, /ENVELOPPE DE PLAUSIBILITÉ, PAS DE L'ANTI-TRICHE/);
  // L'AVEU DE LA 02a EST LEVÉ, ET L'EN-TÊTE DOIT LE DIRE. Il a longtemps annoncé « le serveur ne
  // rejoue pas la partie » et « la sacoche est DÉCLARÉE par le client » : c'est exactement ce que
  // le module 7 a renversé, et un commentaire faux à l'endroit qui décide d'un montant est pire
  // que pas de commentaire — la phase 03 y lira quelles lignes sont opposables.
  assert.ok(!/ne rejoue pas la partie/.test(entete),
    'l\'en-tête prétend encore que le serveur ne rejoue pas : c\'est faux depuis le module 7');
  assert.ok(!/DÉCLARÉ par le client/.test(entete),
    'l\'en-tête prétend encore que la sacoche est déclarée : elle sort du rejeu');
  assert.match(entete, /le serveur REJOUE la partie/, 'l\'en-tête doit dire ce que le serveur fait');
  assert.match(entete, /AUCUN MONTANT NE VIENT PLUS DU CLIENT/, 'et ce que cela a changé du montant');
  assert.match(entete, /cesse d'être la seule protection/,
    'la raison d\'être qui RESTE doit être écrite : l\'enveloppe n\'est plus la seule protection');
  // Les deux contrôles « évidents et faux », eux, n'ont pas bougé d'un mot : ils restent exacts.
  assert.match(entete, /DEUX CONTRÔLES « ÉVIDENTS » SONT FAUX/, 'les deux pièges doivent rester écrits');
  assert.match(entete, /PLAFOND/, 'le sort de payoutCents doit être écrit : un plafond, pas un versement');
  assert.match(entete, /JAMAIS payé ni cru/, 'le sort de declaredNetCents doit être écrit');
  assert.strictEqual(typeof C.ENVELOPPE.controles, 'object');
  const nomsDeTests = fs.readFileSync(path.join(__dirname, 'test.js'), 'utf8');
  assert.ok(nomsDeTests.includes('Le verdict : une enveloppe de plausibilité, pas de l\\\'anti-triche'),
    'la section de tests doit porter le nom de ce que la fonction est');
});

console.log('Le jeu prend son billet, et sait s\'en passer');
// Le bloc Game n'est pas testable ici : il lui faut un navigateur. Ce qui EST testable, c'est la
// décision qu'il délègue — et le fait qu'il la délègue vraiment. Les tests de forme ci-dessous
// lisent donc le texte du fichier après /*SIM-END*/ : ils ne prouvent pas que le jeu tourne, ils
// prouvent qu'aucune règle n'a été recopiée à côté de celle qui est testée. La seule preuve que
// le jeu tourne reste un humain qui joue une partie.
// `JEU` s'arrête à SIM-END et non plus à CORE-END : le bloc SIM, lui, s'exécute pour de vrai dans
// ce fichier, et le mélanger au texte du bloc `Game` ferait passer une garde textuelle pour une
// preuve sur du code qui, lui, est éprouvé autrement.
const JEU = html.slice(html.indexOf('/*SIM-END*/'));
test('un billet qui décrit une autre table ne se joue pas : la graine locale reprend la main', () => {
  // Le serveur n'ouvre qu'un billet à la fois et rend le billet déjà ouvert quelle que soit la
  // table redemandée. Quitter le sas puis revenir sur une autre table laisse donc en main un
  // billet qui parle d'ailleurs : le jouer ferait juger la partie contre les mauvais chiffres.
  const billet = { id: '12', mode: 'solo', stakeCents: 50, seats: 20, brawler: 'bolt',
                   seed: 4242, status: 'open' };
  assert.strictEqual(C.ticketFor(billet, 'solo', 50), billet, 'la table du billet, elle, se joue');
  assert.strictEqual(C.ticketFor(billet, 'duo', 50), null, 'un autre mode');
  assert.strictEqual(C.ticketFor(billet, 'solo', 100), null, 'une autre mise');
  assert.strictEqual(C.ticketFor(billet, 'solo', C.toCents(10)), null, 'la table SHARK sur un billet STREET');
  // Le brawler n'entre pas dans la comparaison : en changer n'est pas changer de partie.
  assert.strictEqual(C.ticketFor({ ...billet, brawler: 'ghost' }, 'solo', 50).id, '12');
  // Et c'est la composition avec seedFor qui tient la promesse : un billet qui ne convient pas
  // fait exactement ce que fait un billet absent.
  assert.strictEqual(C.seedFor(C.ticketFor(billet, 'duo', 50), 777), 777);
  assert.strictEqual(C.seedFor(C.ticketFor(billet, 'solo', 50), 777), 4242);
});
test('ticketFor ne lance sur rien, et refuse un billet qui n\'est plus ouvert', () => {
  for (const rien of [null, undefined, {}, [], 42, 'billet', Object.create(null)])
    assert.strictEqual(C.ticketFor(rien, 'solo', 50), null, Object.prototype.toString.call(rien));
  const billet = { id: '12', mode: 'solo', stakeCents: 50, seed: 1, status: 'open' };
  for (const statut of ['settled', 'rejected', 'expired', undefined, ''])
    assert.strictEqual(C.ticketFor({ ...billet, status: statut }, 'solo', 50), null, String(statut));
  // Une mise que l'appelant n'a pas su convertir ne doit jamais passer pour une correspondance.
  for (const mise of [null, undefined, NaN, '50', 50.5])
    assert.strictEqual(C.ticketFor(billet, 'solo', mise), null, String(mise));
});
test('un règlement rendu par le serveur n\'est pas un compte, et ne doit pas être lu comme tel', () => {
  // Le règlement porte le verdict d'UNE partie — douze clés, aucune statistique. Le lire comme un
  // compte remettrait les quatre compteurs à zéro : `applyAccount` garde le pseudo et l'avatar,
  // mais les statistiques, elles, sont remplacées par ce qu'annonce l'objet reçu. C'est voulu —
  // sinon une statistique fausse ne pourrait jamais redescendre — et c'est exactement pourquoi le
  // jeu redemande /api/me après un règlement au lieu de recycler la réponse.
  const avatars = C.avatarList(Object.keys(C.BRAWLERS));
  const local = { name: 'Loic', avatar: avatars[2].id, stats: { matches: 3, wins: 1, kills: 9, best: 5 } };
  const reglement = { matchId: '12', status: 'settled', issue: 'victoire', controle: null, motif: null,
                      grossCents: 1000, feeCents: 200, netCents: 800, purseCents: 1000,
                      declaredNetCents: 800, ecartCents: 0, settledAt: '2026-03-01T18:05:00Z' };
  const p = C.applyAccount(local, reglement, avatars);
  assert.strictEqual(p.name, 'Loic', 'un règlement n\'a pas de pseudo, et n\'a pas à en effacer un');
  assert.strictEqual(p.avatar, avatars[2].id);
  assert.deepStrictEqual(p.stats, { matches: 0, wins: 0, kills: 0, best: 0 },
    'aucune statistique dans un règlement : le lire comme un compte les efface');
  // Et le vrai chemin, celui que le jeu emprunte : /api/me, dont l'agrégat porte les quatre.
  const q = C.applyAccount(local, { stats: { matches: 4, wins: 2, kills: 11, best: 800 } }, avatars);
  assert.deepStrictEqual(q.stats, { matches: 4, wins: 2, kills: 11, best: 8 });
});
test('le jeu tire sa graine de seedFor, et ne la tire plus lui-même', () => {
  const start = JEU.slice(JEU.indexOf('function startMatch('), JEU.indexOf('// ---------- end screen'));
  assert.ok(start.length > 500, 'startMatch n\'a pas été retrouvée');
  assert.match(start, /const seed=C\.seedFor\(billet,graineLocale\)/, 'la graine passe par seedFor');
  // La graine de secours est toujours là, et c'est bien elle qu'on donne à seedFor : sans compte,
  // sans serveur, sans réseau, la partie repart exactement comme avant la phase.
  assert.match(start, /const graineLocale=\(Date\.now\(\)\^\(Math\.random\(\)\*1e9\)\)>>>0/);
  const lignes = start.split('\n').filter(l => /Math\.random\(\)\*1e9/.test(l) && !l.trim().startsWith('//'));
  assert.strictEqual(lignes.length, 1, 'un seul tirage de graine, et il sert de secours');
  assert.ok(!/const seed=\(Date\.now\(\)/.test(start), 'la graine ne se tire plus directement dans startMatch');
});
test('le sas d\'attente ne regarde jamais le réseau pour lancer la partie', () => {
  // L'invariant le plus important de la phase : un billet qui tarde ne retarde JAMAIS le coup
  // d'envoi. Le sas demande son billet et n'en reparle plus ; c'est son chronomètre qui tranche.
  const sas = JEU.slice(JEU.indexOf('function enterWaiting('), JEU.indexOf('function wFeed('));
  assert.ok(sas.length > 500, 'enterWaiting n\'a pas été retrouvée');
  assert.match(sas, /Match\.sas\(selMode,stake,selBrawler\)/);
  assert.ok(!/await/.test(sas), 'enterWaiting ne doit rien attendre');
  const tick = JEU.slice(JEU.indexOf('function waitTick('), JEU.indexOf('$(\'wLeave\')'));
  assert.ok(tick.includes('startMatch(st,eco)'), 'waitTick n\'a pas été retrouvée');
  for (const interdit of ['await', 'fetch', 'Auth.', 'ticket', 'billet'])
    assert.ok(!tick.includes(interdit), `le décompte du sas ne doit pas connaître ${interdit}`);
});
test('le rapport part par reportFrom, et les faits par WBSim.faits', () => {
  const fin = JEU.slice(JEU.indexOf('function endMatch('), JEU.indexOf('// ---------- live wins ticker'));
  assert.ok(fin.length > 2000, 'endMatch n\'a pas été retrouvée');
  assert.match(fin, /Match\.fin\(\{/, 'la fin de partie passe par le module du billet');
  const rapport = fin.slice(fin.indexOf('Match.fin({'), fin.indexOf('setTimeout('));
  // LES FAITS VIENNENT DE SIM, PAS DU RENDU. Le serveur recalcule les mêmes champs en rejouant la
  // partie : les redéfinir ici ferait deux idées de ce qu'est une durée ou un rang, et le rejeu
  // jugerait une autre partie que celle que l'écran vient d'afficher.
  assert.match(rapport, /\.\.\.faits\(G\)/, 'endMatch redéfinit les faits au lieu de les lire dans SIM');
  assert.match(rapport, /declaredNetCents:C\.toCents\(netGagne\)/);
  assert.match(rapport, /digests:C\.digestsEncode\(G\.empreintes\)/);
  // Aucun montant construit à la main : la conversion dollars → centimes a UN seul point, et
  // c'est toCents. Une multiplication par 100 ici serait un second, exactement celui que la
  // couche monétaire existe pour empêcher.
  const dur = rapport.split('\n').filter(l => !l.trim().startsWith('//') && /[*/]\s*100\b/.test(l));
  assert.deepStrictEqual(dur, [], 'le rapport convertit à la main au lieu d\'appeler toCents');
  // Et aucun montant de plus que celui que le rendu a le droit d'ajouter aux faits de SIM.
  const montants = (rapport.match(/\w+Cents:/g) || []).map(s => s.slice(0, -1)).sort();
  assert.deepStrictEqual(montants, ['declaredNetCents'], 'un montant de plus part au serveur');
  // La sacoche, elle, reste convertie par `toCents` — dans SIM cette fois, qui est le seul endroit
  // à en connaître la valeur en dollars.
  assert.match(sim, /purseCents: C\.toCents\(p\.pouch\)/);
  // Et le rapport lui-même est construit par WBCore : le bloc Game ne choisit pas ce qui traverse.
  const module = JEU.slice(JEU.indexOf('const Match=(function()'), JEU.indexOf('const rulesEl='));
  assert.ok(module.length > 1000, 'le module du billet n\'a pas été retrouvé');
  assert.match(module, /C\.reportFrom\(etat\)/);
});
test('le branchement ne décide rien : tout passe par une fonction de WBCore', () => {
  const module = JEU.slice(JEU.indexOf('const Match=(function()'), JEU.indexOf('const rulesEl='));
  // L'état du flux vient de matchFlow et de rien d'autre : pas de drapeau improvisé à côté.
  for (const attendu of ['C.matchFlow(step,', 'C.ticketFor(ticket,', 'C.reportFrom(etat)', 'C.seedFor(r.data,null)'])
    assert.ok(module.includes(attendu), `${attendu} manque au branchement`);
  // Les six noms d'états n'ont pas à être réécrits : seul 'hors-ligne' est un point de départ, et
  // les comparaisons portent sur les états que la table rend.
  const inventes = ['\'demande\'', '\'billet\'', '\'partie\'', '\'rapport\'', '\'fini\''];
  for (const nom of inventes)
    assert.ok(!module.includes('step=' + nom), `le branchement écrit ${nom} au lieu de le recevoir de matchFlow`);
  // Le portefeuille de démonstration reste dans le navigateur : rien ne part, rien n'arrive.
  for (const interdit of ['wallet', 'START_WALLET', 'balance', 'solde'])
    assert.ok(!module.includes(interdit), `${interdit} n'a rien à faire dans le module du billet`);
});
test('le gaz est lu par zoneAt, jamais recalculé à côté', () => {
  // `zoneAt` avait quinze assertions et aucun appelant : le vrai consommateur du plan, `zoneUpdate`,
  // refaisait le décompte et l'interpolation à la main. La copie testée était la morte, et une
  // mutation qui doublait la durée d'un resserrement laissait toute la suite verte. C'est le patron
  // « respawn() définie deux fois » de docs/HISTORIQUE.md, à l'envers.
  // `zoneUpdate` est descendue dans le bloc SIM au module 5 : elle décide de vrais faits — les
  // dégâts du gaz et la mort qui s'ensuit — et elle ne pouvait pas rester du côté que rien
  // n'exécute. Ce qu'elle a laissé derrière elle est le cercle à l'écran, dans `syncMonde`.
  const zu = sim.slice(sim.indexOf('\nfunction zoneUpdate('), sim.indexOf('// ---------- le contrat public'));
  assert.ok(zu.length > 500, 'zoneUpdate n\'a pas été retrouvée');
  assert.ok(!JEU.includes('function zoneUpdate('), 'zoneUpdate est restée dans le bloc Game');
  assert.match(zu, /C\.zoneAt\(G\.zonePlan,G\.time\)/, 'zoneUpdate doit LIRE le plan par zoneAt');
  // Et la seconde implémentation ne doit pas repousser : ni compteur local, ni interpolation.
  for (const interdit of ['z.timer-=dt', 'z.from', 'shrinkS', 'waitS', 'z.phase++'])
    assert.ok(!zu.includes(interdit), `zoneUpdate recalcule le plan au lieu de le lire : ${interdit}`);
});
test('le délai d\'attente du réseau vient de WBCore, pas d\'un nombre écrit dans le DOM', () => {
  // `fetch` n'a pas de délai. Un serveur qui accepte la connexion et ne répond plus laissait la
  // promesse en vol pour toujours, donc l'événement `delai` que la table de matchFlow prévoit
  // depuis le premier jour n'était jamais produit. La valeur est large exprès : elle vaut aussi
  // pour le rafraîchissement du jeton, et couper un joueur sur un lien lent coûte plus cher que
  // d'attendre quelques secondes de plus celui dont le serveur est mort.
  assert.ok(Number.isInteger(C.NET.timeoutMs) && C.NET.timeoutMs >= 10000 && C.NET.timeoutMs <= 30000,
    `NET.timeoutMs vaut ${C.NET.timeoutMs}`);
  const appel = JEU.slice(JEU.indexOf('  async function call(url,opts){'), JEU.indexOf('const cmHead='));
  assert.ok(appel.length > 200, 'call n\'a pas été retrouvée');
  assert.match(appel, /C\.NET\.timeoutMs/, 'le délai doit venir de WBCore');
  assert.match(appel, /AbortController/);
  assert.match(appel, /clearTimeout/, 'un minuteur qu\'on n\'annule pas retient le processus');
});

// ---- Le module `Match` lui-même, EXÉCUTÉ. ----
// Les quatre cas « hors ligne » plus haut testent la TABLE de matchFlow ; ils réimplémentent `sas`
// et `coupDenvoi`, donc ils ne disent rien du branchement. Ce qui suit extrait le vrai module entre
// ses marqueurs — comme api/core.js extrait WBCore — et le fait tourner avec le vrai `C` et un
// `Auth` en doublure dont chaque promesse se résout à la demande. Aucun DOM : le module n'en touche
// pas, et c'est précisément ce qu'on lui demande.
const MATCH_SRC = html.slice(html.indexOf('/*MATCH-START*/'), html.indexOf('/*MATCH-END*/'));
function bancMatch({ online = true } = {}) {
  const envois = [];
  let syncs = 0;
  // Ce que le module a demandé d'ADOPTER comme montants. C'est le seul chemin par lequel un solde
  // venu d'un billet arrive à l'écran, donc le banc le compte plutôt que de le supposer.
  const adoptes = [];
  const Auth = {
    online: () => online,
    sync: () => { syncs++; },
    montants: data => { adoptes.push(data); },
    send(path, body) {
      let repondre;
      const p = new Promise(r => { repondre = r; });
      envois.push({ path, body, repondre });
      return p;
    },
  };
  const Match = new Function('C', 'Auth', MATCH_SRC + '\nreturn Match;')(C, Auth);
  // Le module ne touche pas au DOM : il PRÉVIENT, et c'est l'écran qui arrête le sas. Le banc
  // ramasse donc ces avertissements comme il ramasse les envois.
  const refus = [];
  Match.surRefus((code, data) => refus.push({ code, data }));
  const renoncesRefuses = [];
  Match.surRenoncementRefuse((code, data) => renoncesRefuses.push({ code, data }));
  return { Match, envois, refus, adoptes, renoncesRefuses, syncs: () => syncs };
}
// Laisser tourner les promesses déjà résolues : le module enchaîne deux `await` au plus.
const souffler = () => new Promise(r => setImmediate(r));
const BILLET = (id, seed) => ({ id, mode: 'solo', stakeCents: 50, seats: 20, teamSize: 1,
                                brawler: 'bolt', seed, status: 'open' });
const FIN = { seconds: 154, kills: 3, deaths: 0, rank: 1, cubes: 0, damage: 900,
              cashedOut: false, purseCents: 200, declaredNetCents: 160 };

testAsync('un règlement qui ne revient jamais ne confisque pas les parties suivantes', () => {
  // LE SCÉNARIO, DE BOUT EN BOUT. Le module restait bloqué sur `rapport` tant que le POST du
  // résultat n'avait pas répondu — et `fetch` n'ayant pas de délai, un serveur muet le bloquait
  // pour de bon. La partie suivante ne demandait aucun billet, ressortait le billet périmé, et
  // rejouait donc EXACTEMENT la même carte et le même gaz ; puis son propre résultat était réémis
  // sur le vieux billet, déjà réglé, et perdu en silence.
  const { Match, envois } = bancMatch();
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => {
      assert.strictEqual(envois.length, 1, 'le sas demande son billet');
      assert.strictEqual(envois[0].path, '/api/match');
      envois[0].repondre({ ok: true, status: 200, data: BILLET('42', 777) });
      return souffler();
    })
    .then(() => {
      assert.strictEqual(C.seedFor(Match.coupDenvoi('solo', 50), 111111), 777, 'la partie 1 joue la graine du billet');
      // Fin de partie : le rapport part, et le serveur ne répondra jamais.
      Match.fin(FIN);
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 2);
      assert.strictEqual(envois[1].path, '/api/match/42/result');
      // Partie 2, alors que le rapport est toujours en vol.
      Match.sas('solo', 0.5, 'bolt');
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 3, 'la partie suivante doit demander SON billet');
      assert.strictEqual(envois[2].path, '/api/match');
      // Le serveur reste muet sur les deux : la partie 2 part hors ligne, sur SA graine locale.
      const billet2 = Match.coupDenvoi('solo', 50);
      assert.strictEqual(billet2, null, 'le vieux billet ne doit jamais resservir');
      assert.strictEqual(C.seedFor(billet2, 111111), 111111, 'deux parties de suite sur la même carte');
      // Et la fin de la partie 2 ne réémet pas un rapport sur le billet 42.
      Match.fin(FIN);
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 3, 'aucun second rapport sur un billet déjà rendu');
    });
});
testAsync('un règlement en retard n\'écrase pas l\'état de la partie suivante', () => {
  // `rendre` peut désormais résoudre alors que l'état a avancé. Sans la garde de génération, un
  // `echec` tardif ferait `demande → hors-ligne` et tuerait la demande de billet de la partie
  // suivante — le joueur repartirait hors ligne sans le savoir.
  const { Match, envois } = bancMatch();
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: BILLET('7', 12345) }); return souffler(); })
    .then(() => {
      Match.coupDenvoi('solo', 50);
      Match.fin(FIN);
      return souffler();
    })
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => {
      // Le règlement de la partie 1 échoue MAINTENANT, pendant que la demande de la 2 est en vol.
      envois[1].repondre({ ok: false, status: 500, data: null });
      return souffler();
    })
    .then(() => {
      // La demande de la partie 2 arrive après, et doit être encaissée : si l'échec tardif avait
      // écrit `hors-ligne`, ce billet-là serait jeté.
      envois[2].repondre({ ok: true, status: 200, data: BILLET('8', 999) });
      return souffler();
    })
    .then(() => {
      assert.strictEqual(C.seedFor(Match.coupDenvoi('solo', 50), 111111), 999,
        'la partie 2 doit jouer SON billet, pas retomber hors ligne');
    });
});
testAsync('un billet qui décrit une autre table n\'est jamais rendu par le coup d\'envoi', () => {
  // Le serveur n'ouvre qu'un billet à la fois : quitter le sas puis revenir sur une autre table
  // laisse en main un billet qui parle d'ailleurs. `ticketFor` tranche, et le module ne l'invente
  // pas — mais il faut qu'il l'appelle vraiment, ce que seul un test d'exécution montre.
  const { Match, envois } = bancMatch();
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: BILLET('3', 4242) }); return souffler(); })
    .then(() => {
      assert.strictEqual(Match.coupDenvoi('duo', 50), null, 'un autre mode');
      // La partie se joue donc hors ligne, et la fin n'a rien à rendre — mais le billet, lui,
      // reste en main : il est toujours ouvert côté serveur pour la table qu'il décrit, et le
      // jeter ici obligerait le joueur à en redemander un pour rien.
      Match.fin(FIN);
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 1, 'aucun rapport sur un billet qu\'on n\'a pas joué');
      assert.strictEqual(C.seedFor(Match.coupDenvoi('solo', 50), 111111), 4242,
        'le billet garde sa table, et la retrouve');
    });
});
testAsync('sans compte ni serveur, le module ne parle à personne', () => {
  const { Match, envois } = bancMatch({ online: false });
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => {
      assert.deepStrictEqual(envois, [], 'hors ligne, aucun appel ne part');
      assert.strictEqual(Match.coupDenvoi('solo', 50), null);
      Match.fin(FIN);
      return souffler();
    })
    .then(() => assert.deepStrictEqual(envois, [], 'et aucun rapport non plus'));
});
// Une trace de trois segments, telle que `TR.segments()` la rend, avec la version du bloc à côté.
const TRACE_ENVOI = { version: 1, segments: ['aaa', 'bbb', 'ccc'], tronquee: false };
testAsync('la trace part sur SA route, en segments, et AVANT le rapport', () => {
  // L'ordre n'est pas un détail : le rejeu du serveur aura besoin de la trace AU MOMENT du
  // règlement. Un rapport arrivé le premier serait jugé sans la pièce qui le prouve.
  const { Match, envois } = bancMatch();
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: BILLET('55', 4242) }); return souffler(); })
    .then(() => {
      Match.coupDenvoi('solo', 50);
      Match.fin(FIN, TRACE_ENVOI);
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 2, 'le premier segment doit partir avant tout le reste');
      assert.strictEqual(envois[1].path, '/api/match/55/trace');
      assert.deepStrictEqual(envois[1].body, { seq: 0, simVersion: 1, data: 'aaa' });
      envois[1].repondre({ ok: true, status: 200, data: {} });
      return souffler();
    })
    .then(() => {
      assert.deepStrictEqual(envois[2].body, { seq: 1, simVersion: 1, data: 'bbb' });
      envois[2].repondre({ ok: true, status: 200, data: {} });
      return souffler();
    })
    .then(() => {
      assert.deepStrictEqual(envois[3].body, { seq: 2, simVersion: 1, data: 'ccc' });
      envois[3].repondre({ ok: true, status: 200, data: {} });
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 5, 'le rapport doit partir après le dernier segment');
      assert.strictEqual(envois[4].path, '/api/match/55/result');
    });
});
testAsync('un segment refusé arrête l\'envoi, mais ne retient jamais le rapport', () => {
  // Le rejeu a besoin de la trace ENTIÈRE : marteler la suite n'userait que la limitation de débit
  // d'un joueur dont le serveur a déjà dit non. Ce que le serveur fera d'une trace incomplète est
  // son affaire, pas celle du client — et une partie jouée doit être rendue quoi qu'il arrive.
  const { Match, envois } = bancMatch();
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: BILLET('56', 4242) }); return souffler(); })
    .then(() => { Match.coupDenvoi('solo', 50); Match.fin(FIN, TRACE_ENVOI); return souffler(); })
    .then(() => { envois[1].repondre({ ok: false, status: 409, data: null }); return souffler(); })
    .then(() => {
      assert.strictEqual(envois.length, 3, 'le second segment ne doit pas partir');
      assert.strictEqual(envois[2].path, '/api/match/56/result', 'le rapport part quand même');
    });
});
testAsync('SANS BILLET, AUCUNE TRACE NE PART — et le jeu se comporte comme avant la phase', () => {
  // Le cas nommé de la 02a, étendu à la trace : pas de compte, pas de serveur, billet illisible, ou
  // billet qui décrit une autre table. Dans les quatre, il n'y a rien à tracer et rien à rendre.
  const horsLigne = bancMatch({ online: false });
  const autreTable = bancMatch();
  return Promise.resolve()
    .then(() => { horsLigne.Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => {
      horsLigne.Match.coupDenvoi('solo', 50);
      // Même si l'appelant lui tendait une trace, elle n'aurait nulle part où aller.
      horsLigne.Match.fin(FIN, TRACE_ENVOI);
      return souffler();
    })
    .then(() => {
      assert.deepStrictEqual(horsLigne.envois, [], 'hors ligne, ni trace ni rapport');
      autreTable.Match.sas('solo', 0.5, 'bolt'); return souffler();
    })
    .then(() => { autreTable.envois[0].repondre({ ok: true, status: 200, data: BILLET('57', 99) }); return souffler(); })
    .then(() => {
      assert.strictEqual(autreTable.Match.coupDenvoi('duo', 50), null, 'le billet décrit une autre table');
      autreTable.Match.fin(FIN, TRACE_ENVOI);
      return souffler();
    })
    .then(() => assert.strictEqual(autreTable.envois.length, 1,
      'un billet qu\'on n\'a pas joué ne doit recevoir ni trace ni rapport'));
});
test('les statistiques venues du serveur passent par applyAccount, jamais par une écriture directe', () => {
  // Le seul endroit qui écrit `profile.stats` sans passer par applyAccount est endMatch, et il
  // écrit ce que la partie VIENT de produire en local — c'est ce qui fait que le jeu hors ligne
  // tient ses compteurs tout seul. Tout ce qui vient du réseau, lui, passe par applyAccount.
  const reseau = JEU.slice(JEU.indexOf('  // ---- notre API de profils ----'), JEU.indexOf('  // ---- l\'ecran ----'));
  assert.ok(reseau.length > 400, 'la partie réseau d\'Auth n\'a pas été retrouvée');
  const ecritures = reseau.split('\n').filter(l => /profile\.stats\s*=/.test(l));
  assert.strictEqual(ecritures.length, 1, 'une seule écriture des statistiques depuis le réseau');
  assert.match(ecritures[0], /profile\.stats=p\.stats/, 'et elle vient de ce qu\'applyAccount a rendu');
  const module = JEU.slice(JEU.indexOf('const Match=(function()'), JEU.indexOf('const rulesEl='));
  assert.ok(!module.includes('profile.stats'), 'le règlement ne doit jamais écrire les statistiques lui-même');
  assert.ok(module.includes('Auth.sync()'), 'après un règlement, le profil se redemande au serveur');
});

console.log('Le jeu lit son solde du serveur, et les deux économies ne se mélangent pas');
// LE MODULE QUI PORTE TOUT LE RISQUE DE LA PHASE 03. Deux économies vivent désormais sur le même
// écran : le portefeuille de DÉMONSTRATION hors ligne, une variable du navigateur qui le dit ; et
// le solde du GRAND LIVRE en ligne, que le serveur seul écrit. `node test.js` ne peut pas voir un
// bug d'écran — c'est écrit dans la spécification et dans les risques — donc ce qu'il peut faire,
// il le fait entièrement : il exécute les deux fonctions du portefeuille, il exécute le module du
// billet, il exécute le libellé du bouton QUITTER, et il tient par garde textuelle ce qui reste.
const AVA = C.avatarList(Object.keys(C.BRAWLERS));
const LOCAL = () => ({ name: 'Loic', avatar: AVA[2].id, stats: { matches: 3, wins: 1, kills: 9, best: 5 } });
test('applyAccount porte le solde et la quarantaine, en CENTIMES jusqu\'au bout du réseau', () => {
  const p = C.applyAccount(LOCAL(), { balanceCents: 4950, quarantineCents: 120 }, AVA);
  assert.strictEqual(p.wallet, 49.5);
  assert.strictEqual(p.quarantine, 1.2);
  // Le domaine, pas un échantillon : la conversion ne perd pas un centime, dans les deux sens.
  for (const c of [0, 1, 7, 49, 50, 99, 500, 1000, 5000, 123456]) {
    const q = C.applyAccount(LOCAL(), { balanceCents: c, quarantineCents: c }, AVA);
    assert.strictEqual(C.toCents(q.wallet), c, `solde ${c}`);
    assert.strictEqual(C.toCents(q.quarantine), c, `quarantaine ${c}`);
  }
  // Et la dotation du serveur tombe exactement sur le portefeuille de départ du jeu : deux
  // économies sur le même écran doivent partir du même nombre. `api/test.js` tient l'autre bout.
  assert.strictEqual(C.applyAccount(LOCAL(), { balanceCents: C.toCents(C.START_WALLET) }, AVA).wallet,
    C.START_WALLET);
  // Un montant qui n'en est pas un ne devient jamais un nombre : ni une chaîne, ni un booléen, ni
  // l'infini. C'est la même doctrine que `toCents`, qui rend `null` plutôt qu'un zéro silencieux.
  for (const faux of ['4950', null, undefined, NaN, Infinity, -Infinity, {}, [], true, false])
    assert.strictEqual(C.applyAccount(LOCAL(), { balanceCents: faux }, AVA).wallet, null,
      String(faux) + ' ne doit pas devenir un solde');
  // Les deux ne se mélangent jamais : les additionner ferait de la quarantaine un solde.
  assert.strictEqual(C.applyAccount(LOCAL(), { balanceCents: 5000 }, AVA).quarantine, null);
  assert.strictEqual(C.applyAccount(LOCAL(), { quarantineCents: 5000 }, AVA).wallet, null);
});
test('GARDE TEXTUELLE : le solde ne se convertit qu\'UNE fois, et le point est applyAccount', () => {
  // Exactement la garde qui protège déjà `best`, étendue aux deux montants de la phase 03. Un
  // second point de conversion est la frontière où l'on se trompe : c'est pour cela que la couche
  // monétaire n'en a qu'un.
  assert.ok(/wallet: montant\(compte && compte\.balanceCents\)/.test(core),
    'le solde doit passer par le même convertisseur que `best`');
  assert.ok(/quarantine: montant\(compte && compte\.quarantineCents\)/.test(core));
  assert.ok(/const montant = v => \(typeof v === 'number' && Number\.isFinite\(v\)\) \? fromCents\(entier\(v\)\) : null;/.test(core),
    'et ce convertisseur doit appeler fromCents, pas diviser par 100 à la main');
  // LE BLOC `Game` NE CONNAÎT PAS LES CHAMPS DU RÉSEAU. Il ne nomme ni `balanceCents` ni
  // `quarantineCents` ni `fromCents` : il n'a donc aucun moyen d'ouvrir un second point de
  // conversion, et un futur « juste ici, une fois » se verra dans ce test avant d'être écrit.
  for (const interdit of ['balanceCents', 'quarantineCents', 'fromCents'])
    assert.ok(!JEU.includes(interdit), `${interdit} n'a rien à faire hors d'applyAccount`);
});
test('LIRE UN RÈGLEMENT COMME UN COMPTE NE REMET AUCUN SOLDE À ZÉRO', () => {
  // Le piège nommé de la 02a, transposé à l'argent — et il coûte cette fois le portefeuille entier
  // à l'écran. Un règlement porte le verdict d'UNE partie et aucun solde ; les statistiques, elles,
  // tombent volontairement à zéro (sinon une statistique fausse ne redescendrait jamais), mais un
  // portefeuille qui disparaît est un bug que personne ne pardonne. Absent rend donc `null`.
  const reglement = { matchId: '12', status: 'settled', issue: 'victoire', controle: null, motif: null,
                      grossCents: 1000, feeCents: 200, netCents: 800, purseCents: 1000,
                      declaredNetCents: 800, ecartCents: 0, settledAt: '2026-03-01T18:05:00Z' };
  const p = C.applyAccount(LOCAL(), reglement, AVA);
  assert.strictEqual(p.wallet, null, 'un règlement n\'est pas un compte : il ne porte aucun solde');
  assert.strictEqual(p.quarantine, null);
  assert.deepStrictEqual(p.stats, { matches: 0, wins: 0, kills: 0, best: 0 });
  // Et aucun des montants du règlement n'est confondu avec un solde : `netCents` vaut 800 et ne
  // doit surtout pas devenir un portefeuille de 8 dollars.
  assert.notStrictEqual(p.wallet, 8);
  // Le même piège sur la réponse de renoncement, qui elle PORTE les deux montants : le jeu ne la
  // lit pas non plus comme un compte, il redemande /api/me. La fonction, elle, saurait les lire —
  // ce test dit que la valeur est juste, pas que le jeu emprunte ce chemin.
  const renonce = { matchId: '12', status: 'renounced', refundedCents: 50,
                    balanceCents: 5000, quarantineCents: 0 };
  const q = C.applyAccount(LOCAL(), renonce, AVA);
  assert.strictEqual(q.wallet, 50);
  assert.strictEqual(q.quarantine, 0, 'zéro est un montant, et il s\'écrit');
  // Le module du billet ne prend PAS ce chemin : il redemande le compte au serveur.
  const module = JEU.slice(JEU.indexOf('const Match=(function()'), JEU.indexOf('const rulesEl='));
  const renoncer = module.slice(module.indexOf('async function renoncerBillet('), module.indexOf('  // Fin de partie.'));
  assert.ok(renoncer.length > 100 && renoncer.length < 2200, 'renoncerBillet n\'a pas été retrouvée');
  assert.ok(renoncer.includes('Auth.sync()'), 'après un renoncement, le solde se redemande');
  const codeRenoncer = renoncer.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!codeRenoncer.includes('applyAccount'), 'le module ne lit pas un compte dans une réponse de renoncement');
  // ET IL SE REDEMANDE DANS LES DEUX CAS, refus compris : un renoncement refusé laisse l'écran sur
  // un montant que le serveur n'a jamais confirmé. `Auth.sync()` est donc AVANT le `return` du
  // chemin heureux, pas sous un `if(r.ok)`.
  assert.ok(!/if\(r\.ok\) Auth\.sync\(\)/.test(codeRenoncer),
    'le solde ne se redemande que sur un succès : un refus laisse l\'écran faux');
  assert.ok(codeRenoncer.indexOf('Auth.sync();') < codeRenoncer.indexOf('if(r.ok)'), codeRenoncer);
});
// LES DEUX FONCTIONS DU PORTEFEUILLE DE DÉMONSTRATION, EXÉCUTÉES. Elles sont trois lignes, et
// c'est exactement pour cela qu'elles méritent d'être extraites et lancées plutôt que relues : une
// garde textuelle dirait que le `if` est écrit, pas qu'il décide.
const PORTE_SRC = JEU.slice(JEU.indexOf('function demoDebit('), JEU.indexOf('function renderWallet('));
function bancPortefeuille(online, depart) {
  assert.ok(PORTE_SRC.length > 100 && PORTE_SRC.length < 1200, 'demoDebit/demoCredit n\'ont pas été retrouvées');
  return new Function('Auth', 'depart', PORTE_SRC
    + '\nlet wallet = depart;'
    + '\nreturn { debit: m => { demoDebit(m); return wallet; },'
    + '\n         credit: m => { demoCredit(m); return wallet; } };')({ online: () => online }, depart);
}
test('EN LIGNE, ni la mise ni le gain ne touchent `wallet` — hors ligne, les deux le font', () => {
  // Le débit a eu lieu côté serveur, à l'ouverture du billet, et le solde est celui que le serveur
  // rend. Le décrémenter ici en plus ferait payer deux fois à l'écran ce que le livre n'a compté
  // qu'une ; le créditer ici afficherait un gain que le grand livre n'a peut-être pas accordé.
  const ligne = bancPortefeuille(true, 50);
  assert.strictEqual(ligne.debit(0.5), 50, 'en ligne, la mise ne descend pas du portefeuille');
  assert.strictEqual(ligne.credit(8), 50, 'en ligne, le gain ne monte pas non plus');
  // Hors ligne, absolument rien ne change : c'est la promesse du fichier unique.
  const seul = bancPortefeuille(false, 50);
  assert.strictEqual(seul.debit(0.5), 49.5);
  assert.strictEqual(seul.credit(8), 57.5);
  // Et sur les quatre tables, en dollars comme le jeu les compte.
  for (const t of C.TIERS) {
    const w = bancPortefeuille(false, C.START_WALLET);
    assert.strictEqual(C.toCents(w.debit(t.stake)), C.toCents(C.START_WALLET) - C.toCents(t.stake), t.label);
    assert.strictEqual(C.toCents(w.credit(t.stake)), C.toCents(C.START_WALLET), t.label);
  }
});
test('GARDE TEXTUELLE : rien d\'autre que les deux fonctions de démonstration n\'écrit `wallet`', () => {
  // Trois interdits en un, et c'est celle que la spécification réclame mot pour mot : aucun
  // `wallet -=`, aucun `wallet +=` sur le chemin EN LIGNE, et aucune écriture de `wallet` depuis
  // une réponse serveur en dehors d'`applyAccount`.
  const lignes = JEU.split('\n').map(l => l.trim()).filter(l => !l.startsWith('//'));
  const muta = lignes.filter(l => /\bwallet\s*[-+]=/.test(l));
  assert.deepStrictEqual(muta, [
    'function demoDebit(montant){ if(!Auth.online()) wallet-=montant; }',
    'function demoCredit(montant){ if(!Auth.online()) wallet+=montant; }',
  ], 'le portefeuille se mute ailleurs que dans les deux fonctions de démonstration');
  // Les seules AFFECTATIONS, et chacune se justifie : la déclaration, le retour au portefeuille de
  // démonstration (recharge hors ligne, déconnexion), et ce qu'`applyAccount` a rendu.
  const aff = lignes.filter(l => /\bwallet\s*=[^=]/.test(l));
  // CINQ ET PLUS QUATRE DEPUIS QUE LE BILLET PORTE LE SOLDE. La garde ne se retire pas, elle SE
  // REFORME avec sa raison écrite — c'est la doctrine du `delete from match_traces` affaibli
  // sciemment. Le cinquième point d'écriture est `adopterMontants`, qui adopte les deux montants
  // rendus AVEC le billet et avec le refus `fonds` : mêmes deux lignes, même convertisseur, même
  // règle du montant absent. Ce qu'il ne fait PAS, et c'est pourquoi il n'est pas `adopter` : il ne
  // touche ni au pseudo, ni à l'avatar, ni aux statistiques — un billet n'en porte aucune, et
  // `applyAccount` les remettrait à zéro.
  assert.strictEqual(aff.length, 5, 'une affectation de `wallet` de plus :\n' + aff.join('\n'));
  assert.ok(aff[0].startsWith('let wallet=C.START_WALLET, quarantine=0,'), aff[0]);
  assert.ok(/if\(Auth\.online\(\)\) return; wallet=C\.START_WALLET;/.test(aff[1]),
    'la recharge doit refuser en ligne avant d\'écrire quoi que ce soit : ' + aff[1]);
  assert.strictEqual(aff[2], 'wallet=C.START_WALLET; quarantine=0;');
  for (const i of [3, 4])
    assert.strictEqual(aff[i], 'if(p.wallet!==null) wallet=p.wallet;',
      'le seul solde venu du réseau est celui qu\'applyAccount a rendu');
  // Et ces `p`-là viennent bien d'`applyAccount`, dans les deux seules fonctions qui adoptent.
  const reseau = JEU.slice(JEU.indexOf('  // ---- notre API de profils ----'), JEU.indexOf('  // ---- l\'ecran ----'));
  const adopte = reseau.slice(reseau.indexOf('function adopter(data){'), reseau.indexOf('  // LES DEUX MONTANTS QUE LE SERVEUR REND'));
  assert.ok(adopte.includes('const p=C.applyAccount(profile,data,AVATARS);'), 'adopter n\'a pas été retrouvée');
  assert.ok(adopte.includes('if(p.wallet!==null) wallet=p.wallet;'));
  assert.ok(adopte.includes('if(p.quarantine!==null) quarantine=p.quarantine;'),
    'la quarantaine suit la même règle : absente, elle ne s\'écrit pas');
  const montants = reseau.slice(reseau.indexOf('function adopterMontants(data){'), reseau.indexOf('async function sync()'));
  assert.ok(montants.length > 100 && montants.length < 400, 'adopterMontants n\'a pas été retrouvée');
  assert.ok(montants.includes('const p=C.applyAccount(profile,data,AVATARS);'),
    'le point de conversion reste applyAccount, ici comme ailleurs');
  assert.ok(montants.includes('if(p.wallet!==null) wallet=p.wallet;'));
  assert.ok(montants.includes('if(p.quarantine!==null) quarantine=p.quarantine;'));
  // LA RAISON D'ÊTRE DE CETTE SECONDE FONCTION EST CE QU'ELLE N'ÉCRIT PAS. Un billet ne porte
  // aucune statistique, et `applyAccount` les remet à zéro sur un objet qui n'en porte pas : lui
  // faire adopter un billet ferait tomber les compteurs du lobby à chaque entrée dans le sas.
  for (const interdit of ['profile.name', 'profile.avatar', 'profile.stats', 'renderProfile('])
    assert.ok(!montants.includes(interdit),
      `adopterMontants écrit ${interdit} : un billet n'est pas un compte`);
  // Et la fonction qui adopte un COMPTE, elle, écrit bien les trois.
  assert.ok(adopte.includes('profile.stats=p.stats;'));
  // LE JEU N'ENVOIE JAMAIS DE SOLDE. Aucun corps de requête ne porte de montant de compte.
  const module = JEU.slice(JEU.indexOf('const Match=(function()'), JEU.indexOf('const rulesEl='));
  for (const interdit of ['wallet', 'START_WALLET', 'balance', 'solde', 'quarantine'])
    assert.ok(!module.includes(interdit), `${interdit} n'a rien à faire dans le module du billet`);
});
test('LE BOUTON DE RECHARGE DISPARAÎT EN LIGNE, et le portefeuille de démo dit qu\'il en est un', () => {
  const rw = JEU.slice(JEU.indexOf('function renderWallet(){'), JEU.indexOf('// ---------- lobby ----------'));
  assert.ok(rw.length > 300, 'renderWallet n\'a pas été retrouvée');
  assert.ok(rw.includes("$('topup').hidden=enLigne;"), 'le bouton de recharge doit disparaître en ligne');
  assert.ok(/enLigne\?'Credits':'Demo wallet'/.test(rw),
    'hors ligne, le portefeuille doit continuer de DIRE à l\'écran qu\'il est de démonstration');
  // La quarantaine se voit dès qu'elle porte un centime : la taire ferait disparaître de l'argent
  // aux yeux du joueur, la fondre dans le solde en ferait un solde dépensable.
  assert.ok(rw.includes('quarantine>0'), 'la quarantaine doit s\'afficher quand elle n\'est pas nulle');
  // Et le geste lui-même est refusé, pas seulement caché : un bouton `hidden` reste cliquable
  // depuis la console, et cette ligne-là serait alors une route de crédit gratuit.
  assert.ok(/\$\('topup'\)\.onclick=e=>\{ e\.stopPropagation\(\); if\(Auth\.online\(\)\) return;/.test(JEU));
  // Aucune promesse d'argent réel nulle part : ce sont des crédits fictifs, et l'écran le dit.
  for (const l of JEU.split('\n')) {
    if (l.trim().startsWith('//')) continue;
    assert.ok(!/\b(real money|euros?|withdraw|deposit)\b/i.test(l) || /No real money/.test(l),
      'l\'écran laisse croire qu\'un euro entre : ' + l.trim());
  }
});
// LE LIBELLÉ DU BOUTON QUITTER, EXÉCUTÉ. Il annonce ce que le SERVEUR arbitrera, donc il doit
// appeler la règle du serveur — `WBCore.renonciationOuverte` — avec le chronomètre du sas.
const QUITTER_SRC = JEU.slice(JEU.indexOf('function sasRemboursable(){'), JEU.indexOf('// the podium reuses'));
// `ecouleMs` est le temps RÉEL depuis le clic, et `t` le chronomètre du sas. Les deux sont
// désormais séparés dans le banc parce qu'ils le sont dans la vie : `W.t` avance par tics de
// `setInterval`, et un navigateur bride ces tics à 1 Hz dans un onglet caché. Les faire coïncider
// par construction, comme le banc le faisait, rendait le défaut invisible.
function bancQuitter(t, enLigne, { repris = false, ecouleMs = null } = {}) {
  assert.ok(QUITTER_SRC.length > 200 && QUITTER_SRC.length < 3200, 'wLeaveLabel n\'a pas été retrouvée');
  const bouton = { textContent: '' };
  const ecoule = ecouleMs === null ? t * 1000 : ecouleMs;
  // Une horloge monotone injectée, dont l'origine est celle que `enterWaiting` pose au clic.
  const perf = { now: () => 100000 + ecoule };
  const ouverte = new Function('C', '$', 'W', 'G', 'Match', 'performance',
    QUITTER_SRC + '\nwLeaveLabel();\nreturn sasRemboursable();')(
    C, () => bouton, { t, enLigne, clic: 100000 }, null, { billetRepris: () => repris }, perf);
  return { texte: bouton.textContent, ouverte };
}
test('le bouton QUITTER dit ce que partir coûte, et il le lit sur une HORLOGE', () => {
  const fenetre = C.renonceFenetreS();
  assert.strictEqual(fenetre, 10, 'la fenêtre a changé de valeur : ce test la suit, il ne la fige pas');
  const marge = C.RENONCE_MARGE_ECRAN_MS;
  // Sur toute la durée d'un sas, au dixième de seconde — le pas du minuteur — le bouton dit vrai.
  // La promesse se ferme une marge AVANT le serveur : voir le commentaire de `sasRemboursable`.
  for (let i = 0; i <= C.LOBBY.wait * 10; i++) {
    const t = i / 10;
    const r = bancQuitter(t, true);
    assert.strictEqual(r.ouverte, t * 1000 + marge <= fenetre * 1000, `t=${t}`);
    assert.strictEqual(r.texte, r.ouverte ? 'LEAVE · REFUND STAKE' : 'LEAVE · STAKE IS LOST', `t=${t}`);
  }
  // Les deux bords, exactement : la fenêtre est fermée au premier millième d'après.
  const bord = (fenetre * 1000 - marge) / 1000;
  assert.ok(bancQuitter(bord, true).ouverte);
  assert.ok(!bancQuitter(bord + 0.001, true).ouverte);
  // HORS LIGNE, RIEN NE CHANGE : le portefeuille de démonstration rend toujours la mise, et le
  // bouton ne va pas se mettre à menacer un joueur qui ne doit rien à personne.
  for (const t of [0, 5, 10, 12, 24.9])
    assert.strictEqual(bancQuitter(t, false).texte, 'LEAVE · REFUND STAKE', `hors ligne, t=${t}`);

  // LE CHRONOMÈTRE DU SAS NE DÉCIDE PLUS DE RIEN, et c'est le cœur de la correction. Un onglet
  // caché voit `setInterval(waitTick,100)` bridé à 1 Hz : vingt secondes réelles n'avancent `W.t`
  // que de deux. L'ancien code promettait alors « LEAVE · REFUND STAKE » à un joueur dont le
  // serveur comptait vingt secondes, le renoncement partait, revenait en `409 fenetre_close`, et la
  // mise était perdue en silence. On rejoue les trois régimes de bridage.
  for (const [periodeMs, nom] of [[100, 'nominal'], [143, 'tics perdus'], [1000, 'onglet caché']]) {
    for (let reelMs = 0; reelMs <= C.LOBBY.wait * 1000; reelMs += 100) {
      const tics = Math.floor(reelMs / periodeMs);
      const r = bancQuitter(tics / 10, true, { ecouleMs: reelMs });
      if (!r.ouverte) continue;
      // Dès que l'écran promet, le serveur doit accepter — quelle que soit la latence de la
      // demande de billet, et quel que soit le régime du minuteur.
      for (const L1 of [0, 30, 200])
        assert.ok(C.renonciationOuverte({ openedAt: L1 }, reelMs),
          `${nom} : l'écran promet à ${reelMs} ms réelles (W.t=${tics / 10}) ce que le serveur refuse`);
    }
  }
  // Et le cas nommé, celui du rapport : W.t ≈ 2 s de tics pour 20 s réelles.
  assert.ok(!bancQuitter(2, true, { ecouleMs: 20000 }).ouverte,
    'vingt secondes en arrière-plan, et l\'écran promet encore un remboursement');
  assert.strictEqual(bancQuitter(2, true, { ecouleMs: 20000 }).texte, 'LEAVE · STAKE IS LOST');

  // L'ÉCRAN FERME LA PROMESSE AVANT LE SERVEUR, ET IL Y A DEUX VOLS, PAS UN. L'ancienne boucle
  // n'injectait qu'un `openedAt` décalé vers l'avant : l'écoulement vu du serveur valait alors
  // `t − L1 ≤ t ≤ fenêtre`, donc l'assertion était vraie par CONSTRUCTION et aucune valeur de
  // latence ne pouvait la faire échouer, pas même 10^9.
  for (let i = 0; i <= C.LOBBY.wait * 10; i++) {
    const t = i / 10;
    if (!bancQuitter(t, true).ouverte) continue;
    // L1 : vol aller du POST /api/match. Il DIMINUE l'écoulement vu du serveur.
    // L2 : vol aller du POST .../renounce. Il l'AUGMENTE — c'est celui que la boucle oubliait, et
    // c'est le seul des deux qui puisse casser la promesse.
    for (const L1 of [0, 30, 200]) for (const L2 of [0, 30, 200, 400, 1000])
      assert.ok(C.renonciationOuverte({ openedAt: L1 }, t * 1000 + L2),
        `l'écran promet un remboursement que le serveur refuserait : t=${t}, L1=${L1}, L2=${L2}`);
  }
  // ET LA RAISON DE LA BOUCLE CI-DESSUS EST FIGÉE, sinon elle redeviendrait vraie par construction
  // le jour où quelqu'un élargirait la marge sans élargir le balayage.
  assert.ok(marge >= 1000, `la marge d'écran (${marge} ms) ne couvre plus le plus grand vol retour balayé`);
  // Un vol retour AU-DELÀ de la marge casse bien la propriété : c'est ce qui prouve que la boucle
  // peut échouer.
  const dernier = bord * 1000;
  assert.ok(!C.renonciationOuverte({ openedAt: 0 }, dernier + marge + 1),
    'aucun vol retour ne peut faire échouer la promesse : la boucle ne mesure rien');
});
test('UN BILLET REPRIS NE PROMET RIEN, quel que soit le chronomètre du sas', () => {
  // Le scénario, et il coûte une mise entière. Le joueur entre au sas, part à 15 s — hors fenêtre,
  // donc `quitterLeSas(false)` garde le billet en main et ne renonce à rien, ce qui est juste. Il
  // reclique aussitôt la table : le sas repart à zéro, mais le serveur lui rend LE MÊME billet, par
  // le chemin `repris`, avec son `opened_at` d'origine. Aucune horloge de ce second sas ne mesure
  // l'âge de ce billet-là : l'écran ne doit donc plus rien promettre.
  for (let i = 0; i <= C.LOBBY.wait * 10; i++) {
    const t = i / 10;
    const r = bancQuitter(t, true, { repris: true });
    assert.strictEqual(r.ouverte, false, `t=${t}`);
    assert.strictEqual(r.texte, 'LEAVE · STAKE IS LOST', `t=${t}`);
  }
  // MAIS TANT QU'AUCUN BILLET N'EST EN MAIN, ON PROMET COMME AVANT, et c'est indispensable : sinon
  // `quitterLeSas(false)` cesserait de renoncer au billet qui arrive en retard, et le trou nommé de
  // docs/PHASE-03.md — « le joueur quitte le sas pendant que la demande est encore en vol » — se
  // rouvrirait, au prix d'une mise entière.
  assert.ok(bancQuitter(0, true, { repris: false }).ouverte);
  // Hors ligne, un billet repris ne veut rien dire : il n'y en a pas, et le portefeuille de
  // démonstration rend toujours la mise.
  assert.strictEqual(bancQuitter(3, false, { repris: true }).texte, 'LEAVE · REFUND STAKE');
});
test('GARDE TEXTUELLE : la promesse de remboursement ne se lit ni sur `W.t` ni sur Date.now', () => {
  // La propriété ne tient que si le chronomètre ne peut pas mentir, et rien ne le vérifiait. `W.t`
  // compte des tics de `setInterval` ; `Date.now` ferait décider un remboursement par un changement
  // d'heure système. Les deux se réécriraient en une frappe, et la correction se déferait en
  // silence.
  const f = QUITTER_SRC.slice(0, QUITTER_SRC.indexOf('function wLeaveLabel('));
  const code = f.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(code.includes('function sasRemboursable(){'), 'sasRemboursable n\'a pas été retrouvée');
  for (const interdit of ['W.t', 'Date.now'])
    assert.ok(!code.includes(interdit), `sasRemboursable lit ${interdit} : il retarde, et dans le mauvais sens`);
  assert.ok(code.includes('performance.now()-W.clic'), 'la promesse doit se lire sur une horloge monotone');
  assert.ok(code.includes('C.RENONCE_MARGE_ECRAN_MS'), 'la marge d\'aller-retour doit être NOMMÉE dans WBCore');
  assert.ok(code.includes('Match.billetRepris()'), 'un billet repris doit fermer la promesse');
  // Et l'origine de cette horloge est bien posée au CLIC, dans `enterWaiting` : posée ailleurs, elle
  // cesserait d'être antérieure à `opened_at`, et l'avance de l'écran sur le serveur tomberait.
  const depart = JEU.slice(JEU.indexOf('function enterWaiting(stake){'), JEU.indexOf('function wFeed(txt){'));
  assert.ok(depart.length > 500, 'enterWaiting n\'a pas été retrouvée');
  assert.ok(depart.includes('clic:performance.now()'), 'l\'origine de l\'horloge du sas a disparu');
  assert.ok(depart.indexOf('clic:performance.now()') < depart.indexOf('Match.sas('),
    'l\'origine doit être posée AVANT que la demande de billet ne parte');
});
test('un sas quitté et un refus nommé passent par le MÊME chemin de retour au lobby', () => {
  // Le lobby ne doit jamais rester mort. Deux sorties de sas et une seule fonction : sinon l'une
  // des deux oublie un minuteur ou une musique, et le lobby revient à moitié vivant.
  const sortie = JEU.slice(JEU.indexOf('function sortirDuSas(texte){'), JEU.indexOf("$('wLeave').onclick="));
  assert.ok(sortie.length > 200, 'sortirDuSas n\'a pas été retrouvée');
  for (const attendu of ['musicStop()', 'waitStop()', 'clearInterval(W.timer)', 'W=null',
                         "$('waiting').classList.remove('on')", "$('lobby').style.display='flex'",
                         'lobbyStart()', 'renderLobby()', 'resetTicker()', 'lobbyMsg('])
    assert.ok(sortie.includes(attendu), `le retour au lobby oublie ${attendu}`);
  // Et le refus emprunte bien ce chemin-là, avec le message que WBCore compose.
  assert.ok(/Match\.surRefus\(\(code,data\)=>\{ sortirDuSas\(C\.refusMessage\(code,data\)\); \}\);/.test(JEU),
    'un refus nommé doit arrêter le sas et dire pourquoi');
  // Le bouton QUITTER lit la fenêtre AVANT de perdre le chronomètre avec `W`.
  const clic = JEU.slice(JEU.indexOf("$('wLeave').onclick="), JEU.indexOf('// UN REFUS NOMME ARRETE LE SAS'));
  assert.ok(clic.indexOf('const rendu=sasRemboursable();') < clic.indexOf('Match.quitterLeSas(rendu)'),
    'la fenêtre doit se lire avant que `W` ne disparaisse');
  assert.ok(clic.indexOf('Match.quitterLeSas(rendu)') < clic.indexOf('sortirDuSas('), clic);
  // ET LE CRÉDIT DE SORTIE LIT `W.enLigne`, JAMAIS `Auth.online()`. Un `demoCredit(W.stake)` nu
  // rendrait une mise que le portefeuille de démonstration n'a jamais payée le jour où le jeton
  // meurt au milieu du sas. La garde interdit la forme non gardée, sinon la régression revient en
  // silence à la première relecture.
  assert.ok(clic.includes('if(!W.enLigne) demoCredit(W.stake);'),
    'le crédit de sortie doit lire l\'économie figée à l\'entrée');
  assert.ok(!/(^|[^)])\s*demoCredit\(W\.stake\);/m.test(clic.replace('if(!W.enLigne) demoCredit(W.stake);', '')),
    'un demoCredit(W.stake) non gardé est revenu dans le bouton QUITTER');
  // ET L'ÉCRAN DE FIN LIT LA MÊME ÉCONOMIE QUE LE SAS, figée cette fois au coup d'envoi. Le sas
  // gelait la sienne dans `W.enLigne` ; l'écran de fin, lui, interrogeait `Auth.online()` à la
  // seconde où la partie se termine. Un jeton mort PENDANT la partie faisait donc tomber le gain
  // dans le portefeuille de démonstration alors que la mise était partie au grand livre à
  // l'ouverture du billet : jusqu'à quarante fois la mise en Resurgence, sur le seul écran qui
  // annonce un gain. Les deux bouts de la partie doivent nommer la même économie.
  assert.ok(/function startMatch\(stake,enLigne\)\{/.test(JEU),
    'startMatch doit recevoir l\'économie du sas, pas la redemander');
  assert.ok(/matchEnLigne=!!enLigne;/.test(JEU),
    'startMatch doit figer l\'économie de la partie');
  assert.ok(/const st=W\.stake, eco=W\.enLigne;[\s\S]*startMatch\(st,eco\);/.test(JEU),
    'le coup d\'envoi doit passer `W.enLigne` à startMatch avant que `W` ne disparaisse');
  const fin = JEU.slice(JEU.indexOf('const take=C.cashoutPayout(p.pouch);'), JEU.indexOf("title = cash ? 'BANKED!'"));
  assert.ok(fin.includes('if(!matchEnLigne) demoCredit(take.net);'),
    'le crédit de l\'écran de fin doit lire l\'économie figée au coup d\'envoi');
  assert.ok(!/(^|[^)])\s*demoCredit\(take\.net\);/m.test(fin.replace('if(!matchEnLigne) demoCredit(take.net);', '')),
    'un demoCredit(take.net) non gardé est revenu dans l\'écran de fin');
  // Et le renoncement refusé a son propre canal de retour : le sas n'existe plus quand la réponse
  // arrive, donc `sortirDuSas` n'a plus rien à faire, mais le joueur doit apprendre ce qu'est
  // devenue sa mise.
  assert.ok(/Match\.surRenoncementRefuse\(/.test(JEU), 'un renoncement refusé n\'est dit à personne');
  const canal = JEU.slice(JEU.indexOf('Match.surRenoncementRefuse('), JEU.indexOf('// CE QUE PARTIR COUTE'));
  assert.ok(canal.includes('C.refusMessage(code,data)'), 'le message doit venir de WBCore');
  assert.ok(canal.includes('lobbyMsg('), 'et s\'afficher au lobby');
});
// LE BOUTON QUITTER, EXÉCUTÉ. La garde textuelle dit que le `if` est écrit, pas qu'il décide : le
// piège est une BASCULE entre l'entrée du sas et le clic, et seul un banc qui la joue peut la voir.
const CLIC_SRC = JEU.slice(JEU.indexOf("$('wLeave').onclick="), JEU.indexOf('// UN REFUS NOMME ARRETE LE SAS'));
function bancClicQuitter({ enLigne, rendu = true, enLigneAuClic }) {
  assert.ok(CLIC_SRC.length > 200 && CLIC_SRC.length < 2500, 'le bouton QUITTER n\'a pas été retrouvé');
  const el = {};
  // Le VRAI `demoCredit`, extrait d'index.html : c'est lui qui consulte `Auth.online()`, et c'est
  // pour cela que la correction est au point d'appel et non dans la fonction — elle a un second
  // appelant légitime, l'écran de fin de partie, qui doit continuer de le consulter.
  const porte = bancPortefeuille(enLigneAuClic, C.START_WALLET);
  const quitte = [], sorties = [];
  new Function('el', '$', 'W', 'sasRemboursable', 'demoCredit', 'Match', 'sortirDuSas', CLIC_SRC)(
    el, () => el, { stake: 0.5, enLigne }, () => rendu, m => { porte.credit(m); },
    { quitterLeSas: v => quitte.push(v) }, t => sorties.push(t));
  el.onclick();
  return { wallet: porte.credit(0), quitte, sorties };
}
test('LE JETON QUI MEURT PENDANT LE SAS NE FAIT PAS ENCAISSER LE PORTEFEUILLE DE DÉMONSTRATION', () => {
  // Le scénario : connecté, le joueur entre au sas — `demoDebit` ne prend rien, le serveur débite
  // 50 centimes au séquestre. Pendant les vingt-cinq secondes du sas, le minuteur de rafraîchissement
  // du jeton reçoit un refus et `forget()` s'exécute. Il clique QUITTER : `Auth.online()` rend
  // désormais faux, donc `demoCredit` créditait 0,50 $ que ce portefeuille-là n'a jamais payé. Un
  // centime de l'économie du grand livre atterrissait dans celle de la démonstration, et rien ne
  // l'aurait corrigé — la session est morte.
  const bascule = bancClicQuitter({ enLigne: true, enLigneAuClic: false });
  assert.strictEqual(bascule.wallet, C.START_WALLET,
    'le portefeuille de démonstration a encaissé une mise qu\'il n\'a jamais payée');
  assert.deepStrictEqual(bascule.quitte, [true], 'le renoncement doit partir quand même');
  assert.deepStrictEqual(bascule.sorties, ['']);
  // EN LIGNE DE BOUT EN BOUT : rien non plus. C'est le serveur qui rend la mise.
  assert.strictEqual(bancClicQuitter({ enLigne: true, enLigneAuClic: true }).wallet, C.START_WALLET);
  // HORS LIGNE DE BOUT EN BOUT : la mise revient, exactement comme avant la phase. C'est la
  // promesse du fichier unique, et elle ne bouge pas.
  assert.strictEqual(bancClicQuitter({ enLigne: false, enLigneAuClic: false }).wallet,
    C.START_WALLET + 0.5);
  // LA BASCULE INVERSE — hors ligne à l'entrée, connecté au clic — ne rend rien, et c'est écrit
  // plutôt que découvert : le point d'appel demande bien le crédit, mais `demoCredit` consulte
  // `Auth.online()`, qui répond désormais vrai. Ce n'est pas un défaut, et c'est pour cela que la
  // correction est au point d'appel et non dans la fonction : se connecter pendant le sas fait
  // passer `wallet` sous la parole du serveur — `adopt` appelle `sync`, qui appelle `adopter`, qui
  // écrit le solde du grand livre par-dessus. Le portefeuille de démonstration n'existe plus à
  // l'écran, il n'y a donc aucune mise à lui rendre.
  assert.strictEqual(bancClicQuitter({ enLigne: false, enLigneAuClic: true }).wallet, C.START_WALLET);
  const adopt = JEU.slice(JEU.indexOf('  function adopt(data){'), JEU.indexOf('  // Rafraichir avant l\'expiration'));
  assert.ok(adopt.length > 200 && adopt.includes('sync();'),
    'se connecter doit redemander le compte : c\'est ce qui remplace le portefeuille de démonstration');
});
test('un refus NOMMÉ n\'est pas une panne, et la liste est fermée', () => {
  // La règle est dans WBCore avec son test, parce que c'est elle qui décide si une partie payante
  // peut devenir une partie gratuite. QUATRE codes depuis la phase 04a, et quatre seulement :
  // `plafond` rejoint les trois autres parce qu'il dit la même chose qu'eux — le serveur a instruit
  // la demande et l'a rejetée, rien n'a été débité, et il y a quelque chose à faire. Le laisser
  // retomber hors ligne ferait jouer GRATUITEMENT celui qu'on vient tout juste de borner.
  assert.deepStrictEqual(C.REFUS_SAS, ['fonds', 'livre', 'renonce_recent', 'plafond']);
  for (const code of C.REFUS_SAS)
    assert.strictEqual(C.refusDuBillet(409, { code }), code, code);
  // Statut 0 : il n'y a pas eu de réponse du tout. Ce n'est pas un refus, c'est une absence — et
  // c'est exactement le cas « serveur muet » que la 02a fait partir hors ligne.
  assert.strictEqual(C.refusDuBillet(0, { code: 'fonds' }), null,
    'sans réponse, il n\'y a rien à refuser : la partie part hors ligne');
  // Un refus que le serveur ne nomme pas ne dit rien de ce que le joueur a le droit de faire :
  // 429, 500, un code inconnu, un corps absent — tous retombent dans le repli hors ligne.
  for (const cas of [[429, null], [500, null], [503, { erreur: 'x' }], [409, { code: 'sim_version' }],
                     [400, { code: 'corps' }], [404, { code: 'billet' }], [409, { code: 'expire' }],
                     [409, { code: {} }], [409, { code: ['fonds'] }], [409, {}]])
    assert.strictEqual(C.refusDuBillet(cas[0], cas[1]), null, JSON.stringify(cas));
  // Ne lance sur rien : un corps hostile ne doit pas casser le sas.
  for (const rien of [null, undefined, 42, 'x', [], Object.create(null)])
    assert.strictEqual(C.refusDuBillet(409, rien), null, Object.prototype.toString.call(rien));
});
test('un refus se dit au joueur en clair, et jamais en détail technique', () => {
  assert.match(C.refusMessage('fonds', {}), /Not enough credits/);
  assert.match(C.refusMessage('livre', {}), /Nothing was charged/);
  // La temporisation dit COMBIEN de temps, et elle prend le nombre du serveur quand il le donne.
  assert.match(C.refusMessage('renonce_recent', { windowSeconds: 10 }), /10 seconds/);
  assert.match(C.refusMessage('renonce_recent', { windowSeconds: 7 }), /7 seconds/);
  // Sans nombre lisible, elle retombe sur la fenêtre de WBCore — jamais sur `NaN seconds`.
  for (const faux of [undefined, null, 'x', NaN, 0, -3])
    assert.match(C.refusMessage('renonce_recent', { windowSeconds: faux }),
      new RegExp(C.renonceFenetreS() + ' seconds'), String(faux));
  // Un code inconnu reste lisible : un message vide laisserait le lobby muet, donc mort.
  for (const code of ['', 'inconnu', undefined, null])
    assert.ok(C.refusMessage(code, {}).length > 10, String(code));
  // Et jamais le détail technique : ni code, ni statut, ni nom de table.
  for (const code of ['fonds', 'livre', 'renonce_recent', 'plafond', 'inconnu'])
    for (const fuite of ['409', 'ledger', 'enjeu:', 'postgres', 'undefined', 'NaN'])
      assert.ok(!C.refusMessage(code, { windowSeconds: 10 }).includes(fuite), code + ' / ' + fuite);
});
test('UN SEUL CODE, DEUX PORTÉES : le message du plafond LIT la portée, et l\'absence rend la MAISON', () => {
  // C'est la raison pour laquelle un seul code suffit. Le sas n'a qu'un comportement à tenir — il
  // s'arrête, il affiche, il ne lance rien — donc faire diverger la liste fermée pour une nuance que
  // le joueur ne peut pas actionner serait une complication gratuite. Mais UNE SEULE PHRASE
  // MENTIRAIT DANS UN CAS SUR DEUX.
  const joueur = C.refusMessage('plafond', { portee: 'joueur', expositionCents: 160000,
                                             plafondCents: 156000, fenetreHeures: 24 });
  const maison = C.refusMessage('plafond', { portee: 'maison', expositionCents: 2100000,
                                             plafondCents: 2000000, fenetreHeures: 24 });
  assert.notStrictEqual(joueur, maison, 'les deux portées doivent dire deux choses différentes');
  // La portée `joueur` promet ce qui est VRAI et vérifié côté serveur : une table moins chère
  // s'ouvre dans la foulée. Les chiffres de ce cas sont ceux de la BANDE OÙ UNE TELLE TABLE EXISTE
  // — le serveur n'y pose pas `aucuneTableMoinsChere` — et la bande d'au-dessus, celle du lobby
  // saturé, a son propre test juste en dessous.
  assert.match(joueur, /smaller buy-in/);
  // La portée `maison` ne promet AUCUNE table : aucune table moins chère n'aiderait, le fusible
  // global refuse tout le monde. Elle dit ce qu'il y a à faire — attendre — et ce qui n'a pas eu
  // lieu : rien n'a été débité.
  assert.ok(!/smaller buy-in/.test(maison), maison);
  assert.match(maison, /try again/i);
  for (const m of [joueur, maison]) assert.match(m, /[Nn]othing was charged/);
  // PORTÉE ABSENTE OU ILLISIBLE : ON REND CELLE DE LA MAISON, délibérément. Promettre une table
  // moins chère quand aucune ne marchera renvoie le joueur cliquer en boucle sur un lobby qui a
  // l'air cassé ; dire « plus tard » à quelqu'un qu'une table moins chère aurait dépanné lui coûte
  // quelques minutes. Le second est le moins cher des deux, donc c'est le repli.
  for (const absente of [{}, { portee: '' }, { portee: null }, { portee: 'JOUEUR' },
                         { portee: 'maison_' }, { portee: ['joueur'] }, { portee: 42 },
                         undefined, null])
    assert.strictEqual(C.refusMessage('plafond', absente), maison, JSON.stringify(absente));
  // Et aucun chiffre du serveur ne fuit à l'écran : le joueur lit ce qu'il peut faire, pas
  // l'exposition de la maison en centimes.
  for (const m of [joueur, maison])
    for (const chiffre of ['156000', '2000000', '160000', '2100000'])
      assert.ok(!m.includes(chiffre), m);
});
test('LOBBY SATURÉ : portée `joueur`, mais on ne promet plus une table qui n\'existe pas', () => {
  // LA TROISIÈME SITUATION, et c'est celle que le plafond est CALIBRÉ pour produire. Le pire cas
  // d'un billet est strictement positif sur les vingt combinaisons mode × palier, donc dès que
  // l'exposition réalisée d'un joueur arrive à moins d'un pire cas minimal du plafond, plus aucune
  // table ne passe. Quatre Resurgence à 10 $ gagnées au maximum y suffisent — c'est exactement le
  // nombre de tables que `PLAFOND_TABLES_PAR_JOUR` laisse gagner.
  //
  // Le serveur décide et le jeu LIT : `aucuneTableMoinsChere` arrive avec le 409, `refusMessage` ne
  // fait aucun calcul. Le plafond d'exposition n'est pas une règle du jeu, et le pire cas minimal du
  // lobby n'a rien à faire dans les 465 Ko que chaque joueur télécharge.
  const corps = { portee: 'joueur', aucuneTableMoinsChere: true, expositionCents: 156750,
                  plafondCents: 156000, fenetreHeures: 24 };
  const sature = C.refusMessage('plafond', corps);
  assert.ok(!/smaller buy-in/.test(sature), sature);
  assert.match(sature, /try again later/i);
  assert.match(sature, /[Nn]othing was charged/);
  // ET IL RESTE DISTINCT DE CELUI DE LA MAISON : la cause doit rester lisible. Un joueur qui a
  // beaucoup gagné et une maison qui ferme boutique ne sont pas la même nouvelle.
  const maison = C.refusMessage('plafond', { portee: 'maison', expositionCents: 2100000,
                                             plafondCents: 2000000, fenetreHeures: 24 });
  assert.notStrictEqual(sature, maison);
  // Le drapeau ABSENT ou FAUX ne change rien : la phrase de toujours, pour la bande où une table
  // moins chère existe vraiment.
  const promesse = C.refusMessage('plafond', { portee: 'joueur' });
  for (const sans of [{ portee: 'joueur' }, { portee: 'joueur', aucuneTableMoinsChere: false }])
    assert.strictEqual(C.refusMessage('plafond', sans), promesse, JSON.stringify(sans));
  assert.match(promesse, /smaller buy-in/);
  // ET LE DRAPEAU NE DÉTOURNE PAS LA PORTÉE `maison` : elle dit déjà « plus tard », et le fusible
  // n'a pas d'autre phrase à rendre. Un serveur ancien qui parle à un client neuf, ou l'inverse,
  // retombe sur le repli existant, qui est celui de la maison.
  assert.strictEqual(C.refusMessage('plafond', { portee: 'maison', aucuneTableMoinsChere: true }),
                     maison);
  // Aucun chiffre ne fuit à l'écran, comme pour les deux autres phrases.
  for (const chiffre of ['156000', '156750', '750', '24'])
    assert.ok(!sature.includes(chiffre), sature);
});
test('matchFlow : renoncer rend le billet, et n\'est pas un coup d\'envoi', () => {
  // Deux transitions nouvelles, et elles ne doublent pas `coup-denvoi` : quitter le sas ne lance
  // rien. Depuis `billet`, le coup d'envoi mène à `partie` ; le renoncement mène à `hors-ligne`,
  // parce que le serveur va CLORE ce billet et que le suivant devra être demandé.
  assert.strictEqual(C.matchFlow('billet', 'renonce'), 'hors-ligne');
  assert.strictEqual(C.matchFlow('demande', 'renonce'), 'hors-ligne');
  assert.strictEqual(C.matchFlow('billet', 'coup-denvoi'), 'partie');
  // Et l'événement ne fait rien ailleurs : une partie en cours ne se renonce pas.
  for (const etat of ['hors-ligne', 'partie', 'rapport', 'fini'])
    assert.strictEqual(C.matchFlow(etat, 'renonce'), etat, etat);
  // Depuis `hors-ligne`, le sas repart et demande son billet : le lobby n'est pas mort.
  assert.strictEqual(C.matchFlow(C.matchFlow('billet', 'renonce'), 'sas-en-ligne'), 'demande');
});
testAsync('UN 409 FONDS ARRÊTE LE SAS, et ne lance AUCUNE partie', () => {
  // La distinction de la phase 03, exécutée. Le serveur a instruit la demande et l'a rejetée :
  // partir quand même ferait de la partie payante une partie gratuite.
  const { Match, envois, refus } = bancMatch();
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => {
      envois[0].repondre({ ok: false, status: 409, data: { erreur: 'Pas assez de crédits pour cette table.',
        code: 'fonds', balanceCents: 20, quarantineCents: 0, requiredCents: 50 } });
      return souffler();
    })
    .then(() => {
      assert.strictEqual(refus.length, 1, 'le sas doit être prévenu');
      assert.strictEqual(refus[0].code, 'fonds');
      assert.strictEqual(refus[0].data.requiredCents, 50, 'le corps du refus arrive tel quel');
      assert.ok(C.refusMessage(refus[0].code, refus[0].data).length > 10, 'et il y a un message à montrer');
      assert.strictEqual(envois.length, 1, 'un refus ne se retente pas tout seul');
      // LE LOBBY N'EST PAS MORT : le sas suivant redemande un billet, tout de suite.
      Match.sas('solo', 0.5, 'bolt');
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 2, 'après un refus, on peut retenter');
      envois[1].repondre({ ok: true, status: 200, data: BILLET('90', 4242) });
      return souffler();
    })
    .then(() => assert.strictEqual(C.seedFor(Match.coupDenvoi('solo', 50), 111111), 4242,
      'et la table suivante se joue normalement'));
});
testAsync('un refus de fonds ne laisse AUCUN billet à jouer', () => {
  // Le pendant du test précédent : ici l'écran atteint quand même le coup d'envoi — ce qui
  // n'arrive pas, puisqu'il quitte le sas — et il n'y a toujours rien à jouer.
  const { Match, envois } = bancMatch();
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: false, status: 409, data: { code: 'fonds' } }); return souffler(); })
    .then(() => {
      assert.strictEqual(Match.coupDenvoi('solo', 50), null, 'aucun billet, donc aucune partie payante');
      assert.strictEqual(envois.length, 1);
    });
});
testAsync('UN 409 PLAFOND ARRÊTE LE SAS, n\'écrit AUCUN montant, et n\'enferme personne', () => {
  // Le quatrième refus nommé, et il se comporte exactement comme les trois autres : le serveur a
  // instruit la demande et l'a rejetée, rien n'a été débité, et la partie ne part PAS hors ligne.
  // Le laisser filer ferait jouer gratuitement celui qu'on vient tout juste de borner.
  const { Match, envois, refus, adoptes } = bancMatch();
  const corps = { erreur: 'x', code: 'plafond', portee: 'joueur', expositionCents: 160000,
                  plafondCents: 156000, fenetreHeures: 24 };
  return Promise.resolve()
    .then(() => { Match.sas('resurgence', 10, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: false, status: 409, data: corps }); return souffler(); })
    .then(() => {
      assert.deepStrictEqual(refus.map(r => r.code), ['plafond'], 'le sas doit être prévenu');
      assert.strictEqual(refus[0].data.portee, 'joueur', 'la portée arrive telle quelle');
      assert.ok(C.refusMessage(refus[0].code, refus[0].data).length > 10, 'et il y a un message');
      assert.strictEqual(envois.length, 1, 'un refus ne se retente pas tout seul');
      // AUCUN MONTANT N'EST ÉCRIT. Le corps d'un `plafond` ne porte ni solde ni quarantaine — rien
      // n'a bougé, il n'y a rien à dire — et `applyAccount` rend alors `null` pour les deux. Sans
      // cette règle, un refus remettrait le portefeuille du lobby à zéro, ce qui est très exactement
      // la panne qu'un montant ABSENT ne doit jamais produire. `expositionCents` et `plafondCents`
      // sont des centimes de la MAISON, et ils ne doivent surtout pas être pris pour un solde.
      assert.strictEqual(adoptes.length, 1, 'le module adopte les montants du refus, une fois');
      const p = C.applyAccount(LOCAL(), adoptes[0], AVA);
      assert.strictEqual(p.wallet, null, 'un refus plafond a écrit un solde');
      assert.strictEqual(p.quarantine, null, 'un refus plafond a écrit une quarantaine');
      // LE LOBBY N'EST PAS MORT, et c'est la promesse que la portée `joueur` fait à l'écran : une
      // table moins chère s'ouvre IMMÉDIATEMENT dans la foulée.
      Match.sas('solo', 0.5, 'bolt');
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 2, 'après un refus de plafond, on peut retenter');
      envois[1].repondre({ ok: true, status: 200, data: BILLET('91', 777) });
      return souffler();
    })
    .then(() => assert.strictEqual(C.seedFor(Match.coupDenvoi('solo', 50), 111111), 777,
      'et la table moins chère se joue normalement'));
});
testAsync('les trois autres refus nommés arrêtent le sas de la même façon', () => {
  const cas = [
    { code: 'livre', corps: { erreur: 'x', code: 'livre', detail: null } },
    { code: 'renonce_recent', corps: { erreur: 'x', code: 'renonce_recent', windowSeconds: 10 } },
    // La portée `maison` : le fusible global a sauté, aucune table moins chère n'aidera, et le sas
    // s'arrête tout pareil.
    { code: 'plafond', corps: { erreur: 'x', code: 'plafond', portee: 'maison',
                                expositionCents: 2100000, plafondCents: 2000000, fenetreHeures: 24 } },
  ];
  return cas.reduce((chaine, c) => chaine.then(() => {
    const { Match, envois, refus } = bancMatch();
    return Promise.resolve()
      .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
      .then(() => { envois[0].repondre({ ok: false, status: 409, data: c.corps }); return souffler(); })
      .then(() => {
        assert.deepStrictEqual(refus.map(r => r.code), [c.code], c.code);
        assert.strictEqual(Match.coupDenvoi('solo', 50), null, c.code);
      });
  }), Promise.resolve());
});
testAsync('LES QUATRE CAS DE REPLI rendent une partie IDENTIQUE, graine comprise', () => {
  // Les quatre cas nommés depuis la 02a, testés COMME DES CAS NORMAUX — c'est la promesse du
  // fichier unique, et la phase 03 ne l'entame pas d'un pouce. Aucun des quatre n'est un refus
  // nommé, donc aucun n'arrête le sas : « un billet qui tarde ne retarde jamais le coup d'envoi ».
  const GRAINE = 20260914;
  const cas = [
    { nom: 'pas de compte, ou ACCOUNT.api vide', online: false, reponse: null },
    { nom: 'serveur muet', online: true, reponse: { ok: false, status: 0, data: null } },
    { nom: 'réponse illisible', online: true, reponse: { ok: true, status: 200, data: { bonjour: 1 } } },
    { nom: 'panne du serveur', online: true, reponse: { ok: false, status: 500, data: null } },
  ];
  return cas.reduce((chaine, c) => chaine.then(() => {
    const { Match, envois, refus } = bancMatch({ online: c.online });
    return Promise.resolve()
      .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
      .then(() => {
        if (!c.online) { assert.deepStrictEqual(envois, [], c.nom + ' : rien ne part'); return souffler(); }
        envois[0].repondre(c.reponse);
        return souffler();
      })
      .then(() => {
        assert.deepStrictEqual(refus, [], c.nom + ' : ce n\'est pas un refus, le sas ne s\'arrête pas');
        const billet = Match.coupDenvoi('solo', 50);
        assert.strictEqual(billet, null, c.nom);
        // LA GRAINE EST CELLE DU NAVIGATEUR, à l'identique : la partie est exactement celle
        // d'hier, la carte, le gaz, les caisses et les vingt brawlers compris.
        assert.strictEqual(C.seedFor(billet, GRAINE), GRAINE, c.nom);
        // Et le portefeuille de démonstration fonctionne comme avant : il prend la mise et la rend.
        const w = bancPortefeuille(false, C.START_WALLET);
        assert.strictEqual(w.debit(0.5), C.START_WALLET - 0.5, c.nom);
        assert.strictEqual(w.credit(0.5), C.START_WALLET, c.nom);
        // Rien à rendre non plus à la fin : sans billet, ni trace ni rapport.
        Match.fin(FIN, TRACE_ENVOI);
        return souffler();
      })
      .then(() => assert.strictEqual(envois.length, c.online ? 1 : 0, c.nom + ' : aucun rapport'));
  }), Promise.resolve());
});
testAsync('quitter le sas PENDANT la fenêtre renonce au billet, et redemande le solde', () => {
  const banc = bancMatch();
  const { Match, envois } = banc;
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: BILLET('91', 4242) }); return souffler(); })
    .then(() => {
      assert.strictEqual(banc.syncs(), 0);
      Match.quitterLeSas(true);
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 2);
      assert.strictEqual(envois[1].path, '/api/match/91/renounce');
      assert.deepStrictEqual(envois[1].body, {}, 'la route ne lit aucun champ, mais le corps se poste');
      envois[1].repondre({ ok: true, status: 200, data: { matchId: '91', status: 'renounced',
        refundedCents: 50, balanceCents: 5000, quarantineCents: 0 } });
      return souffler();
    })
    .then(() => {
      // LE SOLDE SE REDEMANDE, il ne se lit pas dans la réponse : un renoncement n'est pas un compte.
      assert.strictEqual(banc.syncs(), 1, 'le solde doit se redemander au serveur');
      // LE BILLET NE RESSERT PAS : le serveur l'a clos, et le sas suivant en demande un neuf.
      Match.sas('solo', 0.5, 'bolt');
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 3);
      assert.strictEqual(envois[2].path, '/api/match', 'le sas suivant doit demander SON billet');
      envois[2].repondre({ ok: true, status: 200, data: BILLET('92', 777) });
      return souffler();
    })
    .then(() => assert.strictEqual(C.seedFor(Match.coupDenvoi('solo', 50), 111111), 777,
      'et c\'est le billet neuf qui se joue, pas le billet renoncé'));
});
testAsync('UN BILLET RENONCÉ NE RESSORT JAMAIS, même si le suivant n\'arrive pas', () => {
  // Le billet renoncé est CLOS côté serveur. Le garder en main le ferait ressortir au coup d'envoi
  // suivant : même carte, même gaz, sur un billet que le serveur refuserait de régler — et le sas
  // ne demanderait pas le billet neuf dont il a besoin. C'est le patron du billet resservi de la
  // 02b, transposé au renoncement, et il faut un serveur MUET pour le voir.
  const { Match, envois } = bancMatch();
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: BILLET('96', 4242) }); return souffler(); })
    .then(() => { Match.quitterLeSas(true); return souffler(); })
    .then(() => {
      envois[1].repondre({ ok: true, status: 200, data: { matchId: '96', status: 'renounced',
        refundedCents: 50, balanceCents: 5000, quarantineCents: 0 } });
      Match.sas('solo', 0.5, 'bolt');
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois[2].path, '/api/match');
      envois[2].repondre({ ok: false, status: 0, data: null });   // le serveur ne répond plus
      return souffler();
    })
    .then(() => {
      const billet = Match.coupDenvoi('solo', 50);
      assert.strictEqual(billet, null, 'le billet renoncé est ressorti');
      assert.strictEqual(C.seedFor(billet, 111111), 111111, 'la partie repart sur la graine locale');
      // Et sa fin ne rend rien : il n'y a pas de billet, donc pas de rapport.
      Match.fin(FIN, TRACE_ENVOI);
      return souffler();
    })
    .then(() => assert.strictEqual(envois.length, 3, 'aucun rapport sur un billet renoncé'));
});
testAsync('quitter le sas APRÈS la fenêtre ne promet rien, et ne réclame rien', () => {
  // Hors fenêtre, le serveur refuserait — et le réclamer pour rien coûterait au joueur la
  // temporisation `renonce_recent`, donc dix secondes avant de pouvoir rejouer.
  const banc = bancMatch();
  const { Match, envois } = banc;
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: BILLET('93', 4242) }); return souffler(); })
    .then(() => { Match.quitterLeSas(false); return souffler(); })
    .then(() => {
      assert.strictEqual(envois.length, 1, 'aucun renoncement ne part hors fenêtre');
      assert.strictEqual(banc.syncs(), 0, 'et rien ne bouge côté solde');
      // Le billet reste ouvert côté serveur : y revenir le retrouve, et il se joue encore.
      assert.strictEqual(C.seedFor(Match.coupDenvoi('solo', 50), 111111), 4242);
    });
});
testAsync('quitter pendant que la demande est EN VOL renonce au billet qui arrive', () => {
  // Le trou que le débit à l'ouverture creuse, et il coûte une mise entière : le serveur ouvre le
  // billet et débite pendant que le joueur est déjà reparti. Sans ce chemin, personne ne renonce
  // pour lui et la mise reste au séquestre jusqu'à l'expiration.
  const banc = bancMatch();
  const { Match, envois } = banc;
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => {
      assert.strictEqual(envois.length, 1);
      Match.quitterLeSas(true);                    // le joueur part, la demande est encore en vol
      envois[0].repondre({ ok: true, status: 200, data: BILLET('94', 4242) });
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 2, 'le billet arrivé en retard doit être renoncé');
      assert.strictEqual(envois[1].path, '/api/match/94/renounce');
      // Et il n'est jamais entré en jeu : le coup d'envoi n'a rien à sortir.
      assert.strictEqual(Match.coupDenvoi('solo', 50), null);
    });
});
testAsync('un billet qui arrive après un départ HORS fenêtre n\'est pas réclamé', () => {
  const banc = bancMatch();
  const { Match, envois } = banc;
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => {
      Match.quitterLeSas(false);
      envois[0].repondre({ ok: true, status: 200, data: BILLET('95', 4242) });
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 1, 'hors fenêtre, rien ne part');
      assert.strictEqual(Match.coupDenvoi('solo', 50), null, 'et ce billet-là n\'est pas joué');
    });
});
testAsync('LE SOLDE RENDU AVEC LE BILLET ARRIVE À L\'ÉCRAN, et celui du refus AUSSI', () => {
  // Le scénario, et il se voyait à l'œil nu : connecté avec 5 000 c, le joueur entre sur une table
  // à 10 $. Le serveur ouvre le billet, débite, et répond `balanceCents: 4000`. Le jeu faisait
  // seulement `ticket=r.data` : le grand livre portait 4 000, l'écran portait 5 000, et l'écart
  // survivait au retour au lobby, à l'écran de fin, et à toute partie qui ne se règle pas. Les
  // tables restaient allumées alors que le serveur répondrait `409 fonds`.
  const banc = bancMatch();
  const { Match, envois, adoptes } = banc;
  const AVEC = { ...BILLET('60', 777), balanceCents: 4000, quarantineCents: 0 };
  return Promise.resolve()
    .then(() => { Match.sas('solo', 10, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: AVEC }); return souffler(); })
    .then(() => {
      assert.strictEqual(adoptes.length, 1, 'le solde rendu AVEC le billet n\'a pas été adopté');
      assert.strictEqual(adoptes[0], AVEC, 'et c\'est le corps du serveur, pas une soustraction locale');
      // Ce que l'écran en fera, par le seul point de conversion du jeu.
      const p = C.applyAccount(LOCAL(), AVEC, AVA);
      assert.strictEqual(p.wallet, C.fromCents(4000));
      assert.strictEqual(p.quarantine, 0);
    });
});
testAsync('LE CORPS DU 409 fonds PORTE LE SOLDE RÉEL, et c\'est lui qui éteint la table', () => {
  // Sans cela le joueur reclique la même table et reprend le même refus en boucle : l'écran ne se
  // corrige jamais, puisque le seul montant qu'il ait vu est celui d'avant.
  const banc = bancMatch();
  const { Match, envois, adoptes, refus } = banc;
  const CORPS = { erreur: 'x', code: 'fonds', balanceCents: 120, quarantineCents: 0, requiredCents: 1000 };
  return Promise.resolve()
    .then(() => { Match.sas('solo', 10, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: false, status: 409, data: CORPS }); return souffler(); })
    .then(() => {
      assert.deepStrictEqual(refus.map(x => x.code), ['fonds']);
      assert.strictEqual(adoptes.length, 1, 'le solde du refus n\'a pas été adopté');
      assert.strictEqual(adoptes[0], CORPS);
    });
});
testAsync('un billet SANS montants n\'écrit rien, et un refus sans montant non plus', () => {
  // Le repli de la 02a : un serveur qui rend un billet sans `balanceCents`. `applyAccount` rend
  // alors `null` et l'appelant n'écrit pas — c'est la règle qui empêche un règlement de vider le
  // portefeuille à l'écran, et elle vaut ici mot pour mot.
  const banc = bancMatch();
  const { Match, envois, adoptes } = banc;

  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: BILLET('61', 777) }); return souffler(); })
    .then(() => {
      assert.strictEqual(adoptes.length, 1, 'le point d\'adoption doit être appelé, même à vide');
      const p = C.applyAccount(LOCAL(), adoptes[0], AVA);
      assert.strictEqual(p.wallet, null, 'un billet sans montant ne doit rien écrire');
      assert.strictEqual(p.quarantine, null);
      // Et le module, lui, n'a jamais redemandé le compte : le billet n'en est pas un.
      assert.strictEqual(banc.syncs(), 0);
    });
});
testAsync('un serveur MUET n\'écrit aucun montant, et ne casse pas le point d\'adoption', () => {
  // Statut 0, corps nul : le cas de repli le plus banal de la 02a. Le point d'adoption est appelé
  // sur le chemin du refus comme sur celui du billet, donc il doit encaisser un corps absent sans
  // broncher — `applyAccount` rend `null` sur tout ce qui n'est pas un nombre fini.
  const banc = bancMatch();
  const { Match, envois, adoptes, refus } = banc;
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: false, status: 0, data: null }); return souffler(); })
    .then(() => {
      assert.deepStrictEqual(refus, [], 'une absence de réponse ne nomme rien');
      assert.strictEqual(adoptes.length, 1);
      const p = C.applyAccount(LOCAL(), adoptes[0], AVA);
      assert.strictEqual(p.wallet, null);
      assert.strictEqual(p.quarantine, null);
      // Et la partie part quand même, sur la graine locale : c'est la promesse du fichier unique.
      assert.strictEqual(C.seedFor(Match.coupDenvoi('solo', 50), 111111), 111111);
    });
});
testAsync('un billet REPRIS est SU du sas, et il ne promet plus rien', () => {
  // L'enchaînement complet, au-delà du départ hors fenêtre. Le joueur part à 15 s — le billet reste
  // en main, rien n'est renoncé — puis reclique : le serveur rend LE MÊME billet par le chemin
  // `repris`, avec son `opened_at` d'origine. Le second sas repart à zéro, donc aucun chronomètre
  // de ce sas-là ne mesure l'âge du billet.
  const banc = bancMatch();
  const { Match, envois } = banc;
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => {
      envois[0].repondre({ ok: true, status: 200, data: { ...BILLET('96', 4242), repris: false } });
      return souffler();
    })
    .then(() => {
      assert.strictEqual(Match.billetRepris(), false, 'un billet fraîchement ouvert n\'est pas repris');
      Match.quitterLeSas(false);                 // hors fenêtre : le billet reste en main
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 1, 'aucun renoncement ne part hors fenêtre');
      Match.sas('solo', 0.5, 'bolt');            // il reclique la table
      return souffler();
    })
    .then(() => {
      assert.strictEqual(envois.length, 2, 'le second sas demande son billet');
      envois[1].repondre({ ok: true, status: 200, data: { ...BILLET('96', 4242), repris: true } });
      return souffler();
    })
    .then(() => {
      assert.strictEqual(Match.billetRepris(), true, 'le sas ignore qu\'il tient un billet repris');
      // Et l'écran, qui lit cela, ne promet plus : la confrontation complète est dans le test du
      // libellé, celui-ci prouve que le module rend bien la réponse du serveur.
      assert.strictEqual(bancQuitter(0, true, { repris: Match.billetRepris() }).texte, 'LEAVE · STAKE IS LOST');
      // Rien ne dit qu'un billet est repris quand il n'y en a pas : c'est ce qui garde ouvert le
      // renoncement au billet qui arrive en retard.
      Match.coupDenvoi('solo', 50);
      Match.fin(FIN, TRACE_ENVOI);
      assert.strictEqual(Match.billetRepris(), false);
    });
});
testAsync('UN RENONCEMENT REFUSÉ NE S\'AVALE PAS : le joueur l\'apprend, et le solde se redemande', () => {
  // `if(r.ok) Auth.sync()` et rien d'autre : le joueur revenait au lobby persuadé d'avoir été
  // remboursé, pendant que le veilleur balayait sa mise chez la maison. Une mise qui disparaît sans
  // un mot est le pire des deux mondes.
  const banc = bancMatch();
  const { Match, envois, renoncesRefuses } = banc;
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: BILLET('97', 4242) }); return souffler(); })
    .then(() => { Match.quitterLeSas(true); return souffler(); })
    .then(() => {
      assert.strictEqual(envois[1].path, '/api/match/97/renounce');
      envois[1].repondre({ ok: false, status: 409,
                           data: { erreur: 'trop tard', code: 'fenetre_close', windowSeconds: 10 } });
      return souffler();
    })
    .then(() => {
      assert.deepStrictEqual(renoncesRefuses.map(x => x.code), ['fenetre_close'],
        'le refus du renoncement n\'a été dit à personne');
      assert.strictEqual(banc.syncs(), 1, 'le solde doit se redemander même sur un refus');
      // Et le message que l'écran affichera dit ce qui est arrivé à la mise, jamais le code.
      const texte = C.refusMessage('fenetre_close', renoncesRefuses[0].data);
      assert.ok(texte.length > 20 && !/fenetre_close|409/.test(texte), texte);
    });
});
testAsync('une PANNE sur le renoncement ne dit rien, comme partout ailleurs dans ce module', () => {
  // Statut 0 : il n'y a pas eu de réponse. Ce n'est pas un refus, c'est une absence — et le module
  // ne nomme jamais ce que le serveur n'a pas nommé. Le solde se redemande quand même.
  const banc = bancMatch();
  const { Match, envois, renoncesRefuses } = banc;
  return Promise.resolve()
    .then(() => { Match.sas('solo', 0.5, 'bolt'); return souffler(); })
    .then(() => { envois[0].repondre({ ok: true, status: 200, data: BILLET('98', 4242) }); return souffler(); })
    .then(() => { Match.quitterLeSas(true); return souffler(); })
    .then(() => { envois[1].repondre({ ok: false, status: 0, data: null }); return souffler(); })
    .then(() => {
      assert.deepStrictEqual(renoncesRefuses, [], 'une panne silencieuse ne nomme rien');
      assert.strictEqual(banc.syncs(), 1);
    });
});

console.log('La boucle : le pas fixe d\'un côté, l\'image de l\'autre');
// Gardes de forme, permanentes. Elles ne prouvent pas que le jeu tourne — seul un humain qui joue
// le prouve — elles prouvent que la frontière entre ce qui décide et ce qui montre n'a pas été
// refranchie par une édition. C'est la précondition du rejeu : si un `dt` d'image redescend dans
// une fonction de simulation, la partie redevient une fonction de la cadence de l'écran et plus
// personne ne peut la recalculer.
const BOUCLE = JEU.slice(JEU.indexOf('// ---------- loop ----------'));
const PAS_FIXE = BOUCLE.slice(BOUCLE.indexOf('function simPas(){'), BOUCLE.indexOf('function loop(now){'));
const IMAGE = BOUCLE.slice(BOUCLE.indexOf('function loop(now){'));
const codeDe = t => t.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
test('aucune fonction de simulation n\'est appelée depuis la boucle d\'image', () => {
  assert.ok(PAS_FIXE.length > 400, 'simPas n\'a pas été retrouvée');
  assert.ok(IMAGE.length > 800, 'loop n\'a pas été retrouvée');
  // Le pas entier est descendu dans `WBSim.step` au module 5 : c'est LUI qui doit appeler la
  // simulation, et la boucle d'image qui ne doit jamais le faire. La garde compte donc désormais
  // deux côtés — ce que `step` contient, et ce que `loop` n'a pas le droit de contenir.
  const ETAPE = sim.slice(sim.indexOf('\nfunction step(G, entrees){'), sim.indexOf('// ---------- l\'empreinte'));
  assert.ok(ETAPE.length > 400, 'WBSim.step n\'a pas été retrouvée');
  const simulation = ['joueurUpdate(', 'botUpdate(', 'commonUpdate(', 'projUpdate(', 'zonesUpdate(',
                      'nadesUpdate(', 'smokesUpdate(', 'zoneUpdate(', 'respawn(', 'G.time+='];
  for (const nom of simulation) {
    assert.ok(ETAPE.includes(nom), `${nom} doit être appelé depuis le pas de simulation`);
    assert.ok(!codeDe(IMAGE).includes(nom), `${nom} est appelé depuis la boucle d'image, donc avec un dt d'image`);
    assert.ok(!codeDe(PAS_FIXE).includes(nom), `${nom} doit être appelé par WBSim.step, pas par le bloc Game`);
  }
  // Et ce que `simPas` garde n'est plus qu'un aiguillage : lire les commandes, faire tiquer le HUD,
  // traduire ce que le pas a raconté.
  assert.match(codeDe(PAS_FIXE), /const entrees=lireEntrees\(\);/, 'simPas doit LIRE les commandes');
  assert.match(codeDe(PAS_FIXE), /WBSim\.step\(G,entrees\)/, 'simPas doit passer par WBSim.step');
  // Et le pas fixe ne connaît qu'un seul `dt` : celui de WBCore. Aucune horloge, aucun `now`.
  assert.match(PAS_FIXE, /const dt=C\.SIM\.stepS;/, 'le pas doit venir de WBCore, jamais d\'une constante recopiée');
  assert.match(ETAPE, /const dt=C\.SIM\.stepS;/, 'le pas de WBSim.step doit venir de WBCore lui aussi');
  for (const interdit of ['now', 'performance', 'Date.now', 'requestAnimationFrame', 'simReste'])
    assert.ok(!codeDe(PAS_FIXE).includes(interdit), `${interdit} n'a rien à faire dans un pas de simulation`);
  // La boucle, elle, accumule le temps réel et n'exécute que des pas entiers.
  assert.match(IMAGE, /C\.simSteps\(simReste,dtSim\)/, 'la boucle doit passer par simSteps');
  assert.match(IMAGE, /for\(let i=0;i<s\.pas;i\+\+\) simPas\(\);/, 'et exécuter exactement le nombre de pas rendu');
});
test('l\'arrêt sur image ne ralentit plus la simulation, il ralentit ce qu\'on lui verse', () => {
  // Avant : `if(critHold>0){ critHold-=dt; dt*=0.12; }` — l'arrêt sur image du coup critique
  // ralentissait TOUT, le gaz compris. C'était le second endroit, avec la boucle elle-même, où un
  // `dt` d'image entrait dans les règles.
  assert.ok(!codeDe(BOUCLE).includes('dt*='), 'plus aucun dt d\'image n\'est mis à l\'échelle dans la boucle');
  assert.ok(!PAS_FIXE.includes('critHold'), 'la simulation ne doit pas savoir que l\'arrêt sur image existe');
  assert.match(IMAGE, /dtSim=dt\*0\.12/, 'l\'échelle s\'applique à ce qu\'on verse dans l\'accumulateur');
  const lignes = JEU.split('\n').filter(l => l.includes('critHold') && !l.trim().startsWith('//'));
  assert.ok(lignes.length > 0 && lignes.every(l => !/\bsimPas\b/.test(l)),
    'critHold ne vit que du côté rendu et accumulateur');
});
test('CRIT_TEST n\'existe plus, et ne doit pas réapparaître', () => {
  // `const CRIT_TEST = false` était du code mort, pas une triche vivante. Mais il doublait le test
  // de critique juste à côté de l'appel à `C.critShot` : le laisser vivre pendant que le critique
  // descend dans la simulation installerait une seconde règle de critique — le patron du
  // `respawn()` défini deux fois, dont docs/HISTORIQUE.md garde la trace.
  assert.ok(!html.includes('CRIT_TEST'), 'CRIT_TEST est de retour dans index.html');
  // `projUpdate` a rejoint le bloc SIM au module 4 : c'est là qu'on la cherche désormais, et le
  // fait qu'elle n'y soit plus ferait tomber ce test plutôt que de le rendre vide.
  const tir = sim.slice(sim.indexOf('function projUpdate('), sim.indexOf('// ---------- degats, mort, butin'));
  assert.ok(tir.length > 500, 'projUpdate n\'a pas été retrouvée');
  assert.match(tir, /C\.critShot\(/, 'la règle du critique reste celle de WBCore');
  assert.strictEqual(tir.split('C.critShot(').length - 1, 1, 'et il n\'y en a qu\'une');
});

console.log('Le hasard de la simulation : des flux nommés, semés par la graine');
// Un générateur unique par partie suffirait au rejeu. Le piège est ailleurs : ajouter un tirage
// quelque part décale toute la suite AILLEURS. Ces tests-là gardent la propriété qui rend le
// module utile — un flux par usage — et la frontière entre ce qui descend de la graine et ce qui
// reste cosmétique. Aucun ne prouve que le jeu tourne ; seul un humain qui joue le prouve.
test('les sels des flux diffèrent entre eux, et de celui du gaz', () => {
  // Deux sels égaux, et deux usages partageraient la même suite : le gaz et les bots joueraient
  // la même partition. Le sel se dérive du NOM, donc renommer un flux le déplace — c'est voulu,
  // et c'est pourquoi la liste des noms est fermée.
  const sels = C.FLUX.map(C.fluxSalt);
  assert.strictEqual(new Set(sels).size, C.FLUX.length, 'deux flux partagent un sel');
  for (let i = 0; i < C.FLUX.length; i++)
    assert.notStrictEqual(sels[i], C.ZONE_SALT, `${C.FLUX[i]} a le sel du gaz`);
  // Et les graines de flux, elles aussi, restent distinctes de celle du gaz et de celle de la carte.
  for (const graine of [0, 1, 7, 4242, 0xdeadbeef, 4294967295]) {
    const vues = new Set([graine >>> 0, ((graine >>> 0) ^ C.ZONE_SALT) >>> 0]);
    for (const nom of C.FLUX) {
      const s = C.fluxSeed(graine, nom);
      assert.ok(!vues.has(s), `${nom} sème comme un autre flux sur la graine ${graine}`);
      vues.add(s);
    }
  }
});
test('les huit noms attendus existent, et un nom inconnu lance', () => {
  for (const nom of ['bots/identite', 'bots/visee', 'bots/objectif', 'bots/encaissement',
                     'apparition', 'butin/contenu', 'butin/position', 'tir/dispersion'])
    assert.ok(C.FLUX.includes(nom), `le flux ${nom} a disparu de la liste`);
  const flux = C.makeFlux(7);
  // Une faute de frappe créerait sinon un flux neuf en silence : le jeu tirerait d'un côté, le
  // rejeu du serveur de l'autre, et rien ne le signalerait.
  for (const faux of ['bots/vise', 'butin', '', 'toString', 'constructor'])
    assert.throws(() => flux(faux), /flux de hasard inconnu/, JSON.stringify(faux));
});
test('un nom rend toujours le MÊME générateur, donc une suite et non des suites neuves', () => {
  const flux = C.makeFlux(1234);
  assert.strictEqual(flux('bots/visee'), flux('bots/visee'), 'deux appels rendent deux générateurs');
  const a = flux('bots/visee'), suite = [a(), a(), a()];
  const b = C.makeFlux(1234)('bots/visee');
  assert.deepStrictEqual([b(), b(), b()], suite, 'même graine, même suite');
  const autre = C.makeFlux(1235)('bots/visee');
  assert.notDeepStrictEqual([autre(), autre(), autre()], suite, 'deux graines, deux suites');
});
test('tirer N fois de plus dans bots/visee ne déplace pas butin/contenu', () => {
  // C'est la raison d'être des flux nommés, et elle se teste directement : une visée qui
  // consomme plus — un brawler de plus, une passe d'esquive de plus — ne doit pas changer une
  // seule caisse. Avec un générateur unique, ce test tombe.
  const butin = graine => { const f = C.makeFlux(graine); const r = f('butin/contenu');
                            return Array.from({ length: 12 }, () => C.boxDrop(r)); };
  const temoin = butin(20260912);
  for (const n of [0, 1, 5, 137]) {
    const f = C.makeFlux(20260912), visee = f('bots/visee'), contenu = f('butin/contenu');
    for (let i = 0; i < n; i++) visee();
    assert.deepStrictEqual(Array.from({ length: 12 }, () => C.boxDrop(contenu)), temoin,
      `${n} tirages de visée en plus ont déplacé le butin`);
  }
});
test('deux graines voisines ne donnent pas deux flux voisins', () => {
  // Le mélange doit avalancher. Un simple `graine ^ sel` laisserait, sur un générateur
  // congruentiel dont les bits de poids faible sont pauvres, deux graines consécutives rendre
  // deux suites presque superposables — et deux parties d'affilée se ressembleraient.
  const debut = (graine, nom) => { const r = C.makeFlux(graine)(nom); return [r(), r(), r()]; };
  for (const nom of C.FLUX)
    for (let graine = 0; graine < 64; graine++) {
      const [a] = debut(graine, nom), [b] = debut(graine + 1, nom);
      assert.ok(Math.abs(a - b) > 1e-6, `${nom} : les graines ${graine} et ${graine + 1} démarrent au même endroit`);
    }
});
test('melangeSeme consomme exactement n-1 tirages et rend une permutation', () => {
  // Il remplace `sort(() => rng() - 0.5)`. Le nombre de comparaisons qu'un moteur effectue n'est
  // spécifié nulle part : le tri consommait donc une longueur de flux inconnue, et tout ce qui
  // tirait ensuite dans ce flux se décalait d'un moteur à l'autre.
  for (const n of [0, 1, 2, 5, 20, 60]) {
    let tirages = 0;
    const rng = C.makeRng(99), compte = () => { tirages++; return rng(); };
    const source = Array.from({ length: n }, (_, i) => i);
    const melange = C.melangeSeme(source.slice(), compte);
    assert.strictEqual(tirages, Math.max(0, n - 1), `${n} éléments`);
    assert.deepStrictEqual(melange.slice().sort((a, b) => a - b), source, 'ce n\'est plus une permutation');
  }
  // Et il mélange vraiment : sur vingt noms, l'ordre ne doit pas survivre.
  const vingt = Array.from({ length: 20 }, (_, i) => i);
  assert.notDeepStrictEqual(C.melangeSeme(vingt.slice(), C.makeRng(3)), vingt);
  assert.deepStrictEqual(C.melangeSeme(vingt.slice(), C.makeRng(3)), C.melangeSeme(vingt.slice(), C.makeRng(3)));
});

console.log('La frontière du hasard : où Math.random est interdit, où il est attendu');
// Deux listes, écrites ici et nulle part ailleurs. La première nomme les fonctions du chemin de
// simulation : un `Math.random(` y est un fait de partie que le serveur ne pourra pas refaire. La
// seconde nomme celles qui le gardent, pour que personne ne « corrige » plus tard une frontière
// qui est un CHOIX. Sans la seconde liste, la première se lirait comme un travail inachevé.
const corpsDansBloc = (bloc, nom) => {
  const d = bloc.indexOf('\nfunction ' + nom + '(');
  assert.ok(d >= 0, `${nom} n'a pas été retrouvée`);
  const lignes = bloc.slice(d + 1).split('\n'), out = [lignes[0]];
  for (let i = 1; i < lignes.length; i++) {
    const l = lignes[i];
    if (l && !/^[\s}]/.test(l)) break;          // une nouvelle déclaration de premier niveau
    out.push(l);
    if (l === '}') break;                       // la fermeture d'une fonction multi-lignes
  }
  return out.join('\n');
};
// Le chemin de simulation vit désormais dans DEUX blocs : celles des fonctions qui sont déjà
// descendues dans SIM, et celles qui attendent encore leur module. On cherche dans les deux, et on
// exige qu'exactement un des deux la déclare. Deux déclarations, ce serait le patron du
// `respawn()` défini deux fois — la copie vivante finit du côté que rien n'exécute.
const corpsDe = nom => {
  const dansSim = sim.includes('\nfunction ' + nom + '('), dansJeu = JEU.includes('\nfunction ' + nom + '(');
  assert.ok(dansSim !== dansJeu,
    `${nom} est déclarée ${dansSim && dansJeu ? 'DANS LES DEUX blocs' : 'dans aucun des deux blocs'}`);
  return corpsDansBloc(dansSim ? sim : JEU, nom);
};
const sansCommentaires = t => t.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const compte = (t, motif) => (t.match(motif) || []).length;
// Le chemin de simulation : tout ce qui décide d'un fait de la partie.
const HASARD_INTERDIT = ['makeEntity', 'spawnPoints', 'fireSpec', 'hurtBox', 'spawnPickup', 'collect',
                         'respawn', 'pickGoal', 'botUpdate', 'findTarget', 'projUpdate', 'joueurUpdate',
                         'commonUpdate', 'damage', 'useSuper', 'dashUpdate', 'zoneUpdate', 'zonesUpdate',
                         'nadesUpdate', 'buildWorld', 'simPas', 'newMatch', 'step', 'condenseEtat'];
// Le cosmétique, et la seule exception qui n'en est pas une : la graine de secours.
const HASARD_ATTENDU = {
  randomName:  'le pseudo d\'un bot au sas d\'attente, qui ne joue aucune partie',
  corpsNuage:  'la position des bouffées d\'un nuage, pure décoration',
  floatText:   'le décalage horizontal d\'un nombre flottant à l\'écran',
  rendreEvenements: 'quelle vanne un bot poste sur un kill ou un encaissement',
  startMatch:  'la graine LOCALE de secours, qui doit précisément ne PAS être reproductible',
};
test('aucun Math.random dans les fonctions du chemin de simulation', () => {
  for (const nom of HASARD_INTERDIT) {
    const corps = sansCommentaires(corpsDe(nom));
    assert.ok(corps.length > 20, `${nom} est suspicieusement courte, l'extraction a dû rater`);
    assert.strictEqual(compte(corps, /Math\.random\(/g), 0,
      `${nom} tire encore sur Math.random : le serveur ne pourra pas refaire ce qu'elle décide`);
  }
  // Et le générateur du décor ne remonte plus dans l'état de la partie : `G.rng` servait à la fois
  // au feuillage des buissons — dont le nombre vient du palier de qualité, donc de la machine — et
  // aux caisses, aux points d'apparition et aux bots. Sur la même graine, deux appareils ne
  // jouaient pas la même partie.
  assert.ok(!sansCommentaires(JEU).includes('G.rng'),
    'G.rng est de retour : la simulation retire dans le flux du décor');
  assert.match(sim, /alea:C\.makeFlux\(seed\)/, 'les flux de la partie doivent naître de la graine');
});
test('chaque usage tire dans le flux qui porte son nom', () => {
  // Sans cette table, « plus aucun Math.random » se satisferait d'un flux unique rebaptisé, et
  // l'indépendance des usages — la seule raison d'être du module — serait perdue en silence.
  const attendus = {
    makeEntity:  ['bots/identite'],
    fireSpec:    ['tir/dispersion'],
    hurtBox:     ['butin/contenu'],
    spawnPickup: ['butin/position'],
    respawn:     ['apparition'],
    pickGoal:    ['bots/objectif'],
    botUpdate:   ['bots/encaissement', 'bots/visee', 'bots/objectif'],
    newMatch:    ['butin/position', 'bots/identite', 'apparition'],
  };
  for (const [nom, flux] of Object.entries(attendus)) {
    const corps = sansCommentaires(corpsDe(nom));
    for (const f of flux)
      assert.ok(corps.includes(`'${f}'`), `${nom} ne tire plus dans le flux ${f}`);
  }
  // `spawnPoints` reçoit son flux de l'appelant : c'est celui des apparitions, et pas un autre.
  assert.match(sansCommentaires(corpsDe('newMatch')), /spawnPoints\(G,\s*G\.alea\('apparition'\)/);
  // Et AUCUN site d'appel du jeu ne demande un nom qui n'existe pas. `makeFlux` lance sur un nom
  // inconnu, mais seulement quand la ligne s'exécute : une faute de frappe dans une branche rare —
  // le fumigène d'un bot acculé — n'apparaîtrait qu'en pleine partie, chez un joueur. Ici elle
  // tombe à l'intégration continue, pour tous les sites à la fois.
  const demandes = sansCommentaires(sim + JEU).match(/G\.alea\('([^']*)'\)/g) || [];
  assert.ok(demandes.length >= 10, `seulement ${demandes.length} sites d'appel trouvés : l'extraction a dû rater`);
  for (const d of demandes)
    assert.ok(C.FLUX.includes(d.slice(8, -2)), `${d} demande un flux qui n'existe pas`);
});
test('et les fonctions qui gardent Math.random le gardent pour une raison écrite', () => {
  for (const [nom, raison] of Object.entries(HASARD_ATTENDU)) {
    const corps = sansCommentaires(corpsDe(nom));
    assert.ok(compte(corps, /Math\.random\(/g) > 0,
      `${nom} ne tire plus sur Math.random (${raison}) : si c'est voulu, sortir le nom de la liste`);
  }
  // La seule qui mérite d'être épinglée à la ligne près : `startMatch` n'a le droit qu'à UN
  // tirage libre, celui de la graine de secours. C'est la promesse du fichier unique — sans
  // compte, sans serveur, sans réseau, la partie part quand même — et c'est exactement le tirage
  // qu'il ne faut jamais semer.
  const debut = sansCommentaires(corpsDe('startMatch'));
  assert.strictEqual(compte(debut, /Math\.random\(/g), 1, 'startMatch ne doit tirer qu\'une fois librement');
  const ligne = debut.split('\n').find(l => l.includes('Math.random('));
  assert.match(ligne, /graineLocale/, 'le seul tirage libre de startMatch doit être la graine de secours');
  // Les vannes des bots sont du texte à l'écran, jamais un fait de partie. `kill` et `botCashOut`
  // sont descendues dans SIM au module 4 et n'ont plus le droit de tirer du tout ; le tirage a
  // suivi la vanne, du côté qui la PRONONCE, et chaque tirage qui reste doit poster quelque chose.
  for (const nom of ['kill', 'botCashOut'])
    assert.strictEqual(compte(sansCommentaires(corpsDe(nom)), /Math\.random\(/g), 0,
      `${nom} vit dans SIM : un tirage libre y rendrait la partie irrejouable`);
  for (const l of sansCommentaires(corpsDe('rendreEvenements')).split('\n').filter(l => l.includes('Math.random(')))
    assert.ok(/botSay\(|sendEmote\(/.test(l), `rendreEvenements : un tirage libre qui ne sert pas à parler — ${l.trim()}`);
});

console.log('La géométrie tirée de la seule graine, sans transcendantes');
// ECMAScript laisse `Math.cos`, `Math.sin`, `Math.hypot`, `Math.pow`, `Math.atan2` et `Math.exp`
// « implementation-approximated ». La carte, les biomes, le plan de zone et les points de départ
// sont le préfixe commun de toute la partie : s'ils divergent entre deux moteurs, tout ce qui suit
// diverge. Eux seuls ne prennent leurs angles que de la graine, donc eux seuls se quantifient sans
// que personne ne le sente. Ce que ces tests ne prouvent PAS : l'égalité entre deux moteurs.
const TRANSCENDANTES = ['Math.cos', 'Math.sin', 'Math.hypot', 'Math.pow', 'Math.atan2', 'Math.exp'];
const corpsCore = nom => {
  const d = core.indexOf('\n  function ' + nom + '(');
  assert.ok(d >= 0, `${nom} n'a pas été retrouvée dans CORE`);
  const reste = core.slice(d + 1), fin = reste.indexOf('\n  }\n');
  assert.ok(fin > 0, `la fin de ${nom} n'a pas été retrouvée`);
  return reste.slice(0, fin + 4);
};
test('garde textuelle : aucune transcendante dans generateMap, generateBiomes, zonePlan, zoneAt ni spawnPoints', () => {
  const geometrie = { generateMap: corpsCore('generateMap'), generateBiomes: corpsCore('generateBiomes'),
                      zonePlan: corpsCore('zonePlan'), zoneAt: corpsCore('zoneAt'),
                      spawnPoints: corpsDe('spawnPoints') };
  for (const [nom, corps] of Object.entries(geometrie)) {
    assert.ok(corps.length > 200, `${nom} est suspicieusement courte, l'extraction a dû rater`);
    for (const interdite of TRANSCENDANTES)
      assert.ok(!sansCommentaires(corps).includes(interdite),
        `${nom} appelle ${interdite} : deux moteurs ont le droit d'en différer du dernier bit`);
  }
  // `Math.sqrt`, lui, est exactement spécifié par IEEE 754 : c'est pourquoi `dist` existe.
  assert.match(sansCommentaires(corpsCore('dist')), /Math\.sqrt/);
  for (const [dx, dz] of [[3, 4], [0, 0], [-7.5, 12.25], [152, 152]])
    assert.strictEqual(C.dist(dx, dz), Math.sqrt(dx * dx + dz * dz), `dist(${dx},${dz})`);
});
// Un `free()` conforme à celui du jeu, réécrit ici EXPRÈS. Le corps du brawler fait 0,42 de
// demi-largeur, et ce sont ses QUATRE coins qui doivent tenir sur du sol praticable. Un centre sur
// du vide et un coin dans le mur, et le brawler ne bouge plus de la partie. Vérifier le placement
// avec le `free()` du jeu prouverait seulement que le jeu est d'accord avec lui-même ; cette copie
// est une seconde opinion, et elle est comparée à l'originale juste en dessous.
assert.strictEqual(SIMU.R, 0.42, 'le rayon du corps a changé dans le jeu : ce test le suppose');
const libreSur = (cells, N) => {
  const bloque = (x, z) => { const xi = Math.floor(x), zi = Math.floor(z);
    return (xi < 0 || zi < 0 || xi >= N || zi >= N) ? true : C.BLOCKING(cells[xi * N + zi]); };
  return (x, z) => !bloque(x - 0.42, z - 0.42) && !bloque(x + 0.42, z - 0.42)
                && !bloque(x - 0.42, z + 0.42) && !bloque(x + 0.42, z + 0.42);
};
// `spawnPoints` est descendue dans le bloc SIM : elle s'appelle désormais telle quelle, sur un
// état de partie réduit à ce dont elle a besoin. Plus d'extraction de source, plus de `free`
// injecté — c'est le vrai code du jeu, chargé comme le navigateur le charge.
const faireSpawnPoints = (S, MathUtil) => {
  const SS = MathUtil ? chargerSim(S, MathUtil) : SIMU;
  return (cells, rng, teams, teamSize) => SS.spawnPoints({ cells }, rng, teams, teamSize);
};
test('spawnPoints place un corps entier, sur deux cents graines et les cinq modes', () => {
  // LE TEST DE NON-RÉGRESSION QUI MANQUAIT, et rien d'autre : le bug est corrigé dans le code
  // depuis longtemps — `spawnPoints` balaie sur `free()` et non sur `isWall()`. Ce qui n'existait
  // pas, c'est la preuve qu'il le reste. Un centre sur du sol libre ne suffit pas : il faut que
  // les quatre coins du corps tiennent, sans quoi `tryMove()` refuse les deux axes et ce brawler
  // ne bouge plus de la partie — ni ne peut être touché, les balles mourant sur le mur qu'il
  // chevauche. Mesuré à l'époque : un bot par partie en moyenne, au moins un dans 69 % des cartes.
  const MODES = Object.values(C.MODES);
  const spawn = faireSpawnPoints(C);
  for (let graine = 0; graine < 200; graine++) {
    const cells = C.generateMap(graine), libre = libreSur(cells, C.MAP);
    for (const mode of MODES) {
      const pts = spawn(cells, C.makeFlux(graine)('apparition'), mode.teams, mode.teamSize);
      assert.strictEqual(pts.length, mode.teams * mode.teamSize, `graine ${graine} ${mode.id}`);
      for (const p of pts) {
        assert.ok(libre(p.x, p.z), `graine ${graine} ${mode.id} : un corps ne tient pas en ${p.x},${p.z}`);
        assert.ok(p.x > 1 && p.z > 1 && p.x < C.MAP - 1 && p.z < C.MAP - 1, 'point hors carte');
      }
    }
  }
});
test('bac à sable : la géométrie de la graine tourne alors que les transcendantes LANCENT', () => {
  // La garde textuelle ne couvre que ce qui est écrit ; celle-ci couvre ce qui s'exécute, branches
  // rares comprises — la réparation des poches fermées de `generateMap`, le balayage de
  // `spawnPoints` quand le point de départ est muré. Les deux se complètent : le texte est le
  // filet des branches que le corpus n'atteint pas, l'exécution est la preuve du reste.
  let mordant = false;
  const nues = TRANSCENDANTES.map(n => n.slice(5));
  const piege = new Proxy(Math, { get: (t, p) => (mordant && nues.includes(p))
    ? () => { throw new Error('la géométrie de la graine a appelé Math.' + String(p)); }
    : Reflect.get(t, p) });
  const m = { exports: {} };
  new Function('module', 'exports', 'Math', core)(m, m.exports, piege);
  const S = m.exports;
  // Une carte entièrement murée force le balayage de repli de spawnPoints, celui qui cherche un
  // creux en tournant puis en rentrant — la branche qu'aucune graine réelle n'exerce à coup sûr.
  const muree = new Uint8Array(S.MAP * S.MAP).fill(1);
  const spawn = faireSpawnPoints(S, piege);
  mordant = true;
  try {
    for (let graine = 0; graine < 6; graine++) {
      S.generateBiomes(graine);
      const cells = S.generateMap(graine);
      for (const mode of Object.values(S.MODES)) {
        spawn(cells, S.makeFlux(graine)('apparition'), mode.teams, mode.teamSize);
        spawn(muree, S.makeFlux(graine)('apparition'), mode.teams, mode.teamSize);
        const plan = S.zonePlan(graine, mode);
        for (let t = 0; t <= 220; t += 3) S.zoneAt(plan, t);
      }
    }
  } finally { mordant = false; }
  // Et ce qui sort du bac à sable est bien ce que le jeu produit : sinon on aurait prouvé qu'une
  // autre carte n'appelle pas de transcendantes.
  assert.deepStrictEqual(Array.from(S.generateMap(9)), Array.from(C.generateMap(9)));
  assert.deepStrictEqual(S.zonePlan(9, S.MODES.solo), C.zonePlan(9, C.MODES.solo));
});
test('la table des directions est unitaire, cardinale et sans -0', () => {
  assert.strictEqual(C.UNIT_N, 1024);
  assert.strictEqual(C.UNIT.length, C.UNIT_N);
  assert.strictEqual(C.UNIT_COS.length, C.UNIT_N / 4 + 1, 'le quadrant stocké doit couvrir [0, π/2]');
  const vues = new Set();
  for (let i = 0; i < C.UNIT_N; i++) {
    const u = C.UNIT[i];
    assert.ok(Math.abs(Math.sqrt(u.x * u.x + u.z * u.z) - 1) < 1e-15, `direction ${i} non unitaire`);
    // Un -0 se propage dans les comparaisons et les sérialisations sans jamais se voir.
    assert.ok(!Object.is(u.x, -0) && !Object.is(u.z, -0), `direction ${i} porte un -0`);
    vues.add(u.x + ':' + u.z);
  }
  assert.strictEqual(vues.size, C.UNIT_N, 'deux directions se confondent');
  // Les quatre cardinales sont écrites exactes, là où Math.cos(Math.PI/2) rend 6,12e-17.
  assert.deepStrictEqual(C.UNIT[0], { x: 1, z: 0 });
  assert.deepStrictEqual(C.UNIT[256], { x: 0, z: 1 });
  assert.deepStrictEqual(C.UNIT[512], { x: -1, z: 0 });
  assert.deepStrictEqual(C.UNIT[768], { x: 0, z: -1 });
  // La table reste l'échantillonnage régulier qu'elle prétend être : l'écart à Math.cos/Math.sin
  // d'un moteur qui, lui, a le droit de flotter, reste sous l'ulp.
  for (let i = 0; i < C.UNIT_N; i += 7) {
    const a = 2 * Math.PI * i / C.UNIT_N;
    assert.ok(Math.abs(C.UNIT[i].x - Math.cos(a)) < 1e-15 && Math.abs(C.UNIT[i].z - Math.sin(a)) < 1e-15, `direction ${i}`);
  }
  // Les indices se ramènent dans la table, y compris négatifs : les décalages d'angle s'écrivent
  // en indices, et un décalage négatif est le cas normal.
  assert.strictEqual(C.unitAt(-1), C.UNIT[C.UNIT_N - 1]);
  assert.strictEqual(C.unitAt(C.UNIT_N + 3), C.UNIT[3]);
  assert.strictEqual(C.unitAt(-C.UNIT_N * 3 - 5), C.UNIT[C.UNIT_N - 5]);
  // Et un tirage rend toujours une direction, jamais `undefined` sur le bord du domaine.
  for (const v of [0, 0.5, 0.999999999, 1 - Number.EPSILON / 2])
    assert.ok(C.unitFrom(() => v), `unitFrom(${v})`);
});
test('le pas de la table reste plus fin que la maille de la carte', () => {
  // Le pas se choisit sur le plus grand cercle que `generateMap` parcourt, la route à MAP×0,34 :
  // si un pas y dépassait une case, la route circulaire deviendrait pointillée et la réparation de
  // connexité aurait à creuser là où le code d'origine passait tout seul.
  for (const rr of [C.MAP * 0.22, C.MAP * 0.34]) {
    let precedent = null, saut = 0;
    for (let i = 0; i <= C.UNIT_N; i++) {
      const u = C.UNIT[i % C.UNIT_N];
      const p = [Math.round(C.MAP / 2 + u.x * rr), Math.round(C.MAP / 2 + u.z * rr)];
      if (precedent) saut = Math.max(saut, Math.abs(p[0] - precedent[0]), Math.abs(p[1] - precedent[1]));
      precedent = p;
    }
    assert.ok(saut <= 1, `la route de rayon ${rr} saute de ${saut} cases : elle n'est plus continue`);
  }
});
test('même graine, mêmes bots et mêmes points de départ — deux fois, et dans un processus neuf', () => {
  // Le patron déjà employé pour le plan de zone. Deux appels d'affilée peuvent se ressembler par
  // accident, un état accumulé dans le module passerait inaperçu ; un processus neuf ne le peut pas.
  const identites = graine => { const r = C.makeFlux(graine)('bots/identite');
                                return Array.from({ length: 40 }, () => r()); };
  assert.deepStrictEqual(identites(4242), identites(4242));
  assert.notDeepStrictEqual(identites(4242), identites(4243));
  const spawn = faireSpawnPoints(C);
  const cells0 = C.generateMap(0);
  const depart = graine => spawn(cells0, C.makeFlux(graine)('apparition'), C.MODES.duo.teams, C.MODES.duo.teamSize);
  assert.deepStrictEqual(depart(4242), depart(4242));
  const attendu = JSON.stringify({ identites: identites(4242), depart: depart(4242) });
  const dehors = require('child_process').execFileSync(process.execPath, ['-e', `
    const fs = require('fs');
    const html = fs.readFileSync(process.env.WB_FICHIER, 'utf8');
    const bloc = html.slice(html.indexOf('/*CORE-' + 'START*/'), html.indexOf('/*CORE-' + 'END*/'));
    const sim = html.slice(html.indexOf('/*SIM-' + 'START*/'), html.indexOf('/*SIM-' + 'END*/'));
    const m = { exports: {} }; new Function('module', 'exports', bloc)(m, m.exports);
    const C = m.exports;
    const s = { exports: {} }; new Function('module', 'exports', 'WBCore', sim)(s, s.exports, C);
    const G = { cells: C.generateMap(0) };
    const r = C.makeFlux(4242)('bots/identite');
    process.stdout.write(JSON.stringify({
      identites: Array.from({ length: 40 }, () => r()),
      depart: s.exports.spawnPoints(G, C.makeFlux(4242)('apparition'), C.MODES.duo.teams, C.MODES.duo.teamSize) }));
  `], { encoding: 'utf8', env: Object.assign({}, process.env, { WB_FICHIER: path.join(__dirname, GAME) }) });
  assert.strictEqual(dehors, attendu, 'un processus neuf ne rejoue pas les mêmes bots ni les mêmes départs');
});

console.log('Le bloc SIM : l\'état et la grille sortent du rendu');
// Le bloc SIM est le premier morceau du jeu, hors de WBCore, que ce fichier EXÉCUTE réellement.
// Les trois gardes ci-dessous protègent la seule chose qui rende cela possible : qu'il ne dépende
// de rien. La panne qu'elles empêchent est SILENCIEUSE — une attache au rendu qui survit, et le
// bloc cesse de tourner dans Node sans que rien ne casse dans le navigateur.
test('bac à sable : SIM se charge ET tourne sans document, window, THREE, Math.random, Date.now ni performance', () => {
  const sansRandom = new Proxy(Math, { get: (t, p) => p === 'random' ? undefined : Reflect.get(t, p) });
  const sansNow = new Proxy(Date, { get: (t, p) => p === 'now' ? undefined : Reflect.get(t, p) });
  const bac = new Function('module', 'exports', 'WBCore', 'document', 'window', 'THREE', 'performance',
                           'localStorage', 'fetch', 'requestAnimationFrame', 'Math', 'Date', sim);
  const m = { exports: {} };
  bac(m, m.exports, C, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sansRandom, sansNow);
  const Z = m.exports;
  assert.strictEqual(typeof Z.moveEntity, 'function', 'le bloc ne s\'est pas chargé dans le bac à sable');
  // Et il TOURNE là-dedans : le chargement seul prouverait seulement qu'aucune ligne de haut
  // niveau ne touche à l'environnement.
  const cells = C.generateMap(11);
  const G = { cells, zone: { cx: C.MAP / 2, cz: C.MAP / 2, r: 40 }, smokes: [], alea: C.makeFlux(11), ents: [] };
  const pts = Z.spawnPoints(G, C.makeFlux(11)('apparition'), 20, 1);
  const e = Z.makeEntity(G, 'moi', pts[0].x, pts[0].z, 0.5, true, C.BRAWLERS.bolt, 0, 0);
  const f = Z.makeEntity(G, 'lui', pts[1].x, pts[1].z, 0.5, false, C.BRAWLERS.hex, 0.8, 1);
  // AUCUN pointeur de rendu ne survit dans une entité, même « le temps de la transition » : c'est
  // exactement le patron du `respawn()` défini deux fois, et la copie vivante finirait du côté que
  // rien n'exécute.
  assert.ok(!('mesh' in e), 'une entité porte de nouveau un objet de la scène');
  // `eid` est l'identifiant, et il est distinct pour chaque entité. `id`, lui, est la personnalité
  // d'un bot : deux bots peuvent la partager, et le rendu qui s'en servirait mélangerait leurs corps.
  assert.strictEqual(e.eid, 1); assert.strictEqual(f.eid, 2);
  for (let i = 0; i < 30; i++) Z.moveEntity(G, e, 1, 0.3, C.SIM.stepS);
  assert.ok(Z.free(G, e.x, e.z), 'une entité a fini là où son corps ne tient pas');
  assert.strictEqual(typeof Z.canSee(G, e, f), 'boolean');
  assert.strictEqual(Z.isWall(G, -1, -1), true, 'hors carte doit valoir mur');
  assert.strictEqual(Z.inZone(G, C.MAP / 2, C.MAP / 2, 0), true);
});
test('garde textuelle : rien du rendu ne franchit les marqueurs du bloc SIM', () => {
  // Garde PERMANENTE, commentaires compris — un commentaire qui parle de `mesh` est le premier pas
  // vers une ligne qui en touche un. La liste est celle de docs/PHASE-02B.md, plus ce qui rendrait
  // le bloc dépendant d'une horloge ou d'une entropie que le serveur ne peut pas refaire.
  const INTERDITS = ['mesh', 'THREE', 'document', 'window', '$(', 'snd(', 'floatText(', 'feed(',
                     'Math.random', 'Date.now', 'performance', 'localStorage', 'fetch(',
                     'requestAnimationFrame', 'setTimeout', 'navigator'];
  for (const i of INTERDITS)
    assert.ok(!sim.includes(i), `« ${i} » a franchi les marqueurs du bloc SIM`);
  // Et le bloc est bien celui qu'on croit : des marqueurs qui auraient glissé rendraient toutes
  // les assertions ci-dessus vraies sur une chaîne vide.
  assert.ok(sim.length > 3000 && sim.includes('function moveEntity('), 'le bloc SIM n\'a pas été retrouvé');
});
test('une seule copie de chaque règle : SIM appelle WBCore, il ne le recopie pas', () => {
  // Le bloc reçoit WBCore comme le navigateur le lui donne, et s'en sert. S'il cessait de
  // l'appeler, c'est qu'il aurait recopié une règle déjà testée ailleurs — le patron du
  // `zoneUpdate` qui refaisait l'interpolation du gaz à la main.
  for (const nom of ['C.BLOCKING', 'C.smokeSightBlocked', 'C.unitAt', 'C.smokeStart'])
    assert.ok(sim.includes(nom), `SIM n'appelle plus ${nom} : la règle a-t-elle été recopiée ?`);
  assert.ok(sim.includes('const C = WBCore'), 'SIM doit recevoir WBCore comme le fait le bloc Game');
});
test('un seul écrivain de corps d\'entité dans le bloc Game : syncMeshes, et rien d\'autre', () => {
  // La garde qui manquait au `respawn()` défini deux fois, transposée. Les corps vivent dans une
  // table annexe ; un seul site la lit pour écrire dans la scène, et un seul site appelle ce site.
  const jeu = sansCommentaires(JEU);
  assert.strictEqual(compte(jeu, /MESHES\.get\(/g), 1,
    'un second site lit la table des corps : il y aurait deux écrivains, et la copie vivante finirait du côté que rien n\'exécute');
  assert.ok(sansCommentaires(corpsDe('syncMeshes')).includes('MESHES.get('),
    'l\'unique lecteur de la table doit être syncMeshes');
  assert.strictEqual(compte(jeu, /\bsyncMeshes\(\)/g), 2,
    'syncMeshes doit être déclarée une fois et appelée une fois — et depuis la boucle d\'image');
  assert.ok(sansCommentaires(corpsDe('loop')).includes('syncMeshes();'),
    'la recopie se fait une fois par image, pas une fois par pas de simulation');
  // Et aucune fonction de simulation n'écrit plus dans un corps.
  for (const nom of ['moveEntity', 'respawn', 'kill', 'botCashOut', 'dashUpdate', 'commonUpdate',
                     'botUpdate', 'joueurUpdate', 'makeEntity', 'newMatch', 'step', 'zoneUpdate'])
    assert.ok(!sansCommentaires(corpsDe(nom)).includes('.mesh'),
      `${nom} touche de nouveau à un corps : l'unique écrivain est syncMeshes`);
});

// LE CORPUS GELÉ. Il a été capturé sur le code d'AVANT ce module, par un harnais qui extrayait du
// bloc `Game` les fonctions de grille, de mouvement et de vue, les fermait sur un environnement
// réduit et jouait la séquence rejouée ci-dessous. C'est la SEULE preuve écrite qu'un code a bougé
// sans changer : les tests d'invariants, eux, diraient la même chose d'un code qui aurait changé
// en restant juste.
//
// CE QU'IL COUVRE : la couche mouvement et grille, et elle seule — `cellAt`, `isWall`, `free`,
// `tryMove`, `moveEntity`, `losClear`, `inZone`, `inBush`, `canSee`, `obscured`, les deux ponts
// vers `smokeSightBlocked`, et `spawnPoints` sur les cinq modes. Les positions sont comparées
// EXACTEMENT, sans tolérance : ce sont les mêmes opérations, dans le même ordre, sur le même
// moteur.
//
// CE QU'IL NE COUVRE PAS, et il faut le dire : rien du combat, rien du butin, rien des bots, rien
// du gaz, rien de ce que le joueur VOIT. Les entités y sont synthétiques — elles n'ont ni arme, ni
// vie, ni objectif — et leurs directions sont scriptées, donc le corpus ne dit rien de la façon
// dont le jeu choisit une direction. Il ne dit rien non plus du rendu : que `syncMeshes()` dessine
// la même chose qu'avant n'est prouvé par aucun test, ici comme ailleurs, et ne peut l'être que
// par un humain qui joue.
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus-grille.json'), 'utf8'));
test('le code a bougé sans changer : le corpus gelé des requêtes de grille et du mouvement', () => {
  assert.ok(corpus.parGraine.length >= 8, 'le corpus gelé est vide ou tronqué');
  // Les entités du corpus, refaites à l'identique : `speed` et `id` sont des entrées, pas des
  // tirages, pour que rien de ce qui est comparé ne dépende d'un flux de hasard.
  const ent = (n, x, z, team, isPlayer) => ({
    name: 'e' + n, x, z, team, isPlayer: !!isPlayer, vx: 0, vz: 0, ax: 0, az: -1,
    knockx: 0, knockz: 0, speed: 3.2 + (n % 5) * 0.17, id: (n * 0.137) % 1,
  });
  for (const bloc of corpus.parGraine) {
    const graine = bloc.graine, ou = m => `graine ${graine} · ${m}`;
    const cells = C.generateMap(graine);
    const z0 = C.zoneAt(C.zonePlan(graine, C.MODES.solo), 40);
    const G = { cells, time: 0, smokes: [], zone: { cx: z0.cx, cz: z0.cz, r: z0.r } };
    assert.deepStrictEqual([G.zone.cx, G.zone.cz, G.zone.r], bloc.zone, ou('le cercle de gaz'));

    for (const mode of Object.values(C.MODES)) {
      const pts = SIMU.spawnPoints(G, C.makeFlux(graine)('apparition'), mode.teams, mode.teamSize);
      assert.deepStrictEqual(pts.map(p => [p.x, p.z, p.team]), bloc.depart[mode.id], ou('départs ' + mode.id));
    }

    const grille = [];
    for (let i = 0; i < 40; i++) {
      const x = (i * 3.77) % C.MAP, z = (i * 7.31 + 1.5) % C.MAP;
      grille.push([x, z, SIMU.cellAt(G, x, z), SIMU.isWall(G, x, z) ? 1 : 0, SIMU.free(G, x, z) ? 1 : 0]);
    }
    for (const [x, z] of [[-1, -1], [0, 0], [C.MAP - 0.01, C.MAP - 0.01], [C.MAP, 0], [0, C.MAP], [75.5, 75.5]])
      grille.push([x, z, SIMU.cellAt(G, x, z), SIMU.isWall(G, x, z) ? 1 : 0, SIMU.free(G, x, z) ? 1 : 0]);
    assert.deepStrictEqual(grille, bloc.grille, ou('requêtes de grille'));

    const pts = SIMU.spawnPoints(G, C.makeFlux(graine)('apparition'), 20, 1);
    const ents = [];
    for (let i = 0; i < 12; i++) ents.push(ent(i, pts[i].x, pts[i].z, i % 4, i === 0));
    const mouvement = [], dt = C.SIM.stepS;
    for (let pas = 0; pas < 100; pas++) {
      G.time += dt;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        const a = (pas * (0.11 + i * 0.013) + i * 0.7);
        const mx = Math.cos(a), mz = Math.sin(a * 1.3);
        e.ax = mx; e.az = mz;
        if (pas === 30 && i % 3 === 0) { e.knockx = 6 - i * 0.4; e.knockz = -4 + i * 0.3; }
        SIMU.moveEntity(G, e, mx, mz, dt);
      }
      if (pas % 10 === 9) mouvement.push(ents.map(e => [e.x, e.z, e.vx, e.vz, e.knockx, e.knockz]));
    }
    assert.deepStrictEqual(mouvement, bloc.mouvement, ou('cent pas de moveEntity'));

    const glissade = [];
    for (let i = 0; i < 20; i++) {
      const e = ent(100 + i, pts[i].x, pts[i].z, 0, false);
      for (const [dx, dz] of [[0.9, 0], [0, 0.9], [-1.3, 1.3], [0.4, -2.2], [3, 3]]) SIMU.tryMove(G, e, dx, dz);
      glissade.push([e.x, e.z]);
    }
    assert.deepStrictEqual(glissade, bloc.glissade, ou('glissement le long des murs'));
    assert.deepStrictEqual(ents.map(e => [e.x, e.z, e.vx, e.vz, e.speed, e.id]), bloc.etats, ou('états finaux'));

    const vue = [];
    for (let i = 0; i < ents.length; i++) for (let j = 0; j < ents.length; j++) {
      if (i === j) continue;
      vue.push([i, j, SIMU.canSee(G, ents[i], ents[j]) ? 1 : 0, SIMU.obscured(G, ents[i], ents[j]) ? 1 : 0,
                SIMU.losClear(G, ents[i].x, ents[i].z, ents[j].x, ents[j].z) ? 1 : 0,
                SIMU.inBush(G, ents[j]) ? 1 : 0, SIMU.inZone(G, ents[j].x, ents[j].z, 1.5) ? 1 : 0]);
    }
    assert.deepStrictEqual(vue, bloc.vue, ou('ligne de vue'));

    const a0 = ents[0], b0 = ents[1];
    G.smokes = [{ x: (a0.x + b0.x) / 2, z: (a0.z + b0.z) / 2, age: 0.5, team: a0.team },
                { x: (a0.x + b0.x) / 2 + 3, z: (a0.z + b0.z) / 2, age: 3.2, team: 9 }];
    const fumee = [];
    for (let i = 0; i < ents.length; i++) for (let j = 0; j < ents.length; j++) {
      if (i === j) continue;
      fumee.push([i, j, SIMU.canSee(G, ents[i], ents[j]) ? 1 : 0,
                  SIMU.smokeBetween(G, ents[i], ents[j]) ? 1 : 0,
                  SIMU.smokeAt(G, ents[i].x, ents[i].z, ents[j].x, ents[j].z, ents[i].team) ? 1 : 0]);
    }
    assert.deepStrictEqual(fumee, bloc.fumee, ou('le pont vers smokeSightBlocked'));
    G.smokes = [];

    const proches = [];
    for (let i = 0; i < 20; i++) {
      const t = i * 0.9, rr = 0.6 + i * 0.55;
      proches.push(ent(200 + i, C.MAP / 2 + Math.cos(t) * rr, C.MAP / 2 + Math.sin(t) * rr, i % 3, i === 0));
    }
    assert.deepStrictEqual(proches.map(e => [e.x, e.z, e.team]), bloc.proches, ou('la grappe du centre'));
    const vuePres = [];
    for (let i = 0; i < proches.length; i++) for (let j = 0; j < proches.length; j++) {
      if (i === j) continue;
      vuePres.push([i, j, SIMU.canSee(G, proches[i], proches[j]) ? 1 : 0, SIMU.obscured(G, proches[i], proches[j]) ? 1 : 0,
                    SIMU.losClear(G, proches[i].x, proches[i].z, proches[j].x, proches[j].z) ? 1 : 0,
                    SIMU.inBush(G, proches[j]) ? 1 : 0, SIMU.cellAt(G, proches[j].x, proches[j].z),
                    SIMU.inZone(G, proches[j].x, proches[j].z, 0) ? 1 : 0]);
    }
    assert.deepStrictEqual(vuePres, bloc.vuePres, ou('la règle du buisson, à courte portée'));
  }
});
test('le corpus gelé discrimine vraiment : il contient les deux réponses de chaque règle', () => {
  // Un corpus dont toutes les réponses seraient « faux » passerait sur n'importe quel code. Celui
  // de la règle du buisson est le plus fragile des trois : il faut des entités DANS un buisson et
  // d'autres dehors, à moins de quatre blocs les unes des autres.
  let murs = 0, libres = 0, vus = 0, caches = 0, buissons = 0, fumes = 0;
  for (const b of corpus.parGraine) {
    for (const g of b.grille) { if (g[3]) murs++; else libres++; }
    for (const v of b.vuePres) { if (v[2]) vus++; else caches++; if (v[5]) buissons++; }
    for (const f of b.fumee) if (f[3]) fumes++;
  }
  for (const [nom, n] of Object.entries({ murs, libres, vus, caches, buissons, fumes }))
    assert.ok(n >= 20, `le corpus ne contient que ${n} cas de « ${nom} » : il ne prouverait presque rien`);
});

console.log('Les faits : projectiles balayés, dégâts, mort, butin et flux d\'événements');
// CE QUE CETTE SECTION PROUVE, ET CE QU'ELLE NE PROUVE PAS. Elle fait tourner le VRAI code de
// combat, de mort et de butin — celui du bloc SIM, chargé depuis index.html — sur de vraies cartes.
// Elle ne fait PAS jouer une partie : les bots et le joueur descendent au module 5, et ce qui les
// remplace ici est une conduite de quelques lignes. Ce qu'elle couvre est donc l'ARITHMÉTIQUE de la
// partie, pas sa dramaturgie : qui perd combien, où l'argent va, ce qui touche quoi.
const PAS = C.SIM.stepS;

// Un banc de partie : une vraie carte, un vrai plan de gaz, vingt vraies entités, de vraies
// caisses, et les fonctions de SIM appelées telles quelles.
function bancNeuf(mode, stake, graine, t0){
  const cells = C.generateMap(graine);
  const plan = C.zonePlan(graine, mode);
  const G = { cells, time: t0 || 0, pas: 0, evts: [], running: true, stake, modeCfg: mode,
              alea: C.makeFlux(graine), nextEid: 0, zonePlan: plan,
              ents: [], boxes: [], pickups: [], projs: [], zones: [], turrets: [], smokes: [], nades: [],
              dmgDealt: 0, looted: 0, lostPouch: 0, encaisse: 0,
              zone: { cx: plan.startCx, cz: plan.startCz, r: plan.startR, dps: 0 } };
  // Les caisses sont posées comme `startMatch` les pose, dans le même flux et dans le même ordre.
  const aleaCaisses = G.alea('butin/position'), aleaBots = G.alea('bots/identite');
  for (let i = 0; i < (mode.boxes || C.BOXES); i++){
    let x, z, t = 0;
    do { x = 3 + Math.floor(aleaCaisses() * (C.MAP - 6)) + 0.5; z = 3 + Math.floor(aleaCaisses() * (C.MAP - 6)) + 0.5; t++; }
    while ((SIMU.cellAt(G, x, z) !== 0 || Math.abs(C.dist(x - C.MAP / 2, z - C.MAP / 2) - C.MAP * 0.42) < 3) && t < 40);
    G.boxes.push({ x, z, hp: C.BOX_HP, ph: aleaCaisses() * 6.283 });
  }
  const pts = SIMU.spawnPoints(G, G.alea('apparition'), mode.teams, mode.teamSize);
  const bids = Object.keys(C.BRAWLERS), slot = pts.findIndex(p => p.team === 0);
  pts.forEach((pt, i) => {
    const br = C.BRAWLERS[bids[Math.floor(aleaBots() * bids.length)]];
    const e = SIMU.makeEntity(G, 'b' + i, pt.x, pt.z, stake, i === slot, br, 0.6, pt.team);
    e.lives = C.livesFor(mode);
    G.ents.push(e);
    if (i === slot) G.player = e;
  });
  return G;
}
// Un pas de banc. Tout ce qui décide d'un chiffre passe par SIM ; ce qui reste ici est ce que le
// module 5 descendra — la conduite des bots — et le gaz, resté dans `Game`, rejoué à partir de
// `C.zoneAt`, c'est-à-dire de la même règle et pas d'une seconde copie.
function pasDeBanc(G){
  const dt = PAS;
  G.pas++; G.time += dt;
  const a = C.zoneAt(G.zonePlan, G.time);
  G.zone.cx = a.cx; G.zone.cz = a.cz; G.zone.r = a.r; G.zone.dps = a.dps;
  for (const e of G.ents) if (e.respawnT > 0){ e.respawnT -= dt; if (e.respawnT <= 0) SIMU.respawn(G, e); }
  for (const e of G.ents){
    if (!e.alive) continue;
    if (SIMU.dashUpdate(G, e, dt)) continue;
    e.fireCd -= dt; e.stealthT -= dt;
    if (e.ammo < 3){ e.ammoT += dt; if (e.ammoT >= e.brawler.ammoReload){ e.ammo++; e.ammoT = 0; } }
    e.gadget = C.smokeTick(e.gadget, dt);
    if (e.invuln > 0) e.invuln -= dt;
    if (e.flash > 0) e.flash -= dt;
    if (G.modeCfg.cashout) e.cashLock = Math.max(0, (e.cashLock || 0) - dt);
    let t = null, bd = 1e9;
    for (const o of G.ents){ if (o === e || !o.alive || o.team === e.team) continue;
      const d = C.dist(o.x - e.x, o.z - e.z); if (d < bd){ bd = d; t = o; } }
    let mx = 0, mz = 0;
    if (t){
      const dx = (t.x - e.x) / bd, dz = (t.z - e.z) / bd;
      e.ax = dx; e.az = dz;
      if (bd > e.brawler.attack.range * 0.7){ mx = dx; mz = dz; } else { mx = -dz; mz = dx; }
      if (bd < e.brawler.attack.range) SIMU.attack(G, e, dx, dz, bd);
      if (e.super >= e.brawler.super.cost) SIMU.useSuper(G, e, bd);
      if (C.canThrowSmoke(e.gadget) && G.alea('bots/objectif')() < dt * 0.4) SIMU.throwSmoke(G, e, bd);
    }
    // Personne à portée : on va chercher l'argent tombé. Sans cette ligne le banc ne parcourait
    // qu'une seule fois en trente mille pas le chemin « la sacoche tombe, quelqu'un la ramasse »,
    // et l'assertion qui le garde n'aurait tenu qu'à un cheveu.
    if (!t || bd > e.brawler.attack.range){
      let sac = null, sd = 14;
      for (const pk of G.pickups){ if (pk.kind !== 'cash') continue;
        const d = C.dist(pk.x - e.x, pk.z - e.z); if (d < sd){ sd = d; sac = pk; } }
      if (sac && sd > 0.1){ mx = (sac.x - e.x) / sd; mz = (sac.z - e.z) / sd; }
    }
    if (!SIMU.inZone(G, e.x, e.z, 1.5)){ mx = G.zone.cx - e.x; mz = G.zone.cz - e.z; }
    SIMU.moveEntity(G, e, mx, mz, dt);
    for (let i = G.pickups.length - 1; i >= 0; i--){ const pk = G.pickups[i];
      if (C.dist(pk.x - e.x, pk.z - e.z) < 0.9) SIMU.collect(G, e, pk); }
    // Le seuil du jeu est de quatre mises ; ici il en faut deux, et le tirage est plus large :
    // sans cela aucune partie de vingt-cinq secondes ne verrait jamais un encaissement, et le
    // troisième chemin de la sacoche ne serait jamais parcouru par ce banc.
    if (G.modeCfg.cashout && !e.isPlayer && e.pouch >= G.stake * 2 && C.cashoutReady(e.cashLock || 0)
        && G.alea('bots/encaissement')() < dt * 2) SIMU.botCashOut(G, e);
  }
  SIMU.projUpdate(G, dt); SIMU.zonesUpdate(G, dt); SIMU.nadesUpdate(G, dt); SIMU.smokesUpdate(G, dt);
  for (const e of G.ents) if (e.alive && !SIMU.inZone(G, e.x, e.z, 0)){
    e.hp -= G.zone.dps * SIMU.maxHp(e) * dt; e.lastDamageT = G.time;
    if (e.hp <= 0) SIMU.kill(G, e, e.lastHitBy && e.lastHitBy.alive ? e.lastHitBy : null, 'gas');
  }
  const evts = G.evts; G.evts = [];
  return evts;
}
// Tout l'argent de la table, où qu'il se trouve : dans les sacoches, tombé au sol, ou sorti de la
// partie par un encaissement. Il n'y a pas de quatrième endroit, et c'est exactement ce qu'on teste.
function argentTotal(G){
  let somme = 0;
  for (const e of G.ents) somme += e.pouch;
  for (const pk of G.pickups) if (pk.kind === 'cash') somme += pk.amount;
  return somme + (G.encaisse || 0);
}

test('l\'argent se conserve à CHAQUE PAS de la VRAIE simulation, sur les quatre tables et les cinq modes', () => {
  // Jusqu'ici cette conservation n'était prouvée que sur un modèle pur des transferts écrit dans ce
  // fichier — un modèle est d'accord avec lui-même par construction. C'est elle qui fonde
  // `purseBound`, donc le SEUL plafond de paiement qui existe : elle doit se vérifier sur le code
  // qui décide vraiment, pas sur une paraphrase.
  let kills = 0, auSol = 0, encaissements = 0, plusGrosse = 0, ramasses = 0;
  const modes = Object.values(C.MODES);
  for (let mi = 0; mi < modes.length; mi++){
    const mode = modes[mi];
    for (let ti = 0; ti < C.TIERS.length; ti++){
      const stake = C.TIERS[ti].stake, seats = C.seatsOf(mode);
      const totalCents = C.toCents(stake) * seats;
      // Une moitié des combinaisons part du coup d'envoi, l'autre d'un gaz déjà bien refermé :
      // sans cela, aucune partie de vingt-cinq secondes ne verrait jamais une mort par le gaz.
      const tard = ti % 2 === 1 ? C.zoneTotalS(C.zonePlan(700 + mi * 4 + ti, mode)) * 0.62 : 0;
      const G = bancNeuf(mode, stake, 700 + mi * 4 + ti, tard);
      const ou = n => `${mode.id} · ${stake}$ · départ ${Math.round(tard)}s · pas ${n}`;
      assert.strictEqual(C.toCents(argentTotal(G)), totalCents, `${mode.id} · ${stake}$ : la mise de départ`);
      for (let n = 0; n < 1500; n++){
        const evts = pasDeBanc(G);
        assert.strictEqual(C.toCents(argentTotal(G)), totalCents,
          `${ou(n)} : de l'argent apparaît ou disparaît`);
        for (const e of G.ents){
          assert.ok(e.cubes <= C.CUBE.max, `${ou(n)} : ${e.name} porte ${e.cubes} cubes`);
          assert.ok(e.pouch >= 0 && C.toCents(e.pouch) <= totalCents, `${ou(n)} : sacoche hors borne (${e.pouch})`);
          if (e.pouch > plusGrosse) plusGrosse = e.pouch;
        }
        for (const ev of evts){
          if (ev.type === 'mort' && ev.sacoche > 0){ if (ev.transfert) kills++; else auSol++; }
          if (ev.type === 'encaissement') encaissements++;
          if (ev.type === 'ramassage' && ev.kind === 'cash') ramasses++;
        }
      }
    }
  }
  // Sans ces bornes, le test passerait sur une partie où personne ne touche personne.
  assert.ok(kills > 20, `seulement ${kills} sacoches transférées par un kill`);
  assert.ok(auSol > 0, `aucune sacoche lâchée au sol en ${1500} pas × 20 combinaisons`);
  assert.ok(encaissements > 0, `aucun encaissement de bot`);
  // Les seuils restent bas à dessein : une partie est un système chaotique, une différence d'un
  // dernier bit sur `Math.sin` au premier pas change tout ce qui suit. Ce qu'ils gardent, c'est que
  // le banc a bien PARCOURU les quatre chemins, pas qu'il les parcourt un nombre de fois donné.
  assert.ok(ramasses > 0, `aucune sacoche ramassée au sol`);
  assert.ok(plusGrosse > C.TIERS[3].stake, 'aucune sacoche n\'a jamais grossi');
});

// Un banc NU : une arène vide, sans mur, sans caisse, sans gaz, où l'on pose exactement ce dont on
// a besoin. Les tests qui suivent parlent d'une règle à la fois, et une carte tirée d'une graine y
// ajouterait du bruit sans rien prouver de plus.
function areneNue(mode, stake){
  const cells = new Uint8Array(C.MAP * C.MAP);
  const G = { cells, time: 20, pas: 0, evts: [], running: true, stake: stake === undefined ? 0.5 : stake,
              modeCfg: mode || C.MODES.solo, alea: C.makeFlux(99), nextEid: 0,
              ents: [], boxes: [], pickups: [], projs: [], zones: [], turrets: [], smokes: [], nades: [],
              dmgDealt: 0, looted: 0, lostPouch: 0, encaisse: 0,
              zonePlan: C.zonePlan(99, mode || C.MODES.solo),
              zone: { cx: C.MAP / 2, cz: C.MAP / 2, r: C.MAP, dps: 0 } };
  return G;
}
function poser(G, nom, x, z, team, brawler, isPlayer){
  const e = SIMU.makeEntity(G, nom, x, z, G.stake, !!isPlayer, brawler || C.BRAWLERS.bolt, 0.6, team);
  e.lives = C.livesFor(G.modeCfg);
  G.ents.push(e);
  if (isPlayer || !G.player) G.player = G.player || e;
  return e;
}

test('les trois chemins de la sacoche : un kill la transfère entière, le gaz la lâche au sol, l\'encaissement la met à zéro', () => {
  const mise = 0.5;
  // 1. LE KILL. La sacoche passe entière à qui a porté le coup, et rien ne tombe par terre.
  {
    const G = areneNue(C.MODES.solo, mise);
    const tueur = poser(G, 'tueur', 60.5, 60.5, 0, C.BRAWLERS.bolt, true);
    const mort = poser(G, 'mort', 62.5, 60.5, 1, C.BRAWLERS.bolt);
    mort.pouch = 3.5; tueur.pouch = 1;
    const avant = argentTotal(G);
    SIMU.kill(G, mort, tueur, 'shot');
    assert.strictEqual(tueur.pouch, 4.5, 'la sacoche doit passer ENTIÈRE');
    assert.strictEqual(mort.pouch, 0);
    assert.strictEqual(G.pickups.filter(p => p.kind === 'cash').length, 0, 'rien ne tombe quand il y a quelqu\'un à créditer');
    assert.strictEqual(argentTotal(G), avant);
  }
  // 2. LE GAZ. Personne à créditer : elle tombe au sol, pour le montant exact, et l'argent reste
  // dans la partie — c'est la seule chose qui empêche une mort de faire disparaître de l'argent.
  {
    const G = areneNue(C.MODES.solo, mise);
    const v = poser(G, 'gazé', 60.5, 60.5, 0, C.BRAWLERS.bolt, true);
    poser(G, 'autre', 70.5, 70.5, 1, C.BRAWLERS.bolt);
    v.pouch = 2.5;
    const avant = argentTotal(G);
    SIMU.kill(G, v, null, 'gas');
    assert.strictEqual(v.pouch, 0);
    const sacs = G.pickups.filter(p => p.kind === 'cash');
    assert.strictEqual(sacs.length, 1, 'la sacoche doit tomber au sol');
    assert.strictEqual(sacs[0].amount, 2.5);
    assert.strictEqual(argentTotal(G), avant, 'le gaz ne doit pas manger d\'argent');
    // et elle se ramasse, entière, par n'importe qui
    const r = G.ents[1]; r.x = sacs[0].x; r.z = sacs[0].z;
    SIMU.collect(G, r, sacs[0]);
    assert.strictEqual(r.pouch, mise + 2.5);
    assert.strictEqual(argentTotal(G), avant);
  }
  // 3. L'ENCAISSEMENT. La sacoche sort de la partie : elle est mise à zéro ET comptée dans
  // `G.encaisse`. Sans ce compteur, la conservation serait fausse dès le premier bot qui encaisse.
  {
    const G = areneNue(C.MODES.resurgence, mise);
    poser(G, 'moi', 60.5, 60.5, 0, C.BRAWLERS.bolt, true);
    const b = poser(G, 'bot', 64.5, 60.5, 1, C.BRAWLERS.bolt);
    b.pouch = 7;
    const avant = argentTotal(G);
    SIMU.botCashOut(G, b);
    assert.strictEqual(b.pouch, 0);
    assert.strictEqual(b.cashedOut, true);
    assert.strictEqual(G.encaisse, 7);
    assert.strictEqual(argentTotal(G), avant, 'l\'argent encaissé doit rester compté quelque part');
  }
});

test('aucun dégât ne passe pendant GRACE, ni sur un coéquipier, ni sur un invulnérable', () => {
  const G = areneNue();
  const a = poser(G, 'a', 60.5, 60.5, 0, C.BRAWLERS.bolt, true);
  const b = poser(G, 'b', 62.5, 60.5, 1, C.BRAWLERS.bolt);
  const c = poser(G, 'c', 60.5, 62.5, 0, C.BRAWLERS.bolt);
  const plein = b.hp;
  // La protection d'apparition est une durée de PARTIE, pas d'horloge : elle se lit sur G.time.
  G.time = C.GRACE - 0.001;
  SIMU.damage(G, b, 40, a);
  assert.strictEqual(b.hp, plein, 'un dégât est passé pendant la protection d\'apparition');
  G.time = C.GRACE;
  SIMU.damage(G, c, 40, a);
  assert.strictEqual(c.hp, plein, 'un coéquipier a pris des dégâts');
  b.invuln = 1;
  SIMU.damage(G, b, 40, a);
  assert.strictEqual(b.hp, plein, 'un invulnérable a pris des dégâts');
  b.invuln = 0;
  SIMU.damage(G, b, 40, a);
  assert.ok(b.hp < plein, 'et hors de ces trois cas, le dégât doit passer');
  // Aucun des trois refus n'a produit d'événement : ce qui n'arrive pas ne s'affiche pas.
  assert.strictEqual(G.evts.filter(e => e.type === 'degat').length, 1);
});

test('les dégâts comptés au joueur sont plafonnés aux points de vie restants de sa cible', () => {
  const G = areneNue();
  const moi = poser(G, 'moi', 60.5, 60.5, 0, C.BRAWLERS.bolt, true);
  const lui = poser(G, 'lui', 62.5, 60.5, 1, C.BRAWLERS.bolt);
  lui.hp = 12;
  SIMU.damage(G, lui, 500, moi);
  assert.strictEqual(G.dmgDealt, 12, 'le surplus d\'un coup de grâce ne doit pas gonfler la statistique');
  assert.strictEqual(lui.alive, false);
});

test('les cubes ne dépassent jamais CUBE.max, et les points de vie suivent', () => {
  const G = areneNue();
  const e = poser(G, 'moi', 60.5, 60.5, 0, C.BRAWLERS.bolt, true);
  for (let i = 0; i < C.CUBE.max + 8; i++){
    G.pickups.push({ kind: 'cube', x: e.x, z: e.z, amount: 1, owner: null, ph: 0 });
    SIMU.collect(G, e, G.pickups[G.pickups.length - 1]);
  }
  assert.strictEqual(e.cubes, C.CUBE.max);
  assert.strictEqual(e.hp, C.maxHp(e.brawler, C.CUBE.max));
  // Et un cube ramassé au-delà du plafond ne soigne pas non plus : sinon il deviendrait un cœur.
  e.hp = 10;
  G.pickups.push({ kind: 'cube', x: e.x, z: e.z, amount: 1, owner: null, ph: 0 });
  SIMU.collect(G, e, G.pickups[G.pickups.length - 1]);
  assert.strictEqual(e.hp, 10);
});

test('le critique reste la règle des trois tirs de critShot, et personne n\'en a écrit une seconde', () => {
  // On ne relit pas le code : on tire. Le troisième tir qui touche la même cible dans la fenêtre
  // passe à x1.5, et le quatrième repart de zéro. C'est `C.critShot` qui le dit, et le test le
  // vérifie contre elle, pas contre un nombre recopié ici.
  const G = areneNue();
  const moi = poser(G, 'moi', 60.5, 60.5, 0, C.BRAWLERS.bolt, true);
  const lui = poser(G, 'lui', 64.5, 60.5, 1, C.BRAWLERS.bolt);
  lui.hp = 1e6;
  const crits = [];
  for (let tir = 0; tir < 9; tir++){
    moi.fireCd = 0; moi.ammo = 3;
    SIMU.attack(G, moi, 1, 0, 4);
    for (let n = 0; n < 60 && G.projs.length; n++) SIMU.projUpdate(G, PAS);
    const d = G.evts.filter(e => e.type === 'degat');
    G.evts = [];
    assert.ok(d.length > 0, `le tir ${tir} n'a rien touché`);
    crits.push(d.some(e => e.crit));
  }
  // La rafale compte pour UN tir : `attack` incrémente `shotId` une fois, et la première balle qui
  // touche décide pour toute la série.
  const attendu = [];
  let etat = null;
  for (let tir = 0; tir < 9; tir++){
    const r = C.critShot(etat, lui.id, G.time, C.critWindow(moi.brawler));
    etat = r.state; attendu.push(r.crit);
  }
  assert.deepStrictEqual(crits, attendu, 'la série des critiques ne suit plus critShot');
  assert.deepStrictEqual(crits.slice(0, 6), [false, false, true, false, false, true],
    'la règle des trois tirs a changé sans que personne ne le dise');
  // Et une seule règle décide : un seul appel à critShot dans tout le fichier hors de WBCore.
  assert.strictEqual(compte(sim + JEU, /critShot\(/g), 1, 'une seconde règle de critique est apparue');
  assert.ok(!html.includes('CRIT_TEST'), 'CRIT_TEST est de retour');
  assert.ok(!html.includes('BOT_CRIT ='), 'un second interrupteur de critique est apparu');
});

// ---------- la collision balayée ----------
// Reconstruction de l'ANCIEN test, ponctuel, tel qu'il était avant ce module : on avance la balle
// d'un pas entier, puis on regarde si son centre est à moins de 0,62 du corps. Elle vit ici, dans
// le test, pour que « la balle ne traverse plus » soit une affirmation vérifiable et pas une
// intention : sans elle, un test qui touche ne prouverait pas que l'ancien code, lui, manquait.
function ancienTestPonctuel(x0, z0, dx, dz, spd, portee, cx, cz, rayon){
  const step = spd * PAS;
  let x = x0, z = z0, parcouru = 0;
  for (let n = 0; n < 4000; n++){
    x += dx * step; z += dz * step; parcouru += step;
    if (parcouru >= portee) return false;
    if (C.dist(cx - x, cz - z) < rayon) return true;
  }
  return false;
}
function tirer(G, tireur, spec, dx, dz){
  SIMU.spawnProjectile(G, tireur, dx, dz, spec, false, 0);
  for (let n = 0; n < 4000 && G.projs.length; n++) SIMU.projUpdate(G, PAS);
}

test('collision balayée : le cas qui tunnellait — un tir rapide ne frôle plus un corps sans le toucher', () => {
  // LE CAS, en clair. Le super de HEX vole à 36 blocs par seconde : au pas fixe il avance de 0,6
  // bloc par pas. Un brawler posté à 0,58 bloc sur le côté de la trajectoire, à mi-chemin entre
  // deux pas, est à 0,66 de chacun des deux points échantillonnés — donc hors des 0,62 du test
  // ponctuel — alors que le SEGMENT parcouru passe à 0,58 de lui. L'ancien code le manquait ; le
  // nouveau le touche, parce qu'il teste le trajet et non deux instantanés.
  const spec = C.BRAWLERS.hex.super;
  const step = spec.speed * PAS;
  const G = areneNue();
  const moi = poser(G, 'moi', 40.5, 60.5, 0, C.BRAWLERS.hex, true);
  const x0 = moi.x + 0.6;                                   // la balle naît 0,6 devant son tireur
  const cible = poser(G, 'lui', x0 + step * 2.5, 60.5 + 0.58, 1, C.BRAWLERS.bolt);
  const pv = cible.hp;
  assert.ok(!ancienTestPonctuel(x0, moi.z, 1, 0, spec.speed, spec.range, cible.x, cible.z, 0.62),
    'le cas choisi ne tunnellait pas : le test ne prouverait rien');
  tirer(G, moi, spec, 1, 0);
  assert.ok(cible.hp < pv, 'le tir passe encore à travers le corps');
});

test('collision balayée : à toute vitesse, même bien au-delà de ce que le jeu embarque, la balle ne traverse plus', () => {
  // Le pas fixe du module 1 a BORNÉ le tunnel, il ne l'a pas supprimé, et il l'a rendu
  // déterministe. Ce test le dit autrement : la collision ne doit plus dépendre du pas du tout.
  // Les vitesses au-delà de 36 ne sont embarquées par aucun brawler aujourd'hui — elles sont là
  // pour que la propriété tienne le jour où quelqu'un en écrira une, ou changera SIM.stepS.
  let tunnelsAvant = 0;
  for (const spd of [26, 36, 60, 120, 300]){
    const spec = { n: 1, dmg: 30, speed: spd, range: 40, kind: 'burst' };
    const G = areneNue();
    const moi = poser(G, 'moi', 20.5, 60.5, 0, C.BRAWLERS.hex, true);
    const cible = poser(G, 'lui', 20.5 + 0.6 + spd * PAS * 3.5, 60.5, 1, C.BRAWLERS.brick);
    const pv = cible.hp;
    if (!ancienTestPonctuel(moi.x + 0.6, moi.z, 1, 0, spd, spec.range, cible.x, cible.z, 0.62)) tunnelsAvant++;
    tirer(G, moi, spec, 1, 0);
    assert.ok(cible.hp < pv, `à ${spd} blocs par seconde, le tir traverse encore le corps`);
  }
  assert.ok(tunnelsAvant >= 2, 'aucune des vitesses testées ne tunnellait : le test ne prouve rien');
});

test('collision balayée : un mur d\'UNE case arrête la balle, et personne n\'est touché derrière', () => {
  for (const spd of [36, 120, 300]){
    const spec = { n: 1, dmg: 40, speed: spd, range: 40, kind: 'burst' };
    const G = areneNue();
    G.cells[70 * C.MAP + 60] = 1;                            // un seul bloc de pierre, sur le trajet
    const moi = poser(G, 'moi', 60.5, 60.5, 0, C.BRAWLERS.hex, true);
    const derriere = poser(G, 'lui', 75.5, 60.5, 1, C.BRAWLERS.brick);
    const pv = derriere.hp;
    tirer(G, moi, spec, 1, 0);
    assert.strictEqual(derriere.hp, pv, `à ${spd} blocs par seconde, la balle passe à travers un mur d'une case`);
    assert.strictEqual(G.projs.length, 0, 'la balle doit mourir, pas survivre au mur');
  }
  // Et elle meurt AU mur, pas derrière : sinon l'impact se verrait de l'autre côté de la pierre.
  const spec = { n: 1, dmg: 40, speed: 300, range: 40, kind: 'burst' };
  const G = areneNue();
  G.cells[70 * C.MAP + 60] = 1;
  const moi = poser(G, 'moi', 60.5, 60.5, 0, C.BRAWLERS.hex, true);
  SIMU.spawnProjectile(G, moi, 1, 0, spec, false, 0);
  const p = G.projs[0];
  for (let n = 0; n < 4000 && G.projs.length; n++) SIMU.projUpdate(G, PAS);
  // Le mur commence à x=70. Le balayage échantillonne tous les quarts de case : la balle meurt
  // donc au plus un quart de case DANS la pierre, jamais de l'autre côté — à 300 blocs par
  // seconde, un pas entier en vaut cinq.
  assert.ok(p.x >= 70 && p.x <= 70.26, `la balle est morte à ${p.x}, et le mur occupe [70, 71)`);
});

test('collision balayée : les tourelles et les caisses sont balayées elles aussi', () => {
  const spec = { n: 1, dmg: 40, speed: 200, range: 40, kind: 'burst' };
  {
    const G = areneNue();
    const moi = poser(G, 'moi', 60.5, 60.5, 0, C.BRAWLERS.hex, true);
    poser(G, 'lui', 90.5, 90.5, 1, C.BRAWLERS.bolt);
    G.boxes.push({ x: 68.5, z: 60.5, hp: C.BOX_HP, ph: 0 });
    tirer(G, moi, spec, 1, 0);
    assert.ok(G.boxes[0].hp < C.BOX_HP, 'la balle traverse encore une caisse');
  }
  {
    const G = areneNue();
    const moi = poser(G, 'moi', 60.5, 60.5, 0, C.BRAWLERS.hex, true);
    const autre = poser(G, 'lui', 90.5, 90.5, 1, C.BRAWLERS.bolt);
    G.turrets.push({ x: 68.5, z: 60.5, ax: 0, az: 0, hp: 200, maxHp: 200, owner: autre,
                     life: 20, cd: 1, spec: C.BRAWLERS.ward.super.shot, fireRate: 1, flash: 0, name: 't' });
    tirer(G, moi, spec, 1, 0);
    assert.ok(G.turrets[0].hp < 200, 'la balle traverse encore une tourelle');
  }
});

test('l\'ordre de résolution est figé : ni tri, ni parcours de Set, ni clé d\'objet dans le bloc SIM', () => {
  // Le déterminisme du rejeu tient à ce qu'un même pas résolve toujours les mêmes touches dans le
  // même ordre. Trois façons de le perdre en silence, et les trois sont interdites ici.
  const s = sansCommentaires(sim);
  assert.strictEqual(compte(s, /\.sort\(/g), 0,
    'un tri est apparu dans SIM : sa stabilité n\'est pas une propriété sur laquelle un rejeu peut s\'appuyer');
  assert.strictEqual(compte(s, /\bfor\s*\(\s*(?:const|let|var)\s+[\w$]+\s+in\s/g), 0,
    'un for..in est apparu : l\'ordre des clés d\'un objet ne décide de rien');
  assert.strictEqual(compte(s, /Object\.(keys|values|entries)\(/g), 0,
    'SIM parcourt les clés d\'un objet : ce n\'est pas un ordre sur lequel s\'appuyer');
  // `p.hit` et `e.dashHit` sont des Set, et ils ne servent QU'À l'appartenance. Les parcourir
  // ferait dépendre une résolution de l'ordre d'insertion d'un ensemble, ce que rien ne garantit
  // d'un moteur à l'autre.
  for (const m of s.match(/\.(hit|dashHit)\b[^\s]?/g) || [])
    assert.ok(/\.(hit|dashHit)[.=]/.test(m), `un Set est manipulé autrement que par appartenance : ${m}`);
  for (const m of s.match(/\.(hit|dashHit)\.\w+/g) || [])
    assert.ok(/\.(has|add)$/.test(m), `${m} : un Set ne doit servir qu'à \`has\` et \`add\``);
  assert.strictEqual(compte(s, /of\s+\w+\.(hit|dashHit)/g), 0, 'un Set est parcouru pour décider d\'un ordre');
  // Et l'ordre des candidats est bien celui de l'insertion, avec une clé TOTALE : distance le long
  // du segment, puis rang d'insertion. Sans le second terme, deux touches à égalité seraient
  // départagées par le hasard de l'implémentation.
  assert.match(s, /c\.t===m\.t&&c\.ordre<m\.ordre/, 'la clé d\'ordre a perdu son départage');
});

test('le flux d\'événements : SIM ne sonne plus, il RACONTE — et chaque événement est horodaté en pas', () => {
  // La panne que cette garde empêche est SILENCIEUSE : une seule ligne de rendu qui survit dans
  // une règle, et le bloc cesse de tourner dans Node sans que rien ne casse dans le navigateur.
  for (const interdit of ['snd(', 'floatText(', 'feed(', 'endMatch(', 'botSay(', 'sendEmote(', 'deathSting(', 'critFx('])
    assert.ok(!sim.includes(interdit), `« ${interdit} » a survécu dans le code descendu dans SIM`);
  // Les dix-huit fonctions du module vivent dans SIM et NULLE PART ailleurs. `corpsDe` lance si
  // l'une d'elles est déclarée dans les deux blocs — le patron du `respawn()` défini deux fois.
  for (const nom of ['attack', 'fireSpec', 'spawnProjectile', 'projUpdate', 'explode', 'useSuper',
                     'dashUpdate', 'zonesUpdate', 'damage', 'kill', 'hurtBox', 'spawnPickup',
                     'collect', 'respawn', 'botCashOut', 'hurtTurret', 'checkTeams', 'doCashOut'])
    assert.ok(sim.includes('\nfunction ' + nom + '('), `${nom} n'est pas descendue dans SIM`);
  // Et il tourne : une vraie partie de banc produit les cinq familles que la spécification exige.
  const G = bancNeuf(C.MODES.solo, 0.5, 31);
  // Une grenade dans la poche de chacun : elles ne tombent que des caisses, à une sur cinq, et
  // sans ce coup de pouce le banc pourrait ne jamais en voir une en deux mille pas.
  for (const e of G.ents) e.gadget = C.smokePicked(e.gadget);
  const vus = new Map();
  for (let n = 0; n < 2200; n++){
    for (const ev of pasDeBanc(G)){
      assert.strictEqual(ev.pas, G.pas, `un événement ${ev.type} horodaté ${ev.pas} au pas ${G.pas}`);
      assert.ok(Number.isInteger(ev.pas) && ev.pas > 0, 'un événement doit être horodaté EN PAS');
      vus.set(ev.type, (vus.get(ev.type) || 0) + 1);
    }
  }
  for (const nom of ['tir', 'degat', 'mort', 'ramassage', 'nuage'])
    assert.ok(vus.get(nom) > 0, `aucun événement « ${nom} » en 2200 pas`);
  // Les noms sont FERMÉS : un type inconnu ne serait traduit par personne, en silence.
  const connus = new Set(['tir', 'degat', 'mort', 'ramassage', 'nuage', 'explosion', 'super',
                          'gadget', 'detruit', 'encaissement', 'reapparition', 'fin']);
  for (const nom of vus.keys()) assert.ok(connus.has(nom), `événement inconnu : ${nom}`);
  // Le bloc `Game` traduit chacun de ces noms, et rien d'autre : un événement produit et jamais lu
  // serait un son qui disparaît sans que rien ne casse.
  const lecteur = sansCommentaires(corpsDe('rendreEvenements'));
  for (const nom of connus) assert.ok(lecteur.includes(`case '${nom}'`), `le rendu ne lit pas « ${nom} »`);
});

test('un seul écrivain par table annexe : syncMeshes, syncMonde et hudFast, et personne d\'autre', () => {
  // Le module 3 avait posé la règle pour les corps de brawlers. Les corps des projectiles, des
  // caisses, du butin, des zones, des tourelles, des grenades et des nuages la rejoignent ici, et
  // les étiquettes du DOM au-dessus des têtes avec eux — `e.lbl` était le dernier pointeur de
  // rendu posé sur un fait de partie.
  const jeu = sansCommentaires(JEU);
  assert.strictEqual(compte(jeu, /VIS\.get\(/g), 1, 'un second site lit la table des corps annexes');
  assert.strictEqual(compte(jeu, /LABELS\.get\(/g), 1, 'un second site lit la table des étiquettes');
  assert.ok(sansCommentaires(corpsDe('syncMonde')).includes('VIS.get('), 'l\'unique lecteur de VIS doit être syncMonde');
  assert.ok(sansCommentaires(corpsDe('etiquette')).includes('LABELS.get('), 'l\'unique lecteur de LABELS doit être hudFast, par etiquette');
  assert.strictEqual(compte(jeu, /\bsyncMonde\(/g), 2, 'syncMonde doit être déclarée une fois et appelée une fois');
  assert.ok(sansCommentaires(corpsDe('loop')).includes('syncMonde(dt);'), 'la recopie se fait une fois par image');
  // Et plus une seule fonction de simulation ne porte de pointeur de rendu.
  for (const nom of ['projUpdate', 'hurtBox', 'spawnPickup', 'zonesUpdate', 'spawnSmoke', 'nadesUpdate',
                     'smokesUpdate', 'useSuper', 'hurtTurret', 'throwSmoke', 'collect', 'explode'])
    for (const attache of ['.mesh', '.lbl', 'world.', 'discard('])
      assert.ok(!sansCommentaires(corpsDe(nom)).includes(attache),
        `${nom} touche de nouveau au rendu (${attache})`);
});

test('bac à sable : le combat, la mort et le butin tournent avec document, window, THREE, Math.random, Date.now et performance indéfinis', () => {
  // La même garde que le module 3, étendue à ce que ce module a descendu. Le bloc ne se contente
  // pas de se CHARGER là-dedans : il y joue une escarmouche complète.
  const sansRandom = new Proxy(Math, { get: (t, p) => p === 'random' ? undefined : Reflect.get(t, p) });
  const sansNow = new Proxy(Date, { get: (t, p) => p === 'now' ? undefined : Reflect.get(t, p) });
  const bac = new Function('module', 'exports', 'WBCore', 'document', 'window', 'THREE', 'performance',
                           'localStorage', 'fetch', 'requestAnimationFrame', 'Math', 'Date', sim);
  const m = { exports: {} };
  bac(m, m.exports, C, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sansRandom, sansNow);
  const Z = m.exports;
  const cells = new Uint8Array(C.MAP * C.MAP);
  const G = { cells, time: 20, pas: 0, evts: [], running: true, stake: 0.5, modeCfg: C.MODES.resurgence,
              alea: C.makeFlux(5), nextEid: 0, ents: [], boxes: [], pickups: [], projs: [], zones: [],
              turrets: [], smokes: [], nades: [], dmgDealt: 0, looted: 0, lostPouch: 0, encaisse: 0,
              zone: { cx: C.MAP / 2, cz: C.MAP / 2, r: C.MAP, dps: 0 } };
  const a = Z.makeEntity(G, 'a', 60.5, 60.5, 0.5, true, C.BRAWLERS.hex, 0.6, 0);
  const b = Z.makeEntity(G, 'b', 64.5, 60.5, 0.5, false, C.BRAWLERS.brick, 0.6, 1);
  a.lives = 3; b.lives = 3; G.ents.push(a, b); G.player = a;
  G.boxes.push({ x: 62.5, z: 60.5, hp: C.BOX_HP, ph: 0 });
  for (let n = 0; n < 900; n++){
    G.pas++; G.time += C.SIM.stepS;
    for (const e of G.ents){
      if (!e.alive) continue;
      e.fireCd -= C.SIM.stepS;
      if (e.ammo < 3){ e.ammoT += C.SIM.stepS; if (e.ammoT >= e.brawler.ammoReload){ e.ammo++; e.ammoT = 0; } }
      const o = e === a ? b : a; if (!o.alive) continue;
      const d = C.dist(o.x - e.x, o.z - e.z) || 1;
      Z.attack(G, e, (o.x - e.x) / d, (o.z - e.z) / d, d);
      if (e.super >= e.brawler.super.cost) Z.useSuper(G, e, d);
      Z.throwSmoke(G, e, d);
      for (let i = G.pickups.length - 1; i >= 0; i--) Z.collect(G, e, G.pickups[i]);
    }
    Z.projUpdate(G, C.SIM.stepS); Z.zonesUpdate(G, C.SIM.stepS);
    Z.nadesUpdate(G, C.SIM.stepS); Z.smokesUpdate(G, C.SIM.stepS);
    for (const e of G.ents) if (e.respawnT > 0){ e.respawnT -= C.SIM.stepS; if (e.respawnT <= 0) Z.respawn(G, e); }
    G.evts = [];
  }
  assert.ok(G.boxes[0].hp < C.BOX_HP, 'la caisse n\'a jamais été touchée : le banc n\'a rien fait');
  assert.ok(a.kills + b.kills > 0, 'personne n\'est mort : le bac à sable n\'a pas vraiment joué');
  // Et rien de tout cela n'a posé un pointeur de rendu sur un fait de partie.
  for (const e of G.ents) for (const champ of ['mesh', 'lbl', 'lblMn'])
    assert.ok(!(champ in e), `une entité porte de nouveau « ${champ} »`);
  for (const p of G.projs) assert.ok(!('mesh' in p), 'un projectile porte un objet de la scène');
  for (const pk of G.pickups) assert.ok(!('mesh' in pk) && !('shadow' in pk), 'un butin porte un objet de la scène');
});

console.log('Les bots, et une partie ENTIÈRE sans navigateur');
// CE QUE CETTE SECTION FERME, et c'est le trou le plus ancien du dossier : « aucun test ne regarde
// le jeu tourner ». Tout ce qui décide d'un fait de partie vit désormais dans `WBSim` — la grille,
// le combat, le butin, les bots, le joueur, le gaz — et `WBSim.step` avance d'un pas. On peut donc
// jouer une partie complète dans Node, du coup d'envoi à la dernière phase du gaz, sans navigateur,
// sans réseau et sans base.
//
// CE QU'ELLE NE COUVRE PAS, et il faut le dire ici plutôt que dans un commit qu'on ne relira pas :
// L'ÉCRAN. Que le HUD affiche le bon nombre, que la caméra suive, qu'un buisson se fonde, qu'un
// bouton réponde au doigt — rien de tout cela n'est ici et rien ne peut l'être. Deux des bugs
// marquants de docs/HISTORIQUE.md n'ont été trouvés que par un navigateur, et ce harnais ne les
// aurait pas attrapés. Il prouve que la partie se JOUE, pas qu'elle se VOIT.

// LE HARNAIS, ÉCRIT EN TEXTE, et c'est délibéré : il tourne à DEUX endroits — dans ce processus, et
// dans un processus fils qui ne partage rien avec lui. Une seconde copie recopiée à la main serait
// exactement ce que le dépôt interdit partout ailleurs ; ici la source est unique et les deux côtés
// l'évaluent.
//
// Le « pilote » est la conduite du JOUEUR, et rien d'autre : il ne décide d'aucune règle, il produit
// les six nombres et les deux booléens que le bloc `Game` lit sur la souris et les sticks. C'est
// exactement la forme que la trace du module 6 enregistrera.
const HARNAIS = `
function pilote(C, S, G){
  const p = G.player, portee = p.brawler.attack.range;
  if (!p.alive) return { mx:0, mz:0, ax:p.ax, az:p.az, aimDist:portee, feu:false, sup:false };
  let cible = null, bd = 1e9;
  for (const e of G.ents){
    if (e === p || !e.alive || e.team === p.team) continue;
    const d = C.dist(e.x - p.x, e.z - p.z);
    if (d < bd && S.canSee(G, p, e)){ bd = d; cible = e; }
  }
  let ax = p.ax, az = p.az, mx = 0, mz = 0, feu = false, sup = false, aimDist = portee;
  if (cible){
    ax = (cible.x - p.x) / bd; az = (cible.z - p.z) / bd;
    aimDist = Math.min(bd, portee);
    feu = bd < portee;
    sup = p.super >= p.brawler.super.cost;
    if (bd > portee * 0.6){ mx = ax; mz = az; } else { mx = -az; mz = ax; }
  } else {
    const dx = G.zone.cx - p.x, dz = G.zone.cz - p.z, d = C.dist(dx, dz) || 1;
    if (d > 2){ mx = dx / d; mz = dz / d; ax = mx; az = mz; }
  }
  if (!S.inZone(G, p.x, p.z, 1.5)){
    const dx = G.zone.cx - p.x, dz = G.zone.cz - p.z, d = C.dist(dx, dz) || 1;
    mx = dx / d; mz = dz / d;
  }
  // Contourner un mur, comme un joueur le ferait. Sans cette ligne le pilote pousse la pierre
  // jusqu'à la fin du gaz, et le harnais ne prouve plus que le jeu tourne : il prouve qu'une statue
  // se fait gazer.
  if ((mx || mz) && !S.free(G, p.x + mx * 0.9, p.z + mz * 0.9)){
    const s = (p.eid % 2) ? 1 : -1;
    if (S.free(G, p.x - mz * s * 0.9, p.z + mx * s * 0.9)){ const t = mx; mx = -mz * s; mz = t * s; }
    else { const t = mx; mx = mz * s; mz = -t * s; }
  }
  return { mx, mz, ax, az, aimDist, feu, sup };
}
// UNE PARTIE ENTIÈRE. Elle s'arrête sur un état TERMINAL — une seule équipe encore en jeu, ou la
// fin du plan de zone — et jamais sur un compteur d'essais. La borne de pas est un chien de garde :
// si elle se déclenche, c'est que ni l'une ni l'autre des deux fins n'est jamais arrivée, et c'est
// un défaut, pas une fin.
function jouerPartie(C, S, graine, cleMode, miseCents, cleBrawler, trace){
  const mode = C.MODES[cleMode];
  const G = S.newMatch(graine, mode, miseCents, C.BRAWLERS[cleBrawler]);
  const planS = C.zoneTotalS(G.zonePlan);
  // Le compte à rebours d'intro consomme des pas sans faire avancer \`G.pas\` : sans cette marge,
  // exactement comme \`traceMaxSteps\` la prévoit déjà, une partie honnête toucherait le chien de
  // garde deux cent quarante pas avant sa fin.
  const borne = Math.ceil((planS + C.GRACE + C.TRACE.INTRO_S) / C.SIM.stepS);
  const attendu = miseCents * C.seatsOf(mode);
  const sortie = [];
  let pas = 0, fin = null, issue = 'borne', argentKO = 0, echappes = 0, degatsGaz = 0;
  // ---- LA SECONDE OPINION, ET POURQUOI ELLE NE RELIT PLUS L'ÉTAT ----
  // Ce harnais annonçait « ses propres formules » et recopiait \`WBSim.faits\` expression pour
  // expression : \`G.survivedT||G.time\`, \`livesFor(mode)-p.lives\`, \`f.rang\`. Comparé sur cinquante
  // parties, c'était vrai par CONSTRUCTION — un modèle est d'accord avec lui-même, et le dossier
  // s'est déjà fait avoir une fois avec la conservation de l'argent. Ce qui suit se calcule depuis
  // le FLUX D'ÉVÉNEMENTS que la boucle draine déjà, et depuis lui seul : deux chemins distincts,
  // donc un vrai désaccord possible. C'est notamment ce qui rendrait visible le cas que le \`||\` de
  // \`seconds\` cache, et le « rang du joueur contre rang de l'équipe » que la 02a a dû élargir.
  let pasVivant = 0, killsVus = 0, mortsVues = 0, cubesVus = 0, degatsBruts = 0;
  let sacoche = C.fromCents(miseCents), rangVu = 0, sortiAvecLArgent = false;
  const encoreEnJeu = () => {
    // \`inPlay\` réécrit ici plutôt qu'appelé, exactement comme \`free()\` l'a été au module 3 : sans
    // quoi le second avis emprunterait la fonction qu'il est censé contredire.
    const t = new Set();
    for (const en of G.ents) if (!en.cashedOut && (en.alive || en.lives > 0)) t.add(en.team);
    return t.size;
  };
  while (pas < borne){
    const e = trace ? (trace[pas] || {}) : pilote(C, S, G);
    if (!trace) sortie.push(e);
    // Le super et le gadget partent encore d'un ÉVÉNEMENT d'entrée, hors du pas fixe, exactement
    // comme la barre d'espace du jeu : ils sont donc joués ici, entre deux pas, et enregistrés dans
    // la trace comme le reste. Le module 6 devra les y retrouver.
    if (e.sup && G.player.alive) S.useSuper(G, G.player, e.aimDist);
    // Debout AVANT le pas : c'est ce que la simulation regarde pour décider si ce pas-là compte
    // dans la survie du joueur. Le lire après manquerait le pas où il tombe.
    const vivantAvant = G.player.alive;
    for (const ev of S.step(G, e)){
      if (ev.type === 'fin' && !fin) fin = ev;
      if (ev.type === 'degat' && ev.sur === 'gaz') degatsGaz++;
      if (ev.type === 'degat' && ev.src === G.player) degatsBruts += ev.dmg;
      if (ev.type === 'ramassage' && ev.e === G.player){
        if (ev.kind === 'cube') cubesVus = Math.min(C.CUBE.max, cubesVus + ev.amount);
        else if (ev.kind === 'cash') sacoche += ev.amount;
      }
      if (ev.type === 'mort'){
        if (ev.tueur === G.player){ killsVus++; if (ev.transfert) sacoche = C.bucketAfterKill(sacoche, ev.sacoche); }
        if (ev.victime === G.player){
          mortsVues++; cubesVus = 0; sacoche = 0;
          // Le rang se compte ICI, sur l'état, au moment où le joueur sort : le nombre d'équipes
          // encore en jeu, plus la sienne. C'est la seule façon qu'un test pose deux fois la
          // question « rang du joueur ou rang de l'équipe ».
          if (ev.elimine && !rangVu) rangVu = encoreEnJeu() + 1;
        }
      }
      if (ev.type === 'encaissement' && ev.e === G.player) sortiAvecLArgent = true;
    }
    if (vivantAvant) pasVivant = G.pas;
    pas++;
    let somme = 0;
    for (const en of G.ents) somme += en.pouch;
    for (const pk of G.pickups) if (pk.kind === 'cash') somme += pk.amount;
    if (C.toCents(somme + (G.encaisse || 0)) !== attendu) argentKO++;
    for (const en of G.ents) if (en.escapeT > 0){ echappes++; break; }
    if (S.aliveTeams(G).size <= 1){ issue = 'vainqueur'; break; }
    if (G.time >= planS){ issue = 'plan'; break; }
  }
  const coinces = G.ents.filter(e => e.alive && !S.free(G, e.x, e.z));
  const p = G.player;
  return { G, trace: trace || sortie, pas, fin, issue, argentKO, echappes, degatsGaz,
           coinces: coinces.map(e => e.name + '@' + e.x.toFixed(2) + ',' + e.z.toFixed(2)),
           debloques: G.debloques | 0,
           empreinte: S.empreinte(G),
           // L'état final, sous une forme comparable telle quelle. Les positions ne sont PAS
           // arrondies ici : ce que compare la reproductibilité, c'est l'égalité exacte de deux
           // exécutions du même code sur le même moteur, pas la tolérance entre deux moteurs.
           etat: G.ents.map(e => [e.eid, e.name, e.alive, e.cashedOut, e.hp, e.x, e.z, e.vx, e.vz,
                                  e.pouch, e.cubes, e.kills, e.lives, e.ammo]),
           // LA SECONDE OPINION. Chaque champ vient du flux d'événements ou d'un compteur tenu par
           // la boucle, jamais d'une relecture de l'état que \`WBSim.faits\` relit lui aussi.
           //
           // \`damage\` fait exception, et l'exception est écrite plutôt que masquée : la simulation
           // PLAFONNE les dégâts à ce qu'il restait de vie à la cible, et l'événement \`degat\` ne
           // porte pas ce reste — l'événement se draine après le pas, quand la vie a déjà baissé.
           // Le flux ne permet donc que la somme BRUTE, et le test compare ce qu'il peut : le
           // compte de la simulation est non nul et n'excède jamais cette somme.
           degatsBruts: Math.round(degatsBruts),
           rapport: C.reportFrom({
             seconds: pasVivant * C.SIM.stepS,
             kills: killsVus,
             deaths: mortsVues,
             rank: (fin && fin.gagne) ? 1 : (rangVu || encoreEnJeu() || 1),
             cubes: cubesVus,
             damage: G.dmgDealt,
             cashedOut: !!(mode.cashout && sortiAvecLArgent),
             purseCents: C.toCents(sacoche),
             declaredNetCents: (fin && fin.gagne) ? C.toCents(C.cashoutPayout(sacoche).net) : 0,
           }) };
}
return { pilote, jouerPartie };
`;
const H = new Function(HARNAIS)();
const jouer = (graine, mode, miseCents, brawler, trace) =>
  H.jouerPartie(C, SIMU, graine, mode, miseCents, brawler, trace);
// Combien de pas le compte à rebours d'intro consomme sans faire avancer `G.pas`. Il est posé par
// `newMatch` depuis que c'est une règle de simulation, donc il se MESURE plutôt que de se réécrire
// à la main : un test qui recopierait 240 cesserait de dire la vérité le jour où la valeur bouge.
const PAS_INTRO = (() => {
  const G = SIMU.newMatch(1, C.MODES.solo, 50, C.BRAWLERS.bolt);
  let n = 0;
  while (G.intro > 0 && n < 10000){ SIMU.step(G, {}); n++; }
  return n;
})();

// Dix graines, les cinq modes, les quatre tables et dix brawlers : cinquante parties complètes,
// jouées pour de bon. Elles servent à plusieurs tests d'affilée, donc elles se jouent UNE fois.
const GRAINES = [4101, 4102, 4103, 4104, 4105, 4106, 4107, 4108, 4109, 4110];
let PARTIES = [];

test('LE JEU TOURNE : dix graines, cinq modes, une partie complète atteint une fin à chaque fois', () => {
  const modes = Object.keys(C.MODES), brawlers = C.BRAWLER_IDS;
  for (let mi = 0; mi < modes.length; mi++){
    for (let gi = 0; gi < GRAINES.length; gi++){
      const cleMode = modes[mi], mode = C.MODES[cleMode];
      const mise = C.toCents(C.TIERS[gi % C.TIERS.length].stake);
      const r = jouer(GRAINES[gi], cleMode, mise, brawlers[(mi * 3 + gi) % brawlers.length]);
      const ou = `${cleMode} · graine ${GRAINES[gi]}`;
      // La fin est un état TERMINAL, jamais un compteur d'essais épuisé.
      assert.notStrictEqual(r.issue, 'borne', `${ou} : ni vainqueur ni fin de plan en ${r.pas} pas`);
      assert.ok(r.G.time <= C.zoneTotalS(r.G.zonePlan) + C.GRACE,
        `${ou} : la partie a duré ${r.G.time.toFixed(1)} s pour un plan de ${C.zoneTotalS(r.G.zonePlan)} s`);
      // PERSONNE NE FINIT COINCÉ CONTRE UN MUR. Un brawler dont le corps ne tient pas là où il est
      // ne bouge plus de la partie — `tryMove` refuse les deux axes — et il ne peut même pas être
      // tué, les balles mourant sur le mur qu'il chevauche.
      assert.deepStrictEqual(r.coinces, [], `${ou} : des vivants sont coincés dans un mur`);
      PARTIES.push(Object.assign({ cleMode, mode, graine: GRAINES[gi], miseCents: mise }, r));
    }
  }
  assert.strictEqual(PARTIES.length, 50);
  // Et il s'est passé quelque chose. Sans ces bornes, tout ce qui précède passerait sur une partie
  // où vingt statues se font gazer en silence.
  const morts = PARTIES.reduce((n, r) => n + r.G.ents.filter(e => !e.alive).length, 0);
  const kills = PARTIES.reduce((n, r) => n + r.G.ents.reduce((k, e) => k + e.kills, 0), 0);
  const caisses = PARTIES.reduce((n, r) => n + r.G.boxes.filter(b => b.hp <= 0).length, 0);
  const gaz = PARTIES.reduce((n, r) => n + r.degatsGaz, 0);
  assert.ok(kills > 500, `seulement ${kills} kills sur cinquante parties`);
  assert.ok(morts > 200, `seulement ${morts} brawlers au tapis`);
  assert.ok(caisses > 200, `seulement ${caisses} caisses détruites`);
  assert.ok(gaz > 500, `le gaz n'a brûlé personne (${gaz} ticks)`);
  const vainqueurs = PARTIES.filter(r => r.issue === 'vainqueur').length;
  assert.ok(vainqueurs > 20, `seulement ${vainqueurs} parties sur 50 ont fait un vainqueur avant la fin du gaz`);
});

test('le chien de garde stuckT est exercé POUR DE VRAI, pour la première fois du dépôt', () => {
  // Ce chien de garde existe depuis longtemps et rien ne l'avait jamais déclenché : les tests
  // regardaient des bancs de quelques centaines de pas sur des arènes nues, où l'on ne se coince
  // pas. Un test qui vérifie seulement que « personne ne finit coincé » passerait aussi bien sur un
  // jeu où le chien de garde est mort — il faut donc compter ses interventions.
  assert.ok(PARTIES.length === 50, 'la volée de parties n\'a pas été jouée');
  const total = PARTIES.reduce((n, r) => n + r.debloques, 0);
  const avec = PARTIES.filter(r => r.debloques > 0).length;
  assert.ok(total > 200, `le chien de garde n'est intervenu que ${total} fois sur cinquante parties`);
  assert.ok(avec >= 40, `seulement ${avec} parties sur 50 ont eu à débloquer quelqu'un`);
  // Et l'échappée qu'il déclenche dure vraiment : `escapeT` a été vue armée pendant les parties.
  assert.ok(PARTIES.reduce((n, r) => n + r.echappes, 0) > 200, 'aucune échappée n\'a jamais couru');
});

test('L\'ARGENT SE CONSERVE À CHAQUE PAS D\'UNE PARTIE ENTIÈRE, du coup d\'envoi à la fin du gaz', () => {
  // Le module 4 prouvait cette conservation sur un banc de mille cinq cents pas conduit par une IA
  // de quelques lignes écrite dans ce fichier. Elle se vérifie désormais sur la VRAIE partie, bots
  // compris, sur quelque quatre cent mille pas. C'est elle qui fonde `purseBound`, donc le seul
  // plafond de paiement que le serveur possède.
  assert.ok(PARTIES.length === 50, 'la volée de parties n\'a pas été jouée');
  for (const r of PARTIES)
    assert.strictEqual(r.argentKO, 0,
      `${r.cleMode} · graine ${r.graine} : de l'argent apparaît ou disparaît sur ${r.argentKO} pas`);
  // Et l'argent a bel et bien circulé : sans ça, la conservation serait vraie parce que rien n'a
  // bougé. Une sacoche a grossi au-delà de la mise, et de l'argent est sorti par un encaissement.
  const grosse = Math.max(...PARTIES.map(r => Math.max(...r.G.ents.map(e => C.toCents(e.pouch)))));
  const encaisse = PARTIES.reduce((n, r) => n + C.toCents(r.G.encaisse || 0), 0);
  assert.ok(grosse > C.toCents(C.TIERS[0].stake) * 4, `la plus grosse sacoche vaut ${grosse} centimes`);
  assert.ok(encaisse > 0, 'aucun bot n\'a jamais encaissé sur cinquante parties');
});

test('L\'ENVELOPPE DE matchVerdict EST CONFRONTÉE AU CODE DU JEU : cinquante parties sincères passent', () => {
  // LA LEÇON QUE CE DOSSIER A DÉJÀ APPRISE TROIS FOIS : une règle de plausibilité se vérifie contre
  // le code du jeu, jamais contre l'intuition. Trois contrôles « évidents » de la 02a étaient faux —
  // « la sacoche vaut la mise sans kill », « pas plus de kills que d'adversaires », « le rang ne
  // dépasse pas le nombre d'équipes » — et le troisième n'a été démenti qu'au branchement du jeu.
  // Voici enfin de vraies parties à leur opposer.
  assert.ok(PARTIES.length === 50, 'la volée de parties n\'a pas été jouée');
  const issues = {};
  for (const r of PARTIES){
    const secondes = r.rapport.seconds;
    // Un billet honnête : ouvert avant le sas, jugé juste après la fin de la partie.
    const ouvert = 1780000000000;
    const billet = { mode: r.cleMode, stakeCents: r.miseCents, seats: C.seatsOf(r.mode),
                     teamSize: r.mode.teamSize, seed: r.graine,
                     openedAt: ouvert, expiresAt: ouvert + 15 * 60000 };
    const maintenant = ouvert + (C.LOBBY.wait + secondes + 4) * 1000;
    const v = C.matchVerdict(billet, r.rapport, maintenant);
    assert.ok(v.ok, `${r.cleMode} · graine ${r.graine} : l'enveloppe REFUSE une partie sincère — `
      + `${v.controle} : ${v.motif} (rapport ${JSON.stringify(r.rapport)})`);
    issues[v.issue] = (issues[v.issue] || 0) + 1;
    // Et chaque chiffre est dans sa borne, contrôle par contrôle, pour que l'échec dise LEQUEL.
    assert.ok(r.rapport.kills <= v.limites.killsMax, `kills ${r.rapport.kills} > ${v.limites.killsMax}`);
    assert.ok(r.rapport.deaths <= v.limites.mortsMax, `morts ${r.rapport.deaths} > ${v.limites.mortsMax}`);
    assert.ok(r.rapport.rank <= v.limites.rangMax, `rang ${r.rapport.rank} > ${v.limites.rangMax}`);
    assert.ok(r.rapport.cubes <= C.CUBE.max, `cubes ${r.rapport.cubes} > ${C.CUBE.max}`);
    assert.ok(r.rapport.purseCents <= v.limites.sacocheMaxCents,
      `sacoche ${r.rapport.purseCents} > ${v.limites.sacocheMaxCents}`);
    assert.ok(secondes <= v.limites.dureeMaxS, `durée ${secondes} > ${v.limites.dureeMaxS}`);
  }
  // Le harnais joue mal : il perd presque toujours. C'est écrit ici plutôt que caché, parce que
  // c'est la limite de ce test — le chemin « victoire » de l'enveloppe n'est confronté à une vraie
  // partie que quand une graine le veut bien, et il garde ses tests propres ailleurs dans ce
  // fichier. Ce que ces cinquante parties prouvent est l'essentiel : l'enveloppe ne refuse pas un
  // joueur honnête.
  assert.ok((issues.defaite || 0) + (issues.victoire || 0) + (issues.encaissement || 0) === 50);
  // Le rang le plus haut atteint FRÔLE la borne, et c'est exactement le contrôle que la 02a avait
  // dû élargir : le rang annoncé est celui du JOUEUR, pas celui de son équipe.
  const rangs = PARTIES.map(r => ({ rang: r.rapport.rank, max: Math.max(1, Math.round(C.seatsOf(r.mode) / r.mode.teamSize)) }));
  assert.ok(rangs.some(x => x.rang > x.max),
    'aucune partie n\'a atteint le rang « nombre d\'équipes + 1 » : le contrôle élargi en 02a n\'est plus éprouvé');
});

test('L\'ÉTAT TERMINAL EST UN FAIT DE LA PARTIE, et une partie tronquée n\'en a pas', () => {
  // LA RÈGLE QUI TIENT L'ARGENT DANS UN REJEU DIFFÉRÉ. Le serveur n'écrit un montant que si le
  // rejeu atteint une fin ; sans elle, couper le réseau juste après un gros kill deviendrait la
  // meilleure stratégie du jeu le jour où un euro entre. Elle vit dans SIM parce que le jeu et le
  // serveur doivent en avoir exactement une idée.
  assert.ok(PARTIES.length === 50, 'la volée de parties n\'a pas été jouée');
  const fins = {};
  for (const r of PARTIES){
    const t = SIMU.terminal(r.G);
    assert.ok(t, `${r.cleMode} · graine ${r.graine} : une partie complète sans état terminal`);
    fins[t] = (fins[t] || 0) + 1;
    // Et l'issue que le harnais a constatée de l'extérieur dit la même chose.
    assert.ok(r.issue === 'vainqueur' || r.issue === 'plan', r.issue);
  }
  // Le harnais joue mal et perd toujours : les cinquante parties finissent toutes sur
  // l'élimination du joueur. C'est écrit plutôt que caché — les trois autres fins sont éprouvées
  // une par une dans le test suivant, parce qu'aucune ne se commande à un pilote.
  assert.deepStrictEqual(Object.keys(fins), ['elimination'], JSON.stringify(fins));
  // Une partie COUPÉE en plein milieu n'est pas terminale, et c'est tout le sujet : elle ne se
  // règle pas. Trois cents pas, c'est cinq secondes de jeu — le décompte d'intro finit à peine.
  const G = SIMU.newMatch(4101, C.MODES.solo, 50, C.BRAWLERS.bolt);
  for (let i = 0; i < 300; i++) SIMU.step(G, {});
  assert.strictEqual(SIMU.terminal(G), null, 'une partie de cinq secondes est déjà déclarée finie');
  assert.strictEqual(G.fin, null);
});
test('LES QUATRE FINS D\'UNE PARTIE, une par une : encaissement, victoire, élimination, plan', () => {
  // Chacune ouvre le droit d'écrire un montant, donc chacune se vérifie sur le vrai code plutôt que
  // sur la lecture de `terminal`. Aucune ne se commande à un pilote : elles se provoquent.
  const neuf = (cle, brawler) => SIMU.newMatch(4242, C.MODES[cle], 50, C.BRAWLERS[brawler || 'bolt']);

  // ENCAISSEMENT : le joueur sort avec sa sacoche. Il reste vivant, donc rien d'autre ne l'annonce.
  const enc = neuf('resurgence');
  for (let i = 0; i < 300; i++) SIMU.step(enc, {});
  assert.strictEqual(SIMU.terminal(enc), null);
  assert.strictEqual(SIMU.doCashOut(enc), true);
  assert.strictEqual(SIMU.terminal(enc), 'encaissement');
  assert.strictEqual(SIMU.faits(enc).cashedOut, true);
  assert.strictEqual(SIMU.faits(enc).rank, 1, 'sortir avec l\'argent est une sortie gagnante');

  // VICTOIRE : plus qu'une équipe en jeu, et c'est la sienne. On épuise les vies des dix-neuf
  // autres par la vraie fonction de mort.
  const vic = neuf('solo');
  for (let i = 0; i < 300; i++) SIMU.step(vic, {});
  // Une vie chacun, puis le gaz : `kill` sort tout de suite sur un mort, donc on ne peut pas
  // frapper trois fois d'affilée le même — c'est la dernière vie qui élimine, pas le nombre de
  // coups.
  for (const e of vic.ents) if (!e.isPlayer){ e.lives = 1; if (e.alive) SIMU.kill(vic, e, null, 'gas'); }
  assert.strictEqual(SIMU.terminal(vic), 'victoire');
  assert.strictEqual(SIMU.faits(vic).rank, 1);

  // ÉLIMINATION : le joueur perd toutes ses vies. Il n'y a plus de rejeu à attendre.
  const eli = neuf('solo');
  for (let i = 0; i < 300; i++) SIMU.step(eli, {});
  eli.player.lives = 1;
  SIMU.kill(eli, eli.player, null, 'gas');
  assert.strictEqual(SIMU.terminal(eli), 'elimination');
  assert.ok(SIMU.faits(eli).rank > 1);
  assert.strictEqual(SIMU.faits(eli).purseCents, 0, 'mourir vide la sacoche');

  // PLAN : le gaz a fini de se refermer et personne n'a gagné. Le joueur est vivant, donc aucun
  // événement de fin n'a été émis — c'est l'horloge de la partie qui tranche, et elle seule.
  const fin = neuf('solo');
  fin.time = C.zoneTotalS(fin.zonePlan);
  assert.strictEqual(SIMU.terminal(fin), 'plan');
  fin.time -= 0.001;
  assert.strictEqual(SIMU.terminal(fin), null, 'la fin du plan se joue à la seconde près');
});
test('UNE SEULE DÉFINITION DES FAITS D\'UNE PARTIE : le harnais et WBSim disent la même chose', () => {
  // `endMatch` rendait ces neuf champs au serveur, le harnais les recopiait, et le serveur allait
  // les recopier une troisième fois pour son rejeu. Trois copies d'une même définition, dont deux
  // auraient fini par mentir — et alors le serveur aurait jugé une AUTRE partie que celle que
  // l'écran du joueur venait d'afficher. `WBSim.faits` est désormais la seule.
  //
  // LE HARNAIS EN EST LA SECONDE OPINION, ET IL A FALLU LA RENDRE VRAIE. Il annonçait « ses propres
  // formules » et recopiait mot pour mot celles de `faits` — `G.survivedT||G.time`,
  // `livesFor(mode)-p.lives`, `f.rang`, `p.kills` : la comparaison sur cinquante parties était vraie
  // par construction, et elle serait restée verte le jour où `rank` aurait rendu le rang de
  // l'ÉQUIPE au lieu de celui du joueur. C'est le patron que ce dépôt condamne ailleurs — « un
  // modèle est d'accord avec lui-même par construction ». Le harnais dérive maintenant chaque
  // chiffre du FLUX D'ÉVÉNEMENTS et de l'état au moment de l'élimination, sans emprunter ni les
  // mêmes expressions ni les mêmes objets.
  assert.ok(PARTIES.length === 50, 'la volée de parties n\'a pas été jouée');
  for (const r of PARTIES){
    const ou = `${r.cleMode} · graine ${r.graine}`;
    const sim = C.reportFrom({ ...SIMU.faits(r.G), declaredNetCents: r.rapport.declaredNetCents });
    // La DURÉE se compare à une seconde près, et l'écart n'est ni une tolérance de confort ni un
    // désaccord : `G.time` s'accumule par additions de 1/60 et dérive sous le multiple exact, si
    // bien que 94,5 s comptées en pas et 94,49999999 s accumulées ne s'arrondissent pas du même
    // côté. Le défaut que ce contrôle existe pour voir — le `||` qui rend la durée de TOUTE la
    // partie quand `survivedT` vaut zéro — se compte en dizaines de secondes, pas en une.
    assert.ok(Math.abs(sim.seconds - r.rapport.seconds) <= 1,
      `${ou} : durée ${sim.seconds} s pour SIM, ${r.rapport.seconds} s comptées en pas vivants`);
    assert.deepStrictEqual({ ...sim, seconds: 0 }, { ...r.rapport, seconds: 0 },
      `${ou} : SIM et le harnais ne comptent pas pareil`);
    // Les DÉGÂTS ne se dérivent pas du flux : la simulation les plafonne à ce qu'il restait de vie
    // à la cible, et l'événement `degat` ne porte pas ce reste. On compare donc ce qui est
    // comparable, et on l'écrit plutôt que de faire passer une récitation pour un contrôle.
    assert.ok(sim.damage <= r.degatsBruts,
      `${ou} : ${sim.damage} de dégâts comptés pour ${r.degatsBruts} bruts vus passer`);
  }
  // Et il s'est passé assez de choses pour que la comparaison morde : sans ces bornes, cinquante
  // parties où le joueur ne tue personne et ne meurt jamais la rendraient vraie de tous les côtés.
  assert.ok(PARTIES.reduce((n, r) => n + r.rapport.kills, 0) > 20, 'le joueur n\'a jamais tué personne');
  assert.ok(PARTIES.reduce((n, r) => n + r.rapport.deaths, 0) > 20, 'le joueur n\'est jamais mort');
  // LE RANG EST LE POINT QUI COMPTE : c'est celui que la 02a a dû élargir après coup, et le seul
  // que deux chemins distincts peuvent départager. Il faut donc des rangs INTERMÉDIAIRES, ni 1 ni
  // le nombre de sièges — sinon les deux côtés tomberaient d'accord sur un cas dégénéré.
  const intermediaires = PARTIES.filter(r => r.rapport.rank > 1 && r.rapport.rank < C.seatsOf(r.mode)).length;
  assert.ok(intermediaires >= 20, `seulement ${intermediaires} parties finissent sur un rang intermédiaire`);
  // Et le plafonnement des dégâts mord vraiment : c'est ce qui prouve que la somme brute du flux
  // n'est PAS la même quantité, donc que l'exception écrite plus haut en est bien une.
  const plafonnes = PARTIES.filter(r => SIMU.faits(r.G).damage < r.degatsBruts).length;
  assert.ok(plafonnes > 5, `le plafond des dégâts n'a mordu que sur ${plafonnes} parties`);
});
test('L\'ARGENT EN JEU A UN SEUL COMPTEUR, et le serveur l\'assertera avec celui-là', () => {
  // Le harnais fait sa propre somme à chaque pas — c'est la seconde opinion, et elle reste. Celle
  // de SIM est celle que le serveur assertera au moment du règlement, sur la partie qu'il vient de
  // rejouer : les deux doivent tomber sur le même nombre, sinon l'assertion du serveur ne
  // protégerait rien.
  assert.ok(PARTIES.length === 50, 'la volée de parties n\'a pas été jouée');
  for (const r of PARTIES)
    assert.strictEqual(SIMU.argentCents(r.G), r.miseCents * C.seatsOf(r.mode),
      `${r.cleMode} · graine ${r.graine} : l'argent en jeu à la fin ne vaut pas mise × sièges`);
});
test('L\'EMPREINTE VOYAGE EN CONDENSÉS, et la suite dit OÙ deux rejeux s\'écartent', () => {
  // Un seul nombre final répondrait « d'accord » ou « pas d'accord » ; il ne dirait jamais À PARTIR
  // DE QUAND. Or la divergence se MESURE — elle ne se punit pas — et une liste d'exclusion dont
  // personne ne connaît le rendement serait pire que pas de mesure du tout.
  const un = jouer(9091, 'solo', 100, 'hex');
  const suite = un.G.empreintes;
  assert.ok(Array.isArray(suite) && suite.length > 10, `${suite && suite.length} condensés`);
  // Un condensé tous les EMPREINTE_PAS pas, et pas un de plus.
  assert.strictEqual(suite.length, Math.floor(un.G.pas / SIMU.EMPREINTE_PAS));
  for (const v of suite) assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff, String(v));
  // L'aller-retour est exact, zéros de tête compris : c'est une pièce de comparaison, pas un
  // affichage — une valeur qui change en chemin ferait diverger un joueur parfaitement honnête.
  const texte = C.digestsEncode(suite);
  assert.strictEqual(texte.length, suite.length * C.DIGESTS_MOT);
  assert.deepStrictEqual(C.digestsDecode(texte), suite);
  assert.deepStrictEqual(C.digestsDecode(C.digestsEncode([0, 1, 0xffffffff, 0x80000000])),
    [0, 1, 0xffffffff, 0x80000000]);
  // Elle ne LANCE jamais : une suite illisible est une divergence de plus à mesurer, pas un 500 sur
  // la route qui décide d'un montant.
  for (const faux of ['', 'abc', texte + 'x', 'A'.repeat(5), '!!!!!!', 42, null, undefined, []])
    assert.strictEqual(C.digestsDecode(faux), null, JSON.stringify(faux));
  // Et le rang de la divergence est le PREMIER où les deux suites s'écartent.
  assert.strictEqual(C.digestsDiff(suite, suite), -1);
  const autre = suite.slice(); autre[4] = (autre[4] ^ 1) >>> 0;
  assert.strictEqual(C.digestsDiff(suite, autre), 4);
  // Une suite plus courte s'écarte à SA fin : une partie tronquée n'est pas la même partie qu'une
  // partie menée jusqu'au bout.
  assert.strictEqual(C.digestsDiff(suite, suite.slice(0, 7)), 7);
  assert.strictEqual(C.digestsDiff(suite.slice(0, 7), suite), 7);
});
test('la suite des condensés d\'une partie entière tient sous MAX_BODY, dans les cinq modes', () => {
  // Elle part avec le rapport, sur la route qui décide d'un montant — celle dont la borne de corps
  // ne bouge pas d'un octet. Si une partie complète ne tenait pas dedans, le joueur le plus
  // endurant serait le seul à ne jamais pouvoir prouver sa convergence.
  const MAX_BODY = 4 * 1024;
  for (const cle of Object.keys(C.MODES)){
    let pire = 0;
    for (const g of [1, 7, 4101, 90210, 4294967295])
      pire = Math.max(pire, C.traceMaxSteps(C.zonePlan(g, C.MODES[cle])));
    const caracteres = Math.ceil(pire / SIMU.EMPREINTE_PAS) * C.DIGESTS_MOT;
    assert.ok(caracteres <= C.DIGESTS_MAX, `${cle} : ${caracteres} caractères pour ${C.DIGESTS_MAX} permis`);
    // Le rapport entier, condensés compris, doit tenir dans le corps que la route accepte.
    const rapport = C.reportFrom({ seconds: 999, kills: 99, deaths: 9, rank: 99, cubes: 9,
                                   damage: 999999, cashedOut: true, purseCents: 999999,
                                   declaredNetCents: 999999, digests: 'A'.repeat(caracteres) });
    assert.ok(JSON.stringify(rapport).length < MAX_BODY,
      `${cle} : un rapport complet pèse ${JSON.stringify(rapport).length} octets pour ${MAX_BODY}`);
  }
});
test('checkReport lit les condensés comme une chaîne bornée, et une chaîne vide est valide', () => {
  const bon = C.reportFrom({ seconds: 90, kills: 2, deaths: 0, rank: 1, cubes: 3, damage: 900,
                             cashedOut: true, purseCents: 300, declaredNetCents: 240 });
  assert.strictEqual(bon.digests, '', 'un rapport sans condensés en porte une chaîne vide');
  assert.deepStrictEqual(C.checkReport(bon).erreurs, [], 'une chaîne vide doit passer');
  // Elle n'est pas un fait : son contenu n'est jamais validé, seule sa longueur l'est. Un client
  // qui envoie n'importe quoi ne triche pas, il ne prouve simplement aucune convergence.
  assert.deepStrictEqual(C.checkReport({ ...bon, digests: 'nimportequoi' }).erreurs, []);
  for (const [v, code] of [[42, 'type'], [null, 'manquant'], [{}, 'type'],
                           ['A'.repeat(C.DIGESTS_MAX + 1), 'borne']]){
    const { rapport, erreurs } = C.checkReport({ ...bon, digests: v });
    assert.strictEqual(rapport, null, JSON.stringify(v));
    assert.ok(erreurs.some(e => e.field === 'digests' && e.code === code),
      `${JSON.stringify(v)} : ${JSON.stringify(erreurs)}`);
  }
  // Et `reportFrom` coupe sur un multiple de la taille d'un condensé : une suite tranchée en plein
  // mot serait illisible, donc indistinguable d'une suite absente.
  const trop = C.reportFrom({ digests: 'A'.repeat(C.DIGESTS_MAX + 99) });
  assert.strictEqual(trop.digests.length % C.DIGESTS_MOT, 0);
  assert.ok(trop.digests.length <= C.DIGESTS_MAX);
});

test('REPRODUCTIBILITÉ : même graine et même trace, même état final et même empreinte — deux fois', () => {
  const un = jouer(9091, 'solo', 100, 'hex');
  const deux = jouer(9091, 'solo', 100, 'hex', un.trace);
  assert.strictEqual(deux.pas, un.pas, 'la partie rejouée ne dure pas le même nombre de pas');
  assert.deepStrictEqual(deux.etat, un.etat, 'l\'état final diffère');
  assert.strictEqual(deux.empreinte, un.empreinte, 'l\'empreinte diffère');
  assert.deepStrictEqual(deux.rapport, un.rapport, 'le rapport de fin diffère');
  // Une autre graine ne rend pas la même empreinte : sinon l'égalité ci-dessus ne prouverait rien.
  assert.notStrictEqual(jouer(9092, 'solo', 100, 'hex').empreinte, un.empreinte);
  // L'empreinte est un ENTIER 32 bits non signé, et pas un flottant déguisé.
  assert.ok(Number.isInteger(un.empreinte) && un.empreinte >= 0 && un.empreinte <= 0xffffffff,
    `l'empreinte vaut ${un.empreinte}`);
  // Elle est prise à intervalle FIXE de pas, et le bloc le dit lui-même.
  assert.strictEqual(SIMU.EMPREINTE_PAS, 60);
  assert.ok(Number.isInteger(SIMU.SIM_VERSION) && SIMU.SIM_VERSION >= 1, 'SIM_VERSION doit être un entier');
});

test('REPRODUCTIBILITÉ : et dans un processus fils, qui ne partage rien avec celui-ci', () => {
  // Le patron déjà employé pour le plan de zone et pour les points de départ. Deux appels d'affilée
  // peuvent se ressembler par accident — un état accumulé dans le module passerait inaperçu ; un
  // processus neuf ne le peut pas. Le fils charge le MÊME harnais, en texte, et le même index.html.
  const ici = jouer(3141, 'duo', 50, 'shell');
  const dehors = require('child_process').execFileSync(process.execPath, ['-e', `
    const fs = require('fs');
    const html = fs.readFileSync(process.env.WB_FICHIER, 'utf8');
    const bloc = html.slice(html.indexOf('/*CORE-' + 'START*/'), html.indexOf('/*CORE-' + 'END*/'));
    const sim = html.slice(html.indexOf('/*SIM-' + 'START*/'), html.indexOf('/*SIM-' + 'END*/'));
    const m = { exports: {} }; new Function('module', 'exports', bloc)(m, m.exports);
    const C = m.exports;
    const s = { exports: {} }; new Function('module', 'exports', 'WBCore', sim)(s, s.exports, C);
    const H = new Function(process.env.WB_HARNAIS)();
    const r = H.jouerPartie(C, s.exports, 3141, 'duo', 50, 'shell');
    process.stdout.write(JSON.stringify({ pas: r.pas, empreinte: r.empreinte, etat: r.etat, rapport: r.rapport }));
  `], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        env: Object.assign({}, process.env, { WB_FICHIER: path.join(__dirname, GAME), WB_HARNAIS: HARNAIS }) });
  const recu = JSON.parse(dehors);
  assert.strictEqual(recu.pas, ici.pas, 'un processus neuf ne joue pas le même nombre de pas');
  assert.strictEqual(recu.empreinte, ici.empreinte, 'un processus neuf ne rend pas la même empreinte');
  assert.deepStrictEqual(recu.etat, JSON.parse(JSON.stringify(ici.etat)), 'un processus neuf ne finit pas dans le même état');
  assert.deepStrictEqual(recu.rapport, ici.rapport, 'un processus neuf ne rend pas le même rapport');
});

test('SENSIBILITÉ DE L\'EMPREINTE : changer UN SEUL pas de la trace la change', () => {
  // Sans ce test, une empreinte constante passerait tous les tests de reproductibilité ci-dessus et
  // ne prouverait rien du tout. Ce qu'on change est le MOUVEMENT d'un pas : l'empreinte voit la
  // position ET la vitesse, donc un pas de commande inversé s'y inscrit tout de suite.
  const base = jouer(5150, 'solo', 50, 'bolt');
  let vus = 0;
  // Les pas se comptent APRÈS le compte à rebours : pendant l'intro, `step` consomme le pas sans
  // rien faire avancer, donc y retourner une commande ne peut évidemment rien changer. Ce n'est pas
  // une tolérance, c'est la définition de l'intro — et l'écrire ici évite de croire un jour que
  // l'empreinte est aveugle alors que c'est le décompte qui court encore.
  for (const k of [90, 300, 900, 1800, 2700].map(n => n + PAS_INTRO)){
    const e = base.trace[k];
    // Un pas où le joueur ne demande rien — mort, ou déjà au centre du cercle — n'a rien à changer,
    // et l'exiger serait exiger de l'empreinte qu'elle voie ce que la simulation ne retient pas.
    if (!e || (!e.mx && !e.mz)) continue;
    const autre = base.trace.slice();
    autre[k] = Object.assign({}, e, { mx: -e.mx, mz: -e.mz });
    const r = jouer(5150, 'solo', 50, 'bolt', autre);
    assert.notStrictEqual(r.empreinte, base.empreinte,
      `un pas de commande inversé au pas ${k} laisse l'empreinte inchangée`);
    vus++;
  }
  assert.ok(vus >= 3, `seulement ${vus} pas de la trace demandaient un mouvement : le test ne prouve presque rien`);
  // Et l'empreinte n'est pas qu'une fonction du nombre de pas : deux parties de même longueur,
  // jouées différemment, se distinguent.
  const immobile = jouer(5150, 'solo', 50, 'bolt', base.trace.map(() => ({})));
  assert.notStrictEqual(immobile.empreinte, base.empreinte);
});

test('PLANCHER DE PERFORMANCE : une partie solo entière tient largement sous la seconde', () => {
  // POURQUOI CE PLANCHER EXISTE : sans lui, une régression d'un ordre de grandeur se découvre chez
  // le premier joueur, et côté serveur elle mangerait le budget de rejeu du module 7.
  //
  // N ET X, ET LEUR JUSTIFICATION. N est une partie solo complète : 9 240 pas de 1/60 s, vingt
  // brawlers, une vraie carte — soit exactement ce que le serveur aura à rejouer. X vaut 3 000 ms
  // pour une partie qui en prend environ 250 sur la machine de développement : le facteur douze est
  // là pour qu'une machine d'intégration continue lente, ou chargée, ne fasse pas rougir un test qui
  // n'a rien à dire sur elle. Ce qu'il attrape reste ce qu'il doit attraper : un facteur dix.
  const t0 = Date.now();
  const r = jouer(2718, 'solo', 50, 'bolt');
  const ms = Date.now() - t0;
  assert.ok(r.pas > 8000, `la partie mesurée ne fait que ${r.pas} pas : le plancher ne mesurerait rien`);
  assert.ok(ms < 3000, `${r.pas} pas de simulation en ${ms} ms, pour 3000 ms au plus`);
});

test('bac à sable : les bots et une partie entière tournent sans document, window, THREE, Math.random, Date.now ni performance', () => {
  // La même garde qu'aux modules 3 et 4, étendue à ce que ce module a descendu — et cette fois le
  // bloc ne joue pas une escarmouche, il joue une PARTIE, bots compris.
  const sansRandom = new Proxy(Math, { get: (t, p) => p === 'random' ? undefined : Reflect.get(t, p) });
  const sansNow = new Proxy(Date, { get: (t, p) => p === 'now' ? undefined : Reflect.get(t, p) });
  const bac = new Function('module', 'exports', 'WBCore', 'document', 'window', 'THREE', 'performance',
                           'localStorage', 'fetch', 'requestAnimationFrame', 'Math', 'Date', sim);
  const m = { exports: {} };
  bac(m, m.exports, C, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sansRandom, sansNow);
  const Z = m.exports;
  const r = H.jouerPartie(C, Z, 8181, 'trio', 500, 'volt');
  assert.notStrictEqual(r.issue, 'borne', 'la partie du bac à sable n\'a jamais fini');
  assert.strictEqual(r.argentKO, 0, 'l\'argent ne se conserve pas dans le bac à sable');
  assert.ok(r.G.ents.reduce((n, e) => n + e.kills, 0) > 5, 'personne ne s\'est battu dans le bac à sable');
  assert.ok(r.debloques > 0, 'le chien de garde des bots n\'a jamais tourné dans le bac à sable');
  // Et la même partie, jouée par le bloc chargé NORMALEMENT, rend la même empreinte : le bac à
  // sable n'a pas fait jouer un autre jeu.
  assert.strictEqual(r.empreinte, jouer(8181, 'trio', 500, 'volt').empreinte);
  // Toujours aucun pointeur de rendu sur un fait de partie, bots compris.
  for (const e of r.G.ents) for (const champ of ['mesh', 'lbl', 'lblMn'])
    assert.ok(!(champ in e), `une entité porte de nouveau « ${champ} »`);
});

test('les bots sont descendus dans SIM, et le contrat public du bloc est en place', () => {
  // `corpsDe` lance si une fonction est déclarée dans les deux blocs — le patron du `respawn()`
  // défini deux fois, dont la copie vivante finit toujours du côté que rien n'exécute.
  for (const nom of ['findCover', 'findTarget', 'pickGoal', 'botUpdate', 'joueurUpdate',
                     'commonUpdate', 'zoneUpdate', 'aliveTeams', 'playersLeft',
                     'newMatch', 'step', 'empreinte', 'condenseEtat'])
    assert.ok(sim.includes('\nfunction ' + nom + '(') || sim.includes('\nconst ' + nom + ' ') ||
              sim.includes('\nfunction ' + nom + '='), `${nom} n'est pas dans SIM`);
  for (const nom of ['findCover', 'findTarget', 'pickGoal', 'botUpdate', 'joueurUpdate',
                     'commonUpdate', 'zoneUpdate', 'newMatch', 'step'])
    assert.ok(!JEU.includes('\nfunction ' + nom + '('), `${nom} est restée dans le bloc Game`);
  // Le contrat public, celui sur lequel les modules 6 et 7 vont s'appuyer.
  for (const nom of ['newMatch', 'step', 'empreinte', 'drainer', 'condenseEtat'])
    assert.strictEqual(typeof SIMU[nom], 'function', `WBSim.${nom} n'est pas exposée`);
  assert.strictEqual(typeof SIMU.SIM_VERSION, 'number', 'SIM_VERSION doit être une constante du bloc');
  // `b.badGoals` est un Set, et il n'a le droit de servir qu'à l'appartenance : le parcourir ferait
  // dépendre une décision de l'ordre d'insertion d'un ensemble. Même garde que `p.hit`.
  const s = sansCommentaires(sim);
  for (const m of s.match(/\.badGoals\.\w+/g) || [])
    assert.ok(/\.(has|add)$/.test(m), `${m} : un Set ne doit servir qu'à \`has\` et \`add\``);
  assert.strictEqual(compte(s, /of\s+\w+\.badGoals/g), 0, 'badGoals est parcouru pour décider d\'un ordre');
  // La liste des noms de bots vit dans SIM, parce que `newMatch` en a besoin sans navigateur.
  assert.ok(Array.isArray(SIMU.BOT_NAMES) && SIMU.BOT_NAMES.length >= 20);
  assert.ok(!JEU.includes("const BOT_NAMES=["), 'une seconde liste de noms de bots vit dans le bloc Game');
  // Et `newMatch` ne prend ses angles que de la graine : aucune transcendante, comme les cinq
  // fonctions de géométrie du module 2. Elle leur avait échappé parce qu'elle vivait dans
  // `startMatch` — c'est `C.dist` et non plus `Math.hypot` qui place les caisses.
  for (const interdite of TRANSCENDANTES)
    assert.ok(!sansCommentaires(corpsDe('newMatch')).includes(interdite),
      `newMatch appelle ${interdite} : la position des caisses ne vient pourtant que de la graine`);
});

test('les quatorze noms d\'événements restent fermés, et le rendu les traduit tous', () => {
  // Deux nouveaux noms au module 5, et ils sont nés du gaz et du soin hors combat : `zone` pour les
  // trois transitions du plan — il avance, il se pose, il prévient — et `soin` pour le cumul de
  // régénération, qui posait un nombre à l'écran depuis le milieu d'une règle.
  const connus = new Set(['tir', 'degat', 'mort', 'ramassage', 'nuage', 'explosion', 'super',
                          'gadget', 'detruit', 'encaissement', 'reapparition', 'fin', 'zone', 'soin']);
  const vus = new Map();
  const G = SIMU.newMatch(6060, C.MODES.solo, 50, C.BRAWLERS.medic);
  for (let n = 0; n < 6000; n++)
    for (const ev of SIMU.step(G, H.pilote(C, SIMU, G))){
      assert.ok(connus.has(ev.type), `événement inconnu : ${ev.type}`);
      assert.strictEqual(ev.pas, G.pas, `un événement ${ev.type} horodaté ${ev.pas} au pas ${G.pas}`);
      vus.set(ev.type, (vus.get(ev.type) || 0) + 1);
    }
  for (const nom of ['tir', 'degat', 'mort', 'ramassage', 'zone'])
    assert.ok(vus.get(nom) > 0, `aucun événement « ${nom} » en 6000 pas d'une vraie partie`);
  const lecteur = sansCommentaires(corpsDe('rendreEvenements'));
  for (const nom of connus) assert.ok(lecteur.includes(`case '${nom}'`), `le rendu ne lit pas « ${nom} »`);
  // Les trois états de `zone` sont produits ET lus : un état émis que personne ne traduit serait
  // une alarme de gaz qui ne sonne jamais.
  for (const etat of ['avance', 'pose', 'alerte'])
    assert.ok(lecteur.includes(`'${etat}'`), `le rendu ne traduit pas la transition de gaz « ${etat} »`);
});

test('BRAWLER_IDS est le roster, et il n\'en existe qu\'une seule copie', () => {
  // SIM a besoin de l'ordre du roster pour tirer le brawler d'un bot, et il lui est interdit
  // d'appeler `Object.keys` : l'ordre des clés d'un objet ne doit jamais décider d'un fait de
  // partie. La liste est donc dérivée UNE fois dans WBCore, jamais recopiée à la main — un brawler
  // ajouté demain manquerait dans l'une des deux copies, et personne ne le verrait.
  assert.deepStrictEqual(C.BRAWLER_IDS, Object.keys(C.BRAWLERS));
  for (const id of C.BRAWLER_IDS) assert.strictEqual(C.BRAWLERS[id].id, id);
  assert.ok(!sansCommentaires(sim).includes('Object.keys'), 'SIM parcourt les clés d\'un objet');
});

test('LE COMPTE À REBOURS D\'INTRO EST UNE RÈGLE DE SIMULATION, posée par newMatch et par personne d\'autre', () => {
  // LE DÉFAUT QUE CE TEST EXISTE POUR INTERDIRE. Le décompte ne vivait que dans le bloc `Game` :
  // `startMatch` posait `G.intro = 3.999` APRÈS `newMatch`, qui initialisait `intro: 0`. La trace,
  // elle, enregistre ces pas — le commentaire de `TRACE.INTRO_S` le dit depuis le module 6. Le
  // serveur repartait donc d'un décompte à zéro et rejouait en pas RÉELS les deux cent quarante pas
  // que le navigateur avait passés à décompter : il jugeait une autre partie que celle qui s'était
  // affichée, sur TOUTE partie réellement jouée dans un navigateur. Aucun test ne le voyait, parce
  // qu'aucun ne posait `G.intro` — il vivait hors du bloc SIM.
  for (const cle of Object.keys(C.MODES)){
    const G = SIMU.newMatch(4242, C.MODES[cle], 50, C.BRAWLERS.bolt);
    assert.ok(G.intro > 0, `${cle} : newMatch ne pose plus le décompte, le rejeu du serveur dérive`);
  }
  // Il consomme des pas SANS faire avancer la partie : c'est sa définition, et c'est ce que la
  // marge de `traceMaxSteps` réserve déjà.
  assert.ok(PAS_INTRO > 0);
  assert.ok(PAS_INTRO <= Math.ceil(C.TRACE.INTRO_S / C.SIM.stepS),
    `le décompte consomme ${PAS_INTRO} pas, au-delà de la marge que TRACE.INTRO_S réserve`);
  const G = SIMU.newMatch(4242, C.MODES.solo, 50, C.BRAWLERS.bolt);
  for (let i = 0; i < PAS_INTRO; i++) SIMU.step(G, {});
  assert.strictEqual(G.pas, 0, 'un pas de décompte a fait avancer la partie');
  SIMU.step(G, {});
  assert.strictEqual(G.pas, 1, 'le coup d\'envoi n\'a pas été donné à la fin du décompte');
  // Et le bloc `Game` ne le pose plus : il ne fait plus que le LIRE pour la bannière et le remettre
  // à zéro à la fin. Une seconde écriture ferait deux endroits qui doivent s'accorder — la faute
  // d'origine, exactement.
  assert.ok(!sansCommentaires(corpsDe('startMatch')).includes('G.intro='),
    'startMatch repose le décompte : il y aurait de nouveau deux endroits qui doivent s\'accorder');
});

test('QUITTER PENDANT LA RÉAPPARITION FINIT LA PARTIE : sans cela le rejeu n\'atteint jamais un terminal', () => {
  // LE DÉFAUT. Le bouton QUITTER pressé alors que le joueur est mort mais a encore des vies
  // appelait `endMatch` directement : aucun jeton dans la trace, aucun événement `fin`, et
  // `WBSim.kill` sortait de toute façon sur `!victim.alive`. Le serveur rejouait donc une partie
  // qui ne finit jamais, refusait en 409 `non_terminal`, n'écrivait aucun montant, et laissait le
  // billet au veilleur — pour un joueur parfaitement honnête.
  const mode = C.MODES.solo;
  const mort = SIMU.newMatch(7411, mode, 50, C.BRAWLERS.bolt);
  for (let i = 0; i < PAS_INTRO + 400; i++) SIMU.step(mort, {});
  SIMU.kill(mort, mort.player, null, 'gas');
  assert.strictEqual(mort.player.alive, false);
  assert.ok(mort.player.lives > 0, 'le joueur du test doit avoir encore des vies : c\'est tout le cas');
  assert.strictEqual(SIMU.terminal(mort), null, 'la partie ne doit pas déjà être finie');
  // Le jeton d'abandon, rejoué exactement comme le serveur le rejoue.
  assert.strictEqual(SIMU.appliquerActe(mort, { code: C.TRACE.QUIT, ax: 1, az: 0, dist: 0 }), true,
    'un abandon rejoué sur un joueur en réapparition ne fait rien');
  assert.ok(SIMU.terminal(mort), 'la partie abandonnée n\'atteint pas d\'état terminal');
  assert.strictEqual(SIMU.faits(mort).deaths, C.livesFor(mode), 'un abandon solde toutes les vies');
  assert.strictEqual(mort.player.respawnT, 0, 'le joueur attend encore de revenir');
  assert.ok(mort.fin && mort.fin.killer === 'Abandon');
  assert.ok(mort.fin.rang >= 1 && mort.fin.rang <= C.seatsOf(mode) + 1);
  // Debout, l'abandon passe toujours par `kill` : c'est le même geste, et il rend le même terminal.
  const debout = SIMU.newMatch(7411, mode, 50, C.BRAWLERS.bolt);
  for (let i = 0; i < PAS_INTRO + 400; i++) SIMU.step(debout, {});
  assert.strictEqual(SIMU.abandon(debout), true);
  assert.strictEqual(debout.player.alive, false);
  assert.ok(SIMU.terminal(debout));
  assert.strictEqual(SIMU.faits(debout).deaths, C.livesFor(mode));
  // Et il n'y a rien à abandonner deux fois : la seconde pression ne réécrit pas la fin.
  const avant = debout.fin;
  assert.strictEqual(SIMU.abandon(debout), false, 'un joueur déjà éliminé peut abandonner une seconde fois');
  assert.strictEqual(debout.fin, avant, 'la fin a été réécrite par un second abandon');
});

console.log('La trace des entrées du joueur');
// CE QUE CETTE SECTION PROUVE. La trace est le seul chaînon que le serveur n'a pas : il refait la
// carte, le gaz, les caisses et les vingt bots depuis la graine publique, il ne sait pas ce que le
// JOUEUR a fait. Ce qui doit donc tenir, et rien de moins : ce qui est enregistré, quantifié,
// compressé puis décompressé rejoue à l'IDENTIQUE — même état final, même empreinte, sans
// tolérance. Une trace « presque » fidèle serait pire qu'aucune trace : elle paierait un montant
// que personne n'a joué.
//
// CE QU'ELLE NE PROUVE PAS : rien de tout ceci n'est encore branché sur un montant. Aucune décision
// d'argent n'a changé dans ce module, et c'est voulu — le risque reste dans le module suivant.

// Une partie jouée avec le pilote du harnais, MAIS quantifiée comme le jeu la quantifie : c'est
// `lireEntrees` qui rend désormais la valeur quantifiée, et c'est cette valeur-là que le jeu joue.
// Le super, lui, part d'un ÉVÉNEMENT d'entrée, entre deux pas, exactement comme la barre d'espace.
function jouerEtTracer(graine, cleMode, miseCents, cleBrawler, pasMax) {
  const mode = C.MODES[cleMode];
  const G = SIMU.newMatch(graine, mode, miseCents, C.BRAWLERS[cleBrawler]);
  const rec = C.traceEnregistreur(C.traceMaxSteps(G.zonePlan));
  let actes = 0;
  for (let i = 0; i < pasMax; i++) {
    const brut = H.pilote(C, SIMU, G);
    const e = C.traceQuant(brut);
    if (brut.sup && G.player.alive) {
      // Le geste ponctuel : la visée est quantifiée AVANT d'être jouée, et c'est elle qui part dans
      // la trace. Sans cela le rejeu tirerait dans une direction voisine, et tout ce qui suit
      // divergerait.
      const mots = C.traceViseeMots(G.player.ax, G.player.az, e.aimDist);
      const v = C.traceVisee(mots);
      rec.acte(C.TRACE.SUP, mots);
      G.player.ax = v.ax; G.player.az = v.az;
      SIMU.useSuper(G, G.player, v.dist);
      actes++;
    }
    rec.ajouter(e);
    SIMU.step(G, e);
  }
  return { G, rec, actes, texte: rec.texte() };
}
// Le rejeu : une partie NEUVE, la même graine, et rien d'autre que la trace relue.
function rejouerTrace(graine, cleMode, miseCents, cleBrawler, texte) {
  const G = SIMU.newMatch(graine, C.MODES[cleMode], miseCents, C.BRAWLERS[cleBrawler]);
  const lu = C.traceDecode(texte);
  assert.strictEqual(lu.erreur, null, 'la trace ne se relit pas : ' + lu.erreur);
  return { G, pas: SIMU.rejouer(G, lu.items), lu };
}
const etatDe = G => G.ents.map(e => [e.eid, e.alive, e.cashedOut, e.hp, e.x, e.z, e.vx, e.vz,
                                     e.ax, e.az, e.pouch, e.cubes, e.kills, e.lives, e.ammo]);

test('ALLER-RETOUR SANS PERTE : enregistrée, quantifiée, compressée, décompressée, la trace rejoue à l\'identique', () => {
  let actes = 0;
  for (const [graine, mode, mise, brawler] of
       [[7301, 'solo', 50, 'bolt'], [7302, 'duo', 100, 'hex'], [7303, 'resurgence', 500, 'medic']]) {
    const joue = jouerEtTracer(graine, mode, mise, brawler, 2400);
    const rejoue = rejouerTrace(graine, mode, mise, brawler, joue.texte);
    const ou = `${mode} · graine ${graine}`;
    assert.strictEqual(rejoue.pas, 2400, `${ou} : le rejeu n'a pas joué le même nombre de pas`);
    assert.strictEqual(rejoue.G.pas, joue.G.pas, `${ou} : le compteur de pas diverge`);
    // Comparé EXACTEMENT, sans tolérance : les deux exécutions tournent sur le même moteur et sur
    // le même code, donc le moindre écart est un défaut du transport, pas une histoire d'ulp.
    assert.deepStrictEqual(etatDe(rejoue.G), etatDe(joue.G), `${ou} : l'état final diverge`);
    assert.strictEqual(SIMU.empreinte(rejoue.G), SIMU.empreinte(joue.G), `${ou} : l'empreinte diverge`);
    // Et il s'est passé quelque chose : sans ces bornes, tout ce qui précède passerait sur une
    // trace où personne n'appuie sur rien.
    assert.ok(joue.G.dmgDealt > 0, `${ou} : le joueur n'a rien touché`);
    actes += joue.actes;
    if (joue.actes) assert.ok(joue.texte.includes('!'), `${ou} : l'action ponctuelle n'est pas dans le texte`);
  }
  assert.ok(actes > 0, 'aucune action ponctuelle dans les trois traces : le jeton d\'acte n\'est pas éprouvé');
});

test('UNE PARTIE AVEC SON DÉCOMPTE SE REJOUE À L\'IDENTIQUE, empreinte et condensés compris', () => {
  // L'aller-retour de la trace, mais parti d'une partie où le décompte a bien eu lieu — c'est
  // précisément la partie que le navigateur produit, et la seule que les tests ne jouaient jamais.
  // Sans lui, le rejeu du serveur consommait les pas d'intro comme de vrais pas et `digest_match`
  // était faux sur toutes les parties en ligne.
  for (const [graine, mode, mise, brawler] of
       [[7401, 'solo', 50, 'bolt'], [7402, 'resurgence', 100, 'medic']]){
    const joue = jouerEtTracer(graine, mode, mise, brawler, PAS_INTRO + 1200);
    const ou = `${mode} · graine ${graine}`;
    // La trace porte bien les pas du décompte : c'est ce qui rend le rejeu exact des deux côtés.
    assert.strictEqual(joue.rec.pas(), PAS_INTRO + 1200, `${ou} : la trace ne porte pas les pas d'intro`);
    assert.strictEqual(joue.G.pas, 1200, `${ou} : le décompte a fait avancer la partie`);
    const rejoue = rejouerTrace(graine, mode, mise, brawler, joue.texte);
    assert.strictEqual(rejoue.G.pas, joue.G.pas, `${ou} : le rejeu ne joue pas le même nombre de pas`);
    assert.deepStrictEqual(etatDe(rejoue.G), etatDe(joue.G), `${ou} : l'état final diverge`);
    assert.strictEqual(SIMU.empreinte(rejoue.G), SIMU.empreinte(joue.G), `${ou} : l'empreinte diverge`);
    // Et les condensés se suivent d'un bout à l'autre : c'est le nombre que le serveur écrira dans
    // `digest_match`, et `-1` est la seule valeur qui vaille « d'accord partout ».
    assert.strictEqual(C.digestsDiff(rejoue.G.empreintes, joue.G.empreintes), -1,
      `${ou} : les condensés se séparent`);
    assert.ok(joue.G.empreintes.length > 3, `${ou} : trop peu de condensés pour que la comparaison morde`);
  }
});

test('LA TRACE EST LE SEUL CHAÎNON MANQUANT : la même graine sans elle ne rejoue pas la même partie', () => {
  // Sans cette contre-épreuve, l'aller-retour ci-dessus passerait aussi bien sur une trace vide :
  // la graine seule refait déjà la carte, le gaz, les caisses et les vingt bots.
  const joue = jouerEtTracer(7304, 'solo', 50, 'volt', 900);
  const muet = SIMU.newMatch(7304, C.MODES.solo, 50, C.BRAWLERS.volt);
  for (let i = 0; i < 900; i++) SIMU.step(muet, {});
  assert.notStrictEqual(SIMU.empreinte(muet), SIMU.empreinte(joue.G),
    'un joueur immobile rend la même partie qu\'un joueur qui joue : la trace ne sert à rien');
});

test('changer UN SEUL pas de la trace change ce qu\'elle rejoue', () => {
  const joue = jouerEtTracer(7305, 'solo', 50, 'bolt', 600);
  const base = rejouerTrace(7305, 'solo', 50, 'bolt', joue.texte);
  // On coupe la première plage en deux et on retourne le déplacement d'un seul pas au milieu.
  const lu = C.traceDecode(joue.texte);
  // On saute les plages consommées par le compte à rebours : un pas joué pendant l'intro ne fait
  // rien avancer, donc le retourner ne prouverait rien de la trace.
  let avant = 0;
  const i = lu.items.findIndex(it => {
    if (it.t !== 'p') return false;
    const debut = avant; avant += it.n | 0;
    return debut >= PAS_INTRO && (it.mx || it.mz);
  });
  assert.ok(i >= 0, 'aucun pas de la trace ne demandait un mouvement : le test ne prouve rien');
  const items = lu.items.slice();
  const tordu = Object.assign({}, items[i], { mx: -items[i].mx, mz: -items[i].mz, n: 1 });
  const reste = Object.assign({}, items[i], { n: items[i].n - 1 });
  items.splice(i, 1, tordu, ...(reste.n > 0 ? [reste] : []));
  const G = SIMU.newMatch(7305, C.MODES.solo, 50, C.BRAWLERS.bolt);
  SIMU.rejouer(G, items);
  assert.strictEqual(G.pas, base.G.pas, 'le nombre de pas doit être le même : c\'est le geste qui change');
  assert.notStrictEqual(SIMU.empreinte(G), SIMU.empreinte(base.G),
    'un pas retourné ne change rien : la trace ne porte pas ce qu\'elle prétend porter');
});

test('la quantification est IDEMPOTENTE : ce que le jeu joue est exactement ce que la trace porte', () => {
  // C'est la propriété qui rend le rejeu exact plutôt qu'approximatif. `lireEntrees` rend la valeur
  // quantifiée, le jeu la joue, la trace la porte : requantifier ne doit donc plus rien déplacer,
  // sinon le rejeu et la partie s'écarteraient d'un cran à chaque pas.
  const rng = C.makeRng(2718);
  for (let n = 0; n < 4000; n++) {
    const a = rng() * Math.PI * 2;
    const brut = { mx: rng() * 2 - 1, mz: rng() * 2 - 1, ax: Math.cos(a), az: Math.sin(a),
                   aimDist: rng() * 40, feu: rng() < 0.5 };
    const un = C.traceQuant(brut), deux = C.traceQuant(un);
    assert.strictEqual(deux.hi, un.hi, 'la visée se déplace en se requantifiant');
    assert.strictEqual(deux.lo, un.lo, 'le déplacement se déplace en se requantifiant');
    // Et la visée reste EXACTEMENT unitaire : elle sort de la table `C.UNIT`, pas d'un cosinus.
    assert.ok(C.UNIT.includes(C.UNIT[un.hi & 1023]));
    assert.strictEqual(un.ax, C.UNIT[un.hi & 1023].x);
    assert.strictEqual(un.az, C.UNIT[un.hi & 1023].z);
    // La portée est bornée, jamais NaN, jamais négative.
    assert.ok(un.aimDist >= 0 && un.aimDist <= C.TRACE.DIST_MAX / C.TRACE.DIST_PAS);
  }
  // Et rien de tordu ne la fait sortir de ses bornes.
  for (const fou of [{}, { mx: NaN, mz: Infinity, ax: NaN, az: NaN, aimDist: -5 },
                     { mx: 1e9, mz: -1e9, ax: 0, az: 0, aimDist: 1e9 }]) {
    const q = C.traceQuant(fou);
    for (const k of ['mx', 'mz', 'ax', 'az', 'aimDist'])
      assert.ok(Number.isFinite(q[k]), `${k} n'est pas un nombre fini`);
    assert.ok(q.mx >= -1 && q.mx <= 1 && q.mz >= -1 && q.mz <= 1);
  }
});

test('L\'ENREGISTREMENT NE COÛTE JAMAIS UNE IMAGE : un pas identique n\'alloue rien', () => {
  // La propriété qui compte pour la boucle d'image : un pas identique au précédent n'ajoute AUCUNE
  // plage, il incrémente un compteur. Le texte, lui, ne se fabrique qu'à la fin de la partie.
  const rec = C.traceEnregistreur(100000);
  const immobile = C.traceMots({ mx: 0, mz: 0, ax: 1, az: 0, aimDist: 5, feu: false });
  for (let i = 0; i < 50000; i++) rec.ajouter(immobile);
  assert.strictEqual(rec.pas(), 50000);
  assert.ok(rec.plages() <= 1 + Math.ceil(50000 / 262144), `50 000 pas identiques ont produit ${rec.plages()} plages`);
  // Et le pire cas reste BORNÉ : une plage par pas, jamais davantage.
  const avant = rec.plages();
  for (let i = 0; i < 1000; i++)
    rec.ajouter(C.traceMots({ mx: (i % 31) / 15 - 1, mz: 0, ax: 1, az: 0, aimDist: 5, feu: !!(i % 2) }));
  assert.ok(rec.plages() - avant <= 1000, 'une plage par pas au pire, jamais plus');
  // La borne dure est tenue, et elle se dit : au-delà, on cesse d'enregistrer plutôt que de gonfler.
  const court = C.traceEnregistreur(10);
  for (let i = 0; i < 100; i++) court.ajouter(immobile);
  assert.strictEqual(court.pas(), 10);
  assert.strictEqual(court.tronquee(), true);
});

test('la trace se coupe en UN À TROIS segments, jamais vingt, et toujours sur un jeton', () => {
  // Le compromis est écrit dans docs/PHASE-02B.md : on ne paie pas une sémantique d'ordre et de
  // reprise pour une robustesse que la 02a possède déjà. Ce test le tient au chiffre.
  const pire = C.traceEnregistreur(200000);
  // Le pire cas réaliste : une visée qui bouge à chaque pas, donc aucune plage ne se compresse.
  for (let i = 0; i < 9240; i++)
    pire.ajouter(C.traceMots({ mx: 1, mz: 0, ax: Math.cos(i / 97), az: Math.sin(i / 97), aimDist: 6, feu: true }));
  const segs = pire.segments();
  assert.ok(segs.length >= 1 && segs.length <= 3, `${segs.length} segments pour une partie complète`);
  for (const s of segs) assert.ok(s.length <= C.TRACE.SEG, 'un segment dépasse sa taille');
  assert.ok(segs.length <= C.TRACE.MAX_SEG);
  // Recollés, ils rendent exactement le texte, et chaque segment est relisible SEUL : la coupe se
  // fait au jeton, jamais au caractère.
  assert.strictEqual(segs.join(''), pire.texte());
  let pas = 0;
  for (const s of segs) { const lu = C.traceDecode(s); assert.strictEqual(lu.erreur, null); pas += lu.pas; }
  assert.strictEqual(pas, 9240);
});

test('UN SEGMENT PEUT NE PORTER QUE DES ACTES : la coupe tombe au jeton, pas au pas', () => {
  // LE CAS DE FRONTIÈRE, ET CE QU'IL COÛTAIT. Le découpage coupe au JETON, et un jeton d'action
  // ponctuelle ne compte AUCUN pas. Quand la frontière des 24 000 caractères tombe juste avant le
  // dernier geste, le segment de queue ne porte que l'abandon ou l'encaissement — et la route de
  // trace le refusait en 400 sur `!lu.pas`. L'envoi s'arrêtant au premier refus, l'acte terminal
  // n'arrivait jamais : le rejeu s'arrêtait avant la fin, sortait en `non_terminal`, et la partie
  // d'un joueur honnête n'était jamais réglée.
  const rec = C.traceEnregistreur(100000);
  const parPas = Math.floor(C.TRACE.SEG / 5);
  // Des pas tous DISTINCTS : aucune plage ne se compresse, donc cinq caractères chacun, et la
  // frontière tombe exactement au dernier.
  for (let i = 0; i < parPas; i++)
    rec.ajouter(C.traceMots({ mx: 1, mz: 0, ax: C.UNIT[i % 1024].x, az: C.UNIT[i % 1024].z,
                              aimDist: 4, feu: true }));
  rec.acte(C.TRACE.QUIT, 0);
  const segs = rec.segments();
  assert.strictEqual(segs.length, 2, `${segs.length} segments : la frontière n'est pas au bon endroit`);
  assert.strictEqual(segs[0].length, C.TRACE.SEG, 'le premier segment ne remplit pas exactement la borne');
  assert.ok(segs[1].startsWith('!'), 'le second segment ne porte pas un jeton d\'acte');
  assert.strictEqual(segs[1].length, 5, 'le segment de queue ne porte pas exactement un jeton');
  // Chaque segment est relisible SEUL, et le second ne porte aucun pas : c'est légitime, pas une
  // trace vide. Le distinguer d'un segment SANS CONTENU est tout ce que la route a à faire.
  const un = C.traceDecode(segs[0]), deux = C.traceDecode(segs[1]);
  assert.strictEqual(un.erreur, null);
  assert.strictEqual(deux.erreur, null, 'un segment d\'actes seuls doit se relire');
  assert.strictEqual(un.pas, parPas);
  assert.strictEqual(deux.pas, 0, 'un jeton d\'acte ne compte aucun pas : c\'est toute l\'affaire');
  assert.strictEqual(deux.items.length, 1);
  assert.strictEqual(deux.items[0].t, 'a');
  assert.strictEqual(deux.items[0].code, C.TRACE.QUIT);
  // Et recollés, ils rendent le texte entier — celui que le rejeu relira.
  assert.strictEqual(segs.join(''), rec.texte());
  assert.strictEqual(C.traceDecode(segs.join('')).pas, parPas);
});

test('une trace malformée est NOMMÉE, jamais une exception', () => {
  // C'est la leçon du `22003`, transposée : un corps qu'on ne sait pas lire doit sortir avec un code
  // que la route traduit en 400. Une exception ici deviendrait un 500, et un 500 sur cette route
  // laisserait un joueur enfermé dans un billet mort jusqu'à l'expiration.
  const bon = C.traceEnregistreur(1000);
  bon.ajouter(C.traceMots({ mx: 1, mz: 0, ax: 1, az: 0, aimDist: 5, feu: true }));
  bon.acte(C.TRACE.SUP, C.traceViseeMots(0, 1, 3));
  bon.ajouter(C.traceMots({ mx: 0, mz: 1, ax: 0, az: 1, aimDist: 2, feu: false }));
  const t = bon.texte();
  assert.strictEqual(C.traceDecode(t).erreur, null);
  const mauvais = [
    ['', null],                                  // vide : lisible, simplement sans un pas
    ['AA', 'pas'],                               // un mot coupé
    ['AAAA', 'pas'],                             // un mot coupé au milieu
    ['....', 'pas'],                             // hors alphabet
    ['~AAA', 'repetition'],                      // une répétition sans rien à répéter
    [t.slice(0, t.indexOf('!') + 5) + '~AAA', 'repetition'],   // une répétition juste après un acte
    ['!' + '_' + 'AAA', 'acte'],                 // un code d'acte qui n'existe pas
    ['!A', 'acte'],                              // un acte coupé
  ];
  for (const [texte, code] of mauvais)
    assert.strictEqual(C.traceDecode(texte).erreur, code, JSON.stringify(texte));
  for (const rien of [undefined, null, 42, {}, []])
    assert.strictEqual(C.traceDecode(rien).erreur, 'type', String(rien));
  // Et la borne de pas est un refus NOMMÉ, pas un tableau de dix millions d'objets.
  const long = C.traceEnregistreur(100000);
  const m = C.traceMots({ mx: 1, mz: 0, ax: 1, az: 0, aimDist: 5, feu: false });
  for (let i = 0; i < 5000; i++) long.ajouter(m);
  assert.strictEqual(C.traceDecode(long.texte(), 4999, true).erreur, 'trop_de_pas');
  assert.strictEqual(C.traceDecode(long.texte(), 5000, true).erreur, null);
  assert.strictEqual(C.traceDecode(long.texte(), 5000, true).pas, 5000);
});

test('la borne de pas d\'une trace vient du PLAN DE ZONE, jamais d\'un nombre annoncé', () => {
  for (const cle of Object.keys(C.MODES)) {
    const plan = C.zonePlan(9182, C.MODES[cle]);
    const max = C.traceMaxSteps(plan);
    assert.ok(Number.isInteger(max) && max > 0, cle);
    // Une partie complète tient dedans, décompte d'intro compris — c'est la raison de la marge.
    assert.ok(max >= Math.ceil((C.zoneTotalS(plan) + C.GRACE) / C.SIM.stepS), cle);
    assert.ok(max <= Math.ceil((C.zoneTotalS(plan) + C.GRACE + 30) / C.SIM.stepS), cle);
  }
  // Le gaz rapide de Resurgence donne une borne plus courte : elle suit le mode, pas un chiffre rond.
  assert.ok(C.traceMaxSteps(C.zonePlan(9182, C.MODES.resurgence))
          < C.traceMaxSteps(C.zonePlan(9182, C.MODES.solo)));
});

test('LES ACTIONS PONCTUELLES SONT DANS LA TRACE : sans elles, une partie rejouée n\'a ni super ni fumigène', () => {
  // La dette signalée par le module 5, refermée ici. Le super, le fumigène, le tir d'une pression
  // brève, l'encaissement et l'abandon partent tous d'un ÉVÉNEMENT d'entrée, entre deux pas — le
  // module 5 ne l'a pas changé pour ne pas déplacer la latence ressentie. La trace les porte donc
  // comme des jetons à part, et `WBSim.appliquerActe` les rejoue avant le pas qui suit.
  const codes = ['TIR', 'SUP', 'GAD', 'ENC', 'QUIT'];
  assert.strictEqual(new Set(codes.map(k => C.TRACE[k])).size, codes.length, 'deux actions partagent un code');
  assert.strictEqual(C.TRACE.ACTES, codes.length);

  // Chaque action a un EFFET quand elle est rejouée, sinon la porter ne servirait à rien.
  // Le compte à rebours d'abord : tant qu'il court, `step` consomme le pas sans rien faire avancer
  // et `throwSmoke` refuse — c'est la règle du jeu, pas un artefact de test.
  const neuf = () => {
    const G = SIMU.newMatch(7311, C.MODES.resurgence, 50, C.BRAWLERS.bolt);
    for (let i = 0; i < PAS_INTRO + 60; i++) SIMU.step(G, {});
    return G;
  };
  const tir = neuf();
  const munAvant = tir.player.ammo;
  assert.strictEqual(SIMU.appliquerActe(tir, { code: C.TRACE.TIR, ax: 1, az: 0, dist: 5 }), true);
  assert.ok(tir.player.ammo < munAvant, 'un tir rejoué ne consomme pas de munition');

  const sup = neuf();
  sup.player.super = sup.player.brawler.super.cost;
  assert.strictEqual(SIMU.appliquerActe(sup, { code: C.TRACE.SUP, ax: 0, az: 1, dist: 4 }), true);
  assert.strictEqual(sup.player.super, 0, 'un super rejoué ne se déclenche pas');

  const gad = neuf();
  gad.player.gadget = { charges: 1, cd: 0 };
  const nuages = gad.nades.length;
  SIMU.appliquerActe(gad, { code: C.TRACE.GAD, ax: 1, az: 0, dist: 3 });
  assert.ok(gad.nades.length > nuages, 'un fumigène rejoué ne part pas');

  const enc = neuf();
  enc.player.cashLock = 0;
  assert.strictEqual(SIMU.appliquerActe(enc, { code: C.TRACE.ENC, ax: 1, az: 0, dist: 0 }), true);
  assert.strictEqual(enc.player.cashedOut, true, 'un encaissement rejoué n\'encaisse pas');

  const quit = neuf();
  assert.strictEqual(SIMU.appliquerActe(quit, { code: C.TRACE.QUIT, ax: 1, az: 0, dist: 0 }), true);
  assert.strictEqual(quit.player.alive, false, 'un abandon rejoué ne tue pas');

  // Et la visée de l'action est REPOSÉE sur le brawler avant d'être jouée : sans cela, l'action
  // partirait dans la direction du pas précédent, et tout ce qui suit divergerait.
  const vise = neuf();
  vise.player.ax = 1; vise.player.az = 0;
  const u = C.UNIT[300];
  SIMU.appliquerActe(vise, { code: C.TRACE.TIR, ax: u.x, az: u.z, dist: 5 });
  assert.strictEqual(vise.player.ax, u.x);
  assert.strictEqual(vise.player.az, u.z);
});

test('le jeu ENREGISTRE ce qu\'il joue : un seul écrivain, et rien pendant l\'image', () => {
  // Les gardes textuelles du module. La trace ne s'écrit que depuis `simPas` et depuis les gestes
  // ponctuels du joueur ; elle ne se fabrique en texte qu'à la fin de la partie ; et sans billet
  // elle n'existe pas du tout.
  const jeu = sansCommentaires(JEU);
  assert.strictEqual(compte(jeu, /TR\.ajouter\(/g), 1, 'un seul site enregistre un pas');
  // La ligne EXACTE, pas seulement le nom : `if(TR&&false)` contiendrait aussi « TR.ajouter », et
  // une garde textuelle qui se contente d'un nom se laisse désarmer par une condition.
  const pas = sansCommentaires(corpsDe('simPas'));
  assert.ok(/\n\s*if\(TR\) TR\.ajouter\(entrees\);\n/.test(pas),
    'le pas doit être enregistré par simPas, sans condition ajoutée, avant WBSim.step');
  assert.ok(pas.indexOf('TR.ajouter') < pas.indexOf('WBSim.step'),
    'la trace doit s\'écrire AVANT le pas, comme le rejeu la relira');
  // `lireEntrees` rend la valeur QUANTIFIÉE : c'est ce qui fait que le jeu joue exactement ce que la
  // trace porte. Sans cela, le rejeu serait « presque » la partie, et un presque ne se borne pas.
  assert.ok(sansCommentaires(corpsDe('lireEntrees')).includes('C.traceQuant('),
    'lireEntrees doit rendre l\'entrée quantifiée');
  // Le texte et les segments ne se fabriquent QUE dans endMatch : jamais dans la boucle d'image.
  assert.strictEqual(compte(jeu, /TR\.segments\(/g), 1);
  assert.ok(sansCommentaires(corpsDe('endMatch')).includes('TR.segments()'),
    'la trace ne se met en segments qu\'à la fin de la partie');
  assert.ok(!sansCommentaires(corpsDe('loop')).includes('TR.'), 'la boucle d\'image touche à la trace');
  // Sans billet, aucun enregistreur : c'est structurel, pas une condition posée au moment d'envoyer.
  assert.ok(sansCommentaires(corpsDe('startMatch')).includes('TR=billet?C.traceEnregistreur('),
    'l\'enregistreur doit naître du billet, et de lui seul');
  // PLUS AUCUN GESTE DU JOUEUR NE COURT-CIRCUITE LA TRACE, et c'est le patron du lecteur unique
  // appliqué aux entrées : chacune des cinq fonctions de SIM qui décident d'un fait ponctuel
  // n'apparaît qu'UNE fois dans le bloc `Game`, dans sa passerelle. Un treizième bouton branché
  // directement sur `useSuper` produirait une partie qui ne se rejoue pas, sans que rien ne casse.
  for (const [prim, porte] of Object.entries({ attack: 'tirJoueur', useSuper: 'superJoueur',
                                               throwSmoke: 'gadgetJoueur', doCashOut: 'encaisserJoueur',
                                               abandon: 'abandonJoueur' })) {
    assert.strictEqual(compte(jeu, new RegExp('\\b' + prim + '\\(', 'g')), 1,
      `${prim}( est appelée plus d'une fois dans le bloc Game : un geste du joueur contourne la trace`);
    assert.ok(sansCommentaires(corpsDe(porte)).includes(prim + '('),
      `la passerelle ${porte} n'appelle plus ${prim}`);
  }
  // ET L'ÉCRAN DE FIN NE S'OUVRE PLUS DEPUIS UN BOUTON. `endMatch` est la traduction de l'événement
  // `fin` de la simulation, et rien d'autre : le bouton QUITTER pressé sur un joueur mort mais
  // encore en vies l'appelait directement, donc aucun jeton dans la trace, aucun événement de fin,
  // et le rejeu du serveur n'atteignait jamais d'état terminal — 409 `non_terminal` et billet
  // laissé au veilleur, sur une partie parfaitement honnête. Deux lecteurs sont autorisés : sa
  // propre définition, et le traducteur de l'événement.
  assert.strictEqual(compte(jeu, /\bendMatch\(/g), 2,
    'endMatch( doit n\'avoir que deux occurrences : sa définition et le traducteur de l\'événement « fin »');
  assert.ok(sansCommentaires(corpsDe('rendreEvenements')).includes('endMatch('),
    'le traducteur de l\'événement « fin » doit rester le seul appelant d\'endMatch');
});

// ---------------------------------------------------------------------------------------------
// LA FENÊTRE DE RENONCEMENT (phase 03, module 1).
//
// Elle vit dans `WBCore` et pas dans `api/ledger.js` parce qu'elle est la seule règle du grand
// livre réellement PARTAGÉE : le sas d'attente doit dire au joueur ce que partir va lui coûter, et
// le serveur doit l'arbitrer. Ses tests sont donc ici, avec les règles du jeu.
//
// Ils sont en fin de fichier et non dans la section « Waiting room » pour une raison mécanique :
// ils lisent le TEXTE du fichier, et `corpsDe`, `corpsDansBloc` et `sansCommentaires` sont déclarés
// plus haut en `const`, donc hors de portée d'un test qui s'exécuterait avant eux.
console.log('La fenêtre de renoncement');

test('joinRate rend exactement les mêmes valeurs qu\'avant l\'extraction de LOBBY.pressureMax', () => {
  // Le plafond 2,4 était un littéral dans `joinRate` ; il a reçu un nom pour que la fenêtre en
  // DÉRIVE au lieu de le recopier. Nommer une constante ne doit rien changer, et « ne rien
  // changer » se prouve : la référence ci-dessous est l'ANCIENNE fonction, littéral compris, et les
  // deux sont confrontées sur toute la plage de files d'attente que le lobby peut produire.
  const avant = (queue, seats) => (seats - 1) / C.LOBBY.wait * Math.max(0.55, Math.min(2.4, queue / (seats * 3)));
  assert.strictEqual(C.LOBBY.pressureMax, 2.4);
  for (const id of Object.keys(C.MODES)) {
    const seats = C.seatsOf(C.MODES[id]);
    for (let q = 0; q <= 20000; q++)
      assert.strictEqual(C.joinRate(q, seats), avant(q, seats), `${id} file=${q}`);
    // Et les entrées que le lobby ne produit pas mais qu'un appelant pourrait lui donner : le
    // plancher et le plafond doivent se comporter comme avant, eux aussi.
    for (const q of [-1, 0, 0.5, 1e9, Infinity])
      assert.strictEqual(C.joinRate(q, seats), avant(q, seats), `${id} file=${q}`);
  }
});

test('la fenêtre vaut dix secondes, et elle DÉRIVE du lobby au lieu d\'en recopier les nombres', () => {
  assert.strictEqual(C.RENONCE_MARGE_S, 3);
  assert.strictEqual(C.renonceFenetreS(), 10);
  // La dérivation ne se prouve pas en récitant la formule — ce serait la recopier une troisième
  // fois. On BOUGE le lobby et on regarde si la fenêtre suit. Une fenêtre qui aurait gardé « 10 »
  // en dur, ou recopié « 2.4 », ne bougerait pas.
  const pression = C.LOBBY.pressureMax, attente = C.LOBBY.wait;
  try {
    C.LOBBY.pressureMax = 1;                    // salle pleine à 25 s, coup d'envoi à 28 s
    assert.strictEqual(C.renonceFenetreS(), 25);
    C.LOBBY.wait = 50;                          // salle pleine à 50 s, coup d'envoi à 53 s
    assert.strictEqual(C.renonceFenetreS(), 50);
  } finally { C.LOBBY.pressureMax = pression; C.LOBBY.wait = attente; }
  assert.strictEqual(C.renonceFenetreS(), 10, 'le lobby n\'a pas été remis dans son état');
});

test('renonciationOuverte est vraie pendant toute la fenêtre, bornes comprises, et fausse ensuite', () => {
  const F = C.renonceFenetreS() * 1000, t0 = 1700000000000;
  const billet = { openedAt: t0 };
  assert.strictEqual(C.renonciationOuverte(billet, t0), true, 'à l\'instant de l\'ouverture');
  assert.strictEqual(C.renonciationOuverte(billet, t0 + 1), true);
  assert.strictEqual(C.renonciationOuverte(billet, t0 + F - 1), true);
  assert.strictEqual(C.renonciationOuverte(billet, t0 + F), true, 'la borne haute est COMPRISE');
  assert.strictEqual(C.renonciationOuverte(billet, t0 + F + 1), false,
    'une milliseconde de plus et la fenêtre est close');
  assert.strictEqual(C.renonciationOuverte(billet, t0 + 3600000), false);
  // Postgres rend `opened_at` en `Date`, le sas compte en millisecondes. La FORME de l'horodatage
  // ne doit pas décider d'un remboursement : les deux écritures donnent la même réponse.
  assert.strictEqual(C.renonciationOuverte({ openedAt: new Date(t0) }, new Date(t0 + F)), true);
  assert.strictEqual(C.renonciationOuverte({ openedAt: new Date(t0) }, new Date(t0 + F + 1)), false);
  // Rien d'illisible ne doit rendre « ouvert » : un billet sans heure d'ouverture rembourserait
  // tout le monde pour toujours.
  for (const mauvais of [undefined, null, {}, { openedAt: null }, { openedAt: 'hier' }, { openedAt: NaN }])
    assert.strictEqual(C.renonciationOuverte(mauvais, t0), false, JSON.stringify(mauvais));
  assert.strictEqual(C.renonciationOuverte(billet, undefined), false);
});

test('renonciationOuverte ne lit AUCUNE horloge : elle la reçoit', () => {
  // C'est ce qui permet au sas de l'appeler avec son chronomètre et au serveur avec le sien, sans
  // que l'un ait à deviner l'autre. Une horloge lue à l'intérieur rendrait la fonction intestable
  // et, pire, donnerait deux réponses différentes des deux côtés du réseau.
  // `corpsDansBloc` ne sait lire que les déclarations de premier niveau des blocs SIM et `Game` ;
  // celles de `WBCore` vivent dans une fermeture et sont indentées. On les découpe donc ici.
  const corpsCore = nom => {
    const d = core.indexOf(`function ${nom}(`);
    assert.ok(d >= 0, `${nom} n'a pas été retrouvée dans WBCore`);
    const f = core.indexOf('\n  }', d);
    assert.ok(f > d, `la fin de ${nom} n'a pas été retrouvée`);
    return core.slice(d, f);
  };
  const texte = sansCommentaires(corpsCore('renonciationOuverte') + '\n' + corpsCore('renonceFenetreS'));
  for (const interdit of ['Date.now', 'new Date', 'performance', 'Math.random'])
    assert.ok(!texte.includes(interdit), `la fenêtre de renoncement lit ${interdit}`);
  // Et à l'exécution : mêmes arguments, même réponse, quel que soit le moment de l'appel.
  const billet = { openedAt: 0 };
  const a = C.renonciationOuverte(billet, 5000);
  for (let i = 0; i < 1000; i++) assert.strictEqual(C.renonciationOuverte(billet, 5000), a);
});

test('LE TEST QUI COMPTE : la fenêtre est strictement plus courte que le coup d\'envoi le plus précoce, sur TOUT le domaine', () => {
  // Deux règles décident du même nombre : le serveur dira « on peut encore renoncer », le lobby dit
  // « c'est parti ». On les confronte donc sur tout leur domaine et pas sur un exemple — c'est la
  // leçon du pot forfaitaire ressuscité, où deux calculs du même montant avaient cohabité des mois.
  //
  // La règle du sas, reprise du code et gardée textuellement par le test suivant : `W.drop` part de
  // `LOBBY.wait` et descend à `W.t + LOBBY.dropIn` dès que `seatsAt(t, seats, rate) >= seats`.
  // L'instant où la salle se remplit n'est pas déduit d'une formule recopiée : il est CHERCHÉ en
  // interrogeant `seatsAt`, la fonction que `waitTick` appelle réellement.
  const premierPlein = (seats, rate) => {
    let lo = 0, hi = 1;
    while (C.seatsAt(hi, seats, rate) < seats) { hi *= 2; assert.ok(hi < 1e9, 'la salle ne se remplit jamais'); }
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (C.seatsAt(mid, seats, rate) >= seats) hi = mid; else lo = mid;
    }
    return hi;
  };
  const fenetreMs = C.renonceFenetreS() * 1000;
  let plusPrecoce = Infinity, ou = '', combinaisons = 0;
  const eprouver = (etiquette, seats, queue) => {
    const rate = C.joinRate(queue, seats);
    // Le coup d'envoi CONTINU : une borne inférieure de ce que le sas fera vraiment, puisque
    // `waitTick` n'observe la salle que tous les dixièmes de seconde et ne peut donc que décoller
    // plus tard. Confronter la fenêtre à la borne la plus basse est la comparaison la plus dure.
    const envoiS = Math.min(C.LOBBY.wait, premierPlein(seats, rate) + C.LOBBY.dropIn);
    combinaisons++;
    if (envoiS < plusPrecoce) { plusPrecoce = envoiS; ou = etiquette; }
    assert.ok(fenetreMs < envoiS * 1000,
      `${etiquette} : la fenêtre de ${fenetreMs} ms rembourserait une partie lancée depuis ${envoiS * 1000} ms`);
  };
  // 1. Toute la plage de files d'attente, entier par entier, sur les cinq modes. Le plafond est
  //    pris au-dessus de ce que `queueFor` peut rendre à l'heure de pointe d'un samedi soir, et une
  //    assertion plus bas vérifie qu'il l'est resté.
  for (const id of Object.keys(C.MODES)) {
    const seats = C.seatsOf(C.MODES[id]);
    for (let q = 0; q <= 6000; q++) eprouver(`${id} file=${q}`, seats, q);
  }
  // 2. Et le domaine que le jeu produit vraiment : les vingt-quatre heures d'`onlineTotal`, semaine
  //    et week-end, croisées avec les cinq modes et les quatre tables. C'est ce croisement qui
  //    répond à « la borne exacte n'est pas calculable côté serveur » : elle dépend du fuseau
  //    horaire du client, donc on les essaie tous.
  let fileMax = 0;
  for (const jour of ['2026-01-07', '2026-01-10']) {            // un mercredi, un samedi
    for (let h = 0; h < 24; h++) for (const min of [0, 17, 31, 46, 59]) {
      const quand = new Date(`${jour}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`);
      const total = C.onlineTotal(quand);
      for (const id of Object.keys(C.MODES)) {
        const seats = C.seatsOf(C.MODES[id]);
        for (const t of C.TIERS) {
          const q = C.queueFor(total, id, t.stake);
          if (q > fileMax) fileMax = q;
          eprouver(`${id} $${t.stake} ${jour} ${h}h${min}`, seats, q);
        }
      }
    }
  }
  assert.ok(combinaisons > 30000, `le domaine balayé est trop maigre : ${combinaisons} combinaisons`);
  assert.ok(fileMax <= 6000, `queueFor monte à ${fileMax}, au-delà du balayage entier par entier`);
  // Le coup d'envoi le plus précoce du jeu, et il n'est PAS de 25 secondes : `LOBBY.wait` divisé par
  // la pression maximale, plus `dropIn`. C'est exactement ce que la fenêtre doit éviter, et l'écart
  // qu'elle garde est la marge de latence.
  assert.ok(Math.abs(plusPrecoce - (C.LOBBY.wait / C.LOBBY.pressureMax + C.LOBBY.dropIn)) < 1e-6,
    `le coup d'envoi le plus précoce vaut ${plusPrecoce} s (${ou})`);
  assert.ok(plusPrecoce > 13.4 && plusPrecoce < 13.5, `${plusPrecoce} s`);
  assert.strictEqual(C.renonceFenetreS(), 10);
});

test('la règle du sas est toujours celle que la fenêtre suppose', () => {
  // La confrontation ci-dessus rejoue la règle du sas ; elle n'aurait plus aucune valeur si le sas
  // changeait de règle sans que rien ne le dise. Même patron que les gardes textuelles du bloc SIM.
  const depart = sansCommentaires(corpsDe('enterWaiting'));
  assert.ok(depart.includes('drop:C.LOBBY.wait'),
    'le compte à rebours du sas ne part plus de LOBBY.wait');
  assert.ok(depart.includes('C.joinRate(queue,seats)') && depart.includes('C.queueFor('),
    'le sas ne tire plus sa cadence de joinRate/queueFor');
  const tick = sansCommentaires(corpsDe('waitTick'));
  assert.ok(tick.includes('C.seatsAt(W.t,W.seats,W.rate)'),
    'le sas ne compte plus les sièges avec seatsAt');
  assert.ok(tick.includes('W.drop=Math.min(W.drop,W.t+C.LOBBY.dropIn)'),
    'la règle « salle pleine → coup d\'envoi dans dropIn » a changé de forme, et la fenêtre de renoncement la suppose');
  // ET `W.t` RESTE UN COMPTEUR DE TICS, DÉLIBÉRÉMENT. Le passer en temps réel ferait démarrer la
  // partie sans le joueur au retour d'un onglet caché : il pilote les sièges, l'arc et le décompte,
  // c'est-à-dire la mise en scène, et la mise en scène doit suivre l'écran. Ce qui a changé, c'est
  // que la seule question d'ARGENT du sas ne le lit plus — voir la garde de `sasRemboursable`, qui
  // lit `performance.now()-W.clic`. Deux horloges, deux rôles, et la frontière est écrite ici parce
  // que c'est ici qu'on serait tenté de la refranchir.
  assert.ok(tick.includes('W.t+=0.1'), 'le chronomètre de la mise en scène a changé de nature');
  assert.ok(!tick.includes('performance.now()') && !tick.includes('Date.now()'),
    'waitTick lit une horloge : la partie partirait toute seule au retour d\'un onglet caché');
});

Promise.all(enVol).then(() => console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`));
