package main

import (
	"context"
	"encoding/json"
	"io/fs"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"foldstrike"
)

type MessageType string

const (
	MessageTypeJoin    MessageType = "join"
	MessageTypeShot    MessageType = "shot"
	MessageTypeRematch MessageType = "rematch"
	MessageTypeWelcome MessageType = "welcome"
	MessageTypeState   MessageType = "state"
)

const (
	phaseLobby  = "lobby"
	phaseBattle = "battle"
	phaseOver   = "over"
)

const (
	viewYou  = "you"
	viewOpp  = "opp"
	viewDraw = "draw"
)

const (
	winnerNone = -1
	winnerDraw = -2
)

const (
	StickmanCount = 8
	HitRadius     = 0.075
	stickmanW     = 0.06
	stickmanH     = 0.15
	HalfAspect    = 8.0 / 9.0
	maxPlayers    = 2
	spectatorSeat = -1
	maxSpectators = 16
	xMargin       = 0.02
	yMargin       = 0.04
	initialGap    = 0.03
)

type JoinMessage struct {
	Type MessageType `json:"type"`
}

type ShotMessage struct {
	Type MessageType `json:"type"`
	X    float64     `json:"x"`
	Y    float64     `json:"y"`
}

type RematchMessage struct {
	Type MessageType `json:"type"`
}

type WelcomeMessage struct {
	Type      MessageType `json:"type"`
	Seat      int         `json:"seat"`
	Spectator bool        `json:"spectator"`
}

type StateMessage struct {
	Type     MessageType `json:"type"`
	Phase    string      `json:"phase"`
	Winner   string      `json:"winner"`
	YouScore int         `json:"youScore"`
	OppScore int         `json:"oppScore"`
	Round    int         `json:"round"`
	Turn     string      `json:"turn"`
	Own      []Stickman  `json:"own"`
	Opp      []Stickman  `json:"opp"`
	Shots    []ShotView  `json:"shots"`
}

type Shot struct {
	X   float64
	Y   float64
	By  int
	Hit bool
}

type ShotView struct {
	X   float64 `json:"x"`
	Y   float64 `json:"y"`
	Hit bool    `json:"hit"`
	By  string  `json:"by"`
}

type Stickman struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
	Dead bool    `json:"dead"`
}

func remaining(st []Stickman) int {
	n := 0
	for _, s := range st {
		if !s.Dead {
			n++
		}
	}
	return n
}

func (s Stickman) cx() float64 { return s.X + s.W/2 }

func (s Stickman) cy() float64 { return s.Y + s.H/2 }

func (s Stickman) hit(x, y float64) bool {
	dx := (x - s.cx()) * HalfAspect
	dy := y - s.cy()
	return dx*dx+dy*dy <= HitRadius*HitRadius
}

type peer struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

type Player struct {
	peer     *peer
	stickmen []Stickman
}

type outbound struct {
	to      *peer
	payload any
}

type Room struct {
	mu         sync.Mutex
	players    []*Player
	spectators []*peer
	phase      string
	scores     [maxPlayers]int
	winner     int
	turn       int
	shots      []Shot
	rng        *rand.Rand
}

func newRoom() *Room {
	return &Room{
		phase:  phaseLobby,
		winner: winnerNone,
		rng:    rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

func (r *Room) randSrc() *rand.Rand {
	if r.rng == nil {
		r.rng = rand.New(rand.NewSource(time.Now().UnixNano()))
	}
	return r.rng
}

func (r *Room) seatOf(p *peer) int {
	for i, pl := range r.players {
		if pl.peer == p {
			return i
		}
	}
	return -1
}

func (r *Room) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()

	return len(r.players)
}

func (r *Room) spectatorCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()

	return len(r.spectators)
}

func indexOfPeer(list []*peer, p *peer) int {
	for i, q := range list {
		if q == p {
			return i
		}
	}
	return -1
}

func (r *Room) join(p *peer) (bool, bool, []outbound) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.players) >= maxPlayers {
		if len(r.spectators) >= maxSpectators {
			return false, false, nil
		}
		r.spectators = append(r.spectators, p)
		welcome := []outbound{
			{to: p, payload: WelcomeMessage{
				Type:      MessageTypeWelcome,
				Seat:      spectatorSeat,
				Spectator: true,
			}},
		}
		return true, true, append(welcome, r.broadcastLocked()...)
	}

	seat := len(r.players)
	r.players = append(r.players, &Player{
		peer:     p,
		stickmen: generateStickmen(r.randSrc()),
	})

	if len(r.players) == maxPlayers {
		// Regenerate both boards: a player that stayed through a disconnect
		// would otherwise start the match on a damaged one.
		for _, pl := range r.players {
			pl.stickmen = generateStickmen(r.randSrc())
		}
		r.phase = phaseBattle
		r.scores = [maxPlayers]int{}
		r.winner = winnerNone
		r.turn = r.randSrc().Intn(maxPlayers) // coin toss for the opening shot
		r.shots = nil
	}

	outs := []outbound{
		{to: p, payload: WelcomeMessage{Type: MessageTypeWelcome, Seat: seat}},
	}
	return true, false, append(outs, r.broadcastLocked()...)
}

