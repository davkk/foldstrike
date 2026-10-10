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

// MessageType classifies a JSON message on the wire. The `type` field of
// every envelope picks both the direction and the payload shape, so each
// message carries only the fields it needs.
type MessageType string

const (
	// MessageTypeJoin is a client asking to enter the room (once per connection).
	MessageTypeJoin MessageType = "join"
	// MessageTypeShot is a client firing a dot on its own half.
	MessageTypeShot MessageType = "shot"
	// MessageTypeRematch is a client asking to restart after game over.
	MessageTypeRematch MessageType = "rematch"
	// MessageTypeWelcome tells a freshly admitted connection its 0-based seat.
	MessageTypeWelcome MessageType = "welcome"
	// MessageTypeState is the full server -> client snapshot of the room.
	MessageTypeState MessageType = "state"
)

// Game phases a room moves through: lobby -> battle -> over -> battle ...
const (
	phaseLobby  = "lobby"
	phaseBattle = "battle"
	phaseOver   = "over"
)

// Viewer-relative labels as they appear on the wire. Several fields speak
// about the game from the RECEIVER's point of view — the outcome, whose turn
// it is, and whose dot this is — and they all say "you" or "opp", never a
// seat number. viewDraw is the third outcome: a round that wiped both boards.
// The client compares against these exact literals.
const (
	viewYou  = "you"
	viewOpp  = "opp"
	viewDraw = "draw"
)

// Values for Room.winner, which stores a seat plus two states that are not a
// seat. winnerNone means nobody has won yet; winnerDraw means the deciding
// round wiped both boards, which is why a battle no longer ends on the shot
// that empties a board.
const (
	winnerNone = -1
	winnerDraw = -2
)

const (
	// StickmanCount is how many stickmen each player gets when they join or
	// when a rematch regenerates the board.
	StickmanCount = 8
	// HitRadius is the hit-circle radius around a stickman centre, in the
	// owner's local coordinates — which is also the radius as a fraction of
	// the PAPER'S height, because the hit test normalises both axes into that
	// unit (see HalfAspect). It is sized to the drawn figure: the stickman's
	// ink spans about 0.147 of the paper height, so a circle of 0.075 covers
	// it head to feet without scoring from well outside the drawing.
	HitRadius = 0.075
	// stickmanW is the stored rectangle width in the owner's local frame.
	// Local x spans HALF the paper width, so the client scales it by 0.5.
	stickmanW = 0.06
	// stickmanH is the stored rectangle height in the owner's local frame.
	// Local y spans the FULL paper height.
	stickmanH = 0.15
	// HalfAspect weights local x in the hit test: local x covers half of the
	// 16:9 paper (8 units) while local y covers the full height (9 units), so
	// x is scaled by 8/9 to make the hit circle round in screen space.
	HalfAspect = 8.0 / 9.0
	// maxPlayers caps a room; the battle starts when the room is full.
	maxPlayers = 2
	// xMargin / yMargin keep generated stickmen off the paper edges of their
	// own half (local 0..1 spans that half).
	xMargin = 0.02
	yMargin = 0.04
	// initialGap is the separation kept between generated stickmen. It is
	// halved after repeated rejection-sample failures so generation always
	// terminates, rather than looping forever.
	initialGap = 0.03
)

// JoinMessage admits a connection into the room. It carries no fields beyond
// the discriminator: {"type":"join"}.
type JoinMessage struct {
	Type MessageType `json:"type"`
}

// ShotMessage fires a dot at (x, y) in the SHOOTER's own local frame
// (x = 0 outer edge, x = 1 fold; y = 0 top, y = 1 bottom). Coordinates
// outside 0..1 on either axis are rejected by the room.
type ShotMessage struct {
	Type MessageType `json:"type"`
	X    float64     `json:"x"`
	Y    float64     `json:"y"`
}

