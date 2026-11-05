'use strict';

const ICONS = {
  siren:
    'M120 16V8a8 8 0 0 1 16 0v8a8 8 0 0 1-16 0m80 32a8 8 0 0 0 5.66-2.34l8-8a8 8 0 0 0-11.32-11.32l-8 8A8 8 0 0 0 200 48M50.34 45.66a8 8 0 0 0 11.32-11.32l-8-8a8 8 0 0 0-11.32 11.32ZM232 176v24a16 16 0 0 1-16 16H40a16 16 0 0 1-16-16v-24a16 16 0 0 1 16-16v-32a88 88 0 0 1 88.67-88c48.15.36 87.33 40.29 87.33 89v31a16 16 0 0 1 16 16m-97.32-88.11C153.67 91.08 168 108.32 168 128a8 8 0 0 0 16 0c0-27.4-20.07-51.43-46.68-55.89a8 8 0 1 0-2.64 15.78M216 200v-24H40v24z',
  pin: 'M128 16a88.1 88.1 0 0 0-88 88c0 75.3 80 132.17 83.41 134.55a8 8 0 0 0 9.18 0C136 236.17 216 179.3 216 104a88.1 88.1 0 0 0-88-88m0 56a32 32 0 1 1-32 32 32 32 0 0 1 32-32',
  shield:
    'M208 36H48a20 20 0 0 0-20 20v56c0 54.29 26.32 87.22 48.4 105.29 23.71 19.39 47.44 26 48.44 26.29a12.1 12.1 0 0 0 6.32 0c1-.28 24.73-6.9 48.44-26.29 22.08-18.07 48.4-51 48.4-105.29V56a20 20 0 0 0-20-20m-4 76c0 35.71-13.09 64.69-38.91 86.15A126.3 126.3 0 0 1 128 219.38a126.1 126.1 0 0 1-37.09-21.23C65.09 176.69 52 147.71 52 112V60h152ZM79.51 144.49a12 12 0 1 1 17-17L112 143l47.51-47.52a12 12 0 0 1 17 17l-56 56a12 12 0 0 1-17 0Z',
  check:
    'M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24m45.66 85.66-56 56a8 8 0 0 1-11.32 0l-24-24a8 8 0 0 1 11.32-11.32L112 148.69l50.34-50.35a8 8 0 0 1 11.32 11.32',
  paw: 'M240 108a28 28 0 1 1-28-28 28 28 0 0 1 28 28m-168 0a28 28 0 1 0-28 28 28 28 0 0 0 28-28m20-20a28 28 0 1 0-28-28 28 28 0 0 0 28 28m72 0a28 28 0 1 0-28-28 28 28 0 0 0 28 28m23.12 60.86a35.3 35.3 0 0 1-16.87-21.14 44 44 0 0 0-84.5 0A35.25 35.25 0 0 1 69 148.82 40 40 0 0 0 88 224a39.5 39.5 0 0 0 15.52-3.13 64.1 64.1 0 0 1 48.87 0 40 40 0 0 0 34.73-72Z',
};

const SPECIES = { cat: 'Kedi', dog: 'Köpek', rabbit: 'Tavşan', bird: 'Kuş' };

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const view = document.getElementById('view');
const brandNote = document.getElementById('brand-note');

// Sayfadaki her yazı bu işlevden geçer. Metinler yazı olarak eklenir, kod olarak çalışamaz.
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'class') {
      node.className = value;
    } else if (key.startsWith('on')) {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function show(note, ...nodes) {
  brandNote.textContent = note;
  view.replaceChildren(...nodes.filter(Boolean));
}

async function callServer(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `HTTP ${response.status}`);
  }
  return data;
}

function timeAgo(date) {
  const elapsed = Date.now() - date.getTime();
  if (elapsed < MINUTE_MS) {
    return 'az önce';
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} dk önce`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)} sa önce`;
  }
  return `${Math.floor(elapsed / DAY_MS)} gün önce`;
}

