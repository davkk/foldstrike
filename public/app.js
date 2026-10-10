'use strict';

/**
 * Foldstrike — game canvas renderer.
 *
 * The canvas is contained at a 16:9 aspect ratio within the viewport and is
 * split by a vertical fold line: the current player owns the LEFT half, the
 * opponent the RIGHT. Everything — paper, stickmen, shots, HUD and overlays —
 * is drawn on the canvas from the latest `state` message; the page carries no
 * DOM UI of its own.
 *
 * @see ../AGENTS.md — Tailwind styling + JSDoc conventions.
 */

/** @type {HTMLCanvasElement} The play-area canvas. */
const canvas = document.getElementById('canvas');

/**
 * The canvas drawing context. Not `const`: the fold renders the flat board
 * into an offscreen buffer by pointing this at the buffer's context for the
 * duration of one synchronous call (see renderBoardBuffer).
 * @type {CanvasRenderingContext2D}
 */
let ctx = canvas.getContext('2d');

/**
 * Offscreen copy of the flat board, at the canvas's exact pixel size. The
 * fold draws the board here once per frame and then samples it in vertical
 * strips, so a moving sheet costs one board draw plus cheap drawImage calls
 * rather than one full redraw per strip.
 * @type {HTMLCanvasElement}
 */
const buffer = document.createElement('canvas');

/** Margin/desktop colour around the contained 16:9 paper. */
const MARGIN = '#1e1e1e';
/** Paper background colour. */
const PAPER = '#f7f3e8';
/** Fold line colour. */
const FOLD = '#b8a671';
/** Ink (text / own tokens) colour. */
const INK = '#2b2b2b';
/** Opponent (targets, their shots) colour. */
const OPP_COLOR = '#d10a1e';

/** Target paper aspect ratio (width / height). */
const RATIO = 16 / 9;

/** Milliseconds a stickman takes to topple over once it is hit. */
const TOPPLE_MS = 550;
/** Milliseconds the grave takes to rise out of the paper after the topple. */
const GRAVE_MS = 400;
/** Total length of the death animation, in milliseconds. */
const DEATH_MS = TOPPLE_MS + GRAVE_MS;

/** Milliseconds the folding half takes to close over the other half. */
const FOLD_IN_MS = 420;
/** Milliseconds the sheet rests closed — the press that transfers the ink. */
const FOLD_PRESS_MS = 150;
/** Milliseconds the sheet takes to fall open again: the reveal. */
const FOLD_OUT_MS = 520;
/** Total length of one fold, in milliseconds. */
const FOLD_TOTAL_MS = FOLD_IN_MS + FOLD_PRESS_MS + FOLD_OUT_MS;

/**
 * How far the sheet's free edge leads the hinge mid-fold, in radians. It
 * vanishes at rest and at the press (sin 0 = sin PI = 0), so the sheet is
 * dead flat when it must be and bows like paper while it moves.
 */
const FOLD_BEND = 0.42;

/** Vertical strips the folding half is cut into while it moves. */
const FOLD_SLICES = 64;

/** Camera distance from the paper, as a multiple of the half width. */
const FOLD_CAMERA = 3.5;

/** Milliseconds a transferred shot mark takes to grow into place. */
const LAND_MS = 180;
/** Milliseconds a scoring shot's hit ring takes to draw itself in. */
const RING_MS = 160;

/**
 * Death animations in flight, keyed "side:x:y" (the stickman's normalized
 * local coords, which never move) to the time the client first saw it dead.
 * The server keeps hit stickmen on the board with `dead` set, so a key that
 * lingers here is a stickman still on its way to becoming a grave; keys for
 * stickmen the latest state no longer carries are pruned in syncDeaths.
 * @type {Map<string, number>}
 */
const deathAt = new Map();

/**
 * The fold animation in flight: which half lifts — the side the latest shot
 * was fired from — and when it started. Null while the paper lies flat.
 * @type {{side:'left'|'right', t0:number}|null}
 */
let fold = null;

/**
 * When each shot may show what, keyed by the shot's index in `state.shots`:
 * `land` is when the transferred mark (the copy the fold presses onto the far
 * side of the line) grows in — the press moment of the fold the shot arrived
 * with — and `ring` is when its hit circle may appear: only once the paper is
 * flat again, so the circle reads as the verdict rather than part of the
 * reveal. Indexes the latest state no longer carries are pruned in syncShots.
 * @type {Map<number, {land:number, ring:number}>}
 */
const landedAt = new Map();

/** Client -> server: join the room (sent once, right after the socket opens). */
const MSG_JOIN = 'join';
/** Client -> server: fire a shot; x/y are in the shooter's OWN local frame. */
const MSG_SHOT = 'shot';
/** Client -> server: ask for a rematch while phase is "over". */
const MSG_REMATCH = 'rematch';
/** Server -> client: seat assignment, `{"type":"welcome","seat":n}`. */
const MSG_WELCOME = 'welcome';
/** Server -> client: full game state (phase, scores, stickmen, shots). */
const MSG_STATE = 'state';

/**
 * Coordinates are sent on the wire as normalized relative values in 0..1,
 * independent of the canvas/paper size. Both sides communicate this way:
 * the client sends `x`/`y` directly, and the server echoes them back.
 *
 * The paper's own half spans display x 0..0.5, but the wire's player-local
 * frame spans 0..1 across that half alone — hence a shot at paper x `nx` is
 * sent as `nx * 2`.
 */

/** Logical (CSS) width of the play area, in px. */
let w = 0;
/** Logical (CSS) height of the play area, in px. */
let h = 0;
/** Device pixel ratio for crisp retina rendering. */
let dpr = 1;

/**
 * Latest full `state` message from the server, stored whole and re-rendered
 * as-is (the server sends display-frame coords, so no per-player switching).
 * Null until the first state arrives.
 * @type {object|null}
 */