// RematchMessage restarts the game. Honoured only in phase "over" with two
// players: {"type":"rematch"}.
type RematchMessage struct {
	Type MessageType `json:"type"`
}

// WelcomeMessage is the first server -> client message of a session. It
// assigns the connection its 0-based seat in the room.
type WelcomeMessage struct {
	Type MessageType `json:"type"`
	Seat int         `json:"seat"`
}

// StateMessage is the full room snapshot, re-sent on every change (join,
// second player, each shot, rematch, disconnect). The client re-renders from
// the latest state and keeps no history beyond the last message.
//
// Everything in it is already in the VIEWER's display frame, so the client
// does zero per-player switching: own stickmen/dots are sent as stored (drawn
// in the LEFT half at paperX = u*0.5) and opponent ones arrive mirrored (drawn
// in the RIGHT half at paperX = 0.5 + u*0.5), which puts a target exactly
// where the viewer's own mirrored shot will land. See stateLocked for the
// exact transforms.
type StateMessage struct {
	Type  MessageType `json:"type"`
	Phase string      `json:"phase"`
	// Winner speaks the outcome from the RECEIVER's point of view: "you",
	// "opp", or "draw" — the last when the deciding round wiped both boards.
	// Empty unless phase is "over".
	Winner   string `json:"winner"`
	YouScore int    `json:"youScore"`
	OppScore int    `json:"oppScore"`
	// Round counts the pairs of shots played: 1 while the first two shots are
	// outstanding, 2 after both players have fired once, and so on. Zero
	// outside battle.
	Round int `json:"round"`
	// Turn is whose shot is due next, from the RECEIVER's point of view:
	// "you" or "opp" during battle, the empty string otherwise. The client
	// uses it to gate the click and to label the turn banner.
	Turn  string     `json:"turn"`
	Own   []Stickman `json:"own"`
	Opp   []Stickman `json:"opp"`
	Shots []ShotView `json:"shots"`
}

// Shot is the server-side record of a fired dot. X/Y are stored in the
// SHOOTER's own local frame and By is the shooter's seat. The record is
// never marshalled directly: stateLocked turns it into a viewer-relative
// ShotView.
type Shot struct {
	X   float64
	Y   float64
	By  int
	Hit bool
}

// ShotView is one dot as sent to a specific viewer. By is the literal
// "you" or "opp", and X is already flipped (1-u) when the dot belongs to
// the opponent, so it lines up with the mirrored opponent half.
type ShotView struct {
	X   float64 `json:"x"`
	Y   float64 `json:"y"`
	Hit bool    `json:"hit"`
	By  string  `json:"by"`
}

// Stickman is a target token stored in its OWNER's local frame: u, v each in
// 0..1, where u = 0 is the owner's outer edge, u = 1 the fold line, v = 0 the
// top and v = 1 the bottom of the paper. Because a shot at local (u, v)
// lands at the target's local (u, v) after mirroring, the hit test compares
// the shooter's raw coordinates directly against these stored values — the
// server never pre-mirrors for the hit test, only for display.
//
// A hit stickman is NOT deleted: it stays in the list with Dead set, so the
// board keeps a grave where it fell (the client draws it) and both players
// can still see what has been wiped out. Dead tokens are skipped by the hit
// test and no longer count toward the wipe.
type Stickman struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
	// Dead marks a stickman a shot already got; it stays on the board as a
	// grave. Zero value (alive) is what generation produces.
	Dead bool `json:"dead"`
}

// remaining counts the stickmen still standing in a player's army — that is,
// every one a shot has not yet got. The wipe check runs on this, never on
// len(stickmen), because graves stay in the list.
func remaining(st []Stickman) int {
	n := 0
	for _, s := range st {
		if !s.Dead {
			n++
		}
	}
	return n
}

// cx is the stickman centre along local x.
func (s Stickman) cx() float64 { return s.X + s.W/2 }

// cy is the stickman centre along local y.
func (s Stickman) cy() float64 { return s.Y + s.H/2 }

