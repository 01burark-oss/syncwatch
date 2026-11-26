package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const (
	maxNameLen   = 32
	maxRoomLen   = 64
	maxChatLen   = 1000
	maxMsgBytes  = 8 << 10
	sendQueueLen = 64
	pingInterval = 25 * time.Second
)

// Message, istemci ile sunucu arasındaki tek mesaj biçimidir.
// Alanların çoğu yalnızca bazı türlerde doludur.
type Message struct {
	Type string `json:"type"`

	// state
	Playing    bool    `json:"playing,omitempty"`
	Position   float64 `json:"position,omitempty"`
	ServerTime int64   `json:"serverTime,omitempty"` // ms, Unix
	By         string  `json:"by,omitempty"`
	Fresh      bool    `json:"fresh,omitempty"` // oda yeni açıldı, henüz kimse oynatmadı

	// chat / system
	From string `json:"from,omitempty"`
	Text string `json:"text,omitempty"`
	Time int64  `json:"time,omitempty"`

	// file
	File *FileInfo `json:"file,omitempty"`

	// presence
	Members []Member `json:"members,omitempty"`

	// ping / pong
	T int64 `json:"t,omitempty"`
}

type FileInfo struct {
	Name     string  `json:"name"`
	Size     int64   `json:"size"`
	Duration float64 `json:"duration"`
}

type Member struct {
	Name string    `json:"name"`
	File *FileInfo `json:"file,omitempty"`
}

type client struct {
	name string
	file *FileInfo
	send chan Message
}

type room struct {
	mu      sync.Mutex
	clients map[*client]struct{}

	playing    bool
	position   float64 // ServerTime anındaki konum (saniye)
	serverTime int64   // ms
	touched    bool    // en az bir oynat/durdur/sar geldi mi
}

func nowMs() int64 { return time.Now().UnixMilli() }

// stateMsg odanın şu anki durumunu döndürür. r.mu tutulmalı.
func (r *room) stateMsg(by string) Message {
	return Message{Type: "state", Playing: r.playing, Position: r.position, ServerTime: r.serverTime, By: by, Fresh: !r.touched}
}

// currentPosition oynatma devam ediyorsa geçen süreyi ekler. r.mu tutulmalı.
func (r *room) currentPosition(at int64) float64 {
	if !r.playing {
		return r.position
	}
	return r.position + float64(at-r.serverTime)/1000
}

func (r *room) presence() Message {
	m := Message{Type: "presence", Members: []Member{}}
	for c := range r.clients {
		m.Members = append(m.Members, Member{Name: c.name, File: c.file})
	}
	return m
}

// broadcast herkese gönderir. Kuyruğu dolu istemci atlanır (yavaş bağlantı
// diğerlerini bekletmesin); bir sonraki state mesajı onu zaten düzeltir.
func (r *room) broadcast(m Message) {
	for c := range r.clients {
		select {
		case c.send <- m:
		default:
		}
	}
}

type Hub struct {
	mu    sync.Mutex
	rooms map[string]*room
}

func NewHub() *Hub { return &Hub{rooms: map[string]*room{}} }

func (h *Hub) join(id string, c *client) *room {
	h.mu.Lock()
	r, ok := h.rooms[id]
	if !ok {
		r = &room{clients: map[*client]struct{}{}, serverTime: nowMs()}
		h.rooms[id] = r
	}
	h.mu.Unlock()

	r.mu.Lock()
	r.clients[c] = struct{}{}
	c.send <- r.stateMsg("")
	r.broadcast(Message{Type: "system", Text: c.name + " odaya katıldı", Time: nowMs()})
	r.broadcast(r.presence())
	r.mu.Unlock()
	return r
}

func (h *Hub) leave(id string, r *room, c *client) {
	h.mu.Lock()
	r.mu.Lock()
	delete(r.clients, c)
	empty := len(r.clients) == 0
	if empty {
		delete(h.rooms, id)
	} else {
		// Biri çıkınca diğerinin videosu yalnız oynamaya devam etmesin.
		if r.playing {
			now := nowMs()
			r.position = r.currentPosition(now)
			r.playing = false
			r.serverTime = now
			r.broadcast(r.stateMsg(""))
		}
		r.broadcast(Message{Type: "system", Text: c.name + " odadan ayrıldı", Time: nowMs()})
		r.broadcast(r.presence())
	}
	r.mu.Unlock()
	h.mu.Unlock()
}

func cleanText(s string, max int) string {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return s
}

func (h *Hub) ServeWS(w http.ResponseWriter, req *http.Request) {
	roomID := cleanText(req.URL.Query().Get("room"), maxRoomLen)
	name := cleanText(req.URL.Query().Get("name"), maxNameLen)
	if roomID == "" || name == "" {
		http.Error(w, "room ve name gerekli", http.StatusBadRequest)
		return
	}

	conn, err := websocket.Accept(w, req, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxMsgBytes)
	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()

	c := &client{name: name, send: make(chan Message, sendQueueLen)}
	r := h.join(roomID, c)
	defer h.leave(roomID, r, c)
	log.Printf("oda=%q katıldı: %s", roomID, name)

	// Yazıcı: kuyruktaki mesajları gönderir ve bağlantıyı canlı tutar.
	go func() {
		defer cancel()
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-c.send:
				b, _ := json.Marshal(m)
				wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Write(wctx, websocket.MessageText, b)
				wcancel()
				if err != nil {
					return
				}
			case <-ticker.C:
				pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pctx)
				pcancel()
				if err != nil {
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		var m Message
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		h.handle(r, c, m)
	}
	conn.Close(websocket.StatusNormalClosure, "")
	log.Printf("oda=%q ayrıldı: %s", roomID, name)
}

func (h *Hub) handle(r *room, c *client, m Message) {
	now := nowMs()
	switch m.Type {
	case "ping":
		// Saat farkı ölçümü için; yalnızca gönderene döner.
		select {
		case c.send <- Message{Type: "pong", T: m.T, ServerTime: now}:
		default:
		}

	case "play", "pause", "seek":
		if m.Position < 0 || m.Position > 24*3600 {
			return
		}
		r.mu.Lock()
		switch m.Type {
		case "play":
			r.playing = true
		case "pause":
			r.playing = false
		}
		r.position = m.Position
		r.serverTime = now
		r.touched = true
		st := r.stateMsg(c.name)
		st.Text = m.Type // hangi eylem olduğu, istemcide bildirim için
		r.broadcast(st)
		r.mu.Unlock()

	case "chat":
		text := cleanText(m.Text, maxChatLen)
		if text == "" {
			return
		}
		r.mu.Lock()
		r.broadcast(Message{Type: "chat", From: c.name, Text: text, Time: now})
		r.mu.Unlock()

	case "file":
		if m.File == nil {
			return
		}
		f := *m.File
		f.Name = cleanText(f.Name, 200)
		r.mu.Lock()
		c.file = &f
		r.broadcast(r.presence())
		r.mu.Unlock()
	}
}
