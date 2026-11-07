'use strict';

// Yönetim paneli. Kullanıcıların yazdığı her şey ekrana yalnızca metin olarak konur (h ve textContent):
// bir ilan açıklamasına yazılan kod, yöneticinin tarayıcısında asla çalışmaz.

const app = document.getElementById('app');
const dialog = document.getElementById('confirm');
const notice = document.getElementById('notice');

const SPECIES = { cat: 'Kedi', dog: 'Köpek', rabbit: 'Tavşan', bird: 'Kuş' };
const SERVICES = {
  exam: 'Muayene',
  vaccine: 'Aşı',
  surgery: 'Ameliyat',
  dental: 'Diş',
  lab: 'Laboratuvar',
  imaging: 'Görüntüleme',
  grooming: 'Bakım',
  emergency: 'Acil',
};
const DAYS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
const CLINIC_STAMPS = {
  pending: { label: 'Bekliyor', kind: 'pending' },
  approved: { label: 'Listede', kind: 'approved' },
  rejected: { label: 'Reddedildi', kind: 'rejected' },
};
const PROVIDERS = { apple: 'Apple ile giriş', email: 'E-posta ile giriş', development: 'Deneme hesabı' };
const NETWORK_ERROR = 'Sunucuya ulaşılamadı. Bağlantını kontrol edip tekrar dene.';
const STAMP_PAUSE_MS = 700;
const NOTICE_MS = 4000;

const state = {
  email: null,
  summary: null,
  clinicStatus: 'pending',
  reportState: 'open',
  userFilter: 'all',
  userQuery: '',
};

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === 'class') {
      element.className = value;
    } else if (key.startsWith('on')) {
      element.addEventListener(key.slice(2), value);
    } else {
      element.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) {
      element.append(child);
    }
  }
  return element;
}

