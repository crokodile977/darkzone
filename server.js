const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── LOBBY STATE ─────────────────────────────────────────────────────────────
const lobbies = new Map(); // code -> lobby

function generateCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); }
  while (lobbies.has(code));
  return code;
}

function broadcast(lobby, msg, excludeId = null) {
  const data = JSON.stringify(msg);
  for (const [id, client] of lobby.clients) {
    if (id !== excludeId && client.ws.readyState === 1) {
      client.ws.send(data);
    }
  }
}

function broadcastAll(lobby, msg) {
  broadcast(lobby, msg);
}

function getLobbyInfo(lobby) {
  return {
    code: lobby.code,
    mode: lobby.mode,
    difficulty: lobby.difficulty,
    started: lobby.started,
    players: Array.from(lobby.clients.values()).map(c => ({
      id: c.id,
      name: c.name,
      isHost: c.id === lobby.hostId,
      ready: c.ready
    }))
  };
}

// ─── WEBSOCKET ───────────────────────────────────────────────────────────────
let nextId = 1;

wss.on('connection', (ws) => {
  const clientId = String(nextId++);
  let currentLobby = null;
  let clientName = 'Player';

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── CREATE LOBBY ──
      case 'create': {
        const code = generateCode();
        const lobby = {
          code,
          hostId: clientId,
          mode: msg.mode || 'coop',       // 'coop' | 'pvp'
          difficulty: msg.difficulty || 'normal',
          started: false,
          clients: new Map(),
          gameState: null
        };
        lobby.clients.set(clientId, {
          id: clientId,
          ws,
          name: msg.name || 'Player',
          ready: false,
          // game state
          x: 0, y: 0, angle: 0,
          hp: 100, alive: true,
          kills: 0
        });
        lobbies.set(code, lobby);
        currentLobby = lobby;
        clientName = msg.name || 'Player';

        ws.send(JSON.stringify({ type: 'created', code, clientId, lobby: getLobbyInfo(lobby) }));
        break;
      }

      // ── JOIN LOBBY ──
      case 'join': {
        const lobby = lobbies.get(msg.code);
        if (!lobby) { ws.send(JSON.stringify({ type: 'error', msg: 'Lobby not found' })); break; }
        if (lobby.started) { ws.send(JSON.stringify({ type: 'error', msg: 'Game already started' })); break; }
        if (lobby.clients.size >= 8) { ws.send(JSON.stringify({ type: 'error', msg: 'Lobby is full' })); break; }

        lobby.clients.set(clientId, {
          id: clientId, ws,
          name: msg.name || 'Player',
          ready: false,
          x: 0, y: 0, angle: 0,
          hp: 100, alive: true, kills: 0
        });
        currentLobby = lobby;
        clientName = msg.name || 'Player';

        ws.send(JSON.stringify({ type: 'joined', clientId, lobby: getLobbyInfo(lobby) }));
        broadcast(lobby, { type: 'lobby_update', lobby: getLobbyInfo(lobby) }, clientId);
        break;
      }

      // ── CHANGE SETTINGS (host only) ──
      case 'settings': {
        if (!currentLobby || currentLobby.hostId !== clientId) break;
        if (msg.mode) currentLobby.mode = msg.mode;
        if (msg.difficulty) currentLobby.difficulty = msg.difficulty;
        broadcastAll(currentLobby, { type: 'lobby_update', lobby: getLobbyInfo(currentLobby) });
        break;
      }

      // ── START GAME (host only) ──
      case 'start': {
        if (!currentLobby || currentLobby.hostId !== clientId) break;
        if (currentLobby.clients.size < 1) break;
        currentLobby.started = true;

        // Assign spawn positions
        const spawns = generateSpawns(currentLobby.clients.size);
        let idx = 0;
        for (const [id, client] of currentLobby.clients) {
          const sp = spawns[idx++];
          client.x = sp.x; client.y = sp.y;
          client.hp = 100; client.alive = true; client.kills = 0;
        }

        broadcastAll(currentLobby, {
          type: 'game_start',
          mode: currentLobby.mode,
          difficulty: currentLobby.difficulty,
          players: Array.from(currentLobby.clients.values()).map(c => ({
            id: c.id, name: c.name, x: c.x, y: c.y, hp: c.hp,
            isHost: c.id === currentLobby.hostId
          }))
        });
        break;
      }

      // ── PLAYER MOVE ──
      case 'move': {
        if (!currentLobby || !currentLobby.started) break;
        const client = currentLobby.clients.get(clientId);
        if (!client || !client.alive) break;
        client.x = msg.x;
        client.y = msg.y;
        client.angle = msg.angle;
        client.velX = msg.velX || 0;
        client.velY = msg.velY || 0;
        broadcast(currentLobby, {
          type: 'player_move',
          id: clientId,
          x: client.x, y: client.y,
          angle: client.angle,
          velX: client.velX, velY: client.velY
        }, clientId);
        break;
      }

      // ── PLAYER SHOOT ──
      case 'shoot': {
        if (!currentLobby || !currentLobby.started) break;
        broadcast(currentLobby, {
          type: 'player_shoot',
          id: clientId,
          x: msg.x, y: msg.y,
          angle: msg.angle
        }, clientId);
        break;
      }

      // ── HIT (client reports hitting another player or enemy) ──
      case 'hit': {
        if (!currentLobby || !currentLobby.started) break;
        const lobby = currentLobby;

        if (msg.targetType === 'player') {
          // PvP — shooter hits another player
          if (lobby.mode !== 'pvp') break;
          const target = lobby.clients.get(msg.targetId);
          if (!target || !target.alive) break;
          target.hp = Math.max(0, target.hp - (msg.damage || 20));
          if (target.hp <= 0) {
            target.alive = false;
            const shooter = lobby.clients.get(clientId);
            if (shooter) shooter.kills++;
            broadcastAll(lobby, { type: 'player_died', id: msg.targetId, killerId: clientId });
            checkGameOver(lobby);
          } else {
            target.ws.send(JSON.stringify({ type: 'take_damage', damage: msg.damage || 20, killerId: clientId }));
          }
        } else if (msg.targetType === 'enemy') {
          // Coop — hit shared enemy (host authoritative)
          broadcastAll(lobby, {
            type: 'enemy_hit',
            enemyId: msg.enemyId,
            damage: msg.damage || 20,
            shooterId: clientId
          });
        }
        break;
      }

      // ── ENEMY KILLED (reported by any client) ──
      case 'enemy_killed': {
        if (!currentLobby || !currentLobby.started) break;
        const killer = currentLobby.clients.get(clientId);
        if (killer) killer.kills++;
        broadcastAll(currentLobby, {
          type: 'enemy_killed',
          enemyId: msg.enemyId,
          killerId: clientId
        });
        break;
      }

      // ── PLAYER DIED (PvE — killed by enemy) ──
      case 'i_died': {
        if (!currentLobby || !currentLobby.started) break;
        const client = currentLobby.clients.get(clientId);
        if (client) client.alive = false;
        broadcastAll(currentLobby, { type: 'player_died', id: clientId, killerId: 'enemy' });
        checkGameOver(currentLobby);
        break;
      }

      // ── CHAT / PING ──
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!currentLobby) return;
    currentLobby.clients.delete(clientId);

    if (currentLobby.clients.size === 0) {
      lobbies.delete(currentLobby.code);
      return;
    }

    // Transfer host if host left
    if (currentLobby.hostId === clientId) {
      currentLobby.hostId = currentLobby.clients.keys().next().value;
    }

    broadcastAll(currentLobby, {
      type: 'player_left',
      id: clientId,
      lobby: getLobbyInfo(currentLobby)
    });

    if (currentLobby.started) checkGameOver(currentLobby);
  });
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function generateSpawns(count) {
  const spawns = [];
  const margin = 150;
  const mapW = 2000, mapH = 2000;
  for (let i = 0; i < count; i++) {
    // Spread players around the map
    const angle = (i / count) * Math.PI * 2;
    const r = 600;
    spawns.push({
      x: mapW/2 + Math.cos(angle) * r,
      y: mapH/2 + Math.sin(angle) * r
    });
  }
  return spawns;
}

function checkGameOver(lobby) {
  const alive = Array.from(lobby.clients.values()).filter(c => c.alive);
  if (lobby.mode === 'pvp') {
    if (alive.length <= 1) {
      const winner = alive[0] || null;
      broadcastAll(lobby, {
        type: 'game_over',
        winnerId: winner ? winner.id : null,
        scores: Array.from(lobby.clients.values()).map(c => ({
          id: c.id, name: c.name, kills: c.kills, alive: c.alive
        }))
      });
      lobby.started = false;
    }
  } else {
    // Coop — game over when all dead
    if (alive.length === 0) {
      broadcastAll(lobby, {
        type: 'game_over',
        winnerId: null,
        scores: Array.from(lobby.clients.values()).map(c => ({
          id: c.id, name: c.name, kills: c.kills
        }))
      });
      lobby.started = false;
    }
  }
}

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`DARKZONE server running on port ${PORT}`);
});
