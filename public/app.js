const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const rows = document.querySelector('#contact-rows');
const searchInput = document.querySelector('#contact-search');
const dialog = document.querySelector('#contact-dialog');
const form = document.querySelector('#contact-form');
let contacts = [];
let householdOptions = [];
let allTags = [];
let currentUser = null;
let editingId = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options,
    headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const type = response.headers.get('content-type') || '';
  const result = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/auth/me' && url !== '/api/auth/login') showSignedOut();
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return result;
}

function setScreen(screenName) {
  const knownScreens = ['dashboard', 'contacts', 'contact-details', 'memberships', 'donations', 'tasks', 'reports', 'settings'];
  const nextScreen = knownScreens.includes(screenName) ? screenName : 'dashboard';
  document.querySelectorAll('.screen').forEach((screen) => { screen.hidden = screen.id !== `screen-${nextScreen}`; });
  document.querySelectorAll('.nav-link').forEach((link) => {
    const active = link.dataset.screen === nextScreen;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const section = document.querySelector(`#screen-${nextScreen}`);
  document.querySelector('#current-page').textContent = section.dataset.title;
  document.title = `${section.dataset.title} · Advanced Studies CRM`;
  if (location.hash !== `#${nextScreen}`) history.replaceState(null, '', `#${nextScreen}`);
}

function roleCanWrite() { return currentUser && ['admin', 'staff'].includes(currentUser.role); }

function setSignedIn(user) {
  currentUser = user;
  document.querySelector('#auth-gate').hidden = true;
  document.querySelector('.shell').classList.remove('signed-out');
  document.querySelector('.shell').inert = false;
  document.querySelector('#signed-in-name').textContent = user.username;
  document.querySelector('#signed-in-role').textContent = `${user.role} access`;
  document.querySelector('#user-avatar').textContent = user.username.slice(0, 2).toUpperCase();
  document.querySelector('#role-chip').textContent = user.role;
  document.querySelector('#role-chip').hidden = false;
  document.querySelector('#sign-out').hidden = false;
  document.querySelectorAll('[data-add-contact]').forEach((button) => { button.hidden = !roleCanWrite(); });
  document.querySelector('#contact-import-tools').hidden = !roleCanWrite();
  document.querySelector('#export-contacts').hidden = user.role !== 'admin';
  document.querySelector('#user-management').hidden = user.role !== 'admin';
  document.querySelector('#settings-summary').textContent = `Signed in as ${user.username} (${user.role}).`;
}

function showSignedOut() {
  currentUser = null;
  document.querySelector('#auth-gate').hidden = false;
  document.querySelector('.shell').classList.add('signed-out');
  document.querySelector('.shell').inert = true;
  document.querySelector('#sign-out').hidden = true;
  document.querySelector('#role-chip').hidden = true;
  document.querySelector('#login-username').focus();
}

function currentContactFilters() {
  const params = new URLSearchParams();
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
  if (document.querySelector('#tag-filter').value) params.set('tag', document.querySelector('#tag-filter').value);
  if (document.querySelector('#archived-filter').checked) params.set('archived', 'true');
  return params.toString();
}

function renderContacts() {
  const tag = document.querySelector('#tag-filter').value;
  document.querySelector('#showing-count').textContent = `Showing ${contacts.length} ${document.querySelector('#archived-filter').checked ? 'archived ' : ''}contact${contacts.length === 1 ? '' : 's'}`;
  document.querySelector('#clear-search').hidden = !searchInput.value.trim();
  if (!contacts.length) {
    rows.innerHTML = '<tr><td colspan="5" class="empty">No contacts found. Try another search or tag.</td></tr>';
    return;
  }
  rows.innerHTML = contacts.map((contact) => `<tr>
    <td class="id-cell">${escapeHtml(contact.id)}${contact.archived ? ' <span class="archived-badge">Archived</span>' : ''}</td>
    <td class="person-cell">${escapeHtml(contact.name)}</td>
    <td>${escapeHtml(contact.email || '—')}</td>
    <td>${contact.household_id ? `<button type="button" class="text-link" data-open-household="${escapeHtml(contact.household_id)}">${escapeHtml(contact.household_id)} · ${escapeHtml(contact.household_name || '')}</button>` : '—'}</td>
    <td><button class="open-contact" type="button" data-open-contact="${escapeHtml(contact.id)}">Open</button></td>
  </tr>`).join('');
  void tag;
}

async function loadContacts() {
  contacts = await api(`/api/contacts?${currentContactFilters()}`);
  renderContacts();
}

function updateTagOptions() {
  const select = document.querySelector('#tag-filter');
  const selected = select.value;
  select.innerHTML = '<option value="">All tags</option>' + allTags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
  if (allTags.includes(selected)) select.value = selected;
}

async function loadHouseholdOptions() {
  householdOptions = await api('/api/households/options');
  const select = document.querySelector('#contact-household');
  select.innerHTML = '<option value="">No household</option>' + householdOptions.map((household) =>
    `<option value="${escapeHtml(household.id)}">${escapeHtml(household.id)} · ${escapeHtml(household.name)}</option>`
  ).join('') + '<option value="__new__">Create a new household…</option>';
}

async function loadTags() { allTags = await api('/api/contact-tags'); updateTagOptions(); }

async function loadOverview() {
  const data = await api('/api/overview');
  document.querySelector('#test-date').textContent = `Practice data · ${dateFormat.format(new Date(`${data.testDate}T00:00:00`))}`;
  document.querySelector('#metric-contacts').textContent = data.activePeople;
  document.querySelector('#metric-members').textContent = data.activeMemberships;
  document.querySelector('#metric-giving').textContent = money.format(data.donationTotal);
  document.querySelector('#gift-count').textContent = `${data.donationCount} recorded gifts`;
  document.querySelector('#metric-renewals').textContent = data.renewalsDue;
  document.querySelector('#metric-tasks').textContent = data.overdueTasks;
}

function showHistory(history = []) {
  if (!history.length) return '<p class="empty">No history events recorded. Earlier saves from before this build were not tracked; changes now show the account and time.</p>';
  return `<ul class="history-list">${history.map((item) => `<li><strong>${escapeHtml(item.action)}</strong> · ${escapeHtml(item.record_type)} ${escapeHtml(item.record_id)} · ${escapeHtml(item.actor_name)} · ${escapeHtml(dateFormat.format(new Date(item.occurred_at)))}</li>`).join('')}</ul>`;
}

function showContactActions(contact) {
  const controls = roleCanWrite() ? `<div class="detail-actions"><button class="secondary-button" id="edit-contact" type="button" ${contact.archived ? 'disabled' : ''}>Edit</button>${contact.archived ? '<span class="archived-badge">Archived</span>' : `<button class="secondary-button archive-button" id="archive-contact" type="button">Archive</button>`}</div>` : '';
  return controls;
}

async function openContact(contactId) {
  const contact = await api(`/api/contacts/${encodeURIComponent(contactId)}`);
  const details = [
    ['Contact ID', contact.id], ['Name', contact.name], ['Email', contact.email || '—'],
    ['Phone', contact.phone || '—'], ['Household', contact.household_name ? `${contact.household_id} · ${contact.household_name}` : '—'],
    ['Tags', contact.tags.length ? contact.tags.join(', ') : '—'], ['Notes', contact.notes || '—'],
    ['Email permission', contact.email_opt_in ? 'Yes' : 'No'], ['Record status', contact.archived ? 'Archived' : 'Active']
  ];
  document.querySelector('#detail-subhead').textContent = `${contact.name} · ${contact.id}`;
  document.querySelector('#contact-detail-card').innerHTML = `${showContactActions(contact)}
    <dl class="detail-grid">${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
    <section class="linked-records"><h2>Household people</h2><div id="detail-household-people">${contact.household_id ? 'Loading household…' : '<p>No household linked.</p>'}</div></section>
    <section class="linked-records"><h2>Linked records</h2><p>Memberships: ${contact.memberships.length ? contact.memberships.length : 'none saved yet'}</p><p>Donations: ${contact.donations.length ? contact.donations.length : 'none saved yet'}</p><p>Tasks: ${contact.tasks.length ? contact.tasks.length : 'none saved yet'}</p></section>
    <section class="linked-records"><h2>Change history</h2>${showHistory(contact.history)}</section>`;
  if (contact.household_id) {
    try {
      const household = await api(`/api/households/${encodeURIComponent(contact.household_id)}`);
      document.querySelector('#detail-household-people').innerHTML = `<p>${escapeHtml(household.id)} · ${escapeHtml(household.name)}</p><ul class="household-people">${household.people.map((person) => `<li><button class="text-link" data-open-contact="${escapeHtml(person.id)}">${escapeHtml(person.name)} · ${escapeHtml(person.id)}</button>${person.archived ? ' (archived)' : ''} <span>${escapeHtml(person.email || 'no email')}</span></li>`).join('')}</ul>`;
    } catch (error) { document.querySelector('#detail-household-people').textContent = error.message; }
  }
  document.querySelector('#edit-contact')?.addEventListener('click', () => openDialog(contact));
  document.querySelector('#archive-contact')?.addEventListener('click', () => archiveContact(contact.id));
  setScreen('contact-details');
}

async function openHousehold(householdId) {
  const household = await api(`/api/households/${encodeURIComponent(householdId)}`);
  document.querySelector('#detail-subhead').textContent = `${household.name} · ${household.id}`;
  document.querySelector('#contact-detail-card').innerHTML = `<h2>${escapeHtml(household.name)}</h2><p class="subhead">Household ${escapeHtml(household.id)} · ${household.people.length} linked people</p><ul class="household-people">${household.people.map((person) => `<li><button class="text-link" data-open-contact="${escapeHtml(person.id)}">${escapeHtml(person.name)} · ${escapeHtml(person.id)}</button>${person.archived ? ' (archived)' : ''}<span>${escapeHtml(person.email || 'no email')} · ${escapeHtml(person.phone || 'no phone')}</span></li>`).join('')}</ul>`;
  setScreen('contact-details');
}

function openDialog(contact = null) {
  form.reset();
  editingId = contact?.id || null;
  document.querySelector('#form-message').textContent = '';
  document.querySelector('#contact-dialog-title').textContent = contact ? `Edit ${contact.name}` : 'Add Contact';
  document.querySelector('#contact-id').readOnly = Boolean(contact);
  document.querySelector('#contact-id').value = contact?.id || '';
  document.querySelector('#contact-name').value = contact?.name || '';
  document.querySelector('#contact-email').value = contact?.email || '';
  document.querySelector('#contact-phone').value = contact?.phone || '';
  document.querySelector('#contact-tags').value = contact?.tags?.join(', ') || '';
  document.querySelector('#contact-notes').value = contact?.notes || '';
  document.querySelector('#contact-email-opt-in').checked = Boolean(contact?.email_opt_in);
  document.querySelector('#contact-household').value = contact?.household_id || '';
  document.querySelector('#new-household-fields').hidden = true;
  document.querySelector('#new-household-id').value = '';
  document.querySelector('#new-household-name').value = '';
  dialog.showModal();
  (contact ? document.querySelector('#contact-name') : document.querySelector('#contact-id')).focus();
}

function closeDialog() { dialog.close(); }

async function refreshData() { await Promise.all([loadContacts(), loadOverview()]); }

function showError(error, target = '#contact-message') {
  const message = document.querySelector(target);
  message.textContent = error.message;
  message.hidden = false;
}

async function archiveContact(contactId) {
  if (!window.confirm(`Archive ${contactId}? Its history and links will be kept.`)) return;
  try {
    await api(`/api/contacts/${encodeURIComponent(contactId)}/archive`, { method: 'POST', body: '{}' });
    await refreshData();
    await openContact(contactId);
    document.querySelector('#contact-message').textContent = `${contactId} was archived. Its saved details remain available.`;
  } catch (error) { showError(error); }
}

async function loadSettings() {
  if (!currentUser) return;
  try {
    const audit = await api('/api/audit');
    document.querySelector('#audit-list').innerHTML = showHistory(audit);
    if (currentUser.role === 'admin') {
      const users = await api('/api/admin/users');
      document.querySelector('#user-list').innerHTML = `<table><thead><tr><th>USERNAME</th><th>ROLE</th><th>CHANGE ROLE</th></tr></thead><tbody>${users.map((user) => `<tr><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.role)}</td><td><select data-user-role="${user.id}" aria-label="Role for ${escapeHtml(user.username)}"><option ${user.role === 'viewer' ? 'selected' : ''} value="viewer">Viewer</option><option ${user.role === 'staff' ? 'selected' : ''} value="staff">Staff</option><option ${user.role === 'admin' ? 'selected' : ''} value="admin">Admin</option></select></td></tr>`).join('')}</tbody></table>`;
      document.querySelectorAll('[data-user-role]').forEach((select) => select.addEventListener('change', async () => {
        try { await api(`/api/admin/users/${select.dataset.userRole}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) }); }
        catch (error) { showError(error, '#user-message'); await loadSettings(); }
      }));
    }
  } catch (error) { showError(error, '#user-message'); }
}

document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', () => {
  setScreen(link.dataset.screen);
  if (link.dataset.screen === 'settings') loadSettings();
}));
document.querySelectorAll('[data-screen-link]').forEach((button) => button.addEventListener('click', () => setScreen(button.dataset.screenLink)));
window.addEventListener('hashchange', () => setScreen(location.hash.slice(1)));
document.querySelectorAll('[data-add-contact]').forEach((button) => button.addEventListener('click', () => openDialog()));
document.querySelector('#close-dialog').addEventListener('click', closeDialog);
document.querySelector('#cancel-contact').addEventListener('click', closeDialog);
document.querySelector('#contact-household').addEventListener('change', (event) => {
  const isNew = event.target.value === '__new__';
  document.querySelector('#new-household-fields').hidden = !isNew;
  document.querySelector('#new-household-id').required = isNew;
  document.querySelector('#new-household-name').required = isNew;
});
document.querySelector('#clear-search').addEventListener('click', () => { searchInput.value = ''; loadContacts().catch(showError); searchInput.focus(); });
searchInput.addEventListener('input', () => loadContacts().catch(showError));
document.querySelector('#tag-filter').addEventListener('change', () => loadContacts().catch(showError));
document.querySelector('#archived-filter').addEventListener('change', () => loadContacts().catch(showError));
rows.addEventListener('click', (event) => {
  const contactButton = event.target.closest('[data-open-contact]');
  const householdButton = event.target.closest('[data-open-household]');
  if (contactButton) openContact(contactButton.dataset.openContact).catch(showError);
  else if (householdButton) openHousehold(householdButton.dataset.openHousehold).catch(showError);
});
document.querySelector('#contact-detail-card').addEventListener('click', (event) => {
  const contactButton = event.target.closest('[data-open-contact]');
  if (contactButton) openContact(contactButton.dataset.openContact).catch(showError);
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && currentUser) { event.preventDefault(); setScreen('contacts'); searchInput.focus(); }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formMessage = document.querySelector('#form-message');
  formMessage.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  data.email_opt_in = form.elements.email_opt_in.checked;
  if (data.household_id === '__new__') {
    if (!data.new_household_id.trim() || !data.household_name.trim()) {
      formMessage.textContent = 'Enter a new household ID and name, or choose an existing household.';
      document.querySelector(data.new_household_id.trim() ? '#new-household-name' : '#new-household-id').focus();
      return;
    }
    data.household_id = data.new_household_id;
  }
  delete data.new_household_id;
  if (!data.household_id) data.household_name = '';
  try {
    const url = editingId ? `/api/contacts/${encodeURIComponent(editingId)}` : '/api/contacts';
    const result = await api(url, { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(data) });
    closeDialog();
    setScreen('contacts');
    searchInput.value = '';
    await loadHouseholdOptions();
    await refreshData();
    document.querySelector('#contact-message').textContent = `Contact ${result.id} ${editingId ? 'updated' : 'saved'}.`;
    document.querySelector('#contact-message').hidden = false;
    if (editingId) await openContact(result.id);
  } catch (error) {
    formMessage.textContent = error.message;
    if (error.message.toLowerCase().includes('name')) document.querySelector('#contact-name').focus();
  }
});

document.querySelector('#load-practice-data').addEventListener('click', async () => {
  const button = document.querySelector('#load-practice-data');
  button.disabled = true;
  try {
    const result = await api('/api/import/practice-data', { method: 'POST', body: '{}' });
    document.querySelector('#contact-message').textContent = result.message;
    await loadHouseholdOptions();
    await refreshData();
  } catch (error) { showError(error); } finally { button.disabled = false; }
});

document.querySelector('#csv-import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const result = await api('/api/import/contacts-csv', { method: 'POST', body: JSON.stringify({ csv: await file.text() }) });
    const problems = result.rows.filter((item) => item.status === 'error').map((item) => `Row ${item.row} (${item.id || 'no ID'}): ${item.message}`).join(' ');
    document.querySelector('#contact-message').textContent = `CSV import: ${result.added} added, ${result.skipped} kept unchanged, ${result.errors} with errors.${problems ? ` ${problems}` : ''}`;
    document.querySelector('#contact-message').hidden = false;
    await loadHouseholdOptions();
    await refreshData();
  } catch (error) { showError(error); }
  event.target.value = '';
});

document.querySelector('#export-contacts').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/export/contacts.csv', { credentials: 'same-origin' });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Export failed.'); }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = 'crm-contacts.csv'; link.click(); URL.revokeObjectURL(url);
  } catch (error) { showError(error); }
});

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const { user } = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(formData) });
    setSignedIn(user);
    document.querySelector('#login-message').textContent = '';
    await Promise.all([loadHouseholdOptions(), loadTags()]);
    await refreshData();
    if (user.role === 'admin' && location.hash === '#settings') loadSettings();
    document.querySelector('#contact-search').focus();
  } catch (error) { showError(error, '#login-message'); }
});

document.querySelector('#sign-out').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } finally { showSignedOut(); }
});

document.querySelector('#new-user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify(data) });
    event.currentTarget.reset();
    document.querySelector('#user-message').textContent = 'User added.';
    await loadSettings();
  } catch (error) { showError(error, '#user-message'); }
});

async function boot() {
  setScreen(location.hash.slice(1) || 'dashboard');
  try {
    const { user } = await api('/api/auth/me');
    setSignedIn(user);
    await Promise.all([loadHouseholdOptions(), loadTags()]);
    await refreshData();
    if (location.hash === '#settings') loadSettings();
  } catch (_error) { showSignedOut(); }
}
boot();