async function api(method, path, body) {
  let response;
  try {
    response = await fetch(`/admin/api${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (response.status === 204) {
    return null;
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, json?.error ?? 'server_error');
  }
  return json;
}

const DATE = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Istanbul',
});
const TIME = new Intl.DateTimeFormat('tr-TR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Istanbul',
});

function formatDate(value) {
  return value ? DATE.format(new Date(value)) : '';
}

function formatDateTime(value) {
  return value ? `${DATE.format(new Date(value))}, ${TIME.format(new Date(value)).replace(':', '.')}` : '';
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle('notice-error', isError);
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => {
    notice.textContent = '';
  }, NOTICE_MS);
}

// Onay penceresi. Geri alınamayan düğme varsayılan seçili gelmez: Enter yanlışlıkla işlem yapmaz.
function confirmAction({ title, body, action, kind = '' }) {
  return new Promise((resolve) => {
    const finish = (result) => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(result);
    };
    const onCancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    const keep = h('button', { type: 'button', class: 'button button-quiet', onclick: () => finish(false) }, 'Vazgeç');
    dialog.replaceChildren(
      h('h2', { id: 'confirm-title', class: 'confirm-title' }, title),
      h('p', { class: 'confirm-body' }, body),
      h(
        'div',
        { class: 'confirm-actions' },
        keep,
        h('button', { type: 'button', class: `button ${kind}`, onclick: () => finish(true) }, action),
      ),
    );
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
    keep.focus();
  });
}

// Oturum süresi dolduysa girişe döner, diğer hatalarda altta kısa yazı gösterir.
function handleActionError(error) {
  if (error.status === 401) {
    showLogin('Oturumun süresi doldu. Yeniden giriş yap.');
    return;
  }
  showNotice(error.status === 0 ? NETWORK_ERROR : 'İşlem yapılamadı. Sayfayı yenileyip tekrar dene.', true);
}

function loadFailed(error, retry) {
  if (error.status === 401) {
    showLogin('Oturumun süresi doldu. Yeniden giriş yap.');
    return null;
  }
  return h(
    'div',
    { class: 'state state-error' },
    h('strong', {}, 'Liste açılamadı'),
    error.status === 0 ? NETWORK_ERROR : 'Sunucu hata verdi. Biraz sonra tekrar dene.',
    h('br'),
    h('button', { type: 'button', class: 'button button-small', onclick: retry }, 'Tekrar dene'),
  );
}

function emptyState(title, body) {
  return h('div', { class: 'state' }, h('strong', {}, title), body);
}

function loading() {
  return h('div', { class: 'state' }, 'Yükleniyor...');
}

function tabs(options, selected, onSelect) {
  return h(
    'div',
    { class: 'tabs', role: 'group', 'aria-label': 'Süzgeç' },
    options.map(([value, label]) =>
      h(
        'button',
        {
          type: 'button',
          class: 'tab',
          'aria-pressed': value === selected ? 'true' : 'false',
          onclick: () => onSelect(value),
        },
        label,
      ),
    ),
  );
}

function polaroid(url, name) {
  return h(
    'div',
    { class: 'polaroid' },
    url
      ? h('img', { src: url, alt: `${name} fotoğrafı`, width: 72, height: 72 })
      : h('div', { class: 'polaroid-empty' }, 'Fotoğraf yok'),
  );
}

function stamp(label, kind, isLanding = false) {
  return h('div', { class: `stamp stamp-${kind}${isLanding ? ' stamp-landing' : ''}` }, label);
}

function fact(label, value) {
  return value === null || value === undefined || value === '' ? [] : [h('dt', {}, label), h('dd', {}, value)];
}

// Klinik web adresi kullanıcıdan gelir: yalnızca http ve https bağlantı olur, gerisi düz yazı kalır.
function safeLink(url, label = url) {
  return /^https?:\/\//i.test(url)
    ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label)
    : label;
}

// ---- Özet ----

function ledgerValues(values) {
  return h(
    'span',
    { class: 'ledger-values' },
    values.map(([count, label]) => h('span', {}, h('b', {}, String(count)), label)),
  );
}

function ledgerRow(name, values, href) {
  const content = [h('span', { class: 'ledger-name' }, name), ledgerValues(values)];
  return h('li', {}, href ? h('a', { class: 'ledger-row', href }, content) : h('div', { class: 'ledger-row' }, content));
}

async function renderSummary(view) {
  const summary = await refreshSummary();
  const pending = summary.clinics_pending;
  const open = summary.reports_open;
  view.replaceChildren(
    h(
      'div',
      { class: 'head' },
      h(
        'div',
        {},
        h(
          'h1',
          { class: 'title' },
          pending > 0 ? `Onay bekleyen ${pending} klinik var` : 'Onay bekleyen klinik yok',
        ),
        h(
          'p',
          { class: 'lead' },
          open > 0 ? `${open} kayıp ilanı şu an yayında.` : 'Şu an yayında kayıp ilanı yok.',
        ),
      ),
      pending > 0 && h('a', { class: 'button', href: '#/klinikler' }, 'Klinikleri aç'),
    ),
    h(
      'ul',
      { class: 'ledger' },
      ledgerRow(
        'Hesaplar',
        [
          [summary.owners, 'sahip'],
          [summary.vets, 'veteriner'],
          [summary.suspended, 'kapalı'],
          [summary.pets, 'hayvan'],
        ],
        '#/kullanicilar',
      ),
      ledgerRow(
        'Klinikler',
        [
          [summary.clinics_pending, 'bekleyen'],
          [summary.clinics_approved, 'listede'],
          [summary.clinics_rejected, 'reddedilen'],
        ],
        '#/klinikler',
      ),
      ledgerRow(
        'Kayıp ilanları',
        [
          [summary.reports_open, 'açık'],
          [summary.reports_found, 'bulundu'],
          [summary.reports_removed, 'kaldırılan'],
          [summary.sightings, 'ihbar'],
        ],
        '#/ilanlar',
      ),
      ledgerRow('Randevular', [
        [summary.appointments_pending, 'bekleyen'],
        [summary.appointments_confirmed, 'onaylı yaklaşan'],
        [summary.appointments_total, 'toplam'],
      ]),
    ),
  );
}

// ---- Klinikler ----

function hoursText(hours) {
  return hours
    .map((day, index) => `${DAYS[index]}: ${day ? `${day.open} - ${day.close}` : 'Kapalı'}`)
    .join('\n');
}

function clinicFacts(clinic) {
  return h(
    'dl',
    { class: 'facts' },
    fact('Telefon', clinic.phone),
    fact('Adres', clinic.address),
    fact('Çalışma saatleri', hoursText(clinic.hours)),
    fact('Randevu aralığı', `${clinic.slot_minutes} dakika`),
    fact('Baktığı türler', clinic.species.map((key) => SPECIES[key] ?? key).join(', ')),
    fact('Hizmetler', clinic.services.map((key) => SERVICES[key] ?? key).join(', ')),
    fact('Açıklama', clinic.description),
    fact('Web', clinic.website && safeLink(clinic.website)),
    fact(
      'Instagram',
      clinic.instagram &&
        safeLink(`https://www.instagram.com/${encodeURIComponent(clinic.instagram.replace(/^@/, ''))}`, clinic.instagram),
    ),
    fact('Hesap e-postası', clinic.owner_email),
    fact('Başvuru', formatDateTime(clinic.created_at)),
    fact('Yaklaşan randevu', String(clinic.upcoming_appointments)),
  );
}

