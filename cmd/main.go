package main

import (
	"encoding/json"
	"log"
	"math"
	"math/rand"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// MessageType classifies a JSON message on the wire.
type MessageType string

const (
	// MessageTypeJoin is a client requesting to join the game.
	MessageTypeJoin MessageType = "join"
	// MessageTypeShot is a client placing a dot (shot) on its own half.
	MessageTypeShot MessageType = "shot"
	// MessageTypeStickmen carries generated target stickmen to a client.
	MessageTypeStickmen MessageType = "stickmen"
	// MessageTypeAck echoes a received message back to the sender.
	MessageTypeAck MessageType = "ack"
)

// StickmanCount is the number of target stickmen placed on the board.
const StickmanCount = 5

// Message is the JSON envelope exchanged over the WebSocket.
//
// The `type` field selects the payload shape, so each message carries only
// the fields it needs. On read we first decode just the type, then unmarshal
// the same bytes into the matching struct below.
//
// Client → server (shot):
//
//	{"type":"shot","x":0.42,"y":0.75}
//
// Server → client (ack):
//
//	{"type":"ack"}
//
// x/y are normalized relative coordinates in 0..1, independent of the
// canvas/paper size, so both sides always communicate the same way.
type Message struct {
	Type MessageType `json:"type"`
}

// ShotMessage places a dot (shot) on the player's own half. Only this type
// carries coordinates.
type ShotMessage struct {
	Type MessageType `json:"type"`
	X    float64     `json:"x"`
	Y    float64     `json:"y"`
}

// AckMessage echoes a received message back to the sender. No coordinates.

// Stickman is a target token rendered as a red rectangle (a placeholder for
// the actual stickman figure). Coordinates are normalized 0–1 within the
// player's own half of the paper.
type Stickman struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// maxPlayers is the number of clients a single room holds. The game only
// starts once this many have joined.
const maxPlayers = 2

// client is one connected player. The room owns the slice of clients so it can
// later broadcast game state to exactly the two people in the match.
type client struct {
	conn *websocket.Conn
}

// Room is a single 1v1 match. It tracks the clients joined to it and caps at
// maxPlayers. One room exists for the whole server; more rooms come later.
type Room struct {
	mu       sync.Mutex
	clients  []*client
	stickmen []Stickman
}

// add registers a new client and reports whether it was admitted. It returns
// false — and the caller should reject the connection — only if the room is
// already full. Whether this join completed the pair is a separate question:
// the caller reads the room size after add, not its return value.
func (r *Room) add(conn *websocket.Conn) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.clients) >= maxPlayers {
		return false
	}
	r.clients = append(r.clients, &client{conn})
	return true
}

// count is the number of clients in the room, read under the lock.
func (r *Room) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()

	return len(r.clients)
}

// remove drops a client when its connection closes, keeping the slice tidy.
func (r *Room) remove(conn *websocket.Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i, c := range r.clients {
		if c.conn == conn {
			r.clients = append(r.clients[:i], r.clients[i+1:]...)
			break
		}
	}
}

// room is the single match the whole server hosts. One room for now.
var room Room

var upgrader = websocket.Upgrader{}

// wsHandler is an echo handler: it reads a JSON message, logs it, and
// writes it back to the same connection. Replace the echo with real
// game-loop handling later.
func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}

	// Membership is admitted on `join`, not on connect: a raw socket isn't a
	// promise to play. `joined` tracks whether this conn was added to the room,
	// so disconnect cleanup only removes it if it was ever added.
	joined := false
	defer func() {
		if joined {
			room.remove(conn)
			log.Printf("player left; room has %d/%d", room.count(), maxPlayers)
		}
	}()

	for {
		// Read the full envelope as raw bytes once.
		var raw json.RawMessage
		if err := conn.ReadJSON(&raw); err != nil {
			return
		}

		// Decode only the discriminator to pick the payload shape.
		var env struct {
			Type MessageType `json:"type"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			log.Println("Decode error:", err)
			continue
		}

		switch env.Type {
		case MessageTypeJoin:
			// Admit into the room only now. If it's full, reject and close.
			if !room.add(conn) {
				log.Println("Room full; rejecting join")
				conn.Close()
				return
			}
			joined = true
			log.Printf("player joined; room has %d/%d", room.count(), maxPlayers)

			// Send this player their target stickmen now that they're in the room.
			stickmen := generateStickmen()
			if err := conn.WriteJSON(struct {
				Type  MessageType `json:"type"`
				Items []Stickman  `json:"items"`
			}{Type: MessageTypeStickmen, Items: stickmen}); err != nil {
				log.Println("Write error:", err)
				return
			}

			if room.count() == maxPlayers {
				// Two players are now in the room. The game can start from here;
				// the round loop will live here once the battle logic is built.
				log.Println("Second player joined — room ready, game can start (future)")
			}

		case MessageTypeShot:
			// Coordinates are expected only here.
			var s ShotMessage
			if err := json.Unmarshal(raw, &s); err != nil {
				log.Println("Decode error:", err)
				continue
			}
			log.Printf("shot x:%v y:%v", s.X, s.Y)

			// Reply to the player's shot with an ack so the round-trip is visible.
			if err := conn.WriteJSON(&Message{Type: MessageTypeAck}); err != nil {
				log.Println("Write error:", err)
				return
			}

		default:
			log.Printf("type:%s", env.Type)
		}
	}
}

// generateStickmen builds N random target positions on the player's own half
// (left half: nx in 0..0.5, full height ny in 0..1). Each target is a red
// rectangle for now; it will be replaced by an actual stickman figure.
func generateStickmen() []Stickman {
	items := make([]Stickman, 0, StickmanCount)
	width := 0.06
	height := 0.20
	for i := 0; i < StickmanCount; i++ {
		items = append(items, Stickman{
			X: math.Max(0, rand.Float64() * 0.5 - width), // own half
			Y: math.Max(0, rand.Float64() - height),       // full height
			W: width,                 // ~6% of paper width
			H: height,                 // ~20% of paper height
		})
	}
	return items
}

func main() {
	http.Handle("/", http.FileServer(http.Dir("./public")))
	http.HandleFunc("/ws", wsHandler)

	log.Println("Server listening on http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
