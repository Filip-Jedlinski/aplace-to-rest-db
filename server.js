"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/config.js": ["config.js", "text/javascript; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"]
};

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost:8000").pathname;
  const file = files[pathname];
  if ((request.method !== "GET" && request.method !== "HEAD") || !file) {
    response.writeHead(404);
    response.end("Nie znaleziono strony.");
    return;
  }
  fs.readFile(path.join(__dirname, file[0]), (error, content) => {
    if (error) {
      console.error(`Nie mozna odczytac ${file[0]}: ${error.message}`);
      response.writeHead(500);
      response.end("Nie mozna odczytac pliku strony.");
      return;
    }
    response.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : content);
  });
});

server.on("error", error => {
  console.error(`Nie mozna uruchomic strony: ${error.message}`);
  process.exitCode = 1;
});

server.listen(8000, "localhost", () => {
  console.log("Strona dziala: http://localhost:8000");
  console.log("Otworz ten adres w przegladarce. Aby zakonczyc, zamknij to okno.");
});