function rejectMessage(clinic) {
  const parts = [];
  if (clinic.status === 'approved') {
    parts.push('Klinik sahiplerin listesinden kalkar.');
  } else {
    parts.push('Klinik sahiplerin listesine girmez.');
  }
  if (clinic.upcoming_appointments > 0) {
    parts.push(`${clinic.upcoming_appointments} yaklaşan randevu iptal olur, sahiplerine haber gider.`);
  }
  parts.push('Veteriner bilgilerini düzeltip yeniden gönderebilir.');
  return parts.join(' ');
}

function clinicCard(clinic, reload) {
  const card = h('article', { class: 'sticker' });
  const photo = clinic.photo_path ? `/v1/public/clinic-photos/${encodeURIComponent(clinic.photo_path)}` : null;
  const current = CLINIC_STAMPS[clinic.status];
  const currentStamp = stamp(current.label, current.kind);

  async function approve() {
    const isSure = await confirmAction({
      title: `${clinic.name} onaylansın mı?`,
      body: `Klinik sahiplerin listesinde görünür. Oda sicil no ${clinic.license_no} kayıtlarla eşleşiyor mu, kontrol et.`,
      action: 'Onayla',
    });
    if (!isSure) {
      return;
    }
    try {
      await api('POST', `/clinics/${clinic.id}/approve`, {
        name: clinic.name,
        vet_name: clinic.vet_name,
        license_no: clinic.license_no,
      });
    } catch (error) {
      if (error.code === 'account_suspended') {
        showNotice('Bu hesap kapalı. Önce Kullanıcılar bölümünden hesabı yeniden aç.', true);
      } else if (error.code === 'clinic_changed') {
        showNotice('Klinik bilgileri az önce değişti, onaylanmadı. Güncel bilgileri kontrol et.', true);
        reload();
      } else {
        handleActionError(error);
      }
      return;
    }
    currentStamp.replaceWith(stamp('Listede', 'approved', true));
    showNotice(`${clinic.name} onaylandı.`);
    setTimeout(reload, STAMP_PAUSE_MS);
  }

  async function reject() {
    const isApproved = clinic.status === 'approved';
    const isSure = await confirmAction({
      title: isApproved ? `${clinic.name} listeden kaldırılsın mı?` : `${clinic.name} reddedilsin mi?`,
      body: rejectMessage(clinic),
      action: isApproved ? 'Listeden kaldır' : 'Reddet',
      kind: 'button-danger',
    });
    if (!isSure) {
      return;
    }
    try {
      await api('POST', `/clinics/${clinic.id}/reject`);
    } catch (error) {
      handleActionError(error);
      return;
    }
    currentStamp.replaceWith(stamp('Reddedildi', 'rejected', true));
    showNotice(isApproved ? `${clinic.name} listeden kaldırıldı.` : `${clinic.name} reddedildi.`);
    setTimeout(reload, STAMP_PAUSE_MS);
  }

  card.append(
    currentStamp,
    h(
      'div',
      { class: 'sticker-top' },
      polaroid(photo, clinic.name),
      h(
        'div',
        { class: 'sticker-text' },
        h('h2', { class: 'sticker-name' }, clinic.name),
        h('p', { class: 'sticker-line' }, clinic.vet_name),
        h('p', { class: 'sticker-line' }, clinic.area),
        h('p', { class: 'license' }, 'Oda sicil no', h('strong', {}, clinic.license_no)),
      ),
    ),
    h('details', { class: 'more' }, h('summary', {}, 'Tüm bilgiler'), clinicFacts(clinic)),
    h(
      'div',
      { class: 'actions' },
      clinic.status !== 'approved' &&
        h('button', { type: 'button', class: 'button', onclick: approve }, 'Onayla'),
      clinic.status === 'pending' &&
        h('button', { type: 'button', class: 'button button-quiet', onclick: reject }, 'Reddet'),
      clinic.status === 'approved' &&
        h('button', { type: 'button', class: 'button button-quiet', onclick: reject }, 'Listeden kaldır'),
    ),
  );
  return card;
}