func (r *Room) shot(p *peer, x, y float64) []outbound {
	r.mu.Lock()
	defer r.mu.Unlock()

	seat := r.seatOf(p)
	if seat < 0 || r.phase != phaseBattle {
		return nil
	}
	if seat != r.turn {
		return nil
	}
	if !(x >= 0 && x <= 1 && y >= 0 && y <= 1) {
		return nil
	}

	opp := r.players[seat^1]
	hit := -1
	for i, s := range opp.stickmen {
		if !s.Dead && s.hit(x, y) {
			hit = i
			break
		}
	}

	r.shots = append(r.shots, Shot{X: x, Y: y, By: seat, Hit: hit >= 0})
	if hit >= 0 {
		opp.stickmen[hit].Dead = true
		r.scores[seat]++
	}
	// Hand the turn over, hit or miss.
	r.turn = 1 - seat

	// Settle at a round boundary, never on the shot that empties a board.
	if len(r.shots)%2 == 0 {
		empty := func(i int) bool { return remaining(r.players[i].stickmen) == 0 }
		switch {
		case empty(0) && empty(1):
			r.phase, r.winner = phaseOver, winnerDraw
		case empty(seat ^ 1):
			r.phase, r.winner = phaseOver, seat // opponent wiped, shooter intact
		case empty(seat):
			r.phase, r.winner = phaseOver, seat^1
		}
	}

	return r.broadcastLocked()
}

func (r *Room) rematch(p *peer) []outbound {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.phase != phaseOver || len(r.players) != maxPlayers || r.seatOf(p) < 0 {
		return nil
	}

	for _, pl := range r.players {
		pl.stickmen = generateStickmen(r.randSrc())
	}
	r.scores = [maxPlayers]int{}
	r.winner = winnerNone
	r.turn = r.randSrc().Intn(maxPlayers)
	r.shots = nil
	r.phase = phaseBattle

	return r.broadcastLocked()
}

func (r *Room) leave(p *peer) []outbound {
	r.mu.Lock()
	defer r.mu.Unlock()

	if i := indexOfPeer(r.spectators, p); i >= 0 {
		r.spectators = append(r.spectators[:i], r.spectators[i+1:]...)
		return nil
	}

	seat := r.seatOf(p)
	if seat < 0 {
		return nil
	}
	r.players = append(r.players[:seat], r.players[seat+1:]...)
	r.phase = phaseLobby
	r.scores = [maxPlayers]int{}
	r.winner = winnerNone
	r.turn = 0 // lobby: a fresh battle picks the turn again
	r.shots = nil

	return r.broadcastLocked()
}

func (r *Room) broadcastLocked() []outbound {
	outs := make([]outbound, 0, len(r.players)+len(r.spectators))
	for seat, pl := range r.players {
		outs = append(outs, outbound{to: pl.peer, payload: r.stateLocked(seat)})
	}
	for _, sp := range r.spectators {
		outs = append(outs, outbound{to: sp, payload: r.stateLocked(spectatorSeat)})
	}
	return outs
}

func (r *Room) stateLocked(viewer int) StateMessage {
	seat := viewer
	if seat < 0 {
		seat = 0
	}
	own := seat < len(r.players)
	opp := own && len(r.players) == maxPlayers

	st := StateMessage{
		Type:     MessageTypeState,
		Phase:    r.phase,
		YouScore: r.scores[seat],
		Own:      make([]Stickman, 0, StickmanCount),
		Opp:      make([]Stickman, 0, StickmanCount),
		Shots:    make([]ShotView, 0, len(r.shots)),
	}
	if opp {
		st.OppScore = r.scores[seat^1]
	}
	if r.phase == phaseOver {
		switch r.winner {
		case winnerDraw:
			st.Winner = viewDraw
		case seat:
			st.Winner = viewYou
		default:
			st.Winner = viewOpp
		}
	}
	if r.phase == phaseBattle {
		st.Round = 1 + len(r.shots)/2
		if r.turn == seat {
			st.Turn = viewYou
		} else {
			st.Turn = viewOpp
		}
	}

	if own {
		st.Own = append(st.Own, r.players[seat].stickmen...)
	}
	if opp {
		for _, s := range r.players[seat^1].stickmen {
			st.Opp = append(st.Opp, Stickman{
				X:    1 - (s.X + s.W), // mirror the stored span inside the half
				Y:    s.Y,
				W:    s.W,
				H:    s.H,
				Dead: s.Dead,
			})
		}
	}

	for _, sh := range r.shots {
		v := ShotView{X: sh.X, Y: sh.Y, Hit: sh.Hit, By: viewYou}
		if sh.By != seat {
			v.X = 1 - sh.X
			v.By = viewOpp
		}
		st.Shots = append(st.Shots, v)
	}
	return st
}