// hit reports whether a shot at local (x, y) lands within HitRadius of this
// stickman's centre. Local x spans half the paper width while local y spans
// the full height, so dx is scaled by HalfAspect to keep the test isotropic
// (a round hit circle on screen, not a squashed one).
func (s Stickman) hit(x, y float64) bool {
	dx := (x - s.cx()) * HalfAspect
	dy := y - s.cy()
	return dx*dx+dy*dy <= HitRadius*HitRadius
}

// peer is one connection plus the mutex gorilla/websocket requires: only one
// goroutine may write to a conn at a time, and a broadcast triggered by the
// OTHER player's handler targets this conn too. The room stores peers by
// pointer and compares them to route shots/leaves to the right seat; a peer
// may carry a nil conn, which writeAll skips.
type peer struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

// Player is one seat in a room: its connection and the stickmen it owns on
// its half of the paper. The index of a Player in Room.players IS its seat.
type Player struct {
	peer     *peer
	stickmen []Stickman
}

// outbound is one pending server -> client write: a peer and the payload
// addressed to it. Room methods build these under their lock; the handler
// performs them after the lock is released, so a slow client can never stall
// the room. Writes for a broadcast are appended in seat order.
type outbound struct {
	to      *peer
	payload any
}

// Room is the single 1v1 match: up to maxPlayers players (index = seat), the
// current phase, per-seat scores, the winner seat while phase is "over", and
// every dot fired in the current battle. All methods are safe for concurrent
// use; each one does its work under the lock and returns the writes the
// caller must perform OUTSIDE the lock.
type Room struct {
	mu sync.Mutex
	// players is the seat list; it stays compact (0..len-1) by construction.
	players []*Player
	// phase is one of phaseLobby / phaseBattle / phaseOver.
	phase string
	// scores counts hits per seat, zeroed when a battle starts.
	scores [maxPlayers]int
	// winner is the seat that wiped the opponent, or winnerDraw/winnerNone;
	// see its constants. It is only settled at a round boundary, never on the
	// shot that empties a board.
	winner int
	// turn is the seat that fires next. The two players alternate: only this
	// seat's shot is honoured, and every honoured shot hands the turn over.
	// It is re-picked at random whenever a battle starts, so neither seat has
	// a guaranteed opening shot.
	turn int
	// shots records every dot fired in the current battle, in order, in the
	// shooter's local frame.
	shots []Shot
	// rng seeds stickman generation; lazily created so a zero-value Room works.
	rng *rand.Rand
}

// newRoom returns a Room sitting in the lobby with a fresh random source.
func newRoom() *Room {
	return &Room{
		phase:  phaseLobby,
		winner: winnerNone,
		rng:    rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// randSrc returns the room's random source, seeding it on first use. The
// caller must hold r.mu (all generation happens inside room methods).
func (r *Room) randSrc() *rand.Rand {
	if r.rng == nil {
		r.rng = rand.New(rand.NewSource(time.Now().UnixNano()))
	}
	return r.rng
}

// seatOf returns the 0-based seat of p, or -1 when p is not in the room.
// The caller must hold r.mu.
func (r *Room) seatOf(p *peer) int {
	for i, pl := range r.players {
		if pl.peer == p {
			return i
		}
	}
	return -1
}

// count is the number of players currently in the room, read under the lock.
func (r *Room) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()

	return len(r.players)
}

// join admits p, generates its stickmen and returns its welcome plus a state
// for every seat (in seat order). It returns (false, nil) — and the caller
// should close the connection — only when the room is already full. When the
// room reaches maxPlayers it flips to phase battle with zeroed scores.
func (r *Room) join(p *peer) (bool, []outbound) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.players) >= maxPlayers {
		return false, nil
	}

	seat := len(r.players)
	r.players = append(r.players, &Player{
		peer:     p,
		stickmen: generateStickmen(r.randSrc()),
	})

	if len(r.players) == maxPlayers {
		// The pair is complete: start the battle from scratch. Every seat is
		// regenerated, not just the newcomer's, because a player that stayed
		// in the room through a disconnect carries the damaged board from the
		// previous battle — nobody should start a match at a disadvantage.
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
	return true, append(outs, r.broadcastLocked()...)
}