async function renderClinics(view) {
  const list = h('div', {}, loading());
  const reload = () => {
    refreshSummary();
    renderClinics(view);
  };
  const summary = state.summary;
  const pendingLabel = summary ? `Bekleyen (${summary.clinics_pending})` : 'Bekleyen';
  view.replaceChildren(
    h(
      'div',
      { class: 'head' },
      h(
        'div',
        {},
        h('h1', { class: 'title' }, 'Klinikler'),
        h(
          'p',
          { class: 'lead' },
          'Onaylamadan önce oda sicil numarasını Türk Veteriner Hekimleri Birliği kayıtlarından kontrol et.',
        ),
      ),
    ),
    tabs(
      [
        ['pending', pendingLabel],
        ['approved', 'Listede'],
        ['rejected', 'Reddedilen'],
        ['all', 'Tümü'],
      ],
      state.clinicStatus,
      (value) => {
        state.clinicStatus = value;
        renderClinics(view);
      },
    ),
    list,
  );
  const messages = {
    pending: ['Bekleyen başvuru yok', 'Yeni klinik başvuruları burada görünür.'],
    approved: ['Listede klinik yok', 'Onayladığın klinikler burada görünür.'],
    rejected: ['Reddedilen klinik yok', 'Reddettiğin klinikler burada görünür.'],
    all: ['Henüz klinik yok', 'Veterinerler uygulamadan kaydolunca burada görünür.'],
  };
  await pagedList({
    holder: list,
    fetchPage: async (offset) => {
      const { clinics, has_more: hasMore } = await api('GET', `/clinics?status=${state.clinicStatus}&offset=${offset}`);
      return { items: clinics, hasMore };
    },
    renderItem: (clinic) => clinicCard(clinic, reload),
    empty: emptyState(...messages[state.clinicStatus]),
    retry: () => renderClinics(view),
  });
}

// ---- İlanlar ----

function reportStamp(report) {
  if (report.removed_at) {
    return stamp('Kaldırıldı', 'rejected');
  }
  return report.found_at ? stamp('Bulundu', 'approved') : stamp('Açık', 'lost');
}

function sightingRow(sighting, onDeleted) {
  const row = h(
    'li',
    { class: 'sighting' },
    h(
      'div',
      { class: 'sighting-text' },
      sighting.message && h('p', {}, sighting.message),
      sighting.place && h('p', {}, sighting.place),
      !sighting.message && !sighting.place && h('p', {}, 'Yalnızca konum gönderildi'),
      sighting.contact && h('p', { class: 'sighting-contact' }, `İletişim: ${sighting.contact}`),
      h(
        'p',
        { class: 'sighting-meta' },
        formatDateTime(sighting.created_at),
        sighting.has_location ? ', konum eklendi' : '',
      ),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'button button-quiet button-small',
        onclick: async () => {
          const isSure = await confirmAction({
            title: 'İhbar silinsin mi?',
            body: 'İlanın sahibi de bu ihbarı artık göremez. Geri alınamaz.',
            action: 'İhbarı sil',
            kind: 'button-danger',
          });
          if (!isSure) {
            return;
          }
          try {
            await api('DELETE', `/sightings/${sighting.id}`);
            row.remove();
            onDeleted();
            showNotice('İhbar silindi.');
          } catch (error) {
            handleActionError(error);
          }
        },
      },
      'İhbarı sil',
    ),
  );
  return row;
}

