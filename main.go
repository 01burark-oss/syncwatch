// SyncWatch sunucusu: odaları yönetir, oynatma durumunu ve sohbet mesajlarını
// odadaki herkese iletir. Video dosyaları asla sunucuya gelmez.
package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"time"
)

//go:embed web
var webFiles embed.FS

func main() {
	addr := flag.String("addr", ":8080", "dinlenecek adres")
	flag.Parse()

	hub := NewHub()

	static, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/ws", hub.ServeWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("SyncWatch %s adresinde çalışıyor", *addr)
	log.Fatal(srv.ListenAndServe())
}
