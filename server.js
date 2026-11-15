// Word Spies - a Codenames-style game. No dependencies: just run `node server.js`
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const WORDS = `acorn anchor angel apple arrow attic bacon badge baker banjo barrel basket beach beacon bear bell berry bicycle bishop blanket blizzard bolt bone bottle bridge brush bucket cabin cactus camel candle canyon captain carpet castle cat cave chain chair cheese cherry chest chimney circus clock cloud clown coal coast cobra comet compass copper cottage cowboy crab crane crown crystal curtain dagger dancer desert diamond dragon drum duck eagle earth engine fabric falcon farmer feather fence ferry fiddle finger fire flag flute forest fossil fox frog garden garlic ghost giant glacier glove goat gold goose grape guitar hammer harbor hawk helmet honey horse hospital island ivory jacket jelly jewel jungle kettle key kite knight ladder lake lamp lantern laser leaf lemon library lighthouse lion lizard lock magnet mammoth map marble mask meadow mirror monkey moon mountain mouse mummy needle nest night noodle nurse oasis ocean olive onion orange otter oyster paddle palace panda paper parrot peanut pearl pencil penguin piano pilot pirate pizza planet plum pocket pole pond potato pyramid queen rabbit radio rainbow raven ribbon ring river robot rocket rope saddle sailor salad sand satellite scarf school scorpion shadow shark sheep shield ship shoe silver skate snake snow soldier spider spoon spring squirrel statue storm submarine sugar sunset sword table tent thunder tiger toast tomato tower train treasure tree trumpet tunnel turtle umbrella valley vampire village violin volcano wagon waiter wallet whale wheel whistle window witch wizard wolf worm yacht zebra zipper`.split(/\s+/);

const rooms = new Map();
const other = (t) => (t === 'red' ? 'blue' : 'red');
const cap = (t) => (t === 'red' ? 'Red' : 'Blue');