function sightingsBlock(report, onCountChange) {
  const holder = h('div', {}, 'Yükleniyor...');
  let count = report.sightings;
  let isLoaded = false;
  const summary = h('summary', {}, `İhbarlar (${count})`);
  const block = h(
    'details',
    {
      class: 'more',
      ontoggle: async (event) => {
        if (!event.target.open || isLoaded) {
          return;
        }
        isLoaded = true;
        try {
          const { sightings } = await api('GET', `/lost-reports/${report.id}/sightings`);
          holder.replaceChildren(
            sightings.length === 0
              ? 'Bu ilana ihbar gelmemiş.'
              : h(
                  'ul',
                  { class: 'sightings' },
                  sightings.map((sighting) =>
                    sightingRow(sighting, () => {
                      count -= 1;
                      summary.textContent = `İhbarlar (${count})`;
                      onCountChange();
                    }),
                  ),
                ),
          );
        } catch (error) {
          isLoaded = false;
          if (error.status === 401) {
            showLogin('Oturumun süresi doldu. Yeniden giriş yap.');
          } else {
            holder.textContent = error.status === 0 ? NETWORK_ERROR : 'İhbarlar açılamadı.';
          }
        }
      },
    },
    summary,
    holder,
  );
  return block;
}

function reportCard(report, reload) {
  const photo = report.photo_path ? `/v1/public/photos/${encodeURIComponent(report.photo_path)}` : null;
  const speciesLine = [SPECIES[report.species] ?? report.species, report.breed].filter(Boolean).join(', ');
  const owner = report.owner_name || report.owner_email || 'Adı bilinmiyor';

  async function remove() {
    const isOpen = !report.found_at;
    const isSure = await confirmAction({
      title: `${report.pet_name} ilanı kaldırılsın mı?`,
      body: isOpen
        ? 'Kayıp sayfası kapanır, herkese açık fotoğraf silinir, sahibine haber gider. İhbarlar sahibinde kalır. Geri alınamaz, sahibi yeni ilan açabilir.'
        : 'Hayvanın adı kayıp sayfasından da kalkar. Geri alınamaz.',
      action: 'İlanı kaldır',
      kind: 'button-lost',
    });
    if (!isSure) {
      return;
    }
    try {
      await api('POST', `/lost-reports/${report.id}/remove`);
      showNotice(`${report.pet_name} ilanı kaldırıldı.`);
      reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  return h(
    'article',
    { class: 'sticker' },
    reportStamp(report),
    h(
      'div',
      { class: 'sticker-top' },
      polaroid(photo, report.pet_name),
      h(
        'div',
        { class: 'sticker-text' },
        h('h2', { class: 'sticker-name' }, report.pet_name),
        h('p', { class: 'sticker-line' }, speciesLine),
        h('p', { class: 'sticker-line' }, report.last_seen_area),
        h('p', { class: 'sticker-line' }, `Başlangıç: ${formatDateTime(report.started_at)}`),
        h('p', { class: 'sticker-line' }, `Sahibi: ${owner}`),
        report.description && h('p', { class: 'sticker-line' }, report.description),
      ),
    ),
    sightingsBlock(report, () => refreshSummary()),
    !report.removed_at &&
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          { type: 'button', class: `button ${report.found_at ? 'button-quiet' : 'button-lost'}`, onclick: remove },
          'İlanı kaldır',
        ),
      ),
  );
}

