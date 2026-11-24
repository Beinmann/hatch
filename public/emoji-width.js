// Cell widths for the browser terminal, matching tmux: an emoji cluster (skin tone, ZWJ sequence, flag) takes two columns.
// A variation selector keeps the width of its cell: for a narrow base (❤️ ⚠️ ™️) tmux itself erases and skips the second cell (ESC[1X ESC[C), so widening it here would push the following text one column too far right.
// Wraps a Unicode 11 width provider (xterm's addon); only the joining rules are added. Property values are xterm's:
// (kind << 3) | (width << 1) | shouldJoin. A joining character keeps the width of the cell it joins, or widens it.
const KIND_ZWJ = 1, KIND_RI = 2;
const prop = (kind, width, join) => (kind << 3) | ((width & 3) << 1) | (join ? 1 : 0);
const widthOf = (p) => (p >> 1) & 3;
const kindOf = (p) => p >> 3;

// The Unicode 11 table predates later emoji (🫠 🥹 🩷 🪩 ...), which it counts as one column; tmux counts every emoji-presentation character as two.
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const newerEmoji = (cp) => cp >= 0x1F000 && cp <= 0x1FAFF && EMOJI_PRESENTATION.test(String.fromCodePoint(cp));

export function emojiWidthProvider(base) {
  return {
    version: '11-emoji',
    wcwidth: (cp) => (base.wcwidth(cp) === 1 && newerEmoji(cp) ? 2 : base.wcwidth(cp)),
    charProperties(cp, preceding) {
      const pw = widthOf(preceding), pk = kindOf(preceding);
      if (cp === 0xFE0F && pw > 0) return prop(0, pw, true);          // emoji presentation selector: joins, the cell keeps its width
      if (cp === 0x200D && pw > 0) return prop(KIND_ZWJ, pw, true);   // zero width joiner
      if (pk === KIND_ZWJ && pw > 0) return prop(0, pw, true);        // the character after a joiner joins the cluster
      if (cp >= 0x1F3FB && cp <= 0x1F3FF && pw > 0) return prop(0, pw, true); // skin tone modifier
      if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return pk === KIND_RI && pw > 0 ? prop(0, pw, true) : prop(KIND_RI, 2, false); // flag = two regional indicators
      const props = base.charProperties(cp, preceding);
      return widthOf(props) === 1 && newerEmoji(cp) ? prop(kindOf(props), 2, props & 1) : props;
    },
  };
}