function rid(n) {
  const a = 'abcdefghjkmnpqrstuvwxyz';
  let s = '';
  for (let i = 0; i < n; i++) s += a[crypto.randomInt(a.length)];
  return s;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newGame(room) {
  const start = Math.random() < 0.5 ? 'red' : 'blue';
  const types = shuffle([
    ...Array(9).fill(start),
    ...Array(8).fill(other(start)),
    ...Array(7).fill('neutral'),
    'assassin',
  ]);
  room.words = shuffle([...WORDS]).slice(0, 25);
  room.types = types;
  room.revealed = Array(25).fill(false);
  room.start = start;
  room.turn = start;
  room.over = false;
  room.winner = null;
  room.spyClaim = { red: null, blue: null }; // first player to open the key per team this game
  for (const p of room.players.values()) {
    if (p.spy && p.spySince) p.spyMs += Date.now() - p.spySince;
    p.spy = false;
    p.spySince = null;
  }
}

function createRoom() {
  let id;
  do { id = rid(5); } while (rooms.has(id));
  const room = {
    id,
    adminKey: crypto.randomBytes(12).toString('hex'),
    players: new Map(),
    clients: new Set(),
    log: [],
    touched: Date.now(),
  };
  newGame(room);
  rooms.set(id, room);
  return room;
}

function addLog(room, text, flag = false) {
  room.log.push({ t: Date.now(), text, flag });
  if (room.log.length > 500) room.log.shift();
}

function remaining(room, team) {
  let n = 0;
  room.types.forEach((t, i) => { if (t === team && !room.revealed[i]) n++; });
  return n;
}

function viewFor(room, client) {
  const p = room.players.get(client.pid);
  const online = new Set([...room.clients].map((c) => c.pid));
  const view = {
    room: room.id,
    turn: room.turn,
    over: room.over,
    winner: room.winner,
    start: room.start,
    remaining: { red: remaining(room, 'red'), blue: remaining(room, 'blue') },
    cards: room.words.map((w, i) => ({
      w,
      revealed: room.revealed[i],
      type: room.revealed[i] || room.over ? room.types[i] : null,
    })),
    players: [...room.players.values()].map((q) => ({
      id: q.id, name: q.name, team: q.team, online: online.has(q.id),
    })),
    me: p ? { id: p.id, name: p.name, team: p.team, spy: p.spy } : { id: client.pid, name: null, team: null, spy: false },
    // The key is ONLY sent to players who have opened spymaster view (or to the host).
    key: p && p.spy ? room.types : null,
    admin: null,
  };
  if (client.isAdmin) {
    const now = Date.now();
    view.hostKey = room.types;
    view.admin = {
      players: [...room.players.values()].map((q) => ({
        id: q.id, name: q.name, team: q.team, online: online.has(q.id),
        spy: q.spy, opens: q.spyOpens,
        ms: q.spyMs + (q.spy && q.spySince ? now - q.spySince : 0),
      })),
      claim: {
        red: room.spyClaim.red && room.players.get(room.spyClaim.red)?.name,
        blue: room.spyClaim.blue && room.players.get(room.spyClaim.blue)?.name,
      },
      log: room.log.slice(-200),
    };
  }
  return view;
}

function send(client, room) {
  try {
    client.res.write('data: ' + JSON.stringify(viewFor(room, client)) + '\n\n');
  } catch (e) { /* connection gone */ }
}
function broadcast(room) {
  room.touched = Date.now();
  for (const c of room.clients) send(c, room);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 10000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function handleAction(room, body, isAdmin) {
  const pid = String(body.pid || '').slice(0, 64);
  if (!pid) return;
  let p = room.players.get(pid);

  if (body.type === 'join') {
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) return;
    if (!p) {
      p = { id: pid, name, team: null, spy: false, spySince: null, spyOpens: 0, spyMs: 0 };
      room.players.set(pid, p);
      addLog(room, `${name} joined the room`);
    } else if (p.name !== name) {
      addLog(room, `${p.name} renamed to ${name}`);
      p.name = name;
    }
    return;
  }
  if (!p) return;

  switch (body.type) {
    case 'team': {
      const t = body.team === 'red' || body.team === 'blue' ? body.team : null;
      if (p.spy) return; // close spymaster view first
      p.team = t;
      addLog(room, `${p.name} moved to ${t ? cap(t) : 'spectators'}`);
      break;
    }
    case 'spy': {
      if (body.on && !p.spy) {
        p.spy = true;
        p.spySince = Date.now();
        p.spyOpens++;
        let msg = `${p.name} OPENED the spymaster key`;
        let flag = false;
        if (!p.team) {
          msg += ' (not on any team - spectator!)';
          flag = true;
        } else {
          const claimant = room.spyClaim[p.team];
          if (!claimant) {
            room.spyClaim[p.team] = p.id;
            msg += ` as ${cap(p.team)}'s first spymaster this game`;
          } else if (claimant !== p.id) {
            const who = room.players.get(claimant)?.name || 'someone';
            msg += ` on ${cap(p.team)}, but ${who} already is ${cap(p.team)}'s spymaster this game - SUSPICIOUS`;
            flag = true;
          } else {
            msg += ` again (${cap(p.team)}'s spymaster)`;
          }
        }
        addLog(room, msg, flag);
      } else if (!body.on && p.spy) {
        const secs = Math.round((Date.now() - p.spySince) / 1000);
        p.spyMs += Date.now() - p.spySince;
        p.spy = false;
        p.spySince = null;
        addLog(room, `${p.name} closed the spymaster key after ${secs}s`);
      }
      break;
    }
    case 'guess': {
      const i = Number(body.idx);
      if (!Number.isInteger(i) || i < 0 || i > 24) return;
      if (room.over || room.revealed[i]) return;
      if (p.team !== room.turn) return;
      if (p.spy) {
        addLog(room, `${p.name} tried to GUESS a card while looking at the key - SUSPICIOUS`, true);
        return;
      }
      room.revealed[i] = true;
      const t = room.types[i];
      addLog(room, `${p.name} (${cap(p.team)}) guessed "${room.words[i]}" (${t})`);
      if (t === 'assassin') {
        room.over = true;
        room.winner = other(room.turn);
      } else {
        if (t !== room.turn) room.turn = other(room.turn);
        if (remaining(room, 'red') === 0) { room.over = true; room.winner = 'red'; }
        else if (remaining(room, 'blue') === 0) { room.over = true; room.winner = 'blue'; }
      }
      break;
    }
    case 'endturn': {
      if (room.over || p.team !== room.turn || p.spy) return;
      room.turn = other(room.turn);
      addLog(room, `${p.name} ended ${cap(other(room.turn))}'s turn`);
      break;
    }
    case 'newgame': {
      newGame(room);
      addLog(room, `${p.name} started a new game`);
      break;
    }
    default:
      return;
  }
}

const indexHtml = () => fs.readFileSync(path.join(__dirname, 'index.html'));

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(indexHtml());
    }
    if (req.method === 'POST' && u.pathname === '/api/create') {
      const room = createRoom();
      return json(res, 200, { room: room.id, adminKey: room.adminKey });
    }
    if (req.method === 'GET' && u.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const room = rooms.get(u.searchParams.get('room'));
      if (!room) {
        res.write('event: gone\ndata: {}\n\n');
        return res.end();
      }
      const client = {
        res,
        pid: String(u.searchParams.get('pid') || '').slice(0, 64),
        isAdmin: !!u.searchParams.get('admin') && u.searchParams.get('admin') === room.adminKey,
      };
      room.clients.add(client);
      send(client, room);
      broadcast(room); // presence changed
      req.on('close', () => { room.clients.delete(client); broadcast(room); });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/action') {
      const body = await readBody(req);
      const room = rooms.get(body.room);
      if (!room) return json(res, 404, { error: 'no such room' });
      const isAdmin = !!body.admin && body.admin === room.adminKey;
      handleAction(room, body, isAdmin);
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    try { json(res, 400, { error: 'bad request' }); } catch (_) {}
  }
});

// keep SSE connections alive + clean up old rooms
setInterval(() => {
  for (const [id, room] of rooms) {
    if (Date.now() - room.touched > 12 * 3600 * 1000 && room.clients.size === 0) rooms.delete(id);
    for (const c of room.clients) { try { c.res.write(': ping\n\n'); } catch (e) {} }
  }
}, 20000);

server.listen(PORT, () => console.log(`Word Spies running at http://localhost:${PORT}`));
