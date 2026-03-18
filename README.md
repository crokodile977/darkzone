# DARKZONE — Multiplayer Setup

## Структура проекта

```
darkzone/
├── server.js          # WebSocket + Express сервер
├── package.json       # Зависимости
├── public/
│   └── index.html     # Игровой клиент
└── README.md
```

## Деплой на Railway

### 1. Подготовка GitHub репозитория

```bash
git init
git add .
git commit -m "init darkzone"
git branch -M main
git remote add origin https://github.com/ТВОЙ_ЛОГИН/darkzone.git
git push -u origin main
```

### 2. Railway

1. Зайди на [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Выбери репозиторий `darkzone`
4. Railway автоматически найдёт `package.json` и запустит `npm start`
5. После деплоя нажми **Generate Domain** в настройках сервиса
6. Скопируй URL вида `https://darkzone-xxx.railway.app`

### 3. Настройка клиента

В файле `public/index.html` найди строку:
```js
const WS_URL = 'AUTO';
```
Если стоит `'AUTO'` — клиент сам определит адрес сервера (работает когда клиент раздаётся тем же сервером).

## WebSocket протокол

### Клиент → Сервер

| type | поля | описание |
|------|------|----------|
| `create` | name, mode, difficulty | Создать лобби |
| `join` | code, name | Войти в лобби |
| `settings` | mode?, difficulty? | Изменить настройки (только хост) |
| `start` | — | Начать игру (только хост) |
| `move` | x, y, angle, velX, velY | Позиция игрока каждый тик |
| `shoot` | x, y, angle | Выстрел |
| `hit` | targetType, targetId/enemyId, damage | Попадание |
| `enemy_killed` | enemyId | Враг убит |
| `i_died` | — | Игрок умер от врага |
| `ping` | t | Проверка связи |

### Сервер → Клиент

| type | описание |
|------|----------|
| `created` | Лобби создано, получаешь code |
| `joined` | Успешно вошёл в лобби |
| `lobby_update` | Состояние лобби изменилось |
| `game_start` | Игра началась, позиции всех игроков |
| `player_move` | Другой игрок переместился |
| `player_shoot` | Другой игрок выстрелил |
| `player_died` | Игрок умер |
| `take_damage` | Ты получил урон |
| `enemy_hit` | Враг получил урон |
| `enemy_killed` | Враг убит |
| `player_left` | Игрок вышел |
| `game_over` | Игра закончена + результаты |
| `error` | Ошибка (лобби не найдено и т.д.) |
| `pong` | Ответ на ping |