function dateTimeLabel(date) {
  const day = date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' });
  const time = date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time.replace(':', '.')}`;
}

function photoUrl(file) {
  return `/v1/public/photos/${encodeURIComponent(file)}`;
}

function photoPlaceholder() {
  return el('div', { class: 'photo photo-empty' }, icon('paw'));
}

function photoOf({ photo_path: path, pet_name: name }) {
  if (!path) {
    return photoPlaceholder();
  }
  const image = el('img', { class: 'photo', src: photoUrl(path), alt: `${name} fotoğrafı` });
  image.addEventListener('error', () => image.replaceWith(photoPlaceholder()));
  return image;
}

function field(label, control, hint) {
  return el(
    'label',
    { class: 'field' },
    el('span', null, label),
    control,
    hint ? el('small', null, hint) : null,
  );
}

// Konum isteğe bağlı: izin verilmezse kişi yer adını yazarak da ihbar gönderebilir.
function locationControl(onChange) {
  const box = el('div');

  function showIdle(message) {
    box.replaceChildren(
      ...[
        el(
          'button',
          { type: 'button', class: 'btn btn-alert', onclick: askLocation },
          icon('pin'),
          'Şu an buradaysa konumumu ekle',
        ),
        message ? el('p', { class: 'message', role: 'alert' }, message) : null,
      ].filter(Boolean),
    );
  }

  function showAdded() {
    box.replaceChildren(
      el(
        'div',
        { class: 'located' },
        icon('check'),
        el('span', null, 'Şu anki konumun eklendi'),
        el(
          'button',
          {
            type: 'button',
            class: 'link',
            onclick: () => {
              onChange(null);
              showIdle();
            },
          },
          'Kaldır',
        ),
      ),
    );
  }

  function askLocation() {
    if (!navigator.geolocation) {
      showIdle('Bu tarayıcı konum veremiyor. Yer adını yazman yeterli.');
      return;
    }
    box.replaceChildren(
      el('button', { type: 'button', class: 'btn btn-alert', disabled: '' }, 'Konum alınıyor...'),
    );
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        onChange({ lat: coords.latitude, lng: coords.longitude });
        showAdded();
      },
      (error) => {
        showIdle(
          error.code === error.PERMISSION_DENIED
            ? 'Konum izni verilmedi. Yer adını yazman yeterli.'
            : 'Konum alınamadı. Yer adını yazman yeterli.',
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }

  showIdle();
  return box;
}

function sendErrorText(error) {
  switch (error.message) {
    case 'empty_sighting':
      return 'Konumunu ekle ya da nerede gördüğünü yaz.';
    case 'too_many_sightings':
    case 'rate_limited':
      return 'Şu anda çok fazla mesaj geldi. Biraz sonra tekrar dene.';
    case 'unknown_code':
      return 'Bu kayıt artık yok, mesaj gönderilemedi.';
    default:
      return 'Gönderilemedi. İnternet bağlantını kontrol edip tekrar dene.';
  }
}

function sightingForm({ code, heading, submitLabel, note, contactHint }) {
  let spot = null;

  const place = el('input', {
    type: 'text',
    maxlength: '80',
    autocomplete: 'off',
    placeholder: 'Örneğin Bahariye Caddesi',
  });
  const message = el('textarea', {
    maxlength: '500',
    placeholder: 'Örneğin yanımda ya da parka doğru gitti',
  });
  const contact = el('input', {
    type: 'text',
    maxlength: '80',
    autocomplete: 'off',
    placeholder: 'Telefon ya da e-posta',
  });
  const submit = el('button', { type: 'submit', class: 'btn btn-ink' }, submitLabel);
  const feedback = el('div', { 'aria-live': 'assertive' });

  function setFeedback(text) {
    feedback.replaceChildren(...(text ? [el('p', { class: 'message' }, text)] : []));
  }

  const form = el(
    'form',
    {
      class: 'form',
      novalidate: '',
      onsubmit: async (event) => {
        event.preventDefault();
        if (submit.disabled) {
          return;
        }
        if (!spot && !place.value.trim() && !message.value.trim()) {
          setFeedback('Konumunu ekle ya da nerede gördüğünü yaz.');
          return;
        }
        setFeedback('');
        submit.disabled = true;
        submit.textContent = 'Gönderiliyor...';
        try {
          await callServer(`/v1/public/pets/${code}/sightings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              place: place.value,
              lat: spot?.lat ?? null,
              lng: spot?.lng ?? null,
              message: message.value,
              contact: contact.value,
            }),
          });
          form.replaceWith(sentMessage({ code, heading, submitLabel, note, contactHint }));
        } catch (error) {
          console.warn('Gönderilemedi', error);
          setFeedback(sendErrorText(error));
          submit.disabled = false;
          submit.textContent = submitLabel;
        }
      },
    },
    el('h2', null, heading),
    locationControl((value) => {
      spot = value;
    }),
    field('Nerede gördün?', place),
    field('Mesajın', message),
    field('Sana nasıl ulaşsınlar?', contact, contactHint),
    feedback,
    submit,
    el('p', { class: 'note' }, icon('shield'), el('span', null, note)),
  );
  return form;
}

function sentMessage(formOptions) {
  const box = el(
    'div',
    { class: 'sent', tabindex: '-1' },
    icon('check'),
    el('h2', null, 'Teşekkürler!'),
    el('p', null, 'Mesajın iletildi. Uygulamayı açtıklarında görecekler.'),
    el(
      'button',
      { type: 'button', class: 'link', onclick: () => box.replaceWith(sightingForm(formOptions)) },
      'Bir şey daha eklemek istiyorum',
    ),
  );
  // Form uzundu, kişi sonucu görsün diye ekran buraya kayar.
  requestAnimationFrame(() => {
    box.focus();
    box.scrollIntoView({ block: 'center' });
  });
  return box;
}

