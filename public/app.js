'use strict';

/**
 * Foldstrike — game canvas renderer.
 *
 * The canvas is contained at a 16:9 aspect ratio within the viewport and is
 * split by a vertical fold line: the current player owns the LEFT half, the
 * opponent the RIGHT.
 *
 * @see ../AGENTS.md — Tailwind styling + JSDoc conventions.
 */

/** @type {HTMLCanvasElement} The play-area canvas. */
const canvas = document.getElementById('canvas');

/** @type {CanvasRenderingContext2D} The canvas drawing context. */
const ctx = canvas.getContext('2d');

/** Margin/desktop colour around the contained 16:9 paper. */
const MARGIN = '#1e1e1e';
/** Paper background colour. */
const PAPER = '#f7f3e8';
/** Fold line colour. */
const FOLD = '#b8a671';
/** Ink (text / tokens) colour. */
const INK = '#2b2b2b';

/** Target paper aspect ratio (width / height). */
const RATIO = 16 / 9;

const MSG_JOIN = 'join';
const MSG_SHOT = 'shot';
const MSG_STICKMEN = 'stickmen';

/**
 * Coordinates are sent on the wire as normalized relative values in 0..1,
 * independent of the canvas/paper size. Both sides communicate this way:
 * the client sends `x`/`y` directly, and the server echoes them back.
 */

/** Logical (CSS) width of the play area, in px. */
let w = 0;
/**
 * Target stickmen received from the server. Each is a red rectangle
 * ({x,y,w,h} normalized 0–1 within the player's own half).
 * @type {Array<{x:number,y:number,w:number,h:number}>}
 */
let stickmen = [];
/** Logical (CSS) height of the play area, in px. */
let h = 0;
/** Device pixel ratio for crisp retina rendering. */
let dpr = 1;

/**
 * Resize the backing store to match the displayed size and reset the
 * transform so all drawing happens in logical pixels.
 * @returns {void}
 */
function resize() {
    const rect = canvas.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
    dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * Compute the largest 16:9 rectangle that fits within the viewport,
 * centred — i.e. `object-fit: contain` for the paper.
 * @returns {{x:number,y:number,w:number,h:number}} The contain rect in logical px.
 */
function contain() {
    let cw = h * RATIO;
    if (cw > w) {                    // viewport too narrow: height-limited
        cw = w;
    }
    const ch = cw / RATIO;
    return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}

/**
 * The vertical fold line within the contain rect, in logical pixels from
 * the canvas left edge. The current player owns the left half, the opponent
 * the right.
 * @returns {number} The fold's x coordinate.
 */
function foldX() {
    const c = contain();
    return c.x + c.w / 2;
}

/**
 * Render one frame: desktop margin, contained 16:9 paper, vertical fold
 * line, and half labels.
 * @returns {void}
 */
function draw() {
    const c = contain();

    // Desktop/margin fill around the paper.
    ctx.fillStyle = MARGIN;
    ctx.fillRect(0, 0, w, h);

    // Clip everything to the paper rectangle.
    ctx.save();
    ctx.beginPath();
    ctx.rect(c.x, c.y, c.w, c.h);
    ctx.clip();

    // Paper background.
    ctx.fillStyle = PAPER;
    ctx.fillRect(c.x, c.y, c.w, c.h);

    // Vertical fold line down the middle of the paper.
    const fx = foldX();
    ctx.strokeStyle = FOLD;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(fx, c.y);
    ctx.lineTo(fx, c.y + c.h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Target stickmen (red rectangles) on the player's own half.
    ctx.fillStyle = '#d10a1e';
    for (const s of stickmen) {
        ctx.fillRect(c.x + s.x * c.w, c.y + s.y * c.h, s.w * c.w, s.h * c.h);
    }

    // Half labels.
    ctx.fillStyle = INK;
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('YOU', c.x + c.w / 4, c.y + 12);
    ctx.fillText('OPPONENT', c.x + (3 * c.w) / 4, c.y + 12);

    ctx.restore();
}

/**
 * Full render pipeline: measure, then draw.
 * @returns {void}
 */
function render() {
    resize();
    draw();
}

window.addEventListener('resize', render);
render();

/**
 * WebSocket connection to the game server.
 * @type {WebSocket|null}
 */
let socket = null;

/**
 * Build the websocket URL from the current page's location so it works
 * over http(s) and on mobile. `ws://` and `wss://` are derived from the
 * page's own protocol.
 * @returns {string} The ws:// URL to connect to.
 */
function wsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
}

/**
 * Send a JSON message to the server. The WebSocket API accepts strings,
 * so this encodes the object with JSON.stringify.
 * @param {object} message - The message to send.
 * @returns {void}
 */
function sendJSON(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
};

/**
 * Attempt to (re)connect to the server. Called on load and after a drop.
 * @returns {void}
 */
function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    socket = new WebSocket(wsUrl());

    socket.onopen = () => {
        sendJSON({ type: MSG_JOIN });
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === MSG_STICKMEN) {
            stickmen = msg.items || [];
            render();
        }
    };

    socket.onerror = (err) => { console.error(err); };

    // socket.onclose = () => { setTimeout(connect, 1000); };
}

/**
 * Tear down the current socket when the user leaves the page (reload, tab
 * close, navigation). Without this a reload would orphan the old socket on the
 * server, and its follow-up `join` would be admitted as a second player.
 * @returns {void}
 */
function closeSocket() {
    if (socket) {
        socket.onclose = null;   // stop the reconnect loop from firing again
        socket.close();
        socket = null;
    }
}

// Register teardown once per page load.
window.addEventListener('beforeunload', closeSocket);

// Connect on load (and again on page refresh, which re-runs this script).
connect();

/**
 * React to clicks on the play area: only register clicks that land on the
 * player's OWN half (the LEFT half, left of the fold line). Convert the
 * pointer position into normalized (0–1) paper coordinates so the sent
 * coordinate is independent of the current canvas/window size, and, when
 * valid, send them to the server. Dots are placed only on the player's own
 * half, so clicks on the opponent's half are ignored.
 *
 * @param {PointerEvent} event - The click event.
 * @returns {void}
 */
function onClick(event) {
    const rect = canvas.getBoundingClientRect();

    // Pointer position relative to the canvas, in logical px.
    const relX = event.clientX - rect.left;
    const relY = event.clientY - rect.top;

    // Map into the contained paper and normalize to 0..1 on each axis.
    // These percentages are resolution-independent, so resizing the canvas
    // does not change where the placed dot lands.
    const c = contain();
    const nx = (relX - c.x) / c.w;
    const ny = (relY - c.y) / c.h;

    // Ignore clicks that miss the paper entirely.
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

    // Only the player's own half (LEFT of the fold, nx < 0.5) is clickable.
    if (nx >= 0.5) return;

    // send JSON shot message: `{type: 'shot', x, y}` with x/y as normalized
    // (0–1) relative coordinates, matching the server's wire format.
    sendJSON({ type: MSG_SHOT, x: nx, y: ny });
}

canvas.addEventListener('click', onClick);