// shot honours a dot fired by p at local (x, y), but only in phase battle,
// only for a seat in the room, and only when it is that seat's TURN — players
// alternate, one shot each, so the other player's shot is ignored until its
// turn comes round (the client already blocks the click, this is the same rule
// enforced where it counts). Coordinates outside 0..1 (including NaN, which
// fails the positive range check) are also rejected silently.
//
// The shot is tested against the OPPONENT's stored stickmen using the shooter's
// raw local coordinates — that is the mirroring trick of the design. On a hit
// the stickman is marked Dead — it stays on the board as a grave, so nobody
// loses track of what has been wiped — and the shooter scores. A hit or a miss
// alike records the dot, ends the turn and passes it on: aiming is the whole
// of the player's turn, whether the dot lands or not.
//
// Wiping the opponent's board does NOT end the battle on the spot. The other
// player keeps their shot for the round, and the outcome — win or a mutual
// wipe (draw) — is settled once the round has completed. See the decision at
// the end of the function.
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

	// Phase battle implies two players, so the opponent seat always exists.
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
	// Hand the turn over, hit or miss. With two seats the other player is
	// always 1-seat, and once the room is over the turn no longer reaches the
	// client (stateLocked only reports it during battle).
	r.turn = 1 - seat

	// Settle the battle at the ROUND boundary, never on the shot that empties
	// a board. Both players owe each other the shot their round contains, so
	// the one whose board just went empty still fires: they may answer by
	// wiping the other board back, which is a draw. Deciding here instead of
	// inside the hit block is the difference between "first to land the last
	// hit wins" and "everyone plays their move".
	//
	// Shots are recorded in order from a battle that starts with an empty
	// list, and every honoured shot hands the turn over, so the two seats
	// strictly alternate: a round is complete exactly when an even number of
	// shots have been fired, whichever seat opened. The winner is whoever
	// still has stickmen —
	// counted with remaining(), since the dead ones stay on the board as
	// graves and len(stickmen) never shrinks.
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

// rematch restarts the battle, but only in phase over with both seats filled
// and p actually in the room: it regenerates both sides' stickmen, zeroes the
// scores, drops all recorded dots and flips back to phase battle. Either
// player may trigger it.
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
	r.turn = r.randSrc().Intn(maxPlayers) // fresh coin toss for the rematch
	r.shots = nil
	r.phase = phaseBattle

	return r.broadcastLocked()
}

// leave removes p (if present), renumbers the remaining seats compactly,
// clears the recorded dots and drops the room back to phase lobby, then
// returns a state for whoever is left — they wait for a new opponent, which
// returns the room to battle when it fills again. Returns nil when p was not
// in the room (nothing changes, nothing is written).
func (r *Room) leave(p *peer) []outbound {
	r.mu.Lock()
	defer r.mu.Unlock()

	seat := r.seatOf(p)
	if seat < 0 {
		return nil
	}
	// Slicing keeps the remaining players contiguous: old seat N becomes N-1
	// for every seat after the gap.
	r.players = append(r.players[:seat], r.players[seat+1:]...)
	r.phase = phaseLobby
	r.scores = [maxPlayers]int{}
	r.winner = winnerNone
	r.turn = 0 // meaningless in the lobby; a fresh battle sets it anyway
	r.shots = nil

	return r.broadcastLocked()
}

// broadcastLocked builds one StateMessage per player, in seat order. The
// caller must hold r.mu.
func (r *Room) broadcastLocked() []outbound {
	outs := make([]outbound, 0, len(r.players))
	for seat, pl := range r.players {
		outs = append(outs, outbound{to: pl.peer, payload: r.stateLocked(seat)})
	}
	return outs
}