function pagedList({ holder, fetchPage, renderItem, empty, retry }) {
  let offset = 0;
  async function loadMore(button) {
    try {
      const { items, hasMore } = await fetchPage(offset);
      offset += items.length;
      if (offset === 0) {
        holder.replaceChildren(empty);
        return;
      }
      button?.parentElement.remove();
      if (button === undefined) {
        holder.replaceChildren();
      }
      holder.append(...items.map(renderItem));
      if (hasMore) {
        const more = h('button', { type: 'button', class: 'button button-quiet', onclick: () => loadMore(more) }, 'Daha fazla göster');
        holder.append(h('div', { class: 'load-more' }, more));
      }
    } catch (error) {
      if (button) {
        handleActionError(error);
        return;
      }
      const failed = loadFailed(error, retry);
      if (failed) {
        holder.replaceChildren(failed);
      }
    }
  }
  return loadMore();
}

async function renderReports(view) {
  const list = h('div', {}, loading());
  const reload = () => {
    refreshSummary();
    renderReports(view);
  };
  const summary = state.summary;
  view.replaceChildren(
    h(
      'div',
      { class: 'head' },
      h(
        'div',
        {},
        h('h1', { class: 'title' }, 'Kayıp ilanları'),
        h(
          'p',
          { class: 'lead' },
          'Uygunsuz ilanı ya da sahte ihbarı buradan kaldır. Tam konum burada görünmez.',
        ),
      ),
    ),
    tabs(
      [
        ['open', summary ? `Açık (${summary.reports_open})` : 'Açık'],
        ['closed', 'Kapanan'],
      ],
      state.reportState,
      (value) => {
        state.reportState = value;
        renderReports(view);
      },
    ),
    list,
  );
  await pagedList({
    holder: list,
    fetchPage: async (offset) => {
      const { reports, has_more: hasMore } = await api('GET', `/lost-reports?state=${state.reportState}&offset=${offset}`);
      return { items: reports, hasMore };
    },
    renderItem: (report) => reportCard(report, reload),
    empty:
      state.reportState === 'open'
        ? emptyState('Açık ilan yok', 'Sahipler kayıp modunu başlatınca ilanlar burada görünür.')
        : emptyState('Kapanan ilan yok', 'Bulunan ve kaldırılan ilanlar burada görünür.'),
    retry: () => renderReports(view),
  });
}

// ---- Kullanıcılar ----