function showLost(report, code) {
  const name = report.pet_name;
  document.title = `${name} kayıp | Patika`;
  const kind = [SPECIES[report.species], report.breed].filter(Boolean).join(', ');
  const form = sightingForm({
    code,
    heading: 'Beni gördün mü?',
    submitLabel: 'Aileme gönder',
    contactHint: 'Şu an yanındaysam numaranı yaz, ailem seni arayabilsin. Yalnızca onlar görür.',
    note: 'Konumun ve yazdıkların yalnızca aileme gider, bu sayfada görünmez.',
  });
  // Tanıtım yazısı uzayınca form ekranın altında kalıyor: yabancı ne yapacağını hemen görsün.
  const jump = el(
    'button',
    {
      type: 'button',
      class: 'btn btn-alert jump',
      onclick: () => form.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    },
    'Beni gördüysen haber ver',
  );
  show(
    'Kayıp ilanı',
    el(
      'p',
      { class: 'strip' },
      icon('siren'),
      el('span', null, `${name} ${timeAgo(new Date(report.started_at))} kayıp bildirildi`),
    ),
    photoOf(report),
    el('h1', null, `Merhaba, ben ${name}`),
    el('p', { class: 'lead' }, 'Kayboldum, ailem beni arıyor.'),
    report.description ? el('p', { class: 'lead' }, report.description) : null,
    el(
      'div',
      { class: 'facts' },
      el('span', null, el('b', null, 'Son görüldüğüm yer: '), report.last_seen_area),
      el('span', null, el('b', null, 'Ne zaman: '), dateTimeLabel(new Date(report.last_seen_at))),
      kind ? el('span', null, el('b', null, 'Türüm: '), kind) : null,
    ),
    jump,
    form,
  );
}

const NEUTRAL_FORM = {
  heading: 'Ailesine haber ver',
  submitLabel: 'Ailesine gönder',
  contactHint: 'Hayvan yanındaysa numaranı yaz, ailesi seni arayabilsin. Yalnızca onlar görür.',
  note: 'Konumun ve yazdıkların yalnızca ailesine gider, bu sayfada görünmez.',
};

function showFound(report, code) {
  const name = report.pet_name;
  document.title = `${name} bulundu | Patika`;
  const reveal = el(
    'button',
    {
      type: 'button',
      class: 'btn btn-white',
      onclick: () => reveal.replaceWith(sightingForm({ code, ...NEUTRAL_FORM })),
    },
    'Bu hayvan şu an yanında mı? Ailesine haber ver',
  );
  show(
    'Kayıp ilanı',
    el('p', { class: 'strip ok' }, icon('check'), el('span', null, `${name} evine döndü`)),
    el('h1', null, 'Teşekkürler'),
    el('p', { class: 'lead' }, 'Yardım eden herkese teşekkür ederiz. Bu ilan artık kapalı.'),
    el('div', { class: 'form' }, reveal),
  );
}

function showNoReport(code) {
  show(
    'Hayvan künyesi',
    el('h1', null, 'Bu hayvanın bir ailesi var'),
    el(
      'p',
      { class: 'lead' },
      'Şu an kayıp olarak bildirilmemiş. Yanında ya da sahipsiz görünüyorsa ailesine buradan haber verebilirsin.',
    ),
    sightingForm({ code, ...NEUTRAL_FORM }),
  );
}

function showNotFound() {
  show(
    '',
    el('h1', null, 'Bu ilan bulunamadı'),
    el('p', { class: 'lead' }, 'QR kodunu yeniden okutmayı dene ya da bağlantıyı kontrol et.'),
  );
}

function showFailed(code) {
  show(
    '',
    el('h1', null, 'Sayfa açılamadı'),
    el('p', { class: 'lead' }, 'İnternet bağlantını kontrol edip tekrar dene.'),
    el(
      'div',
      { class: 'form' },
      el('button', { type: 'button', class: 'btn btn-ink', onclick: () => load(code) }, 'Tekrar dene'),
    ),
  );
}

async function load(code) {
  show('', el('p', { class: 'loading' }, 'Yükleniyor...'));
  try {
    const report = await callServer(`/v1/public/pets/${code}`);
    if (report.status === 'lost') {
      showLost(report, code);
    } else if (report.status === 'found') {
      showFound(report, code);
    } else {
      showNoReport(code);
    }
  } catch (error) {
    if (error.message === 'unknown_code') {
      showNotFound();
      return;
    }
    console.warn('İlan okunamadı', error);
    showFailed(code);
  }
}

const match = location.pathname.match(/^\/p\/([0-9a-f]{12})\/?$/);
if (match) {
  load(match[1]);
} else {
  showNotFound();
}