let state = null;

/** This connection's 0-based seat from the `welcome` message; -1 until it arrives. */
let seat = -1;

/** True only while tearing the socket down on purpose (page unload). */
let closingIntentionally = false;

/** True after an unexpected socket drop; shows the "reload to rejoin" banner. */
let disconnected = false;

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

    // The fold's offscreen board tracks the canvas exactly. Resizing a
    // canvas clears it, which is fine: it is refilled before every fold frame.
    if (buffer.width !== canvas.width || buffer.height !== canvas.height) {
        buffer.width = canvas.width;
        buffer.height = canvas.height;
    }
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
 * Draw one stickman FIGURE (head, torso, two arms, two legs) fitted inside
 * the given rect. Both halves use the same routine; only the colour differs.
 *
 * @param {number} x - Left edge of the figure's rect, logical px.
 * @param {number} y - Top edge of the figure's rect, logical px.
 * @param {number} fw - Rect width, logical px.
 * @param {number} fh - Rect height, logical px.
 * @param {string} color - Stroke/outline colour (ink for own, red for foe).
 * @returns {void}
 */
function drawStickman(x, y, fw, fh, color) {
    const cx = x + fw / 2;
    const headR = fh * 0.13;
    const headY = y + fh * 0.02 + headR;   // head sits just inside the top
    const neckY = headY + headR;
    const hipY = y + fh * 0.62;
    const shoulderY = neckY + fh * 0.05;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.5, fh * 0.05);
    ctx.lineCap = 'round';

    // Head: a filled circle.
    ctx.beginPath();
    ctx.arc(cx, headY, headR, 0, Math.PI * 2);
    ctx.fill();

    // Torso, arms and legs: one stroked path.
    ctx.beginPath();
    ctx.moveTo(cx, neckY);                 // torso
    ctx.lineTo(cx, hipY);
    ctx.moveTo(cx, shoulderY);             // left arm, angled down
    ctx.lineTo(cx - fw * 0.38, shoulderY + fh * 0.16);
    ctx.moveTo(cx, shoulderY);             // right arm, angled down
    ctx.lineTo(cx + fw * 0.38, shoulderY + fh * 0.16);
    ctx.moveTo(cx, hipY);                  // left leg
    ctx.lineTo(cx - fw * 0.3, y + fh);
    ctx.moveTo(cx, hipY);                  // right leg
    ctx.lineTo(cx + fw * 0.3, y + fh);
    ctx.stroke();
    ctx.restore();
}

/**
 * Build the stable identity of one stickman for the death map. Coordinates
 * are normalized and never change for a given token, so x/y alone tell the
 * two armies apart ("own" vs "opp") and one token from another.
 *
 * @param {'own'|'opp'} side - Which army the token belongs to.
 * @param {{x:number,y:number}} s - The stickman, in normalized local coords.
 * @returns {string} The map key, e.g. "opp:0.3125:0.5".
 */
function deathKey(side, s) {
    return `${side}:${s.x.toFixed(4)}:${s.y.toFixed(4)}`;
}

/**
 * Record any stickman the latest state shows dead that is not yet animating,
 * and forget keys whose stickman is gone (a rematch regenerates the whole
 * board, so its old keys must not linger). Called with each incoming state,
 * right after the fold that state starts has been set up, so a fresh fall can
 * be stamped for the fold's press.
 *
 * @param {object} st - The latest `state` message.
 * @returns {void}
 */
function syncDeaths(st) {
    const now = performance.now();
    const alive = new Set();

    for (const side of ['own', 'opp']) {
        for (const s of st[side] || []) {
            if (!s.dead) continue;
            const key = deathKey(side, s);
            alive.add(key);
            if (!deathAt.has(key)) {
                // Freshly seen dead: start from the top — but wait for the
                // press when a fold runs, so the opening sheet reveals the
                // fall instead of it playing out underneath. A stickman
                // already dead when this page loaded (a reload mid-battle)
                // starts at once, which reads as a board settling rather
                // than a bug.
                deathAt.set(key, revealAt(now));
            }
        }
    }

    for (const key of Array.from(deathAt.keys())) {
        if (!alive.has(key)) deathAt.delete(key);
    }
}

/**
 * Draw a dying stickman: it topples sideways about its feet, the way a paper
 * figure falls over. Falls away from the fold line — left for the own army,
 * right for the foe — so the fall never points into the fold.
 *
 * @param {number} x - Left edge of the figure's rect, logical px.
 * @param {number} y - Top edge of the figure's rect, logical px.
 * @param {number} fw - Rect width, logical px.
 * @param {number} fh - Rect height, logical px.
 * @param {string} color - Stroke/outline colour.
 * @param {number} p - Fall progress in 0..1 (1 = fully down).
 * @param {boolean} right - True to fall to the right, false for the left.
 * @returns {void}
 */
function drawFallingStickman(x, y, fw, fh, color, p, right) {
    const feetY = y + fh;                 // the figure pivots on its feet
    const eased = 1 - (1 - p) * (1 - p);  // ease-out: fast tip, soft landing

    ctx.save();
    ctx.translate(x + fw / 2, feetY);
    ctx.rotate((right ? 1 : -1) * eased * (Math.PI / 2) * 0.95);
    ctx.translate(-(x + fw / 2), -feetY);
    drawStickman(x, y, fw, fh, color);
    ctx.restore();
}

/**
 * Draw the grave a dead stickman leaves behind: a small arched headstone
 * with a cross on it, on a mound of earth at the token's feet. Grows out
 * of the paper (`p` = 0 -> 1) so the fall flows straight into it.
 *
 * @param {number} x - Left edge of the token's rect, logical px.
 * @param {number} y - Top edge of the token's rect, logical px.
 * @param {number} fw - Rect width, logical px.
 * @param {number} fh - Rect height, logical px.
 * @param {string} color - Stone outline colour (ink for own, red for foe).
 * @param {number} p - Rise progress in 0..1.
 * @returns {void}
 */