// stateLocked builds the full state for viewer seat `viewer`, entirely in
// that player's display frame. The transforms:
//
//   - Own stickmen: stored in the viewer's own local frame, sent as-is. The
//     client draws them in the LEFT half at paperX = u*0.5.
//   - Opponent stickmen: stored in the OPPONENT's local frame, spanning
//     x..x+w with x growing from their outer edge toward the fold. They are
//     sent as {x: 1 - (x + w), y, w, h} so the client's RIGHT-half formula
//     (paperX = 0.5 + u*0.5) lands them exactly where the viewer's mirrored
//     shot will hit: a shot at viewer-local u hits the opponent's stored
//     local u and lands at display 1 - u*0.5, which is precisely the
//     mirrored span 1-(x+w) .. 1-x mapped into the right half.
//   - Dots: the shooter's own dot is sent as-is ({x: u}); an opponent dot is
//     flipped to {x: 1 - u} for the same reason, and By becomes "you"/"opp"
//     relative to the viewer.
//   - winner is "you"/"opp"/"draw" relative to the viewer while phase is
//     over, otherwise the empty string.
//   - turn is "you"/"opp" for whichever seat fires next while phase is
//     battle, otherwise the empty string; round counts the pairs of shots
//     played in that battle.
//
// The caller must hold r.mu.
func (r *Room) stateLocked(viewer int) StateMessage {
	st := StateMessage{
		Type:     MessageTypeState,
		Phase:    r.phase,
		YouScore: r.scores[viewer],
		OppScore: r.scores[viewer^1],
		Own:      make([]Stickman, 0, len(r.players[viewer].stickmen)),
		Opp:      make([]Stickman, 0, StickmanCount),
		Shots:    make([]ShotView, 0, len(r.shots)),
	}
	// A battle that reached "over" always settled a winner or a draw at its
	// round boundary, so r.winner is a seat or winnerDraw here, never none.
	if r.phase == phaseOver {
		switch r.winner {
		case winnerDraw:
			st.Winner = viewDraw
		case viewer:
			st.Winner = viewYou
		default:
			st.Winner = viewOpp
		}
	}
	if r.phase == phaseBattle {
		// Every honoured shot is recorded in order, so the round number falls
		// straight out of the shot count: shots 0-1 are round 1, shots 2-3 are
		// round 2, and so on.
		st.Round = 1 + len(r.shots)/2
		if r.turn == viewer {
			st.Turn = viewYou
		} else {
			st.Turn = viewOpp
		}
	}

	st.Own = append(st.Own, r.players[viewer].stickmen...)
	if len(r.players) == maxPlayers {
		for _, s := range r.players[viewer^1].stickmen {
			st.Opp = append(st.Opp, Stickman{
				X: 1 - (s.X + s.W), // mirror the stored span inside the half
				Y: s.Y,
				W: s.W,
				H: s.H,
				// Dead travels with the token: the client draws a grave, and
				// the mirroring never touches which tokens are still standing.
				Dead: s.Dead,
			})
		}
	}

	for _, sh := range r.shots {
		v := ShotView{X: sh.X, Y: sh.Y, Hit: sh.Hit, By: viewYou}
		if sh.By != viewer {
			v.X = 1 - sh.X
			v.By = viewOpp
		}
		st.Shots = append(st.Shots, v)
	}
	return st
}

// generateStickmen places StickmanCount targets inside the player's own half
// (local x 0..1 spans that half, local y 0..1 the full height), respecting
// the edge margins and never overlapping. It rejection-samples with a
// separation gap of initialGap; after repeated failures the gap is halved
// (down to 0, where only true overlap is rejected) so generation always
// terminates. The random source is injected so callers can seed it.
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
			// Relax rather than loop forever: halve the gap, then give up on
			// it entirely once it is below the meaningful threshold.
			if gap /= 2; gap < 0.001 {
				gap = 0
			}
		}
	}
	return items
}