function userRow(user, reload) {
  const isSuspended = Boolean(user.suspended_at);
  const label = user.name || user.email || PROVIDERS[user.provider] || 'Adı bilinmiyor';
  const accountType = user.role === 'vet' ? 'Veteriner' : 'Sahip';

  function suspendMessage() {
    const parts = ['Hesabın oturumu kapanır, yeniden giriş yapamaz.'];
    if (user.open_reports > 0) {
      parts.push(`${user.open_reports} açık ilanı kaldırılır.`);
    }
    if (user.clinic_name) {
      parts.push(`${user.clinic_name} listeden kalkar, yaklaşan randevuları iptal olur.`);
    }
    if (user.upcoming_appointments > 0) {
      parts.push(`${user.upcoming_appointments} yaklaşan randevusu iptal olur.`);
    }
    parts.push('Kayıtları silinmez.');
    return parts.join(' ');
  }

  async function toggle() {
    const isSure = await confirmAction(
      isSuspended
        ? {
            title: `${label} yeniden açılsın mı?`,
            body: 'Hesap yeniden giriş yapabilir. Kaldırılan ilan ve reddedilen klinik kendiliğinden geri gelmez.',
            action: 'Hesabı aç',
          }
        : {
            title: `${label} kapatılsın mı?`,
            body: suspendMessage(),
            action: 'Hesabı kapat',
            kind: 'button-danger',
          },
    );
    if (!isSure) {
      return;
    }
    try {
      await api('POST', `/users/${user.id}/${isSuspended ? 'unsuspend' : 'suspend'}`);
      showNotice(isSuspended ? 'Hesap açıldı.' : 'Hesap kapatıldı.');
      reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  return h(
    'tr',
    {},
    h(
      'td',
      {},
      h('div', { class: 'user-name' }, label),
      user.name && user.email && h('div', { class: 'user-detail' }, user.email),
      h('div', { class: 'user-detail' }, `${accountType}, ${PROVIDERS[user.provider] ?? user.provider}`),
      user.clinic_name && h('div', { class: 'user-detail' }, `Klinik: ${user.clinic_name}`),
      isSuspended && h('span', { class: 'pill' }, `${formatDate(user.suspended_at)} tarihinde kapatıldı`),
    ),
    h('td', { 'data-label': 'Kayıt' }, formatDate(user.created_at)),
    h('td', { 'data-label': 'Son görülme' }, formatDate(user.last_seen_at) || 'Oturum yok'),
    h('td', { class: 'number', 'data-label': 'Hayvan' }, String(user.pets)),
    h('td', { class: 'number', 'data-label': 'Açık ilan' }, String(user.open_reports)),
    h(
      'td',
      {},
      h(
        'button',
        { type: 'button', class: `button button-small ${isSuspended ? '' : 'button-quiet'}`, onclick: toggle },
        isSuspended ? 'Hesabı aç' : 'Hesabı kapat',
      ),
    ),
  );
}

async function renderUsers(view) {
  const list = h('div', {}, loading());
  const reload = () => {
    refreshSummary();
    renderUsers(view);
  };
  const input = h('input', {
    type: 'search',
    name: 'q',
    value: state.userQuery,
    placeholder: 'Ad, e-posta ya da klinik',
    'aria-label': 'Ad, e-posta ya da klinik ara',
    autocomplete: 'off',
  });
  view.replaceChildren(
    h(
      'div',
      { class: 'head' },
      h(
        'div',
        {},
        h('h1', { class: 'title' }, 'Kullanıcılar'),
        h('p', { class: 'lead' }, 'Sağlık kayıtları ve hayvan bilgileri burada görünmez.'),
      ),
    ),
    h(
      'form',
      {
        class: 'search',
        role: 'search',
        onsubmit: (event) => {
          event.preventDefault();
          state.userQuery = input.value.trim();
          renderUsers(view);
        },
      },
      input,
      h('button', { type: 'submit', class: 'button' }, 'Ara'),
    ),
    tabs(
      [
        ['all', 'Hepsi'],
        ['owner', 'Sahip'],
        ['vet', 'Veteriner'],
        ['suspended', 'Kapalı'],
      ],
      state.userFilter,
      (value) => {
        state.userFilter = value;
        renderUsers(view);
      },
    ),
    list,
  );

  const tbody = h('tbody');
  const table = h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'users' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'Hesap'),
          h('th', { scope: 'col' }, 'Kayıt'),
          h('th', { scope: 'col' }, 'Son görülme'),
          h('th', { scope: 'col' }, 'Hayvan'),
          h('th', { scope: 'col' }, 'Açık ilan'),
          h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'İşlem')),
        ),
      ),
      tbody,
    ),
  );

  let offset = 0;
  const query = new URLSearchParams({ q: state.userQuery, filter: state.userFilter });

  async function loadPage(button) {
    try {
      query.set('offset', String(offset));
      const { users, has_more: hasMore } = await api('GET', `/users?${query}`);
      offset += users.length;
      if (offset === 0) {
        list.replaceChildren(
          state.userQuery
            ? emptyState('Sonuç yok', 'Başka bir ad ya da e-posta dene.')
            : emptyState('Bu süzgeçte hesap yok', 'Süzgeci değiştirip tekrar bak.'),
        );
        return;
      }
      if (!button) {
        list.replaceChildren(table);
      }
      button?.parentElement.remove();
      tbody.append(...users.map((user) => userRow(user, reload)));
      if (hasMore) {
        const more = h('button', { type: 'button', class: 'button button-quiet', onclick: () => loadPage(more) }, 'Daha fazla göster');
        list.append(h('div', { class: 'load-more' }, more));
      }
    } catch (error) {
      if (button) {
        handleActionError(error);
        return;
      }
      const failed = loadFailed(error, () => renderUsers(view));
      if (failed) {
        list.replaceChildren(failed);
      }
    }
  }
  await loadPage();
}

// ---- Kabuk ----

const ROUTES = {
  '#/ozet': { label: 'Özet', render: renderSummary },
  '#/klinikler': { label: 'Klinikler', render: renderClinics, count: () => state.summary?.clinics_pending },
  '#/ilanlar': { label: 'İlanlar', render: renderReports, count: () => state.summary?.reports_open, isLost: true },
  '#/kullanicilar': { label: 'Kullanıcılar', render: renderUsers },
};