function drawGrave(x, y, fw, fh, color, p) {
    const cx = x + fw / 2;
    const groundY = y + fh * 0.98;       // slightly above the rect's floor
    const sw = fw * 0.62;                // headstone width
    const sh = fh * 0.5 * p;             // headstone height, grows with p
    const arch = sw / 2;                 // radius of the rounded top
    const stone = Math.max(1, fh * 0.035);

    ctx.save();
    ctx.lineJoin = 'round';

    // Mound of earth under the stone: only appears with the stone.
    ctx.globalAlpha = 0.35 * p;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx, groundY, fw * 0.42 * p, fh * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();

    // Headstone: a rectangle capped by a semicircular arch.
    ctx.globalAlpha = p;
    ctx.strokeStyle = color;
    ctx.lineWidth = stone;
    ctx.beginPath();
    ctx.moveTo(cx - sw / 2, groundY);
    ctx.lineTo(cx - sw / 2, groundY - sh + arch);
    ctx.arc(cx, groundY - sh + arch, sw / 2, Math.PI, 0);
    ctx.lineTo(cx + sw / 2, groundY);
    ctx.stroke();

    // Cross, scaled down with the stone so it never spills past the arch.
    ctx.lineWidth = Math.max(1, stone * 0.8);
    const cy = groundY - sh * 0.55;
    const arm = sh * 0.16;
    ctx.beginPath();
    ctx.moveTo(cx, cy - arm * 1.5);
    ctx.lineTo(cx, cy + arm * 1.5);
    ctx.moveTo(cx - arm, cy);
    ctx.lineTo(cx + arm, cy);
    ctx.stroke();

    ctx.restore();
}

/**
 * Draw one stickman token: a plain figure while alive, and while dead the
 * topple-then-grave animation, ending on the settled grave. Progress comes
 * from deathAt, stamped when the client first saw the token dead.
 *
 * @param {'own'|'opp'} side - Which army the token belongs to.
 * @param {{x:number,y:number,w:number,h:number,dead?:boolean}} s - The token.
 * @param {number} x - Left edge of the token's rect, logical px.
 * @param {number} y - Top edge of the token's rect, logical px.
 * @param {number} fw - Rect width, logical px.
 * @param {number} fh - Rect height, logical px.
 * @param {string} color - Stroke/outline colour.
 * @returns {void}
 */
function drawToken(side, s, x, y, fw, fh, color) {
    if (!s.dead) {
        drawStickman(x, y, fw, fh, color);
        return;
    }

    const t = performance.now() - (deathAt.get(deathKey(side, s)) || 0);
    if (t < TOPPLE_MS) {
        // Falls away from the fold: the own half is on the left, so an own
        // stickman tips left and a foe's tips right. t can be negative — a
        // death stamped for the moment a fold presses waits flat and upright
        // until the sheet comes down on it — so the progress clamps at zero.
        drawFallingStickman(x, y, fw, fh, color, Math.max(0, t / TOPPLE_MS), side === 'opp');
    }
    if (t >= TOPPLE_MS - GRAVE_MS * 0.5) {
        // The grave starts rising before the fall finishes, so the two
        // overlap instead of leaving a gap.
        const p = Math.min(1, (t - (TOPPLE_MS - GRAVE_MS * 0.5)) / (GRAVE_MS * 1.5));
        drawGrave(x, y, fw, fh, color, p);
    }
}

/**
 * Draw one shot as a dot centred on its display point, with an extra ring
 * when the server marked it as a hit.
 *
 * @param {{x:number,y:number,w:number,h:number}} c - The contain rect (scales the radius).
 * @param {number} px - Dot centre x, logical px.
 * @param {number} py - Dot centre y, logical px.
 * @param {string} color - Dot colour (ink for own shots, red for theirs).
 * @param {boolean} hit - Whether this shot hit a stickman.
 * @param {number} [scale] - Dot growth in 0..1, used to pop a transferred
 *   mark into place; omitted or 1 draws the dot at full size.
 * @param {number} [ring] - Growth of the hit ring in 0..1, decoupled from the
 *   dot so a caller can hold the ring back — the fold waits to stamp the
 *   verdict until the paper lies flat. Tied to `scale` when omitted.
 * @returns {void}
 */
function drawDot(c, px, py, color, hit, scale, ring) {
    const s = scale === undefined ? 1 : scale;
    const rs = ring === undefined ? s : ring;
    const base = Math.max(3, Math.min(c.w, c.h) * 0.014);

    ctx.save();
    ctx.globalAlpha = s;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, base * s, 0, Math.PI * 2);
    ctx.fill();

    if (hit && rs > 0) {                  // extra ring around a scoring shot
        ctx.globalAlpha = rs;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, 2 * rs);
        ctx.beginPath();
        ctx.arc(px, py, base * 2.2 * rs, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.restore();
}

/**
 * Draw the HUD: the two scores in the paper's top corners and, during
 * battle, a small hint line along the bottom.
 *
 * @param {{x:number,y:number,w:number,h:number}} c - The contain rect.
 * @returns {void}
 */
