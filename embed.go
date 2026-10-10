// Package foldstrike hosts the static client assets bundled into the server
// binary, so a deployment needs nothing beside the executable itself.
package foldstrike

import "embed"

// PublicFS holds everything under public/. `all:` includes dotfiles, which a
// plain embed pattern would silently drop. The server strips the "public/"
// prefix with fs.Sub before serving.
//
//go:embed all:public
var PublicFS embed.FS
