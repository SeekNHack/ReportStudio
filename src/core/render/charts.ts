export interface Slice {
  label: string;
  value: number;
  color: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Donut chart with a legend, as inline SVG. */
export function donutChart(slices: Slice[], opts: { size?: number; center?: string; caption?: string } = {}): string {
  const size = opts.size ?? 180;
  const r = size / 2 - 14;
  const c = size / 2;
  const total = slices.reduce((s, x) => s + x.value, 0);
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = (s.value / total) * circ;
      const arc = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.color}" stroke-width="22" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${c} ${c})"/>`;
      offset += len;
      return arc;
    })
    .join('');
  const empty = total === 0 ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="22"/>` : '';
  const center = opts.center ?? String(total);
  const legend = slices
    .map(
      (s) =>
        `<li><span class="chart-swatch" style="background:${s.color}"></span><span class="chart-label">${esc(s.label)}</span><span class="chart-value">${s.value}</span></li>`,
    )
    .join('');
  return `<figure class="chart chart-donut"><div class="chart-body"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">${empty}${arcs}<text x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" class="chart-center">${esc(center)}</text></svg><ul class="chart-legend">${legend}</ul></div>${opts.caption ? `<figcaption>${esc(opts.caption)}</figcaption>` : ''}</figure>`;
}

/** Horizontal bar chart, as inline SVG. */
export function barChart(slices: Slice[], opts: { width?: number; caption?: string } = {}): string {
  const width = opts.width ?? 460;
  const rowH = 26;
  const labelW = 90;
  const max = Math.max(1, ...slices.map((s) => s.value));
  const rows = slices
    .map((s, i) => {
      const y = i * rowH;
      const w = ((width - labelW - 40) * s.value) / max;
      return `<text x="0" y="${y + 17}" class="chart-label">${esc(s.label)}</text><rect x="${labelW}" y="${y + 4}" rx="3" width="${Math.max(w, 2)}" height="${rowH - 8}" fill="${s.color}"/><text x="${labelW + w + 6}" y="${y + 17}" class="chart-value">${s.value}</text>`;
    })
    .join('');
  const h = slices.length * rowH;
  return `<figure class="chart chart-bar"><svg viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img">${rows}</svg>${opts.caption ? `<figcaption>${esc(opts.caption)}</figcaption>` : ''}</figure>`;
}