function drawHud(c) {
    const size = Math.max(12, Math.round(Math.min(c.w, c.h) * 0.038));
    const pad = Math.round(size * 0.7);
    const you = state ? state.youScore : 0;
    const opp = state ? state.oppScore : 0;
    const yourTurn = !!state && state.turn === 'you';

    ctx.save();
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';

    ctx.fillStyle = INK;                  // own score, top-left of own half
    ctx.textAlign = 'left';
    ctx.fillText(`YOU ${you}`, c.x + pad, c.y + pad);

    ctx.fillStyle = OPP_COLOR;            // opponent score, top-right
    ctx.textAlign = 'right';
    ctx.fillText(`OPPONENT ${opp}`, c.x + c.w - pad, c.y + pad);

    if (state && state.phase === 'battle') {
        // Round and turn, centred between the two scores. Players fire one
        // shot each in turn, so this line is the answer to "may I shoot?".
        ctx.textAlign = 'center';
        ctx.fillStyle = yourTurn ? INK : 'rgba(43, 43, 43, 0.4)';
        ctx.fillText(`ROUND ${state.round} · ${yourTurn ? 'YOUR TURN' : 'THEIR TURN'}`,
            c.x + c.w / 2, c.y + pad);

        // Bottom hint follows the same rule as the click handler.
        ctx.fillStyle = 'rgba(43, 43, 43, 0.65)';
        ctx.textBaseline = 'bottom';
        ctx.fillText(yourTurn ? 'Click your half to fire' : 'Waiting for their shot…',
            c.x + c.w / 2, c.y + c.h - pad);
    }
    ctx.restore();
}

/**
 * Shrink a font size (only if needed) so `text` fits inside `maxW`.
 * Requires `ctx.font` to be set as a side effect, so call it between a
 * save()/restore() pair.
 *
 * @param {string} weight - Font weight prefix, e.g. "700 " or "".
 * @param {string} text - The text to measure.
 * @param {number} size - Desired font size in px.
 * @param {number} maxW - Maximum allowed text width in px.
 * @returns {number} A font size in px that fits maxW.
 */
