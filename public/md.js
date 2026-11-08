// Small, safe Markdown renderer: everything is HTML-escaped first, and only
// the constructs below produce markup. Written for the note panel.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeUrl = (u) => !/^[a-z][a-z0-9+.-]*:/i.test(u) || /^(https?|mailto):/i.test(u);

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  // images: relative paths only (ticket attachments); no remote or data: images
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, u) =>
    /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(u) ? m : `<img src="${u}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
    safeUrl(u) ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>` : m);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => (codes[i] === undefined ? '' : `<code>${esc(codes[i])}</code>`));
}

function itemContent(text) {
  const t = /^\[( |x|X)\]\s+(.*)$/.exec(text);
  if (t) return `<input type="checkbox" disabled${t[1] === ' ' ? '' : ' checked'}> ${inline(t[2])}`;
  return inline(text);
}

function renderList(items) {
  let html = '';
  const stack = [];
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    if (top && top.indent === it.indent) html += '</li>';
    else { html += `<${tag}>`; stack.push({ indent: it.indent, tag }); }
    html += `<li>${itemContent(it.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || '') && (l || '').includes('-');
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const startsBlock = (l) => /^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|---+\s*$)/.test(l);

export function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const lang = /^```\s*([\w+-]+)/.exec(line)?.[1] || ''; // kept as a class so the note panel can offer Run on shell blocks
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^>/.test(line)) {
      const buf = [];
      for (; i < lines.length && /^>/.test(lines[i]); i++) buf.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && isTableSep(lines[i + 1])) {
      const head = cells(line);
      let html = `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`;
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
        html += `<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      }
      out.push(`${html}</tbody></table>`);
      continue;
    }
    if (LIST_RE.test(line)) {
      const items = [];
      for (; i < lines.length; i++) {
        const lm = LIST_RE.exec(lines[i]);
        if (lm) items.push({ indent: lm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(lm[2]), text: lm[3] });
        else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1].text += ` ${lines[i].trim()}`;
        else break;
      }
      out.push(renderList(items));
      continue;
    }
    const buf = [];
    for (; i < lines.length && lines[i].trim() && (!buf.length || !startsBlock(lines[i])); i++) buf.push(lines[i].trim());
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}
