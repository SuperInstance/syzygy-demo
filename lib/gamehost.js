'use strict';
/*
 * gamehost.js — runs the vendored justMoritz engine headless under jsdom and
 * exposes the demo's two strictly separated channels:
 *
 *   AGENT channel   getAgentGrid()   -> ONLY the character buffer (rows of text)
 *   DISPLAY channel getDisplayState()-> pose / map / sprites, for the page and
 *                                       scorer ONLY. Never imported by the
 *                                       perception or strategy code paths.
 *
 * Actions enter the game the way a human's fingers would: synthetic keyboard
 * events dispatched to the engine's own window.onkeydown/onkeyup handlers.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor');

const KEYS = {
  forward: 87,    // W
  back: 83,       // S
  strafeLeft: 65, // A
  strafeRight: 68,// D
  turnLeft: 81,   // Q
  turnRight: 69,  // E
  run: 16,        // Shift
  jump: 32        // Space
};

class GameHost {
  constructor() {
    const html = fs.readFileSync(path.join(VENDOR_DIR, 'index.html'), 'utf8');
    this.dom = new JSDOM(html, {
      url: 'file://' + path.join(VENDOR_DIR, 'index.html'),
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true
    });
    this.window = this.dom.window;
    this.errors = [];
    this.window.addEventListener('error', e => this.errors.push(String(e.message || e)));
    this._held = new Map(); // keyName -> timeout id
  }

  engine() {
    return this.window.gameEngineJS;
  }

  /** Wait until the engine has produced at least one frame. */
  async ready(timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (this.engine() && this.engine().__syzAgentView()) return true;
      } catch (e) { /* not up yet */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('engine did not produce a frame; page errors: ' + this.errors.join('; '));
  }

  /** AGENT CHANNEL — the character buffer, and nothing else. */
  getAgentGrid() {
    const view = this.engine().__syzAgentView();
    if (!view) return null;
    return view.rows; // array of strings, top row first
  }

  getAgentGridSize() {
    const view = this.engine().__syzAgentView();
    return view ? { width: view.width, height: view.height } : null;
  }

  /** DISPLAY CHANNEL — ground truth for page/scorer only. */
  getDisplayState() {
    try {
      return this.engine().__syzDisplayState();
    } catch (e) {
      return null;
    }
  }

  _dispatch(type, which) {
    const ev = new this.window.KeyboardEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'which', { value: which });
    Object.defineProperty(ev, 'keyCode', { value: which });
    this.window.dispatchEvent(ev);
  }

  keyDown(name) {
    const code = KEYS[name];
    if (!code) throw new Error('unknown key: ' + name);
    this._dispatch('keydown', code);
  }

  keyUp(name) {
    const code = KEYS[name];
    if (!code) throw new Error('unknown key: ' + name);
    this._dispatch('keyup', code);
  }

  /** Hold a key for ms milliseconds (non-blocking). */
  holdKey(name, ms) {
    this.keyDown(name);
    return new Promise(resolve => setTimeout(() => { this.keyUp(name); resolve(); }, ms));
  }

  releaseAll() {
    for (const name of Object.keys(KEYS)) {
      try { this.keyUp(name); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { GameHost, KEYS };
