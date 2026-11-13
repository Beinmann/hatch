// Cell widths for the browser terminal, matching tmux: an emoji cluster (emoji + VS16, skin tone, ZWJ sequence, flag) takes two columns.
// Wraps a Unicode 11 width provider (xterm's addon); only the joining rules are added. Property values are xterm's:
// (kind << 3) | (width << 1) | shouldJoin. A joining character keeps the width of the cell it joins, or widens it.
const KIND_ZWJ = 1, KIND_RI = 2;
const prop = (kind, width, join) => (kind << 3) | ((width & 3) << 1) | (join ? 1 : 0);
const widthOf = (p) => (p >> 1) & 3;
const kindOf = (p) => p >> 3;

export function emojiWidthProvider(base) {
  return {
    version: '11-emoji',
    wcwidth: (cp) => base.wcwidth(cp),
    charProperties(cp, preceding) {
      const pw = widthOf(preceding), pk = kindOf(preceding);
      if (cp === 0xFE0F && pw > 0) return prop(0, 2, true);          // emoji presentation selector: the cell becomes wide
      if (cp === 0x200D && pw > 0) return prop(KIND_ZWJ, pw, true);   // zero width joiner
      if (pk === KIND_ZWJ && pw > 0) return prop(0, pw, true);        // the character after a joiner joins the cluster
      if (cp >= 0x1F3FB && cp <= 0x1F3FF && pw > 0) return prop(0, pw, true); // skin tone modifier
      if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return pk === KIND_RI && pw > 0 ? prop(0, pw, true) : prop(KIND_RI, 2, false); // flag = two regional indicators
      return base.charProperties(cp, preceding);
    },
  };
}
