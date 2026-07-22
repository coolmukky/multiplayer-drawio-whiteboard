# 🖊️ Multiplayer draw.io Whiteboard

A live, interactive whiteboard where **a group of people can draw together in
real time** on a shared [draw.io](https://www.drawio.com) (diagrams.net) canvas.

Open the page, pick a room, share the link — everyone who joins the same room
sees the same board and every edit syncs instantly. Includes presence
(who's on the board), live pointer indicators, and a room chat.

> This is a self-contained project living in the `multiplayer-whiteboard/`
> directory. It has no dependency on the rest of the repository and can be
> lifted into its own repo at any time.

---

## ✨ Features

- **Real-time collaborative drawing** — the full draw.io editor, embedded, with
  every change broadcast to all participants via WebSockets.
- **Rooms** — anyone with the room name (or shared URL) lands on the same board.
- **Live presence** — avatars in the top bar and a people list in the side
  panel show who is currently on the board, each with a unique colour.
- **Remote pointers** — see where other participants are moving on the canvas.
- **Room chat** — a lightweight chat panel next to the board.
- **Late-join sync** — the server keeps the latest diagram so people who join
  mid-session immediately see the current state.
- **Auto-reconnect** — the client transparently reconnects if the socket drops.

## 🧱 How it works

```
Browser ──postMessage──► draw.io <iframe> (embed.diagrams.net)
   │                          (fires "autosave" with full XML on every edit)
   │
   └──WebSocket──► Node server ──broadcast──► every other browser in the room
```

1. The editor is the official draw.io **embed** build, loaded in an `<iframe>`
   and driven over the JSON [embed protocol](https://www.drawio.com/doc/faq/embed-mode).
2. When you draw, draw.io emits an `autosave` event containing the diagram XML.
   The client sends that XML over a WebSocket to the server.
3. The server stores it as the room's latest state and relays it to every other
   participant, whose editors reload the XML. A short suppression window
   prevents echo/feedback loops.

Everything is **in-memory** — no database, no build step, no accounts. Rooms
exist as long as someone is in them.

## 🚀 Getting started

Requirements: **Node.js 18+**.

```bash
cd multiplayer-whiteboard
npm install
npm start
```

Then open **http://localhost:3000** in a couple of browser tabs (or share your
machine's address with teammates on the same network / a tunnel), enter the
same room name in each, and start drawing together.

Set a custom port with `PORT=8080 npm start`.

## 🗂️ Project structure

```
multiplayer-whiteboard/
├── server.js            # Express static server + WebSocket sync hub
├── package.json
├── public/
│   ├── index.html       # App shell (join screen + editor + side panel)
│   ├── styles.css       # UI styling
│   └── app.js           # draw.io embed protocol + WebSocket client logic
├── LICENSE              # MIT
└── README.md
```

## 🔌 WebSocket message protocol

Small JSON messages flow both ways over a single socket:

| Type       | Direction        | Purpose                                    |
| ---------- | ---------------- | ------------------------------------------ |
| `join`     | client → server  | Join a room with a display name            |
| `welcome`  | server → client  | Assigned id/colour + current board + users |
| `presence` | server → client  | Updated participant roster                 |
| `diagram`  | both ways        | Full diagram XML (a board change)          |
| `cursor`   | both ways        | Fractional pointer position                |
| `chat`     | both ways        | A chat message                             |
| `system`   | server → client  | Join/leave notices                         |
| `left`     | server → client  | A participant disconnected                 |

## ⚠️ Notes & limitations

- **Concurrency model:** the whole diagram is replaced on each change (last
  write wins). This is simple and robust for typical group whiteboarding, but is
  not an operational-transform / CRDT engine — two people editing the *exact*
  same shape at the same instant may clobber each other. For most sessions this
  is imperceptible thanks to draw.io's frequent autosave granularity.
- **Persistence:** rooms live in memory and are cleared when empty. Drop in a
  small key/value store in `server.js` if you want boards to survive restarts.
- **Deployment:** any host that runs Node and allows WebSocket upgrades works
  (Render, Railway, Fly.io, a VPS, etc.). The client picks `ws`/`wss`
  automatically from the page protocol.

## 📄 License

MIT — see [LICENSE](./LICENSE).
