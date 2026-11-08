// Plain-text terminal output, shared by output windows, retained runs and terminal watches.
// An OSC payload cannot cross another ESC: malformed prefixes must not repeatedly scan the whole remaining log.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
// Bare control bytes have no useful representation in plain-text logs and can make browser shaping expensive.
export const stripAnsi = (text) => text.replace(ANSI, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

// Streaming consumers cannot re-clean a complete log. Keep only the parser state, never an unbounded OSC payload.
export function createAnsiStripper() {
  let state = 'text';
  return {
    push(text) {
      let out = '';
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (state === 'osc') {
          if (c === '\x07') state = 'text'; else if (c === '\x1b') state = 'oscEscape';
        } else if (state === 'oscEscape') {
          if (c === '\\') state = 'text'; else { state = 'escape'; i--; }
        } else if (state === 'escape') {
          if (c === '[') state = 'csi';
          else if (c === ']') state = 'osc';
          else if (c === '(' || c === ')') state = 'charset';
          else if (c === '=' || c === '>') state = 'text';
          else { state = 'text'; i--; }
        } else if (state === 'csi') {
          if (c === '\x1b') state = 'escape';
          else if (c >= '@' && c <= '~') state = 'text';
          else if (c < ' ' || c > '?') { state = 'text'; i--; }
        } else if (state === 'charset') {
          state = c === '\x1b' ? 'escape' : 'text';
        } else if (c === '\x1b') state = 'escape';
        else if (c === '\t' || c === '\n' || c === '\r' || (c >= ' ' && c !== '\x7f')) out += c;
      }
      return out;
    },
  };
}