func generateStickmen(rnd *rand.Rand) []Stickman {
	items := make([]Stickman, 0, StickmanCount)
	gap := initialGap
	fails := 0
	for len(items) < StickmanCount {
		s := Stickman{
			X: xMargin + rnd.Float64()*(1-stickmanW-2*xMargin),
			Y: yMargin + rnd.Float64()*(1-stickmanH-2*yMargin),
			W: stickmanW,
			H: stickmanH,
		}
		if separatedFromAll(s, items, gap) {
			items = append(items, s)
			gap, fails = initialGap, 0
			continue
		}
		fails++
		if fails%64 == 0 {
			// Halve the gap rather than loop forever.
			if gap /= 2; gap < 0.001 {
				gap = 0
			}
		}
	}
	return items
}

func separatedFromAll(s Stickman, others []Stickman, gap float64) bool {
	for _, o := range others {
		if !separated(s, o, gap) {
			return false
		}
	}
	return true
}

func separated(a, b Stickman, gap float64) bool {
	return a.X+a.W+gap <= b.X ||
		b.X+b.W+gap <= a.X ||
		a.Y+a.H+gap <= b.Y ||
		b.Y+b.H+gap <= a.Y
}

func writeAll(outs []outbound) {
	for _, o := range outs {
		if o.to == nil || o.to.conn == nil {
			continue
		}
		o.to.mu.Lock()
		err := o.to.conn.WriteJSON(o.payload)
		o.to.mu.Unlock()
		if err != nil {
			log.Println("Write error:", err)
		}
	}
}

var room = newRoom()

var upgrader = websocket.Upgrader{}

func wsHandler(w http.ResponseWriter, req *http.Request) {
	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	p := &peer{conn: conn}

	defer conn.Close()
	joined := false
	defer func() {
		if joined {
			writeAll(room.leave(p))
			log.Printf("connection left; room has %d/%d, %d watching",
				room.count(), maxPlayers, room.spectatorCount())
		}
	}()

	for {
		var raw json.RawMessage
		if err := conn.ReadJSON(&raw); err != nil {
			return
		}
		var env struct {
			Type MessageType `json:"type"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			log.Println("Decode error:", err)
			continue
		}

		switch env.Type {
		case MessageTypeJoin:
			if joined {
				continue // one join per connection
			}
			var m JoinMessage
			if err := json.Unmarshal(raw, &m); err != nil {
				log.Println("Decode error:", err)
				continue
			}
			admitted, spectator, outs := room.join(p)
			if !admitted {
				log.Println("Room and spectator list full; rejecting join")
				return
			}
			joined = true
			writeAll(outs)
			role := "player"
			if spectator {
				role = "spectator"
			}
			log.Printf("%s joined; %d/%d playing, %d watching",
				role, room.count(), maxPlayers, room.spectatorCount())

		case MessageTypeShot:
			var m ShotMessage
			if err := json.Unmarshal(raw, &m); err != nil {
				log.Println("Decode error:", err)
				continue
			}
			writeAll(room.shot(p, m.X, m.Y))

		case MessageTypeRematch:
			var m RematchMessage
			if err := json.Unmarshal(raw, &m); err != nil {
				log.Println("Decode error:", err)
				continue
			}
			writeAll(room.rematch(p))

		default:
			log.Printf("unknown message type %q", env.Type)
		}
	}
}

const shutdownTimeout = 10 * time.Second

func main() {
	static, err := fs.Sub(foldstrike.PublicFS, "public")
	if err != nil {
		log.Fatalf("open embedded public: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/ws", wsHandler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		log.Println("Shutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Println("Shutdown error:", err)
		}
	}()

	log.Printf("Server listening on http://0.0.0.0:%s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