function fitText(weight, text, size, maxW) {
    ctx.font = `${weight}${size}px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    if (tw > maxW && tw > 0) {
        return Math.max(10, Math.floor(size * (maxW / tw)));
    }
    return size;
}

/**
 * Draw a centred, semi-transparent panel over the paper with a large
 * heading and optional smaller lines beneath it.
 *
 * @param {{x:number,y:number,w:number,h:number}} c - The contain rect.
 * @param {string} title - The large heading line.
 * @param {string[]} subLines - Smaller lines shown under the heading.
 * @param {string} titleColor - Heading colour.
 * @returns {void}
 */
function drawPanel(c, title, subLines, titleColor) {
    const pw = Math.min(c.w * 0.7, 560);
    const ph = Math.min(c.h * 0.5, 300);
    const px = c.x + (c.w - pw) / 2;
    const py = c.y + (c.h - ph) / 2;
    const midX = c.x + c.w / 2;
    const maxW = pw * 0.86;

    ctx.save();

    // Fit the text to the panel so long lines never clip or spill outside.
    let titleSize = Math.max(18, Math.round(Math.min(pw * 0.16, ph * 0.28)));
    titleSize = fitText('700 ', title, titleSize, maxW);
    let subSize = Math.max(12, Math.round(titleSize * 0.42));
    for (const line of subLines) {
        subSize = Math.min(subSize, fitText('', line, subSize, maxW));
    }

    // Semi-transparent sheet over the paper, with a fold-coloured border.
    ctx.fillStyle = 'rgba(247, 243, 232, 0.92)';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = FOLD;
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, pw, ph);

    // Vertically centre the whole text block inside the panel.
    const blockH = titleSize * 1.3 + subLines.length * subSize * 1.7;
    let y = py + (ph - blockH) / 2 + titleSize * 0.65;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = titleColor;
    ctx.font = `700 ${titleSize}px system-ui, sans-serif`;
    ctx.fillText(title, midX, y);

    ctx.fillStyle = INK;
    ctx.font = `${subSize}px system-ui, sans-serif`;
    y += titleSize * 0.55 + subSize * 0.85;
    for (const line of subLines) {
        ctx.fillText(line, midX, y);
        y += subSize * 1.7;
    }
    ctx.restore();
}

/**
 * Draw the "connection lost" banner across the top of the paper after an
 * unexpected socket close.
 *
 * @param {{x:number,y:number,w:number,h:number}} c - The contain rect.
 * @returns {void}
 */
function drawDisconnected(c) {
    const bh = Math.max(30, Math.round(c.h * 0.1));
    const size = Math.max(13, Math.round(bh * 0.42));

    ctx.save();
    ctx.fillStyle = 'rgba(209, 10, 30, 0.94)';
    ctx.fillRect(c.x, c.y, c.w, bh);
    ctx.fillStyle = PAPER;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Connection lost — reload to rejoin', c.x + c.w / 2, c.y + bh / 2);
    ctx.restore();
}

/**
 * Draw the phase overlays: the lobby waiting panel, the game-over panel,
 * and — always last so it stays visible — the lost-connection banner.
 *
 * @param {{x:number,y:number,w:number,h:number}} c - The contain rect.
 * @returns {void}
 */
function drawOverlays(c) {
    // Panels wait for the sheet to lie flat: a result announced mid-fold
    // would fold away with the half it is printed on.
    if (state && state.phase === 'lobby' && !fold) {
        drawPanel(c, 'Waiting for an opponent…', [], INK);
    } else if (state && state.phase === 'over' && !fold) {
        // Three outcomes: win, lose, or a draw — the last when the deciding
        // round wiped both boards. The server only settles the result once
        // both players have taken the shot their round owes them, so this
        // screen never appears while a move is still outstanding.
        const draw = state.winner === 'draw';
        const won = state.winner === 'you';
        drawPanel(
            c,
            draw ? 'DRAW' : won ? 'YOU WIN' : 'YOU LOSE',
            [`Final score  ${state.youScore} – ${state.oppScore}`, 'Click to play again'],
            draw || won ? INK : OPP_COLOR
        );
    }
    if (disconnected) {
        drawDisconnected(c);
    }
}

/**
 * Absolute time anything first seen in the latest state may show itself: the
 * moment the fold in flight presses down, or right away when the paper lies
 * flat. Newly dead stickmen and newly transferred marks both wait for the
 * press, so the opening sheet reveals them instead of them appearing under it.
 *
 * @param {number} now - The current time, in milliseconds.
 * @returns {number} The timestamp to stamp a fresh animation with.
 */
function revealAt(now) {
    if (!fold) return now;
    const press = fold.t0 + FOLD_IN_MS;
    return press > now ? press : now;
}

/**
 * Stamp every shot the latest state carries that is not stamped yet, and
 * forget indexes it no longer carries (a rematch empties the shot list, so a
 * stale index must not pre-date the marks of the new battle). Called with
 * each incoming state, right after the fold that state starts has been set.
 *
 * @param {object} st - The latest `state` message.
 * @returns {void}
 */
function syncShots(st) {
    const now = performance.now();
    const at = revealAt(now);
    // The mark waits for the press; the hit circle waits for the sheet to lie
    // flat again, so nothing gives the result away while the paper folds.
    const ring = fold ? fold.t0 + FOLD_TOTAL_MS : now;
    const alive = new Set();

    (st.shots || []).forEach((_, i) => {
        alive.add(i);
        if (!landedAt.has(i)) landedAt.set(i, { land: at, ring });
    });

    for (const i of Array.from(landedAt.keys())) {
        if (!alive.has(i)) landedAt.delete(i);
    }
}

/**
 * How much of a timed effect has played out: 0 until its start time, 1 once
 * `ms` has passed, linear in between. Used to grow marks and rings in.
 *
 * @param {number} now - The current time, in milliseconds.
 * @param {number} at - When the effect starts, in milliseconds.
 * @param {number} ms - How long the growth takes.
 * @returns {number} Growth in 0..1.
 */
function growth(now, at, ms) {
    return Math.min(1, Math.max(0, (now - at) / ms));
}

/**
 * Start a fold when `next` brings a shot `prev` did not have: the half that
 * shot was fired from lifts, swings over the fold line and presses its mark
 * onto the other side. The first state never folds (it may already carry
 * shots from a page reload), a shrinking shot list is a rematch or a leave,
 * and a fold already in flight keeps running — its strips re-sample the
 * buffer every frame, so the newest state shows up inside it anyway.
 *
 * @param {object|null} prev - The previous `state` message, or null.
 * @param {object} next - The new `state` message.
 * @returns {void}
 */
function maybeStartFold(prev, next) {
    if (fold || !prev) return;
    const was = (prev.shots || []).length;
    const now = (next.shots || []).length;
    if (now <= was) return;
    const shot = next.shots[now - 1];
    fold = { side: shot.by === 'you' ? 'left' : 'right', t0: performance.now() };
}

/**
 * Eased 0..1 curve for the fold: at rest at both ends, quickest in the
 * middle — the way a hand folds a sheet shut and lets it fall open.
 *
 * @param {number} t - Progress in 0..1.
 * @returns {number} Eased progress in 0..1.
 */
function easeFold(t) {
    const k = Math.min(1, Math.max(0, t));
    return 0.5 - 0.5 * Math.cos(Math.PI * k);
}

/**
 * The sheet's angle at `elapsed` ms into the animation: flat (0), closing to
 * fully folded (PI), resting there through the press, then opening back to
 * flat. Past FOLD_TOTAL_MS it reports 0, the position the flat path draws.
 *
 * @param {number} elapsed - Milliseconds since the fold started.
 * @returns {number} The angle in radians.
 */
function foldAngle(elapsed) {
    if (elapsed < FOLD_IN_MS) return Math.PI * easeFold(elapsed / FOLD_IN_MS);
    if (elapsed < FOLD_IN_MS + FOLD_PRESS_MS) return Math.PI;
    if (elapsed < FOLD_TOTAL_MS) {
        return Math.PI * (1 - easeFold((elapsed - FOLD_IN_MS - FOLD_PRESS_MS) / FOLD_OUT_MS));
    }
    return 0;
}

/**
 * The angle of one strip of the sheet, at distance d from the hinge. The
 * bend term makes the free edge lead the hinge while the sheet closes and
 * trail it while it opens — like paper, not like a door — and it vanishes at
 * both ends of the move (sin 0 = sin PI = 0), so the sheet is dead flat at
 * rest and during the press.
 *
 * @param {number} theta - The sheet's base angle, in radians.
 * @param {number} d - Distance from the fold line, logical px.
 * @param {number} halfW - Half the paper's width, logical px.
 * @returns {number} The strip's angle, clamped to 0..PI.
 */
function flapTheta(theta, d, halfW) {
    const t = theta + FOLD_BEND * Math.sin(theta) * (d / halfW);
    return Math.min(Math.PI, Math.max(0, t));
}

/**
 * Render the flat board into the offscreen buffer. Every drawing routine
 * targets the module-level `ctx`, so this points `ctx` at the buffer for the
 * duration of the call and puts it back afterwards — the call is synchronous,
 * so no other draw can observe the swap.
 *
 * @returns {void}
 */
function renderBoardBuffer() {
    const main = ctx;
    const bctx = buffer.getContext('2d');
    ctx = bctx;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBoard(contain(), false);
    ctx = main;
}

/**
 * Copy a rectangle of the buffer onto the canvas. Source coordinates are in
 * the buffer's backing pixels (logical px times dpr), destination coordinates
 * are logical px in the current transform — so this also works while a strip
 * transform is installed.
 *
 * @param {number} x - Left edge, logical px.
 * @param {number} y - Top edge, logical px.
 * @param {number} bw - Width, logical px.
 * @param {number} bh - Height, logical px.
 * @returns {void}
 */
function blit(x, y, bw, bh) {
    ctx.drawImage(buffer, x * dpr, y * dpr, bw * dpr, bh * dpr, x, y, bw, bh);
}

/**
 * Draw the transferred copy of every shot: the mark the fold pressed onto the
 * far side of the line, mirrored exactly across the fold from where it was
 * aimed — which is where it landed, since the server's hit test mirrors the
 * same way. Each mark grows in when its `land` time arrives (the press moment
 * while a fold runs); its hit ring waits for `ring`, when the paper is flat
 * again, so the fold never gives the verdict away. `rect` clips the marks to
 * one half, which is what the fold path needs to lay them over the
 * stationary sheet.
 *
 * @param {{x:number,y:number,w:number,h:number}} c - The contain rect.
 * @param {{x:number,y:number,w:number,h:number}|null} rect - Clip rect, or null for none.
 * @param {number} now - The current time, in milliseconds.
 * @returns {void}
 */
function drawLandingDots(c, rect, now) {
    if (!state) return;
    const fx = foldX();

    ctx.save();
    if (rect) {
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.w, rect.h);
        ctx.clip();
    }

    (state.shots || []).forEach((shot, i) => {
        const rec = landedAt.get(i);
        const t = now - (rec ? rec.land : now);
        if (t < 0) return; // not pressed through yet
        const mine = shot.by === 'you';
        const aimed = mine
            ? c.x + shot.x * 0.5 * c.w
            : c.x + 0.5 * c.w + shot.x * 0.5 * c.w;
        drawDot(c, 2 * fx - aimed, c.y + shot.y * c.h, mine ? INK : OPP_COLOR,
            !!shot.hit, growth(now, rec ? rec.land : now, LAND_MS),
            growth(now, rec ? rec.ring : now, RING_MS));
    });

    ctx.restore();
}

/**
 * Shade one side of the fold line with a soft shadow that dies away from the
 * hinge: the lifted sheet shades both the table it left behind and the sheet
 * it still hangs over. Strongest mid-fold, gone at rest and during the press,
 * where the sheet lies flat again.
 *
 * @param {{x:number,y:number,w:number,h:number}} rect - The half to shade.
 * @param {number} dir - +1 when the half lies right of the fold, -1 when left.
 * @param {number} theta - The sheet's current angle, in radians.
 * @returns {void}
 */
function shadeFoldSide(rect, dir, theta) {
    const amount = Math.sin(theta);
    if (amount <= 0.02) return;

    const fx = dir > 0 ? rect.x : rect.x + rect.w;
    const reach = rect.w * 0.5;
    const grad = ctx.createLinearGradient(fx, 0, fx + dir * reach, 0);
    grad.addColorStop(0, `rgba(0, 0, 0, ${(0.34 * amount).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(dir > 0 ? rect.x : rect.x + rect.w - reach, rect.y, reach, rect.h);
}

/**
 * Shade one projected strip of the sheet. While its front faces us it darkens
 * as it turns away from the light; past edge-on we are looking at the back of
 * the sheet, so the strip washes towards blank paper and the ink on the far
 * side shows through as a faint mirrored ghost.
 *
 * @param {number} x - Strip left edge, logical px (buffer space).
 * @param {number} sw - Strip width, logical px.
 * @param {{y:number,h:number}} c - The contain rect (the vertical extent).
 * @param {number} theta - The strip's angle, in radians.
 * @returns {void}
 */
function shadeSlice(x, sw, c, theta) {
    const cos = Math.cos(theta);
    if (cos >= 0) {
        const a = 0.32 * (1 - cos); // flat-on: unshaded; edge-on: fully turned
        if (a < 0.005) return;
        ctx.fillStyle = `rgba(20, 20, 20, ${a.toFixed(3)})`;
    } else {
        ctx.fillStyle = `rgba(247, 243, 232, ${(0.55 * -cos).toFixed(3)})`;
    }
    ctx.fillRect(x, c.y, sw, c.h);
}

/**
 * Draw the folding half as FOLD_SLICES vertical strips. A strip at distance d
 * from the hinge swings to (d·cosθ, d·sinθ) in 3D, and a camera
 * FOLD_CAMERA half-widths away scales that by L/(L − z); so every strip gets
 * its own projected x and its own vertical scale. The strips narrow to nothing
 * as the sheet turns edge-on, the free edge looms as it swings towards the
 * viewer, and past edge-on the strips mirror over the fold line and lie down
 * on the other half.
 *
 * @param {{x:number,y:number,w:number,h:number}} c - The contain rect.
 * @param {number} fx - The fold line's x, logical px.
 * @param {number} yc - The vertical centre the camera looks through.
 * @param {number} theta - The sheet's base angle, in radians.
 * @param {number} side - -1 when the sheet lies left of the fold, +1 right.
 * @returns {void}
 */
function drawFlap(c, fx, yc, theta, side) {
    const halfW = c.w / 2;
    const halfH = c.h / 2;
    const step = halfW / FOLD_SLICES;
    const lens = FOLD_CAMERA * halfW;
    // The sheet's own span in buffer coordinates: strips sample nothing else.
    const sheetLo = side < 0 ? c.x : fx;
    const sheetHi = side < 0 ? fx : c.x + c.w;

    // Projected x, vertical scale and angle of every strip boundary.
    const px = new Float64Array(FOLD_SLICES + 1);
    const scale = new Float64Array(FOLD_SLICES + 1);
    const angle = new Float64Array(FOLD_SLICES + 1);
    for (let i = 0; i <= FOLD_SLICES; i++) {
        const d = i * step;
        const th = flapTheta(theta, d, halfW);
        const s = lens / Math.max(lens - d * Math.sin(th), lens * 0.25);
        angle[i] = th;
        scale[i] = s;
        px[i] = fx + side * (d * Math.cos(th) * s);
    }

    for (let i = 0; i < FOLD_SLICES; i++) {
        // Source-space anchors: strip i runs from sxA to sxB on the sheet, and
        // those two ends project to px[i] and px[i+1].
        const sxA = fx + side * i * step;
        const sxB = fx + side * (i + 1) * step;
        const kx = (px[i + 1] - px[i]) / (sxB - sxA);
        // Widen the source by half a pixel a side so neighbouring strips
        // overlap instead of leaving hairline seams where bilinear sampling
        // meets, clamped to the sheet so nothing samples past its edge.
        const lo = Math.max(sheetLo, Math.min(sxA, sxB) - 0.5);
        const hi = Math.min(sheetHi, Math.max(sxA, sxB) + 0.5);

        ctx.save();
        ctx.translate(px[i], yc);
        ctx.scale(kx, (scale[i] + scale[i + 1]) / 2);
        ctx.translate(-sxA, -yc);
        blit(lo, c.y, hi - lo, c.h);
        shadeSlice(lo, hi - lo, c, (angle[i] + angle[i + 1]) / 2);
        ctx.restore();
    }

    // Paper thickness: outline the sheet's projected silhouette, which also
    // hides the seams along the strips' top and bottom edges.
    ctx.beginPath();
    for (let i = 0; i <= FOLD_SLICES; i++) {
        const y = yc - halfH * scale[i];
        if (i === 0) ctx.moveTo(px[i], y);
        else ctx.lineTo(px[i], y);
    }
    for (let i = FOLD_SLICES; i >= 0; i--) {
        ctx.lineTo(px[i], yc + halfH * scale[i]);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(43, 43, 43, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

/**
 * Draw the board mid-fold: the half that stays put straight from the buffer,
 * the marks it is about to receive on top of it, the bare table where the
 * sheet lifted off, and the sheet itself — strip by strip, as if it rotated
 * about the fold line in 3D.
 *
 * @param {{x:number,y:number,w:number,h:number}} c - The contain rect.
 * @returns {void}
 */
function drawFolded(c) {
    const now = performance.now();
    const theta = foldAngle(now - fold.t0);
    const fx = foldX();
    const yc = c.y + c.h / 2;
    const halfW = c.w / 2;
    const flapLeft = fold.side === 'left';

    renderBoardBuffer();

    ctx.save();
    // The sheet may loom past the paper as it swings towards the viewer, so
    // clip to the canvas rather than to the contain rect.
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    // The half that stays put, 1:1 from the buffer.
    const stX = flapLeft ? fx : c.x;
    blit(stX, c.y, halfW, c.h);

    // The transferred marks live here: stamped for the press, so they peek
    // out from under the sheet as it opens.
    drawLandingDots(c, { x: stX, y: c.y, w: halfW, h: c.h }, now);

    // The table the sheet left behind, still shadowed by it, and the crease
    // shadow on the sheet that stays.
    shadeFoldSide({ x: flapLeft ? c.x : fx, y: c.y, w: halfW, h: c.h },
        flapLeft ? -1 : 1, theta);
    shadeFoldSide({ x: stX, y: c.y, w: halfW, h: c.h }, flapLeft ? 1 : -1, theta);

    // The sheet itself, last, so it lies over everything it covers.
    drawFlap(c, fx, yc, theta, flapLeft ? -1 : 1);

    ctx.restore();
}

/**
 * Render one frame: desktop margin, then either the flat board or — while a
 * fold runs — the sheet lifting over the other half.
 * @returns {void}
 */
function draw() {
    const c = contain();

    // Desktop/margin fill around the paper. While a fold runs this is also
    // the table showing through where the sheet used to lie.
    ctx.fillStyle = MARGIN;
    ctx.fillRect(0, 0, w, h);

    if (fold) {
        drawFolded(c);
    } else {
        drawBoard(c, true);
    }
}

/**
 * Draw the flat board: paper, fold line, stickmen, shot marks, HUD and
 * overlays — all from the latest `state`. The fold path runs this into the
 * buffer (landing false) and slices the result up; the flat path draws it
 * straight onto the canvas with the transferred marks included.
 *
 * @param {{x:number,y:number,w:number,h:number}} c - The contain rect.
 * @param {boolean} landing - Include the transferred shot marks. False when
 *   drawing into the fold's buffer: the fold draws those itself, once the
 *   press has revealed them.
 * @returns {void}
 */
function drawBoard(c, landing) {
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

    if (state) {
        // Own stickmen: local frame (0..1 across own half) scaled into the
        // LEFT half of the paper. Ink, because they are yours. Dead ones
        // (s.dead) play out the topple-then-grave animation in place.
        for (const s of state.own || []) {
            drawToken(
                'own',
                s,
                c.x + s.x * 0.5 * c.w,
                c.y + s.y * c.h,
                s.w * 0.5 * c.w,
                s.h * c.h,
                INK
            );
        }

        // Opponent stickmen: the server already mirrored them for our view,
        // so we only scale the local 0..1 frame into the RIGHT half — no
        // second mirror. Red, because they are the targets; a grave in red
        // is a target you already got.
        for (const s of state.opp || []) {
            drawToken(
                'opp',
                s,
                c.x + 0.5 * c.w + s.x * 0.5 * c.w,
                c.y + s.y * c.h,
                s.w * 0.5 * c.w,
                s.h * c.h,
                OPP_COLOR
            );
        }

        // Shots as dots: ours in the left half (ink), theirs in the right
        // (red). x/y arrive in the shooter's local frame, so the same
        // half-scaling as the stickmen applies. The dot shows where the shot
        // was aimed; its ring is the verdict, and waits until the paper is
        // flat again so the fold never gives the result away early.
        (state.shots || []).forEach((shot, i) => {
            const mine = shot.by === 'you';
            const px = mine
                ? c.x + shot.x * 0.5 * c.w
                : c.x + 0.5 * c.w + shot.x * 0.5 * c.w;
            const rec = landedAt.get(i);
            drawDot(c, px, c.y + shot.y * c.h, mine ? INK : OPP_COLOR, !!shot.hit,
                1, growth(performance.now(), rec ? rec.ring : 0, RING_MS));
        });

        // Transferred marks, mirrored across the fold onto the half the shot
        // landed on. The fold path holds these back until its press.
        if (landing) {
            drawLandingDots(c, null, performance.now());
        }

        // Not your turn: your own half dims, so the board says at a glance
        // that nothing you click will fire yet. The opponent's half is the
        // target, never the trigger, so it stays clear.
        if (state.phase === 'battle' && state.turn !== 'you') {
            ctx.fillStyle = 'rgba(30, 30, 30, 0.12)';
            ctx.fillRect(c.x, c.y, c.w / 2, c.h);
        }
    }

    drawHud(c);
    drawOverlays(c);

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

/** True while a requestAnimationFrame loop is already running. */
let animating = false;

/**
 * Whether any frame animation still has work to do: a sheet in flight, or a
 * stickman that has not finished toppling or rising as a grave. Settled
 * graves stamp a time long past, so they do not keep the loop alive — the
 * old "any death key exists" test would have repainted forever after the
 * first hit.
 *
 * @returns {boolean} True when the next frame needs to be painted.
 */
function animationsActive() {
    if (fold) return true;
    const now = performance.now();
    for (const t of deathAt.values()) {
        if (now - t < DEATH_MS) return true;
    }
    return false;
}

/**
 * Drive the frame animations: repaint every frame while the sheet is folding
 * or a stickman is still falling, then stop once the paper lies flat with
 * every grave settled. Restarted by each new state; never runs two loops at
 * once.
 * @returns {void}
 */
function animate() {
    if (animating) return;
    animating = true;
    const tick = () => {
        if (fold && performance.now() - fold.t0 >= FOLD_TOTAL_MS) {
            // The sheet is flat again: the next paint draws the plain board,
            // overlays and all.
            fold = null;
        }
        render();
        if (animationsActive()) {
            requestAnimationFrame(tick);   // still animating: next frame
        } else {
            animating = false;
        }
    };
    requestAnimationFrame(tick);
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
 * Open the game's WebSocket. Called once on load; a connection that drops
 * later is NOT re-opened (a fresh socket would join as a brand-new player),
 * so it surfaces the lost-connection banner instead.
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
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (err) {
            console.warn('ignoring malformed message', err);
            return;
        }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === MSG_WELCOME) {
            seat = typeof msg.seat === 'number' ? msg.seat : -1;
        } else if (msg.type === MSG_STATE) {
            const prev = state;
            state = msg;                 // store the whole message, render as-is
            // A shot the last state did not have folds the half it was fired
            // from; the marks and falls that state brings wait for the fold's
            // press, and the loop repaints until everything has settled.
            maybeStartFold(prev, msg);
            syncShots(msg);
            syncDeaths(msg);
            if (animationsActive()) {
                animate();
            } else {
                render();
            }
        }
        // Unknown message types are ignored on purpose.
    };

    socket.onerror = (err) => { console.error(err); };

    socket.onclose = () => {
        socket = null;
        // An intentional close (page unload) must not show the banner.
        if (!closingIntentionally) {
            disconnected = true;
            render();
        }
    };
}

/**
 * Tear down the current socket when the user leaves the page (reload, tab
 * close, navigation). Without this a reload would orphan the old socket on the
 * server, and its follow-up `join` would be admitted as a second player.
 * The intentional-close flag keeps this teardown from being reported as a
 * lost connection.
 * @returns {void}
 */
function closeSocket() {
    closingIntentionally = true;
    if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
    }
}

// Register teardown once per page load.
window.addEventListener('beforeunload', closeSocket);

// Connect on load (and again on page refresh, which re-runs this script).
connect();

/**
 * React to clicks on the play area: convert the pointer position into
 * normalized paper coordinates (0..1 across the WHOLE paper, so the own
 * half is 0..0.5) and dispatch by phase. Clicks that miss the paper are
 * ignored; during battle only the own half is clickable, and only while it
 * is this player's turn (the players fire one shot each in turn), and the
 * shot is sent in the player's LOCAL frame — the wire's x spans just that
 * half, so paper x `nx` becomes `nx * 2`. After the game is over, any click
 * on the paper asks for a rematch. The lobby ignores clicks entirely.
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

    // The sheet is mid-fold: the board is busy, and the half it folds onto
    // is covered anyway, so nothing is clickable until it lies flat again.
    if (fold) return;

    // Game over: any click on the paper requests a rematch.
    if (state && state.phase === 'over') {
        sendJSON({ type: MSG_REMATCH });
        return;
    }

    // Only the player's own half (LEFT of the fold, nx < 0.5) is clickable.
    if (nx >= 0.5) return;

    // Fire in battle, but only on YOUR turn — the two players alternate, one
    // shot each. The server enforces the same rule, so an early click would be
    // rejected anyway; this just keeps the input honest with the HUD. x is
    // doubled because the wire uses the player's own local frame (0 = outer
    // edge, 1 = fold), not the whole paper's.
    if (state && state.phase === 'battle' && state.turn === 'you') {
        sendJSON({ type: MSG_SHOT, x: nx * 2, y: ny });
    }
    // Lobby, the opponent's turn, or no state yet: nothing to send.
}

canvas.addEventListener('click', onClick);