// separatedFromAll reports whether s keeps at least gap clear of every
// stickman already placed.
func separatedFromAll(s Stickman, others []Stickman, gap float64) bool {
	for _, o := range others {
		if !separated(s, o, gap) {
			return false
		}
	}
	return true
}

// separated reports whether the axis-aligned rectangles a and b do not
// overlap once each edge is grown by gap: being separated on EITHER axis
// counts. At gap 0 touching edges are still separated (no shared area).
func separated(a, b Stickman, gap float64) bool {
	return a.X+a.W+gap <= b.X ||
		b.X+b.W+gap <= a.X ||
		a.Y+a.H+gap <= b.Y ||
		b.Y+b.H+gap <= a.Y
}

// writeAll performs the writes a room method produced. It always runs after
// the room lock is released, so a slow or stuck client can never stall game
// state. Each peer's own mutex serialises writes to its conn (gorilla forbids
// concurrent writers, and one handler's broadcast targets the other player's
// conn). A write error only logs: the read loop will notice the dead socket
// and clean up.
func writeAll(outs []outbound) {
	for _, o := range outs {
		if o.to == nil || o.to.conn == nil {
			continue // no live connection: nothing to write
		}
		o.to.mu.Lock()
		err := o.to.conn.WriteJSON(o.payload)
		o.to.mu.Unlock()
		if err != nil {
			log.Println("Write error:", err)
		}
	}
}

// room is the single match the whole server hosts. One room for now.
var room = newRoom()

var upgrader = websocket.Upgrader{}

// wsHandler upgrades a connection and runs its read loop. Membership starts
// at `join`, not at connect: a raw socket isn't a promise to play, and join
// is honoured only once per connection.
//
// Every inbound frame is decoded in two stages: first only the `type`
// discriminator out of the raw envelope, then the same bytes unmarshalled
// into the concrete struct for that type. Outbound payloads are produced by
// the room under its lock and written by writeAll after the lock is gone.
func wsHandler(w http.ResponseWriter, req *http.Request) {
	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	p := &peer{conn: conn}

	// Defers run LIFO: leave() broadcasts the final state first, then the
	// socket closes.
	defer conn.Close()
	joined := false
	defer func() {
		if joined {
			writeAll(room.leave(p))
			log.Printf("player left; room has %d/%d", room.count(), maxPlayers)
		}
	}()

	for {
		// Stage one: read the full envelope as raw bytes, decode just the
		// discriminator to pick the payload shape.
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
			// Stage two: the concrete struct for this type.
			var m JoinMessage
			if err := json.Unmarshal(raw, &m); err != nil {
				log.Println("Decode error:", err)
				continue
			}
			ok, outs := room.join(p)
			if !ok {
				log.Println("Room full; rejecting join")
				return
			}
			joined = true
			writeAll(outs)
			log.Printf("player joined; room has %d/%d", room.count(), maxPlayers)

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

// shutdownTimeout bounds how long a graceful shutdown waits for in-flight
// requests. Upgraded WebSockets are hijacked and invisible to Shutdown, so
// live game sockets end when the process exits, not after this timeout.
const shutdownTimeout = 10 * time.Second

func main() {
	// The client assets ship inside the binary; serve them straight from the
	// embedded FS instead of the working directory's ./public.
	static, err := fs.Sub(foldstrike.PublicFS, "public")
	if err != nil {
		log.Fatalf("open embedded public: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/ws", wsHandler)
	// /healthz is a cheap liveness probe for the platform's router; it must
	// not touch the room, so it stays up even mid-game.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// PORT is injected by the platform (Render sets it per instance); fall
	// back to 8080 for local runs.
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	// Shut down cleanly on SIGINT/SIGTERM so the platform's redeploy/restart
	// doesn't cut requests mid-flight.
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