function currentRoute() {
  return ROUTES[location.hash] ? location.hash : '#/ozet';
}

function updateNav() {
  const nav = document.getElementById('nav');
  if (!nav) {
    return;
  }
  const active = currentRoute();
  nav.replaceChildren(
    ...Object.entries(ROUTES).map(([hash, route]) => {
      const count = route.count?.();
      return h(
        'a',
        { href: hash, 'aria-current': hash === active ? 'page' : null },
        route.label,
        count > 0 && h('span', { class: `nav-count${route.isLost ? ' nav-count-lost' : ''}` }, String(count)),
      );
    }),
  );
}

async function refreshSummary() {
  state.summary = await api('GET', '/summary');
  updateNav();
  return state.summary;
}

async function renderRoute() {
  const view = document.getElementById('view');
  if (!view) {
    return;
  }
  updateNav();
  window.scrollTo(0, 0);
  const route = ROUTES[currentRoute()];
  document.title = `${route.label} | Patika yönetim`;
  view.replaceChildren(loading());
  try {
    if (!state.summary) {
      await refreshSummary();
    }
    await route.render(view);
  } catch (error) {
    const failed = loadFailed(error, renderRoute);
    if (failed) {
      view.replaceChildren(failed);
    }
  }
}

function showShell() {
  app.replaceChildren(
    h(
      'header',
      { class: 'collar' },
      h('a', { class: 'wordmark', href: '#/ozet' }, 'patika'),
      h('nav', { id: 'nav', class: 'nav', 'aria-label': 'Panel bölümleri' }),
      h(
        'div',
        { class: 'who' },
        h('span', { class: 'who-email' }, state.email),
        h(
          'button',
          {
            type: 'button',
            onclick: async () => {
              try {
                await api('POST', '/logout');
              } catch (error) {
                if (error.status !== 401) {
                  handleActionError(error);
                  return;
                }
              }
              showLogin();
            },
          },
          'Çıkış yap',
        ),
      ),
    ),
    h('main', { id: 'view', class: 'view' }),
  );
  renderRoute();
}

function showLogin(message) {
  state.email = null;
  state.summary = null;
  if (dialog.open) {
    dialog.close();
  }
  document.title = 'Giriş | Patika yönetim';
  const error = h('div', { role: 'alert' });
  const setError = (text) => {
    error.replaceChildren(text ? h('p', { class: 'login-error' }, text) : '');
  };
  setError(message);
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { type: 'submit', class: 'button' }, 'Giriş yap');
  app.replaceChildren(
    h(
      'main',
      { class: 'login' },
      h(
        'form',
        {
          class: 'login-card',
          onsubmit: async (event) => {
            event.preventDefault();
            setError('');
            submit.disabled = true;
            try {
              const result = await api('POST', '/login', { email: email.value, password: password.value });
              state.email = result.email;
              showShell();
            } catch (failure) {
              submit.disabled = false;
              password.value = '';
              if (failure.code === 'invalid_credentials' || failure.code === 'invalid_request') {
                setError('E-posta ya da şifre yanlış.');
              } else if (failure.code === 'rate_limited') {
                setError('Çok fazla yanlış deneme yapıldı. 15 dakika sonra tekrar dene.');
              } else {
                setError(failure.status === 0 ? NETWORK_ERROR : 'Giriş yapılamadı. Biraz sonra tekrar dene.');
              }
            }
          },
        },
        h('p', { class: 'login-word' }, 'patika'),
        h('h1', { class: 'login-title' }, 'Yönetim paneli'),
        error,
        h('label', { class: 'field' }, 'E-posta', email),
        h('label', { class: 'field' }, 'Şifre', password),
        submit,
      ),
    ),
  );
  email.focus();
}

window.addEventListener('hashchange', renderRoute);

(async function start() {
  try {
    const { email } = await api('GET', '/me');
    state.email = email;
    showShell();
  } catch (error) {
    showLogin(error.status === 401 ? undefined : NETWORK_ERROR);
  }
})();
