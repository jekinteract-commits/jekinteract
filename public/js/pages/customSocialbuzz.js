/* Halaman Custom Socialbuzz — katalog tema HTML/CSS Sobuz untuk ditempel
 * ke Dashboard SociaBuzz (Kustomisasi Overlay Alert). */
import { $, esc, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast } from '../lib/ui.js';

const SAMPLE = {
  amount: 'Rp 50.000',
  from_text: 'dari',
  supporter: 'BudiGamer',
  message: 'Mantap streamnya! Semangat terus 🔥'
};

function applySample(html) {
  return String(html || '')
    .replace(/\{amount\}/g, esc(SAMPLE.amount))
    .replace(/\{from_text\}/g, esc(SAMPLE.from_text))
    .replace(/\{supporter\}/g, esc(SAMPLE.supporter))
    .replace(/\{message\}/g, esc(SAMPLE.message));
}

function previewSrcdoc(theme) {
  const css = String(theme.css || '');
  const html = applySample(theme.html || '');
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;padding:0;background:transparent;}
  body{display:flex;align-items:flex-start;justify-content:center;padding:18px 12px;box-sizing:border-box;overflow:hidden;}
  .csb-preview-wrap{width:100%;display:flex;justify-content:center;}
  ${css}
</style>
</head><body><div class="csb-preview-wrap">${html}</div></body></html>`;
}

async function copyText(text, label) {
  const value = String(text || '');
  try {
    await navigator.clipboard.writeText(value);
    toast(label + ' berhasil disalin.', 'ok');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      toast(label + ' berhasil disalin.', 'ok');
    } catch (err) {
      toast('Gagal menyalin ' + label.toLowerCase() + '.', 'err');
    }
    document.body.removeChild(ta);
  }
}

function themeCard(theme) {
  const safeName = esc(theme.name || theme.id || 'Tema');
  return (
    '<article class="csb-card" data-theme-id="' + esc(theme.id) + '">' +
      '<div class="csb-card-head">' +
        '<div class="csb-card-title">' + icon('layers') + '<span>' + safeName + '</span></div>' +
        '<span class="csb-picked">Terpilih</span>' +
      '</div>' +
      '<div class="csb-preview">' +
        '<iframe title="Preview ' + safeName + '" referrerpolicy="no-referrer" data-preview-id="' + esc(theme.id) + '" style="display:block;width:100%;border:0;background:transparent;"></iframe>' +
      '</div>' +
      '<div class="csb-actions">' +
        '<button type="button" class="btn sm csb-copy-html" data-id="' + esc(theme.id) + '">' + icon('copy') + 'Salin HTML</button>' +
        '<button type="button" class="btn sm csb-copy-css" data-id="' + esc(theme.id) + '">' + icon('copy') + 'Salin CSS</button>' +
      '</div>' +
    '</article>'
  );
}

export default {
  id: 'customsocialbuzz',
  title: 'Custom Socialbuzz',
  icon: 'layers',

  render() {
    return (
      '<div class="ph"><h1>Custom Socialbuzz</h1>' +
      '<p>Kumpulan tema overlay alert siap pakai untuk SociaBuzz. Pilih tema, salin kode HTML dan CSS, lalu tempel ke dashboard SociaBuzz.</p></div>' +

      '<div class="stack">' +

      '<section class="panel">' +
        '<div class="fh"><div class="fh-t"><h2>Tentang Custom Socialbuzz</h2></div></div>' +
        '<div class="alert a-info csb-oneline">' + icon('info') +
          '<div>Custom Socialbuzz adalah koleksi template alert <b>HTML</b> dan <b>CSS</b> siap pakai untuk SociaBuzz.</div>' +
        '</div>' +
      '</section>' +

      '<section class="panel">' +
        '<div class="fh"><div class="fh-t"><h2>Cara Pakai di Socialbuzz</h2></div></div>' +
        '<div class="csb-steps">' +
          '<div class="csb-step"><span class="csb-step-n">1</span><div class="csb-step-b"><b class="csb-step-title">Salin HTML dan CSS sesuai tema</b><p>Klik <b>Salin HTML</b> dan <b>Salin CSS</b> pada tema yang kamu pilih.</p></div></div>' +
          '<div class="csb-step"><span class="csb-step-n">2</span><div class="csb-step-b"><b class="csb-step-title">Tempel ke Dashboard SocialBuzz</b><p>Login SocialBuzz, buka <b>Kustomisasi Overlay Alert</b>, lalu tempel ke <b>Kolom HTML Custom</b> dan <b>Kolom CSS Custom</b>.</p></div></div>' +
          '<div class="csb-step"><span class="csb-step-n">3</span><div class="csb-step-b"><b class="csb-step-title">Pasang URL Overlay Alert ke software live</b><p>Ambil <b>URL Overlay Alert</b> dari SocialBuzz, lalu pasang ke <b>TikTok Live Studio</b>, <b>OBS Studio</b>, atau <b>Browser Source</b>.</p></div></div>' +
        '</div>' +
      '</section>' +

      '<section class="panel">' +
        '<div class="fh"><div class="fh-t"><h2>Pilihan Tema</h2><div class="sub">Pilih tema, lihat preview, lalu salin HTML dan CSS untuk ditempel ke SocialBuzz.</div></div>' +
        '<span class="chip c-aud" id="csb-count">Memuat...</span></div>' +
        '<div id="csb-themes" class="csb-scroll">' +
          '<div class="alert a-info">' + icon('info') + '<div>Memuat tema Custom Socialbuzz...</div></div>' +
        '</div>' +
      '</section>' +

      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    const wrap = $('#csb-themes', root);
    const count = $('#csb-count', root);
    let themes = [];
    let selectedId = '';

    function setCount(n, label) {
      if (count) count.textContent = label || (n + ' tema');
    }

    function selectTheme(id, scroll) {
      selectedId = id || '';
      if (!wrap) return;
      wrap.querySelectorAll('.csb-card').forEach((card) => {
        card.classList.toggle('is-selected', card.getAttribute('data-theme-id') === selectedId);
      });
      if (scroll) {
        const sel = wrap.querySelector('.csb-card.is-selected');
        if (sel) sel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    function renderThemes(list) {
      themes = Array.isArray(list) ? list : [];
      if (!wrap) return;
      if (!themes.length) {
        setCount(0, '0 tema');
        wrap.innerHTML = '<div class="alert a-warn">' + icon('alert') + '<div>Tema tidak ditemukan. Pastikan folder <b>Sobuz/Code</b> berisi file tema HTML/CSS.</div></div>';
        return;
      }
      setCount(themes.length);
      wrap.innerHTML = themes.map(themeCard).join('');
      // Set srcdoc via JS property to avoid huge escaped HTML attributes.
      for (const theme of themes) {
        const safeId = (window.CSS && CSS.escape) ? CSS.escape(theme.id) : String(theme.id).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        const iframe = wrap.querySelector('iframe[data-preview-id="' + safeId + '"]');
        if (iframe) iframe.srcdoc = previewSrcdoc(theme);
      }
      if (themes[0]) selectTheme(themes[0].id);
    }

    async function load() {
      try {
        const r = await fetch('/api/sobuz/themes', { cache: 'no-store' });
        const data = await r.json();
        if (!r.ok || !data || data.ok === false) throw new Error((data && data.error) || 'Gagal memuat tema');
        renderThemes(data.themes || []);
      } catch (err) {
        if (wrap) wrap.innerHTML = '<div class="alert a-err">' + icon('alertCircle') + '<div>Gagal memuat tema Custom Socialbuzz. ' + esc(err.message || 'Coba muat ulang halaman.') + '</div></div>';
        setCount(0, 'Error');
      }
    }

    root.addEventListener('click', async (e) => {
      const htmlBtn = e.target.closest('.csb-copy-html');
      const cssBtn = e.target.closest('.csb-copy-css');
      const btn = htmlBtn || cssBtn;
      if (btn) {
        const id = btn.getAttribute('data-id') || '';
        const theme = themes.find((t) => t.id === id);
        if (!theme) return;
        selectTheme(theme.id);
        if (htmlBtn) return copyText(theme.html || '', 'HTML');
        return copyText(theme.css || '', 'CSS');
      }
      const card = e.target.closest('.csb-card');
      if (card) selectTheme(card.getAttribute('data-theme-id') || '');
    });

    load();
    return () => d.run();
  }
};
